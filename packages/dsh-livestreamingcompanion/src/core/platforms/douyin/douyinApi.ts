/**
 * 抖音直播间的 HTTP 部分：房间号解析、进房拿房间信息。
 *
 * 实测（2026-10，Node 直连，只带 ttwid）：
 *   GET live.douyin.com/webcast/room/web/enter/?...&web_rid=<web_rid>  → status_code 0，
 *   data.data[0] 里有 id_str / status(2=直播中) / title / user_count_str，data.user 是匿名观众身份。
 *   不带 a_bogus 也能拿到房间信息；观众名字/uid 要登录才不被打码（本机只读，不登录）。
 *
 * 抖音的 room_id 是 19 位（>2^53）：代码里一律当字符串，别转 number。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;

export interface DouyinRoom {
  roomId: string;
  /** 2 = 直播中，4 = 已结束（抖音自己的约定） */
  status: number;
  live: boolean;
  title: string;
  anchorName?: string;
  anchorId?: string;
  avatar?: string;
  online?: number;
  /** 本场看过（RoomUserSeq 才有，进房接口一般没有） */
  watched?: number;
}

/** 直播间输入：纯数字、live.douyin.com/<数字>、带 web_rid= 的链接都认 */
export function parseDouyinRoom(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  const explicit = /[?&]web_rid=(\d{3,})/.exec(value)?.[1];
  if (explicit) return Number(explicit);
  const path = /live\.douyin\.com\/(\d{3,})/.exec(value)?.[1];
  if (path) return Number(path);
  const digits = /^(\d{3,})$/.exec(value)?.[1];
  return digits ? Number(digits) : null;
}

function cookieJar(cookie: string): string {
  return cookie.trim().replace(/;\s*$/, '');
}

/** 直播页给匿名访客的 ttwid（没有它，进房接口在有些网络下会返回空 body） */
export async function ensureTtwid(cookie: string): Promise<string> {
  if (/ttwid=/.test(cookie)) return cookieJar(cookie);
  try {
    const res = await fetch('https://live.douyin.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const ttwid = raw.map((line) => /^ttwid=([^;]+)/.exec(line)?.[1]).find(Boolean);
    void res.body?.cancel();
    return ttwid ? `${cookieJar(cookie)}${cookie ? '; ' : ''}ttwid=${ttwid}` : cookieJar(cookie);
  } catch {
    return cookieJar(cookie);
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function toRoom(room: Record<string, any>, anchor: Record<string, any> | undefined): DouyinRoom {
  const status = Number(room.status ?? 0);
  const avatarList = anchor?.avatar_thumb?.url_list;
  return {
    roomId: String(room.id_str ?? room.id ?? ''),
    status,
    live: status === 2,
    title: String(room.title ?? ''),
    ...(pickString(anchor?.nickname) ? { anchorName: String(anchor?.nickname) } : {}),
    ...(pickString(anchor?.id_str) ? { anchorId: String(anchor?.id_str) } : {}),
    ...(Array.isArray(avatarList) && typeof avatarList[0] === 'string' ? { avatar: avatarList[0] } : {}),
    ...(Number(room.user_count_str?.replace?.(/\D/g, '')) > 0 ? { online: Number(room.user_count_str.replace(/\D/g, '')) } : {}),
  };
}

export function enterUrl(webRid: number): string {
  return (
    'https://live.douyin.com/webcast/room/web/enter/?' +
    new URLSearchParams({
      aid: '6383',
      app_name: 'douyin_web',
      live_id: '1',
      device_platform: 'web',
      language: 'zh-CN',
      enter_from: 'web_live',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '130.0.0.0',
      web_rid: String(webRid),
    }).toString()
  );
}

/** 进房拿房间信息（Node 直连；被风控时返回 null，交给浏览器桥） */
export async function enterRoom(webRid: number, cookie: string): Promise<DouyinRoom | null> {
  try {
    const jar = await ensureTtwid(cookie);
    const res = await fetch(enterUrl(webRid), {
      headers: {
        'User-Agent': UA,
        Referer: `https://live.douyin.com/${webRid}`,
        Accept: 'application/json',
        ...(jar ? { Cookie: jar } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status_code?: number; data?: { data?: Array<Record<string, any>>; user?: Record<string, any> } };
    const room = body.data?.data?.[0];
    if (body.status_code !== 0 || !room) return null;
    const anchor = (room.owner as Record<string, any> | undefined) ?? undefined;
    const parsed = toRoom(room, anchor);
    // 进房接口对「已结束」的房间不给 owner：拿页面上的人名兜底
    if (!parsed.anchorName) {
      const name = await anchorFromHtml(webRid, jar);
      if (name) parsed.anchorName = name;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 直播页 SSR 里的人名（进房接口不给 owner 时补一下） */
async function anchorFromHtml(webRid: number, cookie: string): Promise<string | null> {
  try {
    const res = await fetch(`https://live.douyin.com/${webRid}`, {
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const store = /"roomStore":(\{.*?"roomInfo":\{.*?\}\})/.exec(html)?.[1];
    if (store) {
      try {
        const info = JSON.parse(store)?.roomInfo;
        const name = info?.anchor?.nickname ?? info?.owner?.nickname;
        if (typeof name === 'string' && name) return name;
      } catch {
        /* 继续用正则 */
      }
    }
    const alt = /"nickname":"([^"]{1,40}"?)/.exec(html)?.[1];
    return typeof alt === 'string' && alt ? alt : null;
  } catch {
    return null;
  }
}
