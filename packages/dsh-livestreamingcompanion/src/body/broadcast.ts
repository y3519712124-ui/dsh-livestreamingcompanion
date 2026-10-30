/**
 * 推流到 B 站：开播拿推流码 → OBS 推流 → 下播。和「彩排」分开：只有主人开了「推流到 B 站」才走这里。
 *
 *   start()   账号没有直播间就开通 → 开播（直播姬签名）→ 要人脸认证就停在 face，等主人用 B 站 App 扫码 →
 *             认证过了自动再开播 → 拿到推流码交给 OBS（专用配置、舞台页当浏览器源）→ 确认推上了
 *   stop()    OBS 停推 → B 站下播
 *
 * 状态给控制台看：哪一步、二维码、OBS 的码率和丢帧。
 */

import { BiliRoom, sameCover, type ProbeResult, type Stream } from './biliRoom';
import { normalizePushServer } from '../core/push/platforms';
import { connectObs, prepareObs, startStreaming, stopStreaming, streamHealth, type Obs, type StreamHealth } from './obs';

export type BroadcastPhase = 'idle' | 'preparing' | 'face' | 'streaming' | 'stopping' | 'error';

export interface BroadcastStatus {
  phase: BroadcastPhase;
  /** 这一步在干什么（控制台显示） */
  step: string;
  roomId: number | null;
  /** 人脸认证的二维码链接（phase = face） */
  faceQr: string | null;
  error: string | null;
  health: StreamHealth | null;
  startedAt: number | null;
  /** 这次用的推流协议 */
  protocol?: 'rtmp' | 'srt';
}

export interface BroadcastOptions {
  cookie(): Promise<string>;
  stageUrl(): string;
  /** 开播用的分区（子分区 id）；不给就用 B 站给这个账号准备的默认分区 */
  areaId(): number | null;
  title(): string | null;
  /** 推流协议：srt（有就用，跨境更稳）还是 rtmp */
  protocol(): 'srt' | 'rtmp';
  /** 推流码率（kbps） */
  kbps(): number;
  /**
   * 手动推流码（可选）：B 站接口回 60043 风控时，用直播姬「第三方推流」给的那对地址+推流码，
   * 直接推，不再调 startLive。返回 null 表示没配，走正常开播接口。
   */
  manualStream?(): Stream | null;
  /** 直播间封面（没设就不换）；和直播间现在的封面是同一张就不再传（封面每换一次都要重新审核） */
  cover(): { data: Uint8Array; mime: string } | null;
  /** 开通了直播间：记下房间号（身体连弹幕、标成自己的直播间） */
  onRoom(roomId: number): void;
  /** 开始推流了（开播推上、或者插件重启后接上）：这一场不是彩排 */
  onStreaming?(): void;
  log?(level: 'info' | 'warn', message: string): void;
}

const FACE_TIMEOUT_MS = 5 * 60_000;

export interface PreflightStep {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  verdict: string;
  /** 能不能直接点开播就上 */
  canStart: boolean;
  steps: PreflightStep[];
  /** 需要人脸认证时给二维码 */
  qr?: string;
}

export class Broadcast {
  private state: BroadcastStatus = { phase: 'idle', step: '', roomId: null, faceQr: null, error: null, health: null, startedAt: null };
  private obs: Obs | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private cancelled = false;

  constructor(private readonly options: BroadcastOptions) {}

  status(): BroadcastStatus {
    return { ...this.state };
  }

  /**
   * 接口探测：把「开播」这件事用几种请求形状各试一次，看哪种 B 站放行。
   * 60043 的返回里 need_face_auth=false、qr 为空，说明不是人脸，更像请求形状/签名问题，用这个找答案。
   */
  async probe(): Promise<{ roomId: number; areaId: number; results: ProbeResult[] }> {
    const cookie = await this.options.cookie();
    if (!cookie) throw new Error('还没有 B 站 Cookie');
    const room = new BiliRoom(cookie);
    const roomId = await room.ensureRoom();
    const pre = await room.preLive();
    const areaId = this.options.areaId() ?? pre.areaId;
    const results = await room.probe(roomId, areaId);
    return { roomId, areaId, results };
  }

