// 直播值班：跟 DSH 跑在同一台机器上，没人看着时替你盯一场直播。不属于插件，单独一个进程。
//
//   记录   舞台上的每件事（弹幕、进场、礼物、她说的话、工具、视频）、每 30 秒推流健康、每分钟 B 站直播间状态、
//          每 2 分钟她动没动 → <输出目录>/events-*.jsonl、health-*.jsonl；它自己做过的事 → guard-*.jsonl；当前汇总 → status.json
//   发现   DSH 挂了、推流断了、直播间掉线、丢帧多、她的会话掉线、6 分钟不说话 → 写进 status.json 的 problems（只记不修）
//   冻住   她的脸连续两次一动不动、她这会儿没在说话、离上次超过 10 分钟 → 让 OBS 刷新舞台页（舞台自己有自愈，这是保底）
//   下播   到了 --end / --hours 的时间 → 控制台下播（她先道别），推流停了再停 OBS 录像，然后退出
//   回关   加 --follow-back 才做：有人关注就用开播账号回关（默认不做：她有 follow 工具，回不回她自己定）
//
// 用法（在 DSH 那台机器上）：node live-guard.mjs [--home <DSH_HOME>] [--plugin <插件包目录>] [--port 3092]
//                                              [--hours 6 | --end 04:30] [--follow-back] [--out <输出目录>]
//   --home 默认环境变量 DSH_HOME；--plugin 默认 <home>/../packages/dsh-livestreamingcompanion；--end 是这台机器的本地时间，过了就是明天
// 从开发机启动到推流服务器：bash tools/start-guard.sh --hours 6
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connectObs, type Obs } from '../packages/dsh-livestreamingcompanion/src/body/obs';

// ── 参数 ──
const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const HOME = resolve(arg('home') ?? process.env.DSH_HOME ?? '.dsh-home');
const PLUGIN = resolve(arg('plugin') ?? join(dirname(HOME), 'packages', 'dsh-livestreamingcompanion'));
const PORT = Number(arg('port') ?? 3092);
const FOLLOW_BACK = argv.includes('--follow-back');
const out = resolve(arg('out') ?? join(HOME, 'dsh-livestreamingcompanion', 'monitor'));
const endAt = (() => {
  const hours = Number(arg('hours'));
  if (hours > 0) return Date.now() + hours * 3600_000;
  const end = arg('end');
  if (!end) return 0;
  const [h, m] = end.split(':').map(Number);
  const at = new Date();
  at.setHours(h, m || 0, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.getTime();
})();

mkdirSync(out, { recursive: true });
const settings = JSON.parse(readFileSync(join(HOME, 'dsh-livestreamingcompanion', 'settings.json'), 'utf8'));
const stage = `http://127.0.0.1:${settings.stagePort}/events?token=${settings.stageToken}&preview=1`;
const roomId = settings.roomId;
const started = Date.now();
const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
const eventsFile = join(out, `events-${stamp}.jsonl`);
const healthFile = join(out, `health-${stamp}.jsonl`);
const guardFile = join(out, `guard-${stamp}.jsonl`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const s = {
  startedAt: started, endAt, followBack: FOLLOW_BACK,
  sseConnected: false, sseDownSince: started as number | null,
  onAir: false, brain: 'off', brainDetail: '', media: false,
  lastSayAt: 0, says: 0, chats: 0, gifts: 0, enters: 0, tools: 0, videos: 0, tokens: 0,
  obs: null as null | { active: boolean; timecode: string; skipped: number; total: number; kbps: number; at: number },
  windowDrop: 0,
  room: null as null | { liveStatus: number; online?: number; at: number },
  frozenChecks: 0, refreshes: 0, followedBack: [] as string[], ending: '',
  problems: [] as string[],
};

const log = (file: string, row: unknown) => appendFileSync(file, JSON.stringify(row) + '\n');
const guard = (what: string, extra: Record<string, unknown> = {}) => log(guardFile, { at: Date.now(), what, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 她的脸在画面上的哪一块（按当前模板和角色包算，聊天布局、放视频布局各一块）──
type Box = [number, number, number, number];
function readJson(...candidates: string[]): any {
  for (const file of candidates) if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  return null;
}
function faceBoxes(): { chat: Box | null; video: Box | null } {
  const template = readJson(join(HOME, 'dsh-livestreamingcompanion', 'templates', settings.template, 'template.json'), join(PLUGIN, 'assets', 'templates', settings.template, 'template.json'));
  const character = readJson(join(HOME, 'dsh-livestreamingcompanion', 'characters', settings.character, 'character.json'), join(PLUGIN, 'assets', 'characters', settings.character, 'character.json'));
  const [cw, ch] = character?.clips?.size ?? character?.image?.size ?? [1, 1.75];
  const chat = template?.widgets?.find((w: any) => w.type === 'character');
  const videoPatch = template?.layouts?.video?.find((w: any) => w.type === 'character');
  // 角色挂件：x、y 是左上角，宽 w（不写就按 520），scale 整体缩放；脸和手大约在宽 30–78%、高 18–56% 那一块
  const box = (w: any): Box | null => {
    if (!w) return null;
    const width = (w.w ?? 520) * (w.scale ?? 1);
    const height = width * (ch / cw);
    return [w.x + width * 0.3, w.y + height * 0.18, w.x + width * 0.78, w.y + height * 0.56].map(Math.round) as Box;
  };
  return { chat: box(chat), video: box(chat && videoPatch ? { ...chat, ...videoPatch } : null) };
}
const faces = faceBoxes();

// ── 开播账号的 Cookie（DSH 凭据文件里折行的 YAML 字符串；只有回关用）──
function biliCookie(): string {
  const lines = readFileSync(join(HOME, '.credentials.yaml'), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+BILIBILI_COOKIE:/.test(l));
  if (at < 0) return '';
  const parts = [lines[at].replace(/^\s+BILIBILI_COOKIE:\s*/, '')];
  for (let i = at + 1; i < lines.length && /^\s{4,}\S/.test(lines[i]); i++) parts.push(lines[i].trim());
  return parts.join(' ');
}

// ── 舞台事件流 ──
async function sse(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(stage);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      s.sseConnected = true; s.sseDownSince = null;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* 坏行 */ }
        }
      }
    } catch { /* DSH 重启或挂了 */ }
    if (s.sseConnected) s.sseDownSince = Date.now();
    s.sseConnected = false;
    await sleep(3000);
  }
}

