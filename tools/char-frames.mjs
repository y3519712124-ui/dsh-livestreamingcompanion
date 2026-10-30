/**
 * Turn one action pose into a short frame sequence (the natural-looking way).
 *
 *   node tools/char-frames.mjs --dry-run      # print the plan, no API calls
 *   node tools/char-frames.mjs                # generate 4 frames per action
 *   node tools/char-frames.mjs --only=p3
 *
 * Each action becomes 4 keyframes: wind-up -> strike -> peak hold -> settle back.
 * They land as <action>-1..4.webp (fitted to the idle canvas) and are written to
 * character.json as image.frames[action] = [...], which the stage plays at 12fps.
 *
 * Requires the image endpoint; when it is unreachable the tool exits with the reason.
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
  'anime illustration, cel shading, clean line art, rim light',
  'plain transparent background, no text, no watermark, whole figure and props inside the frame',
].join(', ');

/** action -> four keyframe descriptions (same character, progressive motion) */
const ACTIONS = {
  'throw-bowl': {
    p2: [
      'crouching slightly, both hands gripping the empty white rice bowl low in front of her belly, eyes narrowed, winding up',
      'mid throw: right arm sweeping upward fast, bowl leaving her hands, body twisting, a few rice grains flying',
      'peak: right arm fully extended overhead in follow-through, the bowl spinning high above her head with motion arcs, laughing',
      'settling: arm coming down, weight back on both feet, still grinning, bowl no longer in frame',
    ],
    build: 'chibi anime girl, 3 heads tall, full body',
  },
  'sword-slash': {
    p3: [
      'drawing back: greatsword pulled behind her right shoulder, torso coiled, knees bent, focused eyes',
      'strike: greatsword sweeping diagonally across the frame, blade blurred with speed, first sparks',
      'peak: full crescent arc of glowing blue sword energy leaving the blade, hair and skirt blown back, fierce grin',
      'settling: sword lowered to her side, energy fading into sparks, stance relaxing',
    ],
    build: 'tall slender anime girl, 7 heads tall, full body',
  },
};

const PACKS = { p2: 'dafeiyu-p2', p3: 'dafeiyu-p3' };
const dryRun = process.argv.includes('--dry-run');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 420_000, ...opts });
}

function size(file) {
  const [w, h] = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .trim()
    .split(',')
    .map(Number);
  return { w, h };
}

function alphaBox(file) {
  const { w, h } = size(file);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: w * h + 4096,
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
  if (maxX < 0) return null;
  const pad = 6;
  return {
    x: Math.max(0, minX - pad),
    y: Math.max(0, minY - pad),
    w: Math.min(w - 1, maxX + pad) - Math.max(0, minX - pad) + 1,
    h: Math.min(h - 1, maxY + pad) - Math.max(0, minY - pad) + 1,
  };
}

function generate(prompt, tag) {
  const body = join(tmp, `${tag}-body.json`);
  writeFileSync(
    body,
    JSON.stringify({ model: MODEL, prompt, n: 1, size: '1024x1536', background: 'transparent', output_format: 'png', response_format: 'url' }),
    'ascii',
  );
  const out = join(tmp, `${tag}-resp.json`);
  rmSync(out, { force: true });
  run('curl.exe', [
    '-4', '-s',
    '--max-time', '150', '--connect-timeout', '30',
    '-o', out,
    '-X', 'POST', `${BASE}/images/generations`,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${KEY}`,
    '--data-binary', `@${body}`,
  ]);
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const url = json?.data?.[0]?.url;
  if (!url) throw new Error(`${tag}: ${JSON.stringify(json?.error ?? json).slice(0, 120)}`);
  const png = join(tmp, `${tag}.png`);
  rmSync(png, { force: true });
  run('curl.exe', ['-4', '-s', '--max-time', '150', '--connect-timeout', '20', '-o', png, url]);
  return png;
}

/** fit into the idle canvas, then write webp */
function finish(raw, target, canvas) {
  const box = alphaBox(raw);
  if (!box) throw new Error(`${target}: 没有透明通道`);
  const png = `${target}.png`;
  run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-frames:v', '1', png]);
  const [tw, th] = canvas;
  const s = size(png);
  const scale = Math.min(tw / s.w, th / s.h);
  const w = Math.max(2, Math.round(s.w * scale));
  const h = Math.max(2, Math.round(s.h * scale));
  run('ffmpeg', [
    '-y', '-v', 'error', '-i', png,
    '-vf', `scale=${w}:${h},pad=${tw}:${th}:(ow-iw)/2:(oh-ih):color=black@0`,
    '-frames:v', '1', `${png}.pad.png`,
  ]);
  run('ffmpeg', ['-y', '-v', 'error', '-i', `${png}.pad.png`, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '88', '-compression_level', '4', target]);
  rmSync(png, { force: true });
  rmSync(`${png}.pad.png`, { force: true });
}

for (const [key, dir] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const canvas = manifest.image?.size ?? [875, 1494];
  manifest.image.frames ??= {};

  for (const [action, spec] of Object.entries(ACTIONS)) {
    const frames = spec[key];
    if (!frames) continue;
    const names = [];
    for (let i = 0; i < frames.length; i++) {
      const file = `${action}-${i + 1}.webp`;
      names.push(file);
      const prompt = `${spec.build}, ${frames[i]}, ${CHARACTER}`;
      if (dryRun) {
        console.log(`${dir} ${action}[${i + 1}] -> ${file}\n   ${prompt.slice(0, 150)}...`);
        continue;
      }
      // 已经出过的帧跳过（断了再跑只补缺的）
      if (existsSync(join(packDir, file)) && !process.argv.includes('--force')) {
        console.log(`   skip ${file}`);
        continue;
      }
      console.log(`${dir} ${action}[${i + 1}/${frames.length}] generating ...`);
      const raw = generate(prompt, `${key}-${action}-${i + 1}`);
      finish(raw, join(packDir, file), canvas);
      console.log(`   ok ${file}`);
    }
    if (!dryRun) {
      manifest.image.frames[action] = names;
      manifest.image.moods[action] = names[names.length - 1];
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
  }
}
console.log(dryRun ? 'dry run: nothing generated' : 'done');
