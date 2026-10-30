/**
 * Action poses for the still-image characters (P1 has animated clips; these two are PNGs,
 * so an "action" = an extra pose the stage swaps in on a trigger).
 *
 *   P2: throw-bowl  - she flings her empty rice bowl up in the air, follow-through pose
 *   P3: sword-slash - mid swing of the greatsword with a crescent of glowing sword energy
 *
 *   node tools/char-moods.mjs
 *   node tools/char-moods.mjs --only=p3 --pose=sword-slash
 *
 * Poses land as <pack>/<file>.png (alpha-cropped) and are wired into
 * character.json: image.moods[<key>] + reactions[<event>] -> <key>,
 * so a big gift makes P2 fling the bowl / P3 slash.
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

// 每个表情都必须带上角色描述（CHARACTER 在后面定义，运行时才取，没问题）——
// 第一次跑忘了带，结果生成出来是个棕发的另一个角色，白跑一张。
const MOODS = {
  laugh: (b) => `${b}, laughing happily with one hand covering her mouth, eyes squeezed shut, joyful, ${CHARACTER}`,
  shy: (b) => `${b}, shy and blushing, both hands clasped together in front of her chest, looking away, small smile, ${CHARACTER}`,
  shocked: (b) => `${b}, surprised: both hands raised beside her cheeks, wide eyes, mouth open in a small o, ${CHARACTER}`,
  sad: (b) => `${b}, sad: head slightly lowered, eyes downcast, small frown, shoulders drooping, ${CHARACTER}`,
  think: (b) => `${b}, thinking: one fingertip on her chin, eyes looking up to the side, small "hmm" expression, ${CHARACTER}`,
  angry: (b) => `${b}, pouting angry: hands on hips, cheeks puffed out, brows furrowed, still cute, ${CHARACTER}`,
};

const CHARACTER = [
  'very long wavy deep-indigo blue hair with pale blue tips',
  'white lace maid headband with a small blue ribbon bow',
  'navy sailor-collar maid dress, white frilled apron with a tiny blue whale emblem, gold trim and buttons',
  'blue whale tail behind the legs',
  'blue mary-jane shoes with white socks',
  'anime illustration, cel shading, clean line art, rim light',
  'plain transparent background, no text, no watermark, whole figure and props inside the frame',
].join(', ');

const PACKS = {
  p2: {
    dir: 'dafeiyu-p2',
    build: 'chibi anime girl, 3 heads tall, full body',
    poses: {
      'throw-bowl': {
        file: 'throw-bowl.png',
        prompt: (b) =>
          `${b}, she has just flung her empty white rice bowl up into the air: right arm thrown upward in follow-through, ` +
          `the bowl spinning above her head with motion arcs, body twisted, mischievous grin, one eye squinting, ` +
          `a few rice grains flying, ${CHARACTER}`,
        reactions: { 'gift.huge': 'throw-bowl', 'superchat.big': 'throw-bowl', 'gift.big': 'throw-bowl' },
      },
    },
  },
  p3: {
    dir: 'dafeiyu-p3',
    build: 'tall slender anime girl, 7 heads tall, full body',
    poses: {
      'sword-slash': {
        file: 'sword-slash.png',
        prompt: (b) =>
          `${b}, mid swing with her huge ornate blue greatsword: blade sweeping diagonally across the frame, ` +
          `a bright crescent arc of glowing blue sword energy trailing from the edge, sparks and light streaks, ` +
          `hair, skirt and ribbon blown back by the shockwave, fierce confident expression, ${CHARACTER}`,
        reactions: { 'gift.huge': 'sword-slash', 'superchat.big': 'sword-slash', 'gift.big': 'sword-slash' },
      },
    },
  },
};

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
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** generate one image, retrying because this proxy sometimes stalls on a request */
function generate(prompt, tag) {
  const body = join(tmp, `${tag}-body.json`);
  writeFileSync(
    body,
    JSON.stringify({ model: MODEL, prompt, n: 1, size: '1024x1536', background: 'transparent', output_format: 'png', response_format: 'url' }),
    'ascii',
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = join(tmp, `${tag}-resp.json`);
    rmSync(out, { force: true });
    try {
      run('curl.exe', [
        '-4', '-s',
        '--max-time', '330', '--connect-timeout', '30',
        '-o', out,
        '-X', 'POST', `${BASE}/images/generations`,
        '-H', 'Content-Type: application/json',
        '-H', `Authorization: Bearer ${KEY}`,
        '--data-binary', `@${body}`,
      ]);
      const json = JSON.parse(readFileSync(out, 'utf8'));
      const url = json?.data?.[0]?.url;
      if (!url) throw new Error(JSON.stringify(json?.error ?? json).slice(0, 120));
      const png = join(tmp, `${tag}.png`);
      rmSync(png, { force: true });
      run('curl.exe', ['-4', '-s', '--max-time', '150', '--connect-timeout', '20', '-o', png, url]);
      if (!existsSync(png)) throw new Error('download failed');
      return png;
    } catch (err) {
      console.log(`  ${tag} attempt ${attempt}: ${String(err.message).slice(0, 100)}`);
    }
  }
  throw new Error(`${tag}: 3 attempts failed`);
}

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
const poseFilter = process.argv.find((a) => a.startsWith('--pose='))?.split('=')[1] ?? '';
const fitOnly = process.argv.includes('--fit-only');
const force = process.argv.includes('--force');

