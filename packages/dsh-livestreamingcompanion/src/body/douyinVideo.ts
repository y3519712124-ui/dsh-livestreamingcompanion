/**
 * 抖音视频：按分享链接 / 视频 id 看详情、拿可播放地址。
 *
 * 为什么不直接打接口（2026-10 实测）：
 * - `www.douyin.com/aweme/v1/web/aweme/detail/` 从 Node 直连返回 403
 *   `Blocked by ArgusSecurityPlugin Uifid Not Found`；`iesdouyin` 的 iteminfo 已经空了。
 * - 但真 Chrome 打开视频页时，页面自己会发这个请求（带 UIFID + a_bogus），拿得到完整 JSON。
 *
 * 所以走浏览器桥：打开 `www.douyin.com/video/<id>`，把页面自己那次 `aweme/detail` 的响应截下来。
 * 页面里也不点任何东西，只读。
 */

import { BrowserBridge } from '../core/platforms/douyin/douyinBridge';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface DouyinVideo {
  awemeId: string;
  title: string;
  author: string;
  authorId: string;
  durationSec: number;
  /** 可播放地址（无水印的那条） */
  playUrl: string | null;
  cover?: string;
  publishedAt?: string;
  stats: { likes: number; comments: number; shares: number; collects: number };
  /** 官方字幕文件的地址（作者上传了才有） */
  captionUrl?: string;
  tags: string[];
}

/** 19~20 位数字、/video/<id>、带 modal_id= 的链接都认 */
export function parseDouyinVideo(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const direct = /(?:^|\D)(\d{18,20})(?:\D|$)/.exec(value)?.[1];
  if (direct) return direct;
  const path = /\/(?:video|note)\/(\d{18,20})/.exec(value)?.[1];
  if (path) return path;
  const modal = /[?&]modal_id=(\d{18,20})/.exec(value)?.[1];
  return modal ?? null;
}

/** 分享短链（v.douyin.com/xxx）→ 视频 id */
export async function resolveDouyinShare(text: string): Promise<string | null> {
  const direct = parseDouyinVideo(text);
  if (direct) return direct;
  const short = /(?:https?:\/\/)?v\.douyin\.com\/[\w-]+/.exec(text)?.[0];
  if (!short) return null;
  try {
    const res = await fetch(short.startsWith('http') ? short : `https://${short}`, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12_000),
    });
    return parseDouyinVideo(res.headers.get('location') ?? '');
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function text(value: unknown, max = 300): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 无水印：老链接里是 playwm，换成 play；新接口给的本来就是干净的，原样用 */
function cleanPlayUrl(url: string): string {
  return url.replace('/playwm/', '/play/').replace(/^http:/, 'https:');
}

function bestPlayUrl(detail: Record<string, any>): string | null {
  const video = detail.video ?? {};
  const bitRates: any[] = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  const candidates = [
    ...bitRates.map((b) => b?.play_addr?.url_list?.[0]),
    video.play_addr?.url_list?.[0],
    video.play_addr_h264?.url_list?.[0],
    video.download_addr?.url_list?.[0],
  ].filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
  return candidates.length ? cleanPlayUrl(candidates[0]) : null;
}

