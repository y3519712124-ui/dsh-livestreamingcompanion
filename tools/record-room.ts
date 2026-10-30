// 开发工具：匿名（只读）录一个直播间 N 秒的事件，写成 JSONL：{at, isUpdate, event}。录下来的含观众昵称，只放本地，不进仓库。
// 用法：node tools/record-room.mjs <房间号> <秒数> <输出.jsonl>（先打包：cd packages/dsh-livestreamingcompanion && npx esbuild ../../tools/record-room.ts --bundle --platform=node --format=esm --outfile=../../tools/record-room.mjs）
import { writeFileSync, appendFileSync } from 'node:fs';
import { LiveHub } from '../packages/dsh-livestreamingcompanion/src/core/hub';
const [room, seconds, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
writeFileSync(out, '');
const hub = new LiveHub();
const start = Date.now();
hub.subscribe((event, isUpdate) => appendFileSync(out, JSON.stringify({ at: Date.now() - start, isUpdate, event }) + '\n'));
hub.connect({ platform: 'bilibili', roomId: room, cookie: '' });
const timer = setInterval(() => {
  const s = hub.status();
  process.stdout.write(`\r${((Date.now() - start) / 1000).toFixed(0)}s state=${s.state} online=${s.stats.online ?? '-'} perMin=${JSON.stringify(s.perMinute)}   `);
}, 5000);
setTimeout(() => { clearInterval(timer); console.log('\nstats', JSON.stringify(hub.status().stats), JSON.stringify(hub.status().room)); hub.disconnect(); process.exit(0); }, seconds * 1000);
