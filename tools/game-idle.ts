// 先打包：cd packages/dsh-livestreamingcompanion && npx esbuild ../../tools/game-idle.ts --bundle --platform=node --format=esm --outfile=../../tools/game-idle.mjs
// 游戏线身体空闲分析：node tools/game-idle.mjs <session.v4.jsonl.zstd>
// 身体在忙 = game_act 开始的后台动作，到「（用了 N 秒）」或「停下了」为止；其余时间身体空着。
// 看空着的时候她的脑子在干什么：思考（等模型）、回直播间（弹幕/欢迎/礼物/主人）、在 game_continue 里等、两轮之间没人叫她。
import zlib from 'node:zlib';
import fs from 'node:fs';

const ev = zlib.zstdDecompressSync(fs.readFileSync(process.argv[2])).toString().split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && typeof e.time === 'number');
const txt = (c) => (Array.isArray(c) ? c : c?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const hhmm = (t) => new Date(t + 9 * 3600e3).toISOString().slice(11, 19);

// 1. 后台动作
const starts = [];
const calls = new Map();
for (const e of ev) {
  if (e.type === 'tool/call') calls.set(e.data.callId, e);
  if (e.type !== 'tool/result') continue;
  const call = calls.get(e.data.message?.toolCallId);
  const t = txt(e.data.message);
  if (call?.data.name === 'game_act') {
    const m = /^开始(.+?)。/.exec(t);
    if (m) starts.push({ label: m[1], start: e.time, end: null, how: '' });
  }
  // 完成：「采集 oak_log ×6：做完了（…）…（用了 30 秒）」
  for (const line of t.split('\n')) {
    const m = /^(.+?)：(.+?)（用了 (\d+) 秒）/.exec(line);
    if (m) {
      const s = [...starts].reverse().find((x) => x.label === m[1] && x.end === null && x.start <= e.time);
      if (s) { s.end = Math.min(e.time, s.start + Number(m[3]) * 1000); s.how = m[2].slice(0, 6); }
    }
    const stop = /^停下了（原来在(.+?)）/.exec(line);
    if (stop) {
      const s = [...starts].reverse().find((x) => x.label === stop[1] && x.end === null);
      if (s) { s.end = e.time; s.how = '被她停下'; }
    }
  }
}
// 新动作开始时旧动作还没收尾的：当成被新动作顶掉
starts.sort((a, b) => a.start - b.start);
for (let i = 0; i < starts.length; i++) if (starts[i].end === null) starts[i].end = starts[i + 1]?.start ?? starts[i].start;

// 2. 忙的区间合并
const busy = [];
for (const s of starts) {
  const last = busy[busy.length - 1];
  if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
  else busy.push({ start: s.start, end: s.end });
}
const first = busy[0].start;
const last = ev[ev.length - 1].time;

// 3. 空着的区间
const idle = [];
for (let i = 0; i + 1 < busy.length; i++) idle.push({ start: busy[i].end, end: busy[i + 1].start });

// 4. 脑子的时间线：每一步（step/start → assistant/message）、在 game_continue 里等、两轮之间
const segs = [];
let stepStart = null;
let pushKind = 'game';
let turnEnd = null;
const pend = new Map();
for (const e of ev) {
  if (e.type === 'user/message') {
    const t = txt(e.data);
    pushKind = /<观众弹幕>/.test(t) ? 'chat' : /进直播间的观众|关注|礼物|醒目|上舰|人气/.test(t) && !/【时刻】/.test(t) ? 'room' : /<主人>/.test(t) ? 'owner' : 'game';
  }
  if (e.type === 'turn/start' && turnEnd !== null) { segs.push({ start: turnEnd, end: e.time, kind: '两轮之间（没人叫她）' }); turnEnd = null; }
  if (e.type === 'turn/end') turnEnd = e.time;
  if (e.type === 'step/start') stepStart = e.time;
  if (e.type === 'assistant/message' && stepStart !== null) {
    const parts = e.data.message?.content ?? [];
    const said = parts.some((p) => p.type === 'text' && p.text.trim());
    segs.push({ start: stepStart, end: e.time, kind: `想（${pushKind === 'game' ? '游戏' : '直播间'}）` });
    stepStart = null;
    e.said = said;
  }
  if (e.type === 'tool/call') pend.set(e.data.callId, e);
  if (e.type === 'tool/result') {
    const c = pend.get(e.data.message?.toolCallId);
    if (c?.data.name === 'game_continue') segs.push({ start: c.time, end: e.time, kind: '在 game_continue 里等' });
    else if (c && e.time - c.time > 500) segs.push({ start: c.time, end: e.time, kind: `等工具 ${c.data.name}` });
  }
}

// 5. 汇总空着的时间
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const sum = {};
let idleTotal = 0;
const big = [];
for (const g of idle) {
  const len = g.end - g.start;
  if (len <= 0) continue;
  // 插件重启那几段（会话里一分钟以上没有任何事件）不算
  const inside = ev.filter((e) => e.time > g.start && e.time < g.end).map((e) => e.time);
  const gaps = [g.start, ...inside, g.end].map((t, i, a) => (i ? t - a[i - 1] : 0));
  if (Math.max(...gaps) > 60_000) continue;
  idleTotal += len;
  let covered = 0;
  const mine = {};
  for (const s of segs) {
    const o = overlap(g, s);
    if (!o) continue;
    mine[s.kind] = (mine[s.kind] ?? 0) + o;
    covered += o;
  }
  for (const [k, v] of Object.entries(mine)) sum[k] = (sum[k] ?? 0) + v;
  sum['其它（说话、两次调用之间）'] = (sum['其它（说话、两次调用之间）'] ?? 0) + Math.max(0, len - covered);
  if (len > 30_000) big.push({ g, len, mine });
}
const play = last - first;
const busyTotal = busy.reduce((a, b) => a + (Math.min(b.end, last) - b.start), 0);
console.log(`游戏时间 ${hhmm(first)}–${hhmm(last)}（${(play / 60000).toFixed(0)} 分钟）；后台动作 ${starts.length} 个，身体在忙 ${(busyTotal / 60000).toFixed(1)} 分钟，空着 ${(idleTotal / 60000).toFixed(1)} 分钟（不含插件重启）`);
console.log('身体空着的时候，她的脑子在：');
for (const [k, v] of Object.entries(sum).sort((a, b) => b[1] - a[1])) console.log(`  ${k}：${(v / 60000).toFixed(1)} 分钟（${((v / idleTotal) * 100).toFixed(0)}%）`);
console.log(`\n空着超过 30 秒的 ${big.length} 段：`);
for (const { g, len, mine } of big.slice(0, 40)) console.log(`  ${hhmm(g.start)} 空 ${(len / 1000).toFixed(0)} 秒：${Object.entries(mine).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)}s`).join('，')}`);
const lens = idle.map((g) => g.end - g.start).filter((x) => x > 0).sort((a, b) => a - b);
console.log(`\n每次空档：中位 ${(lens[Math.floor(lens.length / 2)] / 1000).toFixed(1)} 秒，90% 分位 ${(lens[Math.floor(lens.length * 0.9)] / 1000).toFixed(1)} 秒，共 ${lens.length} 次`);