const followQueue: Array<{ uid: string; name: string }> = [];
function onEvent(e: any): void {
  const now = Date.now();
  if (e.type === 'hello') return log(eventsFile, { at: now, type: 'hello' });
  if (e.type === 'say') { s.says++; s.lastSayAt = now; delete e.audio; delete e.timeline; }
  if (e.type === 'room') s.onAir = !!e.onAir;
  if (e.type === 'brain') { s.brain = e.state; s.brainDetail = e.detail ?? ''; }
  if (e.type === 'usage') s.tokens = e.tokens ?? s.tokens;
  if (e.type === 'tool') s.tools++;
  if (e.type === 'media') { s.media = e.action === 'play'; if (e.action === 'play') s.videos++; }
  if (e.type === 'live') {
    const k = e.event?.kind;
    if (k === 'chat' && !e.isUpdate) s.chats++;
    if (k === 'gift' || k === 'superchat' || k === 'membership') s.gifts++;
    if (k === 'enter') s.enters++;
    if (FOLLOW_BACK && k === 'follow' && /^\d+$/.test(String(e.event.user?.id ?? ''))) followQueue.push({ uid: String(e.event.user.id), name: String(e.event.user.name) });
  }
  log(eventsFile, { at: now, ...e });
}

// ── 回关（--follow-back）──
async function followLoop(): Promise<void> {
  const done = new Set<string>();
  for (;;) {
    const next = followQueue.shift();
    if (!next) { await sleep(5000); continue; }
    if (done.has(next.uid)) continue;
    try {
      const cookie = biliCookie();
      const csrf = /bili_jct=([^;\s]+)/.exec(cookie)?.[1] ?? '';
      const H = { 'User-Agent': UA, Referer: 'https://space.bilibili.com/', Cookie: cookie };
      const rel = await (await fetch(`https://api.bilibili.com/x/web-interface/relation?mid=${next.uid}`, { headers: H })).json() as any;
      const mine = rel.data?.relation?.attribute;
      if (mine === 2 || mine === 6) { done.add(next.uid); guard('follow-skip', { ...next, reason: 'already following' }); continue; }
      const r = await (await fetch('https://api.bilibili.com/x/relation/modify', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ fid: next.uid, act: '1', re_src: '11', csrf }) })).json() as any;
      guard('follow-back', { ...next, code: r.code, message: r.message });
      if (r.code === 0) { done.add(next.uid); s.followedBack.push(next.name); }
    } catch (err) {
      guard('follow-error', { ...next, error: String((err as Error).message) });
    }
    await sleep(3000);
  }
}

