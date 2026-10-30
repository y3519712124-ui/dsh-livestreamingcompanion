/**
 * 抖音搜索冒烟：
 *   1) 没 Cookie → 应该直接告诉她「要登录」，不开浏览器
 *   2) 假 Cookie → 接口回 2483，应该也归到「要登录」，不开浏览器
 *   3) 假 Cookie + 页面路径 → 浏览器塞 Cookie、打开搜索页、截 general/search/single
 *      （预期：页面提示登录，截到 2483 或缺席；这一步只是验证桥真的跑起来了）
 *
 *   node tools/douyin-search-smoke.mjs [关键词]
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'packages', 'dsh-livestreamingcompanion', '.douyin-search-smoke.mjs');
const { build } = createRequire(join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'package.json'))('esbuild');

const entry = `
import { DouyinVideos, parseSearch, searchQuery } from '../packages/dsh-livestreamingcompanion/src/body/douyinVideo';
import { BrowserBridge } from '../packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinBridge';

const keyword = process.argv[2] ?? '猫';
const fake = 'ttwid=fake-ttwid; sessionid=fake-session';

const step = (name, value) => console.log('\\n=== ' + name + ' ===\\n' + value);

// 1) 没 Cookie
const none = new DouyinVideos(() => new BrowserBridge({}), async () => '');
step('no cookie', JSON.stringify(await none.search(keyword)));

// 2) 假 Cookie（Node 直连）
const fakeVideos = new DouyinVideos(() => new BrowserBridge({}), async () => fake);
step('fake cookie (http path)', JSON.stringify(await fakeVideos.search(keyword)));

// 3) 页面路径：直接走 searchInPage（private，运行时能拿到），验证塞 Cookie / 截响应 / 提前收手
const bridgeVideos = new DouyinVideos(() => new BrowserBridge({}), async () => fake);
const started = Date.now();
const pageResult = await bridgeVideos['searchInPage'](keyword, fake).catch((err) => ({ reason: 'error:' + err.message }));
step('page path', JSON.stringify({ ms: Date.now() - started, ...pageResult }));

// 4) 纯函数自检
step('searchQuery', searchQuery(keyword).slice(0, 120));
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

const child = spawn(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
