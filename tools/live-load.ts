// 先打包：cd packages/dsh-livestreamingcompanion && npx esbuild ../../tools/live-load.ts --bundle --platform=node --format=esm --outfile=../../tools/live-load.mjs
// 直播压测：照 2026-10-25 那场 MC 直播的真实流量往插件里灌模拟事件（泊松到达），记下每件发出的时间（见 docs/game-line.md「压测」）。
// node tools/live-load.mjs <端口> <curl 的 cookie jar> <分钟> <弹幕原文.json：字符串数组，含观众原话，只放本地> <输出.jsonl>
// 流量（那场 208 分钟实测）：弹幕约 6 条/分钟（推到她面前 4.9 条/分钟，还有积压）、进场约 30 人/分钟、关注约 1 个/分钟、礼物约 0.4 个/分钟
import fs from 'node:fs';

const [port, jarFile, minutes, chatFile, out] = process.argv.slice(2);
const cookie = fs.readFileSync(jarFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#') || l.startsWith('#HttpOnly_')).map((l) => l.replace('#HttpOnly_', '').split('\t')).filter((p) => p.length >= 7).map((p) => `${p[5]}=${p[6].trim()}`).join('; ');
const base = `http://127.0.0.1:${port}/api/dsh-livestreamingcompanion`;
const texts = JSON.parse(fs.readFileSync(chatFile, 'utf8')).filter((t) => t.length <= 40);
const RATES = { chat: 6, enter: 30, follow: 1, gift: 0.4 };
const OWNER = [
  [3, '刚才那下好险，血少的时候先跑，别硬打'],
  [8, '天快黑了吧？找个地方躲好再继续挖'],
  [12, '跟大家说说你现在背包里都有什么'],
];
const viewers = Array.from({ length: 40 }, (_, i) => `弹幕观众${String(i + 1).padStart(2, '0')}`);
let passer = 0;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
// 弹幕：一部分人会连着说好几条（真实直播间里常见）
const talkers = viewers.slice(0, 12);

async function post(path, body) {
  const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
}
function log(entry) {
  fs.appendFileSync(out, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
}

fs.writeFileSync(out, '');
const start = Date.now();
const end = start + Number(minutes) * 60_000;
const next = (rate) => -Math.log(1 - Math.random()) * 60_000 / rate;
const due = Object.fromEntries(Object.entries(RATES).map(([k, r]) => [k, start + next(r)]));
const owners = OWNER.filter(([m]) => m < Number(minutes)).map(([m, text]) => ({ at: start + m * 60_000, text }));

while (Date.now() < end) {
  const now = Date.now();
  for (const [kind, rate] of Object.entries(RATES)) {
    if (now < due[kind]) continue;
    due[kind] = now + next(rate);
    try {
      if (kind === 'chat') {
        const name = Math.random() < 0.5 ? pick(talkers) : pick(viewers);
        const text = pick(texts);
        await post('simulate', { kind: 'chat', name, text });
        log({ kind, name, text });
      } else if (kind === 'enter') {
        const name = `路过的${++passer}`;
        await post('simulate', { kind: 'enter', name });
        log({ kind, name });
      } else if (kind === 'follow') {
        const name = `路过的${Math.max(1, passer - Math.floor(Math.random() * 10))}`;
        await post('simulate', { kind: 'follow', name });
        log({ kind, name });
      } else {
        const name = pick(viewers);
        const gift = pick(['小花花', '人气票', '粉丝团灯牌', '小花花']);
        const count = Math.random() < 0.2 ? 3 : 1;
        await post('simulate', { kind: 'gift', name, gift, count, yuan: gift === '粉丝团灯牌' ? 1 : 0.1 });
        log({ kind, name, gift, count });
      }
    } catch (err) {
      log({ kind: 'error', error: String(err) });
    }
  }
  const owner = owners.find((o) => !o.sent && now >= o.at);
  if (owner) {
    owner.sent = true;
    await post('owner', { text: owner.text }).then(() => log({ kind: 'owner', text: owner.text }), (err) => log({ kind: 'error', error: String(err) }));
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('done');