// ── OBS：推流健康、冻住检测、刷新、停录像 ──
let obs: Obs | null = null;
async function withObs<T>(fn: (o: Obs) => Promise<T>): Promise<T | null> {
  try {
    obs ??= await connectObs(false);
    return await fn(obs);
  } catch (err) {
    try { obs?.close(); } catch { /* 已经断了 */ }
    obs = null;
    log(healthFile, { at: Date.now(), kind: 'obs-error', error: String((err as Error).message) });
    return null;
  }
}

let last: { skipped: number; total: number; bytes: number; at: number } | null = null;
async function obsTick(): Promise<void> {
  await withObs(async (o) => {
    const st = await o.call<any>('GetStreamStatus');
    const now = Date.now();
    const kbps = last && st.outputBytes >= last.bytes ? Math.round(((st.outputBytes - last.bytes) * 8) / Math.max(1, now - last.at)) : 0;
    s.windowDrop = last && st.outputTotalFrames > last.total ? (st.outputSkippedFrames - last.skipped) / (st.outputTotalFrames - last.total) : 0;
    last = { skipped: st.outputSkippedFrames, total: st.outputTotalFrames, bytes: st.outputBytes, at: now };
    s.obs = { active: st.outputActive, timecode: st.outputTimecode, skipped: st.outputSkippedFrames, total: st.outputTotalFrames, kbps, at: now };
    log(healthFile, { at: now, kind: 'obs', ...s.obs, windowDrop: s.windowDrop });
  });
}

/** 节目画面缩成 480×270 的 BMP，取一块区域的像素（BMP 没有压缩噪点：不动就是逐像素一样） */
async function region(o: Obs, box: Box): Promise<Uint8Array> {
  const shot = await o.call<{ imageData: string }>('GetSourceScreenshot', { sourceName: '直播', imageFormat: 'bmp', imageWidth: 480, imageHeight: 270 });
  const buf = Buffer.from(shot.imageData.split(',')[1], 'base64');
  const offset = buf.readUInt32LE(10), w = buf.readInt32LE(18), hRaw = buf.readInt32LE(22), bpp = buf.readUInt16LE(28) / 8;
  const h = Math.abs(hRaw), stride = Math.ceil((w * bpp) / 4) * 4;
  const [x0, y0, x1, y1] = box.map((v) => Math.round(v / 4));
  const px: number[] = [];
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const row = hRaw > 0 ? h - 1 - y : y;
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) for (let c = 0; c < 3; c++) px.push(buf[offset + row * stride + x * bpp + c]);
  }
  return Uint8Array.from(px);
}

let lastRefreshAt = 0;
async function freezeTick(): Promise<void> {
  const box = s.media ? faces.video : faces.chat;
  if (!s.onAir || !box) return;
  const diff = await withObs(async (o) => {
    const a = await region(o, box);
    await sleep(2000);
    const b = await region(o, box);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return a.length ? sum / a.length : null;
  });
  if (diff === null || diff === undefined) return;
  log(healthFile, { at: Date.now(), kind: 'character-motion', diff: Math.round(diff * 100) / 100, media: s.media });
  // 冻住时这块逐像素一模一样（0.00），动起来是几十
  s.frozenChecks = diff < 0.05 ? s.frozenChecks + 1 : 0;
  if (s.frozenChecks >= 2 && s.brain === 'listening' && Date.now() - lastRefreshAt > 10 * 60_000) {
    lastRefreshAt = Date.now();
    s.frozenChecks = 0;
    const sources = await withObs(async (o) => {
      const { inputs } = await o.call<{ inputs: Array<{ inputName: string }> }>('GetInputList', { inputKind: 'browser_source' });
      for (const i of inputs) await o.call('PressInputPropertiesButton', { inputName: i.inputName, propertyName: 'refreshnocache' });
      return inputs.length;
    });
    s.refreshes++;
    guard('stage-refresh', { reason: 'character frozen', diff, sources });
  }
}

