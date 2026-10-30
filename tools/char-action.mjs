/**
 * 给动作做一套 12 帧关键帧（吃饭 / 捂嘴笑），生成后由 tools/char-clip.mjs 编成 alpha webm。
 *
 *   node tools/char-action.mjs --dry-run
 *   node tools/char-action.mjs --only=p2 --action=eat
 *   node tools/char-action.mjs                 # 四个动作全跑，已有的帧会跳过
 *
 * 每帧的提示词按「动作阶段」递进写死，保证 12 帧是同一个人做的同一套动作。
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

const PACKS = {
  p2: {
    dir: 'dafeiyu-p2',
    build: 'chibi anime girl, 3 heads tall, full body',
    actions: {
      eat: [
        'reaching down for the white rice bowl with both hands, chopsticks resting across the rim',
        'lifting the chopsticks, looking at the bowl eagerly',
        'scooping a big helping of white rice, bowl held in the other hand at waist height',
        'bringing the chopsticks up toward her mouth, cheeks already rounding',
        'rice in her mouth, cheeks puffed out, chopsticks still between her lips',
        'chewing happily with eyes closed, chopsticks lowered, bowl at her chest',
        'swallowing and diving back in, lifting a second scoop of rice',
        'taking a bigger bite, rice grains on her cheek, delighted expression',
        'chewing with both cheeks completely full, eyes wide and sparkling',
        'pausing satisfied, chopsticks down, small grain of rice stuck to her lips',
        'wiping her mouth with the back of her hand, bowl still in her other arm',
        'patting her belly with a proud grin, empty bowl held up in the other hand',
      ],
      laugh: [
        'small polite smile, hands down in front of her apron',
        'starting to giggle, one corner of her mouth twitching up',
        'right hand starting to rise toward her face, shoulders lifting',
        'hand covering her mouth, eyes beginning to squeeze shut',
        'hand pressed over her mouth, eyes squeezed closed, laughing',
        'shoulders shaking with laughter, hand still over her mouth',
        'leaning forward while laughing, other hand on her stomach',
        'laughing harder, head tilted down, both eyes closed in a happy arc',
        'wiping a tear from under her eye with one finger, still giggling',
        'laughter settling, hand leaving her mouth, big smile',
        'residual giggle, hand at her chest, eyes half closed and happy',
        'bright happy smile, hands back together in front of the apron',
      ],
    },
  },
  p3: {
    dir: 'dafeiyu-p3',
    build: 'tall slender anime girl, 7 heads tall, full body',
    actions: {
      eat: [
        'planting the greatsword point-down in the ground beside her, freeing her hands',
        'picking up a white rice bowl, the sword upright at her side',
        'holding the bowl in one hand, lifting chopsticks with the other, composed expression',
        'scooping rice with the chopsticks, eyes on the bowl',
        'taking the first bite, chopsticks at her lips, eyes widening a little',
        'chewing with one cheek full, still holding the bowl neatly',
        'smiling as she chews, chopsticks resting on the rim',
        'taking a bigger bite, cheeks puffed, letting her guard down',
        'chewing quickly, a grain of rice stuck to her cheek',
        'pausing with a satisfied sigh, chopsticks lowered',
        'wiping her mouth with a folded napkin, looking embarrassed but pleased',
        'pulling the greatsword back out of the ground with her free hand, bowl still in the other',
      ],
      laugh: [
        'calm confident smirk, sword resting on her shoulder',
        'chuckling quietly, eyes narrowing with amusement',
        'lifting her free hand toward her face, sword still on her shoulder',
        'fingertips over her mouth as she laughs, ears slightly pink',
        'hand covering her mouth, eyes closing in genuine laughter',
        'shoulders shaking, sword tilting off her shoulder as she laughs',
        'head tilting back a little, laughing openly, hand still over her mouth',
        'laughing so hard her eyes water, sword held loosely at her side',
        'wiping under one eye with a fingertip, still smiling',
        'laughter fading into a warm smile, sword back on her shoulder',
        'small residual giggle, looking away shyly',
        'composed confident smile again, but her eyes are still smiling',
      ],
    },
  },
};

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
const onlyAction = process.argv.find((a) => a.startsWith('--action='))?.split('=')[1] ?? '';

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

for (const [key, pack] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, pack.dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const canvas = manifest.image?.size ?? [875, 1494];

  for (const [action, stages] of Object.entries(pack.actions)) {
    if (onlyAction && action !== onlyAction) continue;
    for (let i = 0; i < stages.length; i++) {
      const n = i + 1;
      const target = join(packDir, `${action}-${n}.webp`);
      const prompt = `${pack.build}, ${stages[i]}, ${CHARACTER}`;
      if (dryRun) {
        console.log(`${pack.dir} ${action}[${n}] -> ${action}-${n}.webp\n   ${prompt.slice(0, 120)}...`);
        continue;
      }
      if (existsSync(target) && !force) {
        console.log(`   skip ${action}-${n}.webp`);
        continue;
      }
      console.log(`${pack.dir} ${action}[${n}/12] generating ...`);
      try {
        finish(generate(prompt, `${key}-${action}-${n}`), target, canvas);
        console.log(`   ok ${action}-${n}.webp`);
      } catch (err) {
        // 单帧失败不要终止整轮：下一轮会重新补这一张
        console.log(`   FAIL ${action}-${n}: ${String(err.message).slice(0, 90)}`);
      }
    }
  }
}
console.log(dryRun ? 'dry run: nothing generated' : 'done — 接着跑 char-clip.mjs / char-sync.mjs');