/**
 * Letterbox an action pose onto the idle canvas (bottom-centre, scaled by height).
 * The stage draws every mood inside the idle aspect box, so an un-fitted wider pose
 * would shrink and jump when it swaps in.
 */
function fitToCanvas(file, targetW, targetH) {
  const s = size(file);
  const scale = Math.min(targetW / s.w, targetH / s.h);
  const w = Math.max(2, Math.round(s.w * scale));
  const h = Math.max(2, Math.round(s.h * scale));
  const out = `${file}.tmp.png`;
  run('ffmpeg', [
    '-y', '-v', 'error', '-i', file,
    '-vf', `scale=${w}:${h},pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih):color=black@0`,
    '-frames:v', '1', out,
  ]);
  rmSync(file, { force: true });
  run('ffmpeg', ['-y', '-v', 'error', '-i', out, '-frames:v', '1', file]);
  rmSync(out, { force: true });
  return `${targetW}x${targetH}`;
}

for (const [key, pack] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, pack.dir);
  const idle = join(packDir, 'idle.png');
  if (!existsSync(idle)) {
    console.log(`skip ${key}: no idle.png`);
    continue;
  }
  const manifestPath = join(packDir, 'character.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.image) {
    const s = size(idle);
    manifest.image = { size: [s.w, s.h], idle: 'idle.png' };
  }
  manifest.image.moods ??= {};
  manifest.reactions ??= {};

  if (fitOnly) {
    const [tw, th] = manifest.image.size;
    for (const file of Object.values(manifest.image.moods)) {
      const target = join(packDir, file);
      if (!existsSync(target)) continue;
      console.log(`${key}/${file}: fit -> ${fitToCanvas(target, tw, th)}`);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    continue;
  }

  const poses = {
    // expression variants first (mood keys must match what the show sends: laugh/shy/shocked/sad/think/angry)
    ...Object.fromEntries(Object.entries(MOODS).map(([name, prompt]) => [name, { file: `${name}.png`, prompt }])),
    ...pack.poses,
  };

  for (const [poseKey, pose] of Object.entries(poses)) {
    if (poseFilter && poseKey !== poseFilter) continue;
    const target = join(packDir, pose.file);
    const webpName = pose.file.replace(/\.png$/, '.webp');
    const webpPath = join(packDir, webpName);
    // 已生成过就跳过（动作姿势也算）：char-sync 会把 png 收成 webp 并删掉 png，所以两种都要看
    if (!force && (existsSync(target) || existsSync(webpPath))) {
      const name = existsSync(target) ? pose.file : webpName;
      if (manifest.image.moods[poseKey] !== name) manifest.image.moods[poseKey] = name;
      if (pose.reactions) Object.assign(manifest.reactions, pose.reactions);
      continue;
    }
    console.log(`${key}/${poseKey}: generating ...`);
    const raw = generate(pose.prompt(pack.build), `${key}-${poseKey}`);
    const box = alphaBox(raw);
    if (!box) throw new Error(`${key}/${poseKey}: 没有透明通道，不能当立绘`);
    run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-frames:v', '1', target]);
    const [tw, th] = manifest.image.size;
    fitToCanvas(target, tw, th);
    manifest.image.moods[poseKey] = pose.file;
    if (pose.reactions) Object.assign(manifest.reactions, pose.reactions);
    console.log(`${key}/${poseKey}: ${pose.file} -> ${tw}x${th} canvas`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${key}: moods=${Object.keys(manifest.image.moods).join(',') || '-'} reactions=${JSON.stringify(manifest.reactions)}`);
}
