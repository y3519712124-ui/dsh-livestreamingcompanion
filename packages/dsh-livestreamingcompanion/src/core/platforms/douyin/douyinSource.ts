/**
 * 抖音直播弹幕连接：借浏览器桥（真 Chrome）连上直播间，把页面收到的帧解成统一事件。
 *
 * 保活：桥每 0.9 秒取一次帧；10 秒一帧都没有且房间在播，就当桥掉了，重开浏览器。
 * 重连退避 1s → 2s → … → 30s，连上后归零。房间信息每 60 秒刷一次（标题、在线人数）。
 */

import type { LiveRoomInfo } from '../../live';
import type { LiveSource, LiveSourceListener } from '../source';
import { BrowserBridge } from './douyinBridge';
import { decodePushFrame, type DouyinContext } from './douyinDecode';
import { enterRoom, type DouyinRoom } from './douyinApi';

const POLL_MS = 900;
const ROOM_REFRESH_MS = 60_000;
const SILENCE_LIMIT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export interface DouyinSourceOptions {
  cookie: string;
  /** 浏览器可执行文件（空：自动找 Chrome/Edge） */
  browserPath?: string;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export class DouyinLiveSource implements LiveSource {
  readonly platform = 'douyin' as const;
  private listener: LiveSourceListener | null = null;
  private bridge: BrowserBridge | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private roomTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private lastFrameAt = 0;
  private stopped = true;
  private room: DouyinRoom | null = null;
  private ctx: DouyinContext = { roomId: '', anchorId: '' };
  private openedAt = 0;

  constructor(private readonly webRid: number, private readonly options: DouyinSourceOptions) {}

  private log(level: 'info' | 'warn', message: string): void {
    this.options.log?.(level, message);
  }

  start(listener: LiveSourceListener): void {
    this.listener = listener;
    this.stopped = false;
    void this.connect().catch((err: Error) => this.scheduleRetry(`连接失败：${err.message}`));
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.retryTimer = this.pollTimer = this.roomTimer = null;
    this.bridge?.stop();
    this.bridge = null;
    this.listener?.state('idle');
    this.listener = null;
  }

  private async connect(): Promise<void> {
    const listener = this.listener;
    if (this.stopped || !listener) return;
    listener.state(this.backoffMs > 1000 ? 'reconnecting' : 'connecting');

    // 1) 房间信息：Node 直连（实测可用）；被风控就交给页面自己去问
    let room = await enterRoom(this.webRid, this.options.cookie);
    if (!room) this.log('warn', '抖音进房接口没返回，直接用浏览器桥（房间信息从页面里取）');
    this.room = room;
    this.ctx = { roomId: room?.roomId ?? '', anchorId: room?.anchorId ?? '' };
    if (room) this.announce(room);

    // 2) 浏览器桥：页面自己连弹幕
    const bridge = new BrowserBridge({ browserPath: this.options.browserPath });
    this.bridge = bridge;
    try {
      await bridge.open(`https://live.douyin.com/${this.webRid}`);
    } catch (err) {
      bridge.stop();
      this.bridge = null;
      this.scheduleRetry((err as Error).message);
      return;
    }
    if (this.stopped) {
      bridge.stop();
      return;
    }

    // 页面里再问一次房间信息（Node 被挡时这里通）
    if (!this.room) {
      const pageRoom = await this.roomFromPage(bridge);
      if (pageRoom) {
        this.room = pageRoom;
        this.ctx = { roomId: pageRoom.roomId, anchorId: pageRoom.anchorId ?? '' };
        this.announce(pageRoom);
      }
    }

    this.openedAt = Date.now();
    this.lastFrameAt = this.openedAt;
    this.startPolling(bridge);
    this.startRoomRefresh();
    this.backoffMs = 1000;
    listener.state('connected', {
      loggedIn: false,
      error: this.room?.live === false ? '这个直播间现在没在播（弹幕要等开播才会来）' : undefined,
    });
    this.log('info', `抖音直播间 ${this.webRid} 已连上（浏览器桥）`);
  }

  /** 页面里问一次进房接口：带页面 Cookie，比 Node 直连不容易被挡 */
  private async roomFromPage(bridge: BrowserBridge): Promise<DouyinRoom | null> {
    const raw = await bridge
      .evaluate<string>(`(async () => {
      const r = await fetch('/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&web_rid=${this.webRid}', { credentials: 'include' });
      const j = await r.json();
      const room = j?.data?.data?.[0];
      if (!room) return '';
      return JSON.stringify({ roomId: room.id_str, status: room.status, title: room.title, anchorName: room.owner?.nickname, anchorId: room.owner?.id_str, avatar: room.owner?.avatar_thumb?.url_list?.[0], online: Number(String(room.user_count_str || '').replace(/\\D/g, '')) });
    })()`)
      .catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<DouyinRoom> & { status?: number };
      const status = Number(parsed.status ?? 0);
      return {
        roomId: String(parsed.roomId ?? ''),
        status,
        live: status === 2,
        title: String(parsed.title ?? ''),
        ...(parsed.anchorName ? { anchorName: parsed.anchorName } : {}),
        ...(parsed.anchorId ? { anchorId: String(parsed.anchorId) } : {}),
        ...(parsed.avatar ? { avatar: parsed.avatar } : {}),
        ...(parsed.online ? { online: parsed.online } : {}),
      };
    } catch {
      return null;
    }
  }

  private announce(room: DouyinRoom): void {
    const listener = this.listener;
    if (!listener) return;
    const info: LiveRoomInfo = {
      platform: 'douyin',
      roomId: this.webRid,
      title: room.title || undefined,
      anchorName: room.anchorName,
      anchorId: room.anchorId,
    };
    listener.room(info);
    listener.stats({
      live: room.live,
      ...(room.online ? { online: room.online } : {}),
    });
  }

  private startPolling(bridge: BrowserBridge): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // 定时器里的 Promise 一定要自己兜住：漏出去的 rejection 会把宿主带崩
      void this.poll(bridge).catch((err: Error) => this.log('warn', `取弹幕出错：${err.message}`));
    }, POLL_MS);
  }

  private async poll(bridge: BrowserBridge): Promise<void> {
    const listener = this.listener;
    if (this.stopped || !listener || this.bridge !== bridge) return;
    let frames: string[] = [];
    try {
      const drained = await bridge.drain();
      frames = drained.frames;
    } catch (err) {
      this.scheduleRetry(`取帧失败：${(err as Error).message}`);
      return;
    }
    const now = Date.now();
    if (!frames.length) {
      // 没在播的时候本来就安静；在播却一直没帧，就是桥掉了
      if (this.room?.live && now - this.lastFrameAt > SILENCE_LIMIT_MS && now - this.openedAt > 15_000) {
        this.scheduleRetry('10 秒没有收到弹幕');
      }
      return;
    }
    this.lastFrameAt = now;
    for (const b64 of frames) {
      let outputs;
      try {
        outputs = decodePushFrame(Buffer.from(b64, 'base64'), this.ctx, now);
      } catch (err) {
        this.log('warn', `解抖音帧失败：${(err as Error).message}`);
        continue;
      }
      for (const out of outputs) {
        try {
          if (out.type === 'event') listener.event(out.event);
          else if (out.type === 'stats') listener.stats(out.stats);
          else if (out.type === 'room' && out.title) listener.room({ platform: 'douyin', roomId: this.webRid, title: out.title });
        } catch (err) {
          this.log('warn', `交给下游时出错：${(err as Error).message}`);
        }
      }
    }
  }

  private startRoomRefresh(): void {
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.roomTimer = setInterval(() => {
      void (async () => {
        if (this.stopped) return;
        const room = await enterRoom(this.webRid, this.options.cookie);
        if (!room) return;
        this.room = room;
        this.ctx = { roomId: room.roomId, anchorId: room.anchorId ?? this.ctx.anchorId };
        this.announce(room);
      })().catch((err: Error) => this.log('warn', `刷新房间信息失败：${err.message}`));
    }, ROOM_REFRESH_MS);
  }

  private scheduleRetry(reason: string): void {
    this.bridge?.stop();
    this.bridge = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.pollTimer = this.roomTimer = null;
    if (this.stopped) return;
    this.log('warn', `抖音直播：${reason}，${this.backoffMs / 1000}s 后重连`);
    this.listener?.state('reconnecting', { error: reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err: Error) => this.scheduleRetry(`重连失败：${err.message}`));
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}
