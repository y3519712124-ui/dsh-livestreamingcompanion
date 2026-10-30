/**
 * 验证浏览器桥的两个登录相关能力：
 *   1) cookies()  能把这个浏览器会话里的抖音 Cookie 读出来（应该有 ttwid）
 *   2) applyCookies() 塞进去的 key 能读回（登录流程就是把读到的整条存下来）
 *
 *   node tools/douyin-bridge-cookie.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'packages', 'dsh-livestreamingcompanion', '.douyin-cookie-check.mjs');
const { build } = createRequire(join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'package.json'))('esbuild');

const entry = `
import { BrowserBridge } from '../packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinBridge';
const bridge = new BrowserBridge({});
try {
  await bridge.open('https://www.douyin.com/');
  const before = await bridge.cookies();
  console.log('before:', before.split('; ').map((p) => p.split('=')[0]).join(', ') || '(空)');
  const applied = await bridge.applyCookies('dsh_probe=ok; dsh_probe2=v%2F1');
  const after = await bridge.cookies();
  console.log('applied:', applied);
  console.log('has ttwid:', /(?:^|;\\s*)ttwid=/.test(after));
  console.log('has probe:', /(?:^|;\\s*)dsh_probe=ok/.test(after), /dsh_probe2=/.test(after));
  console.log('after count:', after.split('; ').length);
} catch (err) {
  console.log('ERR', err.message);
} finally {
  bridge.stop();
}
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

const child = spawn(process.execPath, [out], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