// ── B 站直播间 ──
async function roomTick(): Promise<void> {
  if (!roomId) return;
  try {
    const j = await (await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) })).json() as any;
    s.room = { liveStatus: j.data?.live_status, online: j.data?.online, at: Date.now() };
    log(healthFile, { kind: 'room', ...s.room });
  } catch (err) {
    log(healthFile, { at: Date.now(), kind: 'room-error', error: String((err as Error).message) });
  }
}

// ── 到点下播：控制台的下播接口（web.log 里的令牌换登录 cookie）──
async function dshCookie(): Promise<string> {
  const line = readFileSync(join(HOME, 'web.log'), 'utf8').split('\n').reverse().find((l) => l.includes('token=')) ?? '';
  const token = /token=([A-Za-z0-9_-]+)/.exec(line)?.[1] ?? '';
  const home = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`, { redirect: 'manual' });
  return home.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function endShow(): Promise<void> {
  s.ending = 'offair requested';
  guard('end-start', { endAt });
  try {
    const cookie = await dshCookie();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/dsh-livestreamingcompanion/offair`, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{}' });
    guard('offair', { status: r.status });
  } catch (err) {
    guard('offair-error', { error: String((err as Error).message) });
  }
  // 等她道别、推流停下（最多 6 分钟）
  for (let i = 0; i < 72; i++) {
    await sleep(5000);
    const active = await withObs(async (o) => (await o.call<any>('GetStreamStatus')).outputActive as boolean);
    if (!s.onAir && active === false) break;
  }
  const record = await withObs(async (o) => {
    const rec = await o.call<any>('GetRecordStatus');
    if (!rec.outputActive) return 'not recording';
    return (await o.call<{ outputPath: string }>('StopRecord')).outputPath;
  });
  const stream = await withObs(async (o) => (await o.call<any>('GetStreamStatus')).outputActive);
  s.ending = `done: record ${record}, stream active ${stream}`;
  guard('end-done', { record, streamActive: stream, onAir: s.onAir });
  judge();
  process.exit(0);
}

// ── 状态汇总 ──
function judge(): void {
  const now = Date.now();
  const p: string[] = [];
  const live = s.onAir;
  if (!s.sseConnected && s.sseDownSince && now - s.sseDownSince > 90_000) p.push('dsh-down: 舞台事件流断了超过 90 秒');
  if (live && s.obs && !s.obs.active) p.push('stream-down: OBS 没在推流');
  if (live && !s.obs) p.push('obs-unreachable: 连不上 OBS');
  if (live && s.room && s.room.liveStatus !== 1) p.push(`room-offline: live_status=${s.room.liveStatus}`);
  if (live && s.windowDrop > 0.05) p.push(`dropping: 最近 30 秒丢帧 ${(s.windowDrop * 100).toFixed(1)}%`);
  if (live && s.brain === 'away') p.push(`brain-away: ${s.brainDetail}`);
  if (live && now - Math.max(s.lastSayAt, started) > 6 * 60_000) p.push(`silent: ${Math.round((now - Math.max(s.lastSayAt, started)) / 60_000)} 分钟没说话`);
  s.problems = p;
  writeFileSync(join(out, 'status.json'), JSON.stringify({ ...s, now, uptimeMin: Math.round((now - started) / 60_000) }, null, 1));
}

void sse();
if (FOLLOW_BACK) void followLoop();
setInterval(() => void obsTick(), 30_000);
setInterval(() => void roomTick(), 60_000);
setInterval(() => void freezeTick(), 120_000);
setInterval(judge, 15_000);
void obsTick();
void roomTick();
if (endAt) setTimeout(() => void endShow(), Math.max(0, endAt - Date.now()));
guard('guard-start', { endAt: endAt || null, endAtLocal: endAt ? new Date(endAt).toString() : null, followBack: FOLLOW_BACK, faces, out });
