/**
 * Generate P2 / P3 character art (P1 keeps its animated clips pack).
 *   P2 = chibi, holding an empty rice bowl   -> assets/characters/dafeiyu-p2
 *   P3 = tall, holding a big sword           -> assets/characters/dafeiyu-p3
 *
 *   node tools/char-gen.mjs            # both
 *   node tools/char-gen.mjs --only=p2
 *
 * Transport (learned on this proxy): curl -4 (IPv6 connects time out),
 * response_format=url (b64 streaming gets truncated), background=transparent + png.
 * No image library needed: ffmpeg extracts the alpha channel, we scan it for the
 * bounding box, then ffmpeg crops. ffmpeg is on PATH (winget shim).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const chars = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'characters');
const tmp = join(here, '.gen');
mkdirSync(tmp, { recursive: true });

const BASE = process.env.IMAGE_BASE ?? 'https://88cf.scxai.top/v1';
const KEY = process.env.IMAGE_KEY ?? 'sk-3cfe0e715273e15e225e3afc34f61d27f3ab054175cd5a4fd7232bb744f27e88';
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-2.5-sunburst';

const CHARACTER = [
  'very long wavy deep-indigo blue hair with pale blue tips',
  'white lace maid headband with a small blue ribbon bow',
  'navy sailor-collar maid dress, white frilled apron with a tiny blue whale emblem, gold trim and buttons',
  'blue whale tail behind the legs',
  'blue mary-jane shoes with white socks',
  'anime illustration, cel shading, clean line art, soft rim light',
  'plain transparent background, no text, no watermark, whole figure inside the frame with margin',
].join(', ');

const POSES = {
  p2: {
    dir: 'dafeiyu-p2',
    name: '大肥鱼·干饭',
    prompt: `chibi anime girl, 3 heads tall, full body standing front view, both hands holding up one empty white ceramic rice bowl at chest height, happy, ${CHARACTER}`,
  },
  p3: {
    dir: 'dafeiyu-p3',
    name: '大肥鱼·宝剑',
    prompt: `tall slender anime girl, 7 heads tall, full body standing front view, both hands gripping a huge ornate blue greatsword planted point-down in front of her, confident smile, ${CHARACTER}`,
  },
};

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 240_000, ...opts });
}

function generate(pose) {
  const bodyFile = join(tmp, `${pose.key}-body.json`);
  const outFile = join(tmp, `${pose.key}-resp.json`);
  const png = join(tmp, `${pose.key}.png`);
  writeFileSync(
    bodyFile,
    JSON.stringify({ model: MODEL, prompt: pose.prompt, n: 1, size: '1024x1536', background: 'transparent', output_format: 'png', response_format: 'url' }),
    'ascii',
  );
  rmSync(outFile, { force: true });
  run('curl.exe', [
    '-4', '-s',
    '--max-time', '200', '--connect-timeout', '20',
    '-o', outFile,
    '-X', 'POST', `${BASE}/images/generations`,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${KEY}`,
    '--data-binary', `@${bodyFile}`,
  ]);
  const json = JSON.parse(readFileSync(outFile, 'utf8'));
  const url = json?.data?.[0]?.url;
  if (!url) throw new Error(`${pose.key}: no url: ${JSON.stringify(json?.error ?? json).slice(0, 160)}`);
  rmSync(png, { force: true });
  run('curl.exe', ['-4', '-s', '--max-time', '120', '--connect-timeout', '20', '-o', png, url]);
  return png;
}

function size(file) {
  const [w, h] = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).trim().split(',').map(Number);
  return { w, h };
}

/** alpha bbox: decode the alpha plane to raw gray and scan it */
function alphaBox(file) {
  const { w, h } = size(file);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: w * h + 1024,
    timeout: 120_000,
  });
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (raw[row + x] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h, opaque: false };
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, opaque: true };
}

/** crop to the alpha box, then make a 360x360 bust portrait for the console/alert icon */
function finish(pose, raw) {
  const packDir = join(chars, pose.dir);
  const box = alphaBox(raw);
  if (!box.opaque) throw new Error(`${pose.key}: 图片没有透明通道（模型没给透明背景），先别用`);
  const idle = join(packDir, 'idle.png');
  run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-frames:v', '1', idle]);

  const portrait = join(packDir, 'art', 'portrait.webp');
  mkdirSync(dirname(portrait), { recursive: true });
  const side = Math.min(box.w, Math.round(box.h * 0.6));
  const px = Math.max(0, Math.round((box.w - side) / 2));
  run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', `crop=${side}:${side}:${box.x + px}:${box.y},scale=360:360`, '-frames:v', '1', '-quality', '90', portrait]);

  const manifestPath = join(packDir, 'character.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = pose.name;
  manifest.renderer = 'image';
  manifest.image = { size: [box.w, box.h], idle: 'idle.png' };
  manifest.art = { portrait: 'art/portrait.webp' };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const legacy = join(packDir, 'idle.webp');
  if (existsSync(legacy)) rmSync(legacy);
  console.log(`ok ${pose.key}: idle.png ${box.w}x${box.h}, portrait.webp, name=${pose.name}`);
}

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
const keys = Object.keys(POSES).filter((k) => !only || k === only);
if (!keys.length) {
  console.log('no pose matched');
  process.exit(2);
}
for (const key of keys) {
  const pose = { key, ...POSES[key] };
  console.log(`generating ${key} ...`);
  const raw = generate(pose);
  finish(pose, raw);
}
