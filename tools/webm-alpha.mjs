/**
 * Ask Chrome whether a webm really carries alpha (ffmpeg/ffprobe can't tell us:
 * VP8/VP9 alpha lives in a side stream, and this build's decoder ignores it).
 *
 *   node tools/webm-alpha.mjs tools/.gen/vp8a.webm [more.webm ...]
 *
 * Prints the alpha value Chrome samples at a few corners of the first frame.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.log('usage: node tools/webm-alpha.mjs <file.webm> ...');
  process.exit(1);
}
const payload = files.map((f) => ({ path: resolve(f), b64: readFileSync(resolve(f)).toString('base64') }));

const entry = `
import { BrowserBridge } from './src/core/platforms/douyin/douyinBridge';
const payload = ${JSON.stringify(payload)};

const bridge = new BrowserBridge({ warmupMs: 0, extraArgs: ['--disable-features=CalculateNativeWinOcclusion'] });
await bridge.open('data:text/html,<html><body></body></html>');

for (const item of payload) {
  const script = \`
(async () => {
  const src = 'data:video/webm;base64,' + ${JSON.stringify('')} + ITEM;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = src;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error')); });
  await v.play().catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(v, 0, 0);
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  return JSON.stringify({ w: c.width, h: c.height, tl: px(1, 1), br: px(c.width - 2, c.height - 2), center: px(c.width >> 1, c.height >> 1) });
})()
\`.replace('ITEM', JSON.stringify(item.b64));
  const out = await bridge.evaluate(script, true);
  console.log(item.path.split(/[\\\\/]/).pop() + ' -> ' + (out || 'no result'));
}
bridge.stop();
`;

const bundle = join(pkg, '.webm-alpha.mjs');
await build({ entryPoints: [], stdin: { contents: entry, resolveDir: pkg }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['ws', 'bufferutil', 'utf-8-validate'], logLevel: 'error' });
await import(`file://${bundle.replace(/\\/g, '/')}`);
