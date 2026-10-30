/**
 * Double the keyframe density of an action by generating the in-between poses.
 *
 *   node tools/char-tween.mjs            # p2 throw-bowl + p3 sword-slash
 *   node tools/char-tween.mjs --only=p3 --dry-run
 *
 * Existing <action>-1..4.webp are renumbered to 1,3,5,7 (descending so nothing is overwritten),
 * then the gaps (2,4,6) are generated from prompts describing the transitional pose.
 * Run tools/char-sync.mjs afterwards to rebuild image.frames.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** in-between prompts, keyed by the gap position they fill (2, 4, 6) */
const TWEENS = {
  'throw-bowl': {
    p2: 'chibi anime girl, 3 heads tall, full body',
    frames: {
      2: 'rising out of the crouch, both hands lifting the empty white rice bowl to waist height, eyes opening wide with effort',
      4: 'arm at shoulder height just after release, the empty bowl a little above her open hand, body still twisting upward',
      6: 'arm coming down from overhead, hand open, the bowl far above and out of frame, laughing',
    },
  },
  'sword-slash': {
    p3: 'tall slender anime girl, 7 heads tall, full body',
    frames: {
      2: 'sword drawn back behind her shoulder, torso coiled the other way, weight shifting onto the back foot, starting the swing',
      4: 'blade halfway through the diagonal sweep, the first thin arc of blue energy forming along the edge, hair lifting',
      6: 'follow-through: blade past her hip, the blue arc widening behind her, skirt still swinging from the motion',
    },
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
  for (let attempt = 1; attempt <= 4; attempt++) {
    const out = join(tmp, `${tag}-resp.json`);
    rmSync(out, { force: true });
    try {
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
      if (!url) throw new Error(JSON.stringify(json?.error ?? json).slice(0, 100));
      const png = join(tmp, `${tag}.png`);
      rmSync(png, { force: true });
      run('curl.exe', ['-4', '-s', '--max-time', '120', '--connect-timeout', '20', '-o', png, url]);
      if (!existsSync(png)) throw new Error('download failed');
      return png;
    } catch (err) {
      console.log(`   ${tag} attempt ${attempt}: ${String(err.message).slice(0, 90)}`);
    }
  }
  throw new Error(`${tag}: 4 attempts failed`);
}

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
  const pad = `${png}.pad.png`;
  run('ffmpeg', ['-y', '-v', 'error', '-i', png, '-vf', `scale=${w}:${h},pad=${tw}:${th}:(ow-iw)/2:(oh-ih):color=black@0`, '-frames:v', '1', pad]);
  run('ffmpeg', ['-y', '-v', 'error', '-i', pad, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '88', '-compression_level', '4', target]);
  rmSync(png, { force: true });
  rmSync(pad, { force: true });
}

for (const [key, dir] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const canvas = manifest.image?.size ?? [875, 1494];

  for (const [action, spec] of Object.entries(TWEENS)) {
    const build = spec[key];
    if (!build) continue;
    const have = readdirSync(packDir).filter((f) => new RegExp(`^${action}-\\d+\\.webp$`).test(f));
    if (have.length < 4) {
      console.log(`${dir} ${action}: 关键帧不足 4 张（当前 ${have.length}），先跑 char-frames`);
      continue;
    }
    // 把 1..4 挪成 1,3,5,7（从大到小，避免覆盖）；已经是 7 张就直接补中间帧
    if (!have.includes(`${action}-7.webp`)) {
      for (const n of [4, 3, 2, 1]) {
        const from = join(packDir, `${action}-${n}.webp`);
        const to = join(packDir, `${action}-${n * 2 - 1}.webp`);
        if (existsSync(from) && !existsSync(to)) renameSync(from, to);
      }
      console.log(`${dir} ${action}: 现有 4 帧重编号为 1,3,5,7`);
    }
    for (const [idx, text] of Object.entries(spec.frames)) {
      const target = join(packDir, `${action}-${idx}.webp`);
      const prompt = `${build}, ${text}, ${CHARACTER}`;
      if (dryRun) {
        console.log(`${dir} ${action}[${idx}] -> ${target.split(/[\\/]/).pop()}\n   ${prompt.slice(0, 140)}...`);
        continue;
      }
      if (existsSync(target)) {
        console.log(`   skip ${action}-${idx}.webp`);
        continue;
      }
      console.log(`${dir} ${action}[${idx}] generating ...`);
      finish(generate(prompt, `${key}-${action}-${idx}`), target, canvas);
      console.log(`   ok ${action}-${idx}.webp`);
    }
  }
}
console.log(dryRun ? 'dry run: nothing generated' : 'done — 记得跑 tools/char-sync.mjs');
