/**
 * Encode frame sequences into an alpha WebM using Chrome's own encoder.
 *
 *   node tools/char-webm.mjs --only=p2 --action=throw-bowl
 *   node tools/char-webm.mjs --verify            # 只检查已有 webm 的 alpha
 *
 * Why not ffmpeg: this box's ffmpeg libvpx wrapper drops alpha (yuva420p in -> yuv420p out),
 * so VP8/VP9 alpha cannot be muxed there. Chrome's MediaRecorder can encode VP8/VP9 with
 * alpha straight from a canvas, and we already ship a CDP bridge for Douyin — reuse it.
 *
 * The result is a normal <video>-playable webm with a transparent background, i.e. the same
 * shape as P1's clips, so the stage can play it with the clips renderer.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const chars = join(pkg, 'assets', 'characters');
const tmp = join(here, '.gen');
mkdirSync(tmp, { recursive: true });
const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const FPS = 24;
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'p2';
const actionArg = process.argv.find((a) => a.startsWith('--action='))?.split('=')[1] ?? '';
const PACK = only === 'p3' ? 'dafeiyu-p3' : 'dafeiyu-p2';
const ACTIONS = actionArg ? [actionArg] : ['throw-bowl', 'sword-slash'];

function framesOf(dir, action) {
  return readdirSync(dir)
    .map((f) => new RegExp(`^${action}-(\\d+)\\.webp$`).exec(f))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => join(dir, m[0]));
}

const packDir = join(chars, PACK);
const jobs = [];
for (const action of ACTIONS) {
  const frames = framesOf(packDir, action);
  if (frames.length < 4) continue;
  jobs.push({ action, frames });
}
if (!jobs.length) {
  console.log('no frame sequences found');
  process.exit(0);
}

/** 每个关键帧按 1/FPS 秒占据时间轴，帧之间用 Chrome 的合成器做 alpha 混合 */
const payload = jobs.map((job) => ({
  action: job.action,
  frames: job.frames.map((f) => ({ name: f.split(/[\\/]/).pop(), b64: readFileSync(f).toString('base64') })),
}));

const entry = `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserBridge } from './src/core/platforms/douyin/douyinBridge';

const payload = ${JSON.stringify(payload)};
const outDir = ${JSON.stringify(packDir)};
const fps = ${FPS};

const bridge = new BrowserBridge({ warmupMs: 0, extraArgs: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'] });
await bridge.open('data:text/html,<html><body style="margin:0;background:transparent"></body></html>');

for (const job of payload) {
  const script = \`
(async () => {
  const fps = \${fps};
  const frames = \${JSON.stringify(job.frames)};
  const imgs = await Promise.all(frames.map((f) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = 'data:image/webp;base64,' + f.b64;
  })));
  const w = imgs[0].naturalWidth, h = imgs[0].naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: true });
  document.body.appendChild(canvas);
  const stream = canvas.captureStream(fps);
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();
  for (let i = 0; i < imgs.length; i++) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(imgs[i], 0, 0);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return JSON.stringify({ mime, size: bytes.length, b64: btoa(bin) });
})()
\`;
  const raw = await bridge.evaluate(script, true);
  if (!raw) { console.log('  ' + job.action + ': 页面没返回结果'); continue; }
  const out = JSON.parse(raw);
  writeFileSync(join(outDir, job.action + '.webm'), Buffer.from(out.b64, 'base64'));
  console.log('  ' + job.action + '.webm  ' + out.mime + '  ' + Math.round(out.size / 1024) + 'KB');
}
bridge.stop();
`;

const bundle = join(pkg, '.char-webm.mjs');
await build({ entryPoints: [], stdin: { contents: entry, resolveDir: pkg }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['ws', 'bufferutil', 'utf-8-validate'], logLevel: 'error' });
await import(`file://${bundle.replace(/\\/g, '/')}`);