export function toVideo(detail: Record<string, any>): DouyinVideo | null {
  const awemeId = String(detail.aweme_id ?? '');
  if (!awemeId) return null;
  const stats = detail.statistics ?? {};
  const author = detail.author ?? {};
  const captions: any[] = Array.isArray(detail.video?.cla_info?.caption_infos) ? detail.video.cla_info.caption_infos : [];
  const captionUrl = captions.map((c) => c?.url).find((u): u is string => typeof u === 'string');
  const tags = [...text(detail.desc ?? '', 600).matchAll(/#(\S+)/g)].map((m) => m[1]).slice(0, 8);
  return {
    awemeId,
    title: text(detail.desc ?? '', 120) || '（没有标题）',
    author: text(author.nickname ?? '', 30),
    authorId: String(author.sec_uid ?? author.uid ?? ''),
    // duration 是毫秒
    durationSec: Math.round(num(detail.video?.duration) / 1000),
    playUrl: bestPlayUrl(detail),
    ...(detail.video?.cover?.url_list?.[0] ? { cover: String(detail.video.cover.url_list[0]) } : {}),
    ...(detail.create_time ? { publishedAt: new Date(num(detail.create_time) * 1000).toISOString().slice(0, 10) } : {}),
    stats: {
      likes: num(stats.digg_count),
      comments: num(stats.comment_count),
      shares: num(stats.share_count),
      collects: num(stats.collect_count),
    },
    ...(captionUrl ? { captionUrl } : {}),
    tags,
  };
}

// ── 搜索 ────────────────────────────────────────────

export type DouyinOrder = 'relevance' | 'newest' | 'likes';

/** 搜索给她的候选（比详情轻：只要挑得动就行） */
export interface DouyinHit {
  awemeId: string;
  title: string;
  author: string;
  authorId: string;
  durationSec: number;
  likes: number;
  cover?: string;
  publishedAt?: string;
}

export type DouyinSearch =
  | { hits: DouyinHit[]; via: 'http' | 'page' }
  | { error: 'login' | 'blocked' | 'empty'; message: string };

const SORT: Record<DouyinOrder, string> = { relevance: '0', newest: '1', likes: '2' };

const SEARCH_URL = 'https://www.douyin.com/aweme/v1/web/general/search/single/';

/** 和网页搜索页自己发的一模一样（少一个参数就可能被当成异常流量） */
export function searchQuery(keyword: string, page = 1, order: DouyinOrder = 'relevance'): string {
  const count = 12;
  return new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    search_channel: 'aweme_video_web',
    keyword,
    search_source: 'tab_search',
    query_correct_type: '1',
    is_filter_search: '0',
    from_group_id: '',
    offset: String(Math.max(0, (page - 1) * count)),
    count: String(count),
    sort_type: SORT[order],
    publish_time: '0',
    pc_client_type: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '130.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    platform: 'PC',
  }).toString();
}

/** 一条搜索结果的候选；非视频（用户、直播、话题）跳过 */
export function hitOf(item: Record<string, any>): DouyinHit | null {
  const aweme = item?.aweme_info ?? item?.aweme_mix_info?.aweme_list?.[0] ?? null;
  const awemeId = String(aweme?.aweme_id ?? '');
  if (!awemeId) return null;
  const stats = aweme.statistics ?? {};
  return {
    awemeId,
    title: text(aweme.desc ?? '', 80) || '（没有标题）',
    author: text(aweme.author?.nickname ?? '', 24),
    authorId: String(aweme.author?.sec_uid ?? aweme.author?.uid ?? ''),
    durationSec: Math.round(num(aweme.video?.duration) / 1000),
    likes: num(stats.digg_count),
    ...(aweme.video?.cover?.url_list?.[0] ? { cover: String(aweme.video.cover.url_list[0]) } : {}),
    ...(aweme.create_time ? { publishedAt: new Date(num(aweme.create_time) * 1000).toISOString().slice(0, 10) } : {}),
  };
}

export function parseSearch(json: unknown): DouyinHit[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const hits: DouyinHit[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const hit = hitOf(item as Record<string, any>);
    if (hit) hits.push(hit);
  }
  return hits;
}

type HttpSearch = { kind: 'ok'; hits: DouyinHit[] } | { kind: 'login' } | { kind: 'status'; message: string } | { kind: 'failed' };