  /**
   * 开播前自检：登录 → 直播间 → 分区 → **真的试一次 startLive**（拿到推流码就说明实名/风控都过了），
   * 拿到码后立刻下播，不留一场空直播。区分三种失败：60043（实名/开播人认证）、60024（要人脸）、其它。
   */
  async preflight(): Promise<PreflightResult> {
    const steps: PreflightStep[] = [];
    const add = (key: string, label: string, ok: boolean, detail: string) => { steps.push({ key, label, ok, detail }); };
    try {
      if (this.streaming) return { verdict: '正在推流，先下播再做自检', canStart: true, steps };
      const cookie = await this.options.cookie();
      if (!cookie) {
        add('cookie', 'B 站 Cookie', false, '没配开播账号的 Cookie');
        return { verdict: '没有 B 站 Cookie', canStart: false, steps };
      }
      const room = new BiliRoom(cookie);
      const me = await room.whoami();
      add('login', 'B 站登录', me.loggedIn, me.loggedIn ? `${me.name}（UID ${me.uid}）` : 'Cookie 失效，重新登录');
      if (!me.loggedIn) return { verdict: 'Cookie 失效', canStart: false, steps };

      const roomId = await room.ensureRoom();
      add('room', '直播间', true, `房间 ${roomId}`);
      const pre = await room.preLive();
      const areaId = this.options.areaId() ?? pre.areaId;
      add('area', '直播分区', !!areaId, areaId ? `${pre.areaName || areaId}` : '没有可用分区，去控制台填一个');

      const result = await room.start(roomId, areaId);
      if (result.kind === 'live') {
        add('start', '接口开播', true, 'B 站放行（已拿到推流码，实名/风控都过了）');
        try {
          await room.stop(roomId);
          add('cleanup', '自检后下播', true, '已立刻下播，直播间回到未开播');
        } catch (err) {
          add('cleanup', '自检后下播', false, `下播没成功：${(err as Error).message}（去直播间手动关一下）`);
        }
        return { verdict: '可以开播：点「开播」就行', canStart: true, steps };
      }
      if (result.kind === 'verify') {
        add('start', '接口开播', false, `60043：${result.message}`);
        if (result.data) {
          let raw = '';
          try {
            raw = JSON.stringify(result.data).slice(0, 400);
          } catch {
            raw = String(result.data).slice(0, 400);
          }
          add('raw', 'B 站原始返回', true, raw || '(空)');
        }
        add('fix', '怎么修', true,
          '这是 B 站的开播身份核验（不是账号实名）：打开直播姬点一次「开始直播」，它会弹人脸二维码，扫码通过后立刻结束直播；'
          + '回来再点「开播」或「自检」。仍然被拒就改用「B 站拒绝接口开播？用直播姬的推流码开」那条。');
        return { verdict: 'B 站要求开播身份核验（60043）：先用直播姬扫一次人脸，或用直播姬推流码开播', canStart: false, steps };
      }
      add('start', '接口开播', false, `60024：${result.message}`);
      add('fix', '怎么修', true, '点「开播」，用 B 站 App 扫弹出的二维码做人脸认证');
      return { verdict: '需要人脸认证（点开播，扫码）', canStart: false, steps, qr: result.qr };
    } catch (err) {
      add('error', '自检', false, (err as Error).message);
      return { verdict: (err as Error).message, canStart: false, steps };
    }
  }

  get streaming(): boolean {
    return this.state.phase === 'streaming';
  }

  private set(patch: Partial<BroadcastStatus>): void {
    const was = this.state.phase;
    this.state = { ...this.state, ...patch };
    if (this.state.phase === 'streaming' && was !== 'streaming') this.options.onStreaming?.();
    if (patch.step) this.options.log?.('info', `推流：${patch.step}`);
  }

  /** 开播并推流；在后台跑，进度看 status()。已经在跑就什么也不做 */
  start(): void {
    if (this.state.phase === 'preparing' || this.state.phase === 'face' || this.state.phase === 'streaming') return;
    this.cancelled = false;
    this.set({ phase: 'preparing', step: '检查 B 站登录', faceQr: null, error: null, health: null });
    void this.run().catch((err) => {
      this.set({ phase: 'error', step: '', faceQr: null, error: (err as Error).message });
      this.options.log?.('warn', `推流失败：${(err as Error).message}`);
    });
  }

