// 先打包：cd packages/dsh-livestreamingcompanion && npx esbuild ../../tools/live-report.ts --bundle --platform=node --format=esm --outfile=../../tools/live-report.mjs
// 压测报告（观众听到的）：node tools/live-report.mjs <livetest 输出> <直播记录 show.jsonl> <直播线会话.zstd> <游戏线会话.zstd> [听到的时间线.txt]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [sentFile, showFile, liveFile, gameFile, transcriptFile] = process.argv.slice(2);
const sent = fs.readFileSync(sentFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const show = fs.readFileSync(showFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const load = (f) => zlib.zstdDecompressSync(fs.readFileSync(f)).toString().split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && typeof e.time === 'number');
const txt = (c) => (Array.isArray(c) ? c : c?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
const clean = (s) => s.replace(/\[[a-z]+\]/g, '').trim();
const live = load(liveFile);
const game = load(gameFile);
const from = sent[0].at;
const to = sent[sent.length - 1].at + 60_000;
const says = show.filter((e) => e.type === 'say' && e.start >= from - 5_000 && e.start <= to);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;

// 每句话是哪条线说的：按游戏线写下的文字认
const gameWords = game.filter((e) => e.type === 'assistant/message').map((e) => ({ t: e.time, text: clean(txt(e.data.message)) })).filter((x) => x.text);
const lineOf = (say) => (gameWords.some((g) => g.text.includes(say.text.slice(0, 12)) || say.text.includes(g.text.slice(0, 12))) ? '游戏' : '直播');
for (const s of says) s.line = lineOf(s);

console.log(`压测 ${((to - 60_000 - from) / 60000).toFixed(1)} 分钟：发了 弹幕 ${sent.filter((s) => s.kind === 'chat').length}、进场 ${sent.filter((s) => s.kind === 'enter').length}、关注 ${sent.filter((s) => s.kind === 'follow').length}、礼物 ${sent.filter((s) => s.kind === 'gift').length}、主人 ${sent.filter((s) => s.kind === 'owner').length}`);

// 1. 弹幕：多久听到她点自己的名字
const chats = sent.filter((s) => s.kind === 'chat');
const firstOf = new Map();
for (const c of chats) if (!firstOf.has(c.name) || true) firstOf.set(`${c.name}@${c.at}`, c);
const lat = [];
let unanswered = 0;
// 她常把「弹幕观众08」简称成「08」「8」：名字后面跟着逗号、顿号、空格这些才算点名（别把「20/20」当成点名）
const named = (text, name) => {
  if (text.includes(name)) return true;
  const n = /(\d+)$/.exec(name)?.[1];
  return !!n && new RegExp(`(^|[^\\d.])(0?${Number(n)})(?=[号，,、 ：:])`).test(text);
};
for (const c of chats) {
  const heard = says.find((s) => s.start >= c.at && named(s.text, c.name));
  if (heard && heard.start - c.at < 180_000) lat.push(heard.start - c.at); else unanswered++;
}
console.log(`\n弹幕：${chats.length} 条，${lat.length} 条之后听到她点名（同一个人连着说的几条算同一次回应），${unanswered} 条一直没点到名`);
console.log(`  发出 → 听到点名：中位 ${sec(q(lat, 0.5))}，90% ${sec(q(lat, 0.9))}，最慢 ${sec(Math.max(...lat))}`);
const people = new Set(chats.map((c) => c.name));
const answeredPeople = [...people].filter((n) => says.some((s) => named(s.text, n)));
console.log(`  说过话的 ${people.size} 人里，被点过名的 ${answeredPeople.length} 人`);

// 2. 游戏线的话：写下 → 念出来
const gw = gameWords.filter((g) => g.t >= from && g.t <= to);
const gDelay = [];
const lost = [];
for (const g of gw) {
  const s = says.find((x) => x.start >= g.t - 2_000 && (x.text.includes(g.text.slice(0, 12)) || g.text.includes(x.text.slice(0, 12))));
  if (s) gDelay.push(s.start - g.t); else lost.push(g.text);
}
console.log(`\n游戏里的话：写了 ${gw.length} 段，念出来 ${gDelay.length} 段，没念 ${lost.length} 段`);
console.log(`  写下 → 开口：中位 ${sec(q(gDelay, 0.5))}，90% ${sec(q(gDelay, 0.9))}，最慢 ${sec(Math.max(...gDelay, 0))}`);
for (const l of lost.slice(0, 5)) console.log(`  没念：${l.slice(0, 40)}`);

// 3. 主人的话：回了几次（直播线一分钟内出声几段；游戏线在交接后有没有说「收到」）
const owners = sent.filter((s) => s.kind === 'owner');
for (const o of owners) {
  const liveReplies = live.filter((e) => e.type === 'assistant/message' && e.time > o.at && e.time < o.at + 60_000 && clean(txt(e.data.message)));
  const firstLive = liveReplies[0];
  const handoff = live.find((e) => e.type === 'tool/call' && e.data.name === 'game_side' && e.time > o.at && e.time < o.at + 60_000);
  const ack = handoff ? gameWords.filter((g) => g.t > handoff.time && g.t < handoff.time + 30_000).map((g) => g.text) : [];
  console.log(`\n主人：「${o.text}」`);
  console.log(`  直播线回：${firstLive ? `${sec(firstLive.time - o.at)} 后「${clean(txt(firstLive.data.message)).slice(0, 40)}」` : '没回'}`);
  console.log(`  交给游戏：${handoff ? JSON.parse(handoff.data.arguments || '{}').message?.slice(0, 40) : '没交'}；之后游戏里说：${ack.length ? ack.map((a) => `「${a.slice(0, 30)}」`).join(' ') : '（没说）'}`);
}

// 3b. 交接（game_side）：观众听到几次回应；游戏线没念的回执是什么（有没有吞掉要紧的话）
const handoffs = live.filter((e) => e.type === 'tool/call' && e.data.name === 'game_side' && e.time >= from && e.time <= to);
let twice = 0;
for (const h of handoffs) {
  const gameSaid = says.filter((s) => s.line === '游戏' && s.start > h.time && s.start < h.time + 40_000);
  if (gameSaid.length) twice++;
}
const unsaid = show.filter((e) => e.type === 'unsaid' && e.t >= from && e.t <= to);
console.log(`\n交接 ${handoffs.length} 次：40 秒内游戏线又出声 ${twice} 次；游戏线没念的回执 ${unsaid.length} 条：`);
for (const u of unsaid) console.log(`  （没念）${clean(u.text).slice(0, 60)}`);

// 4. 嘴和冷场
const talk = says.reduce((a, s) => a + (s.end - s.start), 0);
const gaps = says.slice(1).map((s, i) => ({ at: says[i].end, gap: s.start - says[i].end })).sort((a, b) => b.gap - a.gap);
console.log(`\n嘴：${says.length} 句（直播 ${says.filter((s) => s.line === '直播').length}，游戏 ${says.filter((s) => s.line === '游戏').length}），说话占 ${((talk / (to - 60_000 - from)) * 100).toFixed(0)}% 的时间；最长的安静：${gaps.slice(0, 3).map((g) => `${new Date(g.at).toTimeString().slice(0, 8)} ${sec(g.gap)}`).join('，')}`);

// 5. 把游戏里的自己说成别人
const split = /那边|它在|它正|它一|另一条线|游戏线|另一个我|那个我|另一个你|分身/;
const bad = says.filter((s) => split.test(s.text));
console.log(`\n把游戏里的自己说成别人：${bad.length} 句`);
for (const b of bad.slice(0, 5)) console.log(`  ✗ [${b.line}] ${b.text.slice(0, 50)}`);

// 6. 观众听到的时间线（人看有没有违和）
if (transcriptFile) {
  const events = [
    ...sent.filter((s) => s.kind === 'chat' || s.kind === 'owner').map((s) => ({ t: s.at, line: s.kind === 'owner' ? `   主人> ${s.text}` : `   ${s.name}> ${s.text}` })),
    ...says.map((s) => ({ t: s.start, line: `【${s.line}】${s.text}` })),
  ].sort((a, b) => a.t - b.t);
  fs.writeFileSync(transcriptFile, events.map((e) => `${new Date(e.t).toTimeString().slice(0, 8)} ${e.line}`).join('\n'));
  console.log(`\n听到的时间线写在 ${transcriptFile}`);
}
