/**
 * 端到端冒烟：真的连一个抖音直播间（借浏览器桥），把解出来的事件打出来。
 *
 *   node tools/douyin-live-smoke.mjs <web_rid> [秒]
 *
 * 这个脚本用 esbuild 现打（源码是 TS），跑完自己退出。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// 产物放在插件包里：ws 是插件的依赖，require('ws') 要能从那个目录解析
const out = join(here, '..', 'packages', 'dsh-livestreamingcompanion', '.douyin-smoke.mjs');
// esbuild 装在插件包里（仓库根上没有 node_modules）
const { build } = createRequire(join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'package.json'))('esbuild');

const entry = `
import { DouyinLiveSource } from '../packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinSource';
const webRid = Number(process.argv[2] ?? '0');
const seconds = Number(process.argv[3] ?? 35);
if (!webRid) { console.log('need web_rid'); process.exit(2); }
const source = new DouyinLiveSource(webRid, { cookie: '', log: (level, message) => console.log('[' + level + ']', message) });
let events = 0;
const kinds = new Map();
source.start({
  event(event) {
    events += 1;
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    if (events <= 8) console.log('event', event.kind, JSON.stringify(event.user?.name), JSON.stringify((event).text ?? (event).giftName ?? ''));
  },
  stats(stats) { if (Object.keys(stats).length) console.log('stats', JSON.stringify(stats)); },
  room(info) { console.log('room', JSON.stringify(info)); },
  state(state, detail) { console.log('state', state, detail?.error ?? ''); },
});
setTimeout(() => {
  console.log('TOTAL events', events, JSON.stringify([...kinds.entries()]));
  source.stop();
  setTimeout(() => process.exit(events > 0 ? 0 : 3), 500);
}, seconds * 1000);
`;

await build({
  stdin: { contents: entry, resolveDir: here, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const args = process.argv.slice(2);
const child = spawn(process.execPath, [out, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
