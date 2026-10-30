/**
 * 把动作关键帧从 7 张补到 12 张（时间轴按均匀插空重排，再把空位画出来）。
 *
 *   node tools/char-fill.mjs                 # p2 throw-bowl + p3 sword-slash
 *   node tools/char-fill.mjs --only=p3 --dry-run
 *
 * 旧 1..7 -> 新 1,2,4,6,8,10,12；空出来的 3,5,7,9,11 用「过渡姿势」提示词生成。
 * 生成完跑 tools/char-clip.mjs 重编 webm（那边会先把帧拷成连续编号再喂给 ffmpeg）。
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

/** 旧 7 张在新 12 帧时间轴上的位置 */
const SLOTS = [1, 2, 4, 6, 8, 10, 12];

const PLANS = {
  'throw-bowl': {
    pack: 'dafeiyu-p2',
    build: 'chibi anime girl, 3 heads tall, full body',
    gaps: {
      3: 'arm starting to accelerate upward, the empty white bowl still held at chest height, eyes narrowing, body beginning to twist',
      5: 'hand above shoulder height, the bowl just leaving her fingers, three rice grains in the air',
      7: 'arm nearly overhead, the bowl high above her head, mouth open in a laugh, hair lifting',
      9: 'arm coming back down past her head, the bowl far above and out of frame, still grinning',
      11: 'arm down at waist level, weight settling back onto both feet, small happy smile',
    },
  },
  'sword-slash': {
    pack: 'dafeiyu-p3',
    build: 'tall slender anime girl, 7 heads tall, full body',
    gaps: {
      3: 'blade starting the forward sweep at chest height, torso uncoiling, both hands tight on the grip',
      5: 'blade halfway across her body, a thin bright arc of blue energy beginning along the edge',
      7: 'blade below waist height, the blue arc wide behind her, sparks scattering',
      9: 'blade at hip level, the arc thinning out into wisps, skirt still swinging',
      11: 'sword lowering toward her side, stance relaxing, energy almost gone',
    },
  },
};

const dryRun = process.argv.includes('--dry-run');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
const force = process.argv.includes('--force');

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
        '-4', '-s', '--max-time', '150', '--connect-timeout', '30',
        '-o', out, '-X', 'POST', `${BASE}/images/generations`,
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

for (const [action, plan] of Object.entries(PLANS)) {
  if (only && plan.pack !== (only === 'p2' ? 'dafeiyu-p2' : 'dafeiyu-p3')) continue;
  const packDir = join(chars, plan.pack);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const canvas = manifest.image?.size ?? [875, 1494];

  const have = readdirSync(packDir)
    .map((f) => new RegExp(`^${action}-(\\d+)\\.webp$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  // 三种状态：原始 7 帧(1..7) → 重排；已重排的稀疏 7 帧 → 直接补空位；已 12 帧 → 补缺
  const sparse = have.join(',') === '1,2,4,6,8,10,12';
  if (have.length === 7 && have[6] === 7) {
    for (let i = SLOTS.length - 1; i >= 0; i--) {
      const from = join(packDir, `${action}-${have[i]}.webp`);
      const to = join(packDir, `${action}-${SLOTS[i]}.webp`);
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    }
    console.log(`${plan.pack} ${action}: 7 帧重排到 1,2,4,6,8,10,12`);
  } else if (!sparse && have.length !== 12) {
    console.log(`${plan.pack} ${action}: 当前 ${have.length} 帧（${have.join(',')}），既不是原始 7 也不是已重排，跳过`);
    continue;
  }

  for (const [slot, text] of Object.entries(plan.gaps)) {
    const target = join(packDir, `${action}-${slot}.webp`);
    const prompt = `${plan.build}, ${text}, ${CHARACTER}`;
    if (dryRun) {
      console.log(`${plan.pack} ${action}[${slot}] -> ${action}-${slot}.webp\n   ${prompt.slice(0, 130)}...`);
      continue;
    }
    if (existsSync(target) && !force) {
      console.log(`   skip ${action}-${slot}.webp`);
      continue;
    }
    console.log(`${plan.pack} ${action}[${slot}] generating ...`);
    finish(generate(prompt, `${plan.pack}-${action}-${slot}`), target, canvas);
    console.log(`   ok ${action}-${slot}.webp`);
  }
}
console.log(dryRun ? 'dry run: nothing generated' : 'done — 接着跑 node tools/char-clip.mjs');