/** Node 直连搜索接口（带登录 Cookie） */
async function searchHttp(keyword: string, cookie: string, options: { page?: number; order?: DouyinOrder } = {}): Promise<HttpSearch> {
  try {
    const res = await fetch(`${SEARCH_URL}?${searchQuery(keyword, options.page ?? 1, options.order ?? 'relevance')}`, {
      headers: {
        'User-Agent': UA,
        Referer: `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`,
        Accept: 'application/json, text/plain, */*',
        Cookie: cookie.trim(),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 403) return { kind: 'failed' };
    const body = (await res.json().catch(() => null)) as { status_code?: number; status_msg?: string; data?: unknown } | null;
    if (!body) return { kind: 'failed' };
    if (body.status_code === 2483) return { kind: 'login' };
    if (body.status_code !== 0) return { kind: 'status', message: String(body.status_msg ?? `status_code ${body.status_code}`) };
    return { kind: 'ok', hits: parseSearch(body) };
  } catch {
    return { kind: 'failed' };
  }
}

export function douyinSearchText(query: string, result: DouyinSearch, options: { page?: number; order?: DouyinOrder } = {}): string {
  if ('error' in result) return result.message;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const where = `搜抖音「${query}」（${result.via === 'http' ? '接口直连' : '页面抓取'}，第 ${page} 页）`;
  if (!result.hits.length) return `${where}：一条也没搜到。换个说法，或者让观众发个链接。`;
  const lines = [`${where}：`];
  result.hits.forEach((hit, i) => {
    const meta = [hit.author ? `@${hit.author}` : '', hit.durationSec ? clock(hit.durationSec) : '', hit.likes ? `${count(hit.likes)}赞` : '', hit.publishedAt ?? ''].filter(Boolean).join('，');
    lines.push(`${i + 1}. ${hit.awemeId}「${hit.title}」${meta}`);
  });
  lines.push('', '要看哪条：douyin_video 或 play_douyin_video 填那个 19 位 id；换 order（relevance/newest/likes）或 page 再搜。');
  return lines.join('\n');
}

/** Cookie 体检：只看键名，不打印值 */
export interface CookieReport {
  count: number;
  names: string[];
  /** 有 sessionid / sessionid_ss / sid_tt 之一才算「登录过」 */
  hasSession: boolean;
  hasTtwid: boolean;
  hasOdinTt: boolean;
  length: number;
}

export function cookieReport(cookie: string): CookieReport {
  const names = cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.slice(0, Math.max(0, part.indexOf('='))).trim())
    .filter(Boolean);
  const has = (name: string) => names.some((n) => n === name);
  return {
    count: names.length,
    names,
    hasSession: has('sessionid') || has('sessionid_ss') || has('sid_tt'),
    hasTtwid: has('ttwid'),
    hasOdinTt: has('odin_tt'),
    length: cookie.length,
  };
}

export interface DouyinCheck {
  report: CookieReport;
  api: 'ok' | 'login' | 'blocked' | 'error' | 'none';
  message: string;
}

/** 这个播放地址现在还活着吗（取两个字节；抖音地址带时效，过一会儿就 403） */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/', Range: 'bytes=0-1' },
      signal: AbortSignal.timeout(8_000),
    });
    void res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export class DouyinVideos {
  constructor(
    private readonly makeBridge: () => BrowserBridge,
    /** 抖音 Cookie：搜索要登录态（详情不登录也能截页面） */
    private readonly cookie: () => Promise<string> = async () => '',
  ) {}

  async info(awemeId: string): Promise<DouyinVideo | null> {
    const bridge = this.makeBridge();
    const cookie = await this.cookie().catch(() => '');
    try {
      const json = (await bridge.captureJson(`https://www.douyin.com/video/${awemeId}`, /aweme\/v1\/web\/aweme\/detail/, 25_000, cookie)) as
        | { aweme_detail?: Record<string, any> }
        | null;
      const detail = json?.aweme_detail;
      return detail ? toVideo(detail) : null;
    } catch {
      // 桥超时/页面没给：当成「这条打不开」，不要往上抛（抛出去会让工具报错、更糟的是没人接就崩宿主）
      return null;
    } finally {
      bridge.stop();
    }
  }

  /**
   * 播放地址（放舞台用；舞台服务器会带抖音的 Referer 转发）。
   * 抖音的播放地址带时效签名：先探一下（Range 取两个字节），死了就重新取一次详情。
   */
  async playUrl(awemeId: string): Promise<{ url: string; durationSec: number } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const info = await this.info(awemeId);
      if (!info?.playUrl) return null;
      if (await reachable(info.playUrl)) return { url: info.playUrl, durationSec: info.durationSec };
    }
    return null;
  }

  /**
   * 搜视频。两条路：
   * 1) Node 直连搜索接口（快，~0.3s）：要登录 Cookie，抖音只对登录用户开搜索；
   * 2) 页面里搜（慢，~6s，稳）：浏览器带着 Cookie 打开搜索页，截页面自己那次请求的响应。
   *
   * 顺序：先在本地看一眼 Cookie 里有没有 sessionid（没有就不用浪费一次浏览器），
   * 然后再试接口；接口说没登录/被拦，仍然去页面试一次（页面的请求是它自己签的，
   * 有时接口判的和页面判的不一样）。
   */
  async search(query: string, options: { page?: number; order?: DouyinOrder } = {}): Promise<DouyinSearch> {
    const keyword = query.trim();
    if (!keyword) return { error: 'empty', message: '搜什么？给个关键词。' };
    const cookie = await this.cookie().catch(() => '');
    const report = cookieReport(cookie);
    if (!report.count) {
      return {
        error: 'login',
        message: '抖音的搜索只对登录用户开放（未登录时接口固定返回「请先登录，再继续搜索吧」）。'
          + '设置 → 密钥 →「用浏览器登录抖音」，或者手填一条完整 Cookie，再搜。',
      };
    }
    if (!report.hasSession) {
      return {
        error: 'login',
        message: `这个抖音 Cookie 里没有 sessionid（现在只有：${report.names.slice(0, 10).join('、') || '空'}），所以抖音当你是没登录的游客。`
          + '要的不是 ttwid 那串匿名 Cookie：在浏览器里登录抖音之后，复制整条（含 sessionid / sid_tt）。点「用浏览器登录抖音」最省事。',
      };
    }
    const page = Math.max(1, Math.floor(options.page ?? 1));

    const direct = await searchHttp(keyword, cookie, { page, order: options.order });
    if (direct.kind === 'ok') return { hits: direct.hits, via: 'http' };

    // 接口这条路没成（没登录 / 被拦 / 空）：页面的请求是它自己签的，再试一次
    const viaPage = await this.searchInPage(keyword, cookie);
    if ('hits' in viaPage) return { hits: viaPage.hits, via: 'page' };
    if (viaPage.reason === 'captcha') {
      return {
        error: 'blocked',
        message: '抖音卡在验证码中间页：先用你自己的浏览器打开抖音搜一次、把验证码过掉（同一个网络、同一个账号），再让我搜。',
      };
    }
    if (viaPage.reason === 'login' || direct.kind === 'login') {
      return {
        error: 'login',
        message: `Cookie 里有 sessionid，但抖音两边都判成未登录（接口回「${direct.kind === 'login' ? '请先登录' : '非登录态'}」，页面上也是登录提示）。`
          + '多半是这条 sessionid 过期了，或者复制时被截断。重新点一次「用浏览器登录抖音」。',
      };
    }
    return {
      error: 'blocked',
      message: `抖音搜索没给结果（接口这条路回了「${direct.kind === 'status' ? direct.message : '异常'}」，页面那条也没截到响应）。`
        + '可能是这个网络/IP 被限流，过一会儿再试；急的话让观众直接发视频链接。',
    };
  }

  /** 检查登录态：Cookie 里有什么（只看键名）+ 接口一测。控制台「检查抖音登录态」用 */
  async check(): Promise<DouyinCheck> {
    return this.verify(await this.cookie().catch(() => ''));
  }

  /** 用这条 Cookie 验一遍登录态（登录流程存之前先验，别把废 Cookie 存进去还报成功） */
  async verify(cookie: string): Promise<DouyinCheck> {
    const report = cookieReport(cookie);
    if (!report.count) return { report, api: 'none', message: '还没有抖音 Cookie' };
    const probe = await searchHttp('猫', cookie, {});
    const api = probe.kind === 'ok' ? 'ok' : probe.kind === 'login' ? 'login' : probe.kind === 'status' ? 'blocked' : 'error';
    const detail = probe.kind === 'status' ? probe.message : '';
    const message =
      api === 'ok'
        ? `登录态有效（${report.count} 个 Cookie，接口已确认）`
        : api === 'login'
          ? `接口判为未登录：${report.hasSession ? 'sessionid 可能已过期' : 'Cookie 里没有 sessionid'}`
          : api === 'blocked'
            ? `接口被拦：${detail}`
            : '接口请求失败（网络或风控）';
    return { report, api, message };
  }

  /** 页面兜底：带 Cookie 打开搜索页，截页面自己那次 general/search/single 的响应 */
  private async searchInPage(keyword: string, cookie: string): Promise<{ hits: DouyinHit[] } | { reason: 'captcha' | 'login' | 'timeout' }> {
    const bridge = this.makeBridge();
    let reason: 'captcha' | 'login' | null = null;
    const startedAt = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
      const json = (await bridge.captureJson(url, /general\/search\/single/, 20_000, cookie, async () => {
        // 登录页/验证码页/什么都没渲染出来时别干等满超时：每秒半看一眼
        const probe = bridge
          .evaluate<string>(`JSON.stringify({ t: document.title, b: document.body.innerText.slice(0, 300), n: document.querySelectorAll('a[href*="/video/"]').length })`)
          .catch(() => null);
        const raw = await Promise.race([probe, sleep(1200).then(() => null)]);
        const waited = Date.now() - startedAt;
        if (!raw) {
          // 页面还在加载：等它
          return waited > 15_000 ? 'timeout' : null;
        }
        const { t, b, n } = JSON.parse(raw) as { t?: string; b?: string; n?: number };
        const text = `${t ?? ''}\n${b ?? ''}`;
        if (/验证码|安全验证/.test(text)) {
          reason = 'captcha';
          return 'captcha';
        }
        if (/扫码登录|请先登录|登录后查看更多/.test(text)) {
          reason = 'login';
          return 'login';
        }
        // 10 秒了页面上一条视频链接都没有：这条网络下大概率被挡
        return waited > 10_000 && !n ? 'timeout' : null;
      })) as Record<string, any> | null;
      const hits = parseSearch(json);
      return hits.length ? { hits } : { reason: reason ?? 'timeout' };
    } catch {
      return { reason: reason ?? 'timeout' };
    } finally {
      bridge.stop();
    }
  }
}

// ── 写给她看 ────────────────────────────────────────

function count(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万` : String(n);
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}` : `${hms[1]}:${String(hms[2]).padStart(2, '0')}`;
}

export function douyinVideoText(v: DouyinVideo): string {
  const lines = [
    `「${v.title}」（抖音 ${v.awemeId}）`,
    `- 作者：${v.author}`,
    `- 时长 ${clock(v.durationSec)}${v.publishedAt ? `，${v.publishedAt} 发布` : ''}`,
    `- 点赞 ${count(v.stats.likes)}，评论 ${count(v.stats.comments)}，分享 ${count(v.stats.shares)}，收藏 ${count(v.stats.collects)}（抖音网页端不给播放量）`,
  ];
  if (v.tags.length) lines.push(`- 话题：${v.tags.join('、')}`);
  if (v.captionUrl) lines.push('- 这条有官方字幕，可以用字幕听内容（不然就靠 Whisper 听）。');
  if (!v.playUrl) lines.push('- 没拿到能放的地址：可能被限流了，过一会儿再试。');
  lines.push('', '要放给大家看用 play_douyin_video；只是想知道内容，这条就够。');
  return lines.join('\n');
}