  private async run(): Promise<void> {
    const cookie = await this.options.cookie();
    if (!cookie) throw new Error('还没有 B 站 Cookie：在设置里填上开播账号的 Cookie');
    const room = new BiliRoom(cookie);
    const me = await room.whoami();
    if (!me.loggedIn) throw new Error('B 站 Cookie 失效了：重新登录 B 站，复制新的 Cookie 填到设置里');

    this.set({ step: '准备直播间' });
    const roomId = await room.ensureRoom();
    this.set({ roomId });
    this.options.onRoom(roomId);

    const pre = await room.preLive();
    const areaId = this.options.areaId() ?? pre.areaId;
    if (!areaId) throw new Error('还没选直播分区');
    const title = this.options.title();
    if (title) await room.update(roomId, { title });
    const cover = this.options.cover();
    if (cover && !sameCover(pre.coverUrl, cover.data)) {
      this.set({ step: '换直播间封面' });
      await room.setCover(cover.data, cover.mime);
    }

    this.set({ step: '向 B 站申请开播' });
    let stream: Stream | null = null;
    const manual = this.options.manualStream?.() ?? null;
    if (manual) {
      // 主人自己填了推流码：不调 startLive，绕开 60043 风控（B 站那边照样能收到推流）
      stream = manual;
      this.set({ step: '用你填的推流码开播（跳过 B 站接口）', protocol: manual.protocol });
    }
    const deadline = Date.now() + FACE_TIMEOUT_MS;
    const toStream = (r: Extract<Awaited<ReturnType<typeof room.start>>, { kind: 'live' }>) => {
      // B 站给 SRT 地址时会写成 rtmpsrt://…（OBS 不认，会报 Unknown protocol! 然后无限重连），
      // 而且只有地址真是 srt:// 才用 SRT，否则一律按 RTMP 给 OBS。
      const raw = this.options.protocol() === 'srt' && r.srt ? r.srt : r.stream;
      const addr = normalizePushServer(raw.addr);
      return { ...raw, addr, protocol: addr.startsWith('srt://') ? 'srt' : 'rtmp' } as Stream;
    };

    while (!stream) {
      if (this.cancelled) return;
      let result = await room.start(roomId, areaId);

      // 60043 + need_face_auth=false：B 站只允许「直播姬客户端」开播（探测里同时出现 60034「仅支持直播姬开播」）。
      // 换成旧版本号签名会进人脸分支并给出二维码——先拿二维码扫，扫完再用正常签名申请一次。
      if (result.kind === 'verify') {
        this.set({ step: '60043：换个签名版本再问一次 B 站要二维码' });
        const alt = await room.startOld(roomId, areaId);
        if (alt.kind === 'live') {
          stream = toStream(alt);
          break;
        }
        if (alt.kind !== 'face') {
          throw new Error(
            `B 站的接口开播被拦了（60043：${result.message}；探测另见 60034「系统维护仅支持直播姬开播」）。`
            + '这说明这个账号此刻只允许在直播姬里点开播。两个办法：'
            + '① 在直播姬里点「开始直播」开一次、再结束，然后回来重试；'
            + '② 直接在「推流到 B 站」下面填直播姬 → 第三方推流给的「推流地址 + 推流码」，走手动推流。',
          );
        }
        result = alt;
      }

      if (result.kind === 'live') {
        stream = toStream(result);
        break;
      }

      // 人脸认证：等主人用 B 站 App 扫码，认证过了再用正常签名申请一次
      this.set({ phase: 'face', step: '等你用 B 站 App 扫码做人脸认证', faceQr: result.qr });
      while (!(await room.faceVerified(roomId))) {
        if (this.cancelled) return;
        if (Date.now() > deadline) throw new Error('人脸认证等了 5 分钟还没完成，重新点开播再试');
        await new Promise((r) => setTimeout(r, 2000));
      }
      this.set({ phase: 'preparing', step: '认证通过，再申请开播', faceQr: null });
      const afterFace = await room.start(roomId, areaId);
      if (afterFace.kind === 'live') {
        stream = toStream(afterFace);
        break;
      }
      const afterFaceOld = await room.startOld(roomId, areaId);
      if (afterFaceOld.kind === 'live') {
        stream = toStream(afterFaceOld);
        break;
      }
      throw new Error('人脸认证过了但 B 站还是不给推流码：用「推流到 B 站」里的手动推流码这条路');
    }

    this.set({ step: '打开 OBS、设好画质' });
    this.obs = await connectObs(true);
    await prepareObs(this.obs, this.options.stageUrl(), this.options.kbps());
    this.set({ step: `开始推流（${stream.protocol.toUpperCase()}，${this.options.kbps()} kbps）`, protocol: stream.protocol });
    await startStreaming(this.obs, stream.addr, stream.code);
    this.set({ phase: 'streaming', step: '推流中', startedAt: Date.now() });
    this.healthTimer = setInterval(() => void this.poll(), 2000);
  }

  private async poll(): Promise<void> {
    if (!this.obs) return;
    try {
      const health = await streamHealth(this.obs);
      this.set({ health });
      if (!health.active && this.state.phase === 'streaming') this.set({ phase: 'error', error: 'OBS 停止推流了（看 OBS 的日志）' });
    } catch (err) {
      this.set({ error: `读不到 OBS 状态：${(err as Error).message}` });
    }
  }

  /**
   * 插件重启前就在推流（OBS 是单独的进程，一直推着）：接上它，不重新开播。
   * OBS 没在推了返回 false
   */
  async adopt(roomId: number): Promise<boolean> {
    if (this.state.phase === 'streaming') return true;
    try {
      const obs = await connectObs(false);
      const health = await streamHealth(obs);
      if (!health.active) { obs.close(); return false; }
      this.obs = obs;
      this.cancelled = false;
      this.set({ phase: 'streaming', step: '推流中（插件重启后接上）', roomId, faceQr: null, error: null, health, startedAt: Date.now() });
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => void this.poll(), 2000);
      return true;
    } catch {
      return false;
    }
  }

  /** 停推、下播 */
  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const roomId = this.state.roomId;
    this.set({ phase: 'stopping', step: '停止推流、下播', faceQr: null });
    const errors: string[] = [];
    try {
      const obs = this.obs ?? await connectObs(false);
      await stopStreaming(obs);
      obs.close();
    } catch (err) {
      errors.push(`OBS：${(err as Error).message}`);
    }
    this.obs = null;
    if (roomId) {
      try {
        const cookie = await this.options.cookie();
        await new BiliRoom(cookie).stop(roomId);
      } catch (err) {
        errors.push(`B 站：${(err as Error).message}`);
      }
    }
    this.set({ phase: errors.length ? 'error' : 'idle', step: '', error: errors.length ? `下播时出错：${errors.join('；')}` : null, health: null, startedAt: null });
  }
}
