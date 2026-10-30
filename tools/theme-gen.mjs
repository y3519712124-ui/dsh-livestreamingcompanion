/**
 * 生成六个直播主题的背景图，并搭好模板目录。
 *
 *   node tools/theme-gen.mjs                 # 全部（已有 bg.png 跳过）
 *   node tools/theme-gen.mjs --only=forest-mist
 *   node tools/theme-gen.mjs --force
 *
 * 传输用 curl（Windows 自带）：Node 的 fetch/https 在这个域名上会卡住（DNS 有 AAAA，
 * v6 连接超时；https 直连虽然能连上但请求会长时间不回）。curl 实测 28~100 秒能拿到完整 JSON。
 * 单张最多等 300 秒；失败重试 3 次。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'templates');
const DEFAULT = join(templates, 'default');
const TMP_JSON = join(here, '.gen-out.json');
const TMP_BODY = join(here, '.gen-body.json');

const BASE = process.env.IMAGE_BASE ?? 'https://88cf.scxai.top/v1';
const KEY = process.env.IMAGE_KEY ?? 'sk-3cfe0e715273e15e225e3afc34f61d27f3ab054175cd5a4fd7232bb744f27e88';
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-2.5-sunburst';
const SIZE = '1536x1024';
const TIMEOUT_S = 150;
/** 主模型偶尔会排到很久（实测有一次 15 分钟不回）：同一家的 flare 兜底，画质同档 */
const MODELS = [MODEL, process.env.IMAGE_FALLBACK ?? 'gpt-image-2.5-flare'];

const STYLE = 'anime illustration, cel shading, soft cinematic lighting, detailed background art, '
  + 'no people, no characters, no text, no watermark, 16:9 widescreen, '
  + 'composition keeps the left and right thirds calm for UI overlays, gentle depth of field';

const THEMES = [
  { id: 'forest-mist', name: '晨雾森林', accent: ['#6fb1a6', '#cdb4f0'], prompt: `a quiet misty forest clearing at early morning, tall mossy trees, pale light shafts through fog, ferns and small glowing spores, a wooden path, teal and mint palette, ${STYLE}` },
  { id: 'observatory', name: '星空天文台', accent: ['#6c7bd9', '#f2b5d4'], prompt: `an old hilltop observatory dome at night, starry sky with milky way, brass telescope, warm lamp light spilling from the open dome, indigo and violet palette with warm highlights, ${STYLE}` },
  { id: 'sakura-cafe', name: '樱町咖啡', accent: ['#f2a3b8', '#ffd9a0'], prompt: `a small corner cafe on a sakura lined street in spring afternoon, pink petals drifting, warm wood interior seen through glass, rose and cream palette, ${STYLE}` },
  { id: 'cloud-library', name: '云端书阁', accent: ['#8fb7ff', '#ffe6a7'], prompt: `a floating library above a sea of clouds at golden hour, endless bookshelves on drifting islands, warm reading lamps, marble arches, sky blue and honey palette, ${STYLE}` },
  { id: 'neon-rain', name: '雨夜霓虹', accent: ['#7f5cff', '#46e0ff'], prompt: `a narrow rainy alley at night with abstract neon light shapes, wet pavement reflections, steam from vents, electric violet and cyan palette, ${STYLE}` },
  { id: 'winter-greenhouse', name: '冬日暖房', accent: ['#9fd4c7', '#ffd1b3'], prompt: `a glass greenhouse in winter evening, snow outside, warm string lights among plants and terracotta pots, wooden bench, teal and amber palette, ${STYLE}` },
];

const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(args, timeoutMs) {
  // -4 很关键：这个域名有 AAAA，curl 和 Node 走 v6 会 connect 超时（实测 15s 000）
  return execFileSync('curl.exe', ['-4', '-s', ...args], { encoding: 'utf8', timeout: timeoutMs });
}

/** 生成一张：接口只回 url（response_format=url，回包几百字节），图再从 CDN 拉，比等 b64 流快得多 */
function curlGenerate(prompt, target, model = MODEL) {
  writeFileSync(TMP_BODY, JSON.stringify({ model, prompt, n: 1, size: SIZE, response_format: 'url' }), 'ascii');
  rmSync(TMP_JSON, { force: true });
  try {
    curl(
      [
        '--max-time', String(TIMEOUT_S),
        '--connect-timeout', '15',
        '-o', TMP_JSON,
        '-X', 'POST', `${BASE}/images/generations`,
        '-H', 'Content-Type: application/json',
        '-H', `Authorization: Bearer ${KEY}`,
        '--data-binary', `@${TMP_BODY}`,
      ],
      (TIMEOUT_S + 20) * 1000,
    );
  } catch (err) {
    return { ok: false, reason: `生成请求失败：${err.message?.slice(0, 120)}` };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(TMP_JSON, 'utf8'));
  } catch {
    return { ok: false, reason: '生成接口没回完整 JSON' };
  } finally {
    rmSync(TMP_JSON, { force: true });
  }
  const url = json?.data?.[0]?.url;
  if (!url) return { ok: false, reason: `响应里没有 url：${JSON.stringify(json?.error ?? json).slice(0, 120)}` };
  rmSync(target, { force: true });
  try {
    curl(['--max-time', '120', '--connect-timeout', '15', '-o', target, url], 150_000);
  } catch (err) {
    return { ok: false, reason: `下图失败：${err.message?.slice(0, 120)}` };
  }
  if (!existsSync(target)) return { ok: false, reason: '下图没有任何输出' };
  const buf = readFileSync(target);
  if (buf.length < 1000 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    rmSync(target, { force: true });
    return { ok: false, reason: `下回来的不是 PNG（${buf.length} 字节）` };
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { ok: true, bytes: buf.length, size: `${w}x${h}`, model };
}

async function generate(theme) {
  const dir = join(templates, theme.id);
  mkdirSync(dir, { recursive: true });
  const bg = join(dir, 'bg.png');
  if (existsSync(bg) && !force) {
    console.log(`skip ${theme.id}（已有 bg.png）`);
    return true;
  }
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const result = curlGenerate(theme.prompt, bg, model);
      if (result.ok) {
        console.log(`ok ${theme.id} [${model}]: ${result.bytes} bytes ${result.size} ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return true;
      }
      console.log(`  ${theme.id} [${model}] attempt ${attempt}: ${result.reason}`);
      await sleep(3000 * attempt);
    }
  }
  console.log(`FAIL ${theme.id}`);
  return false;
}

function scaffold(theme) {
  const dir = join(templates, theme.id);
  const manifest = JSON.parse(readFileSync(join(DEFAULT, 'template.json'), 'utf8'));
  manifest.id = theme.id;
  manifest.name = theme.name;
  manifest.theme = { '--ls-accent': theme.accent[0], '--ls-accent-2': theme.accent[1] };
  writeFileSync(join(dir, 'template.json'), JSON.stringify(manifest, null, 2) + '\n');

  const css = readFileSync(join(DEFAULT, 'style.css'), 'utf8')
    .replaceAll('ls-template-default', `ls-template-${theme.id}`)
    .replace('url("room.jpg")', 'url("bg.png")');
  writeFileSync(join(dir, 'style.css'), css);
  // 字体各自带一份（舞台只给相对 url() 补 token，绝对路径会 401）
  cpSync(join(DEFAULT, 'fonts'), join(dir, 'fonts'), { recursive: true });

  const preview = join(dir, 'preview.png');
  if (existsSync(join(dir, 'bg.png'))) copyFileSync(join(dir, 'bg.png'), preview);
}

const list = onlyArg ? THEMES.filter((t) => t.id === onlyArg) : THEMES;
if (!list.length) {
  console.log('没有匹配的主题 id');
  process.exit(2);
}
let failed = 0;
for (const theme of list) {
  if (await generate(theme)) scaffold(theme);
  else failed += 1;
}
console.log(`done. failed=${failed}/${list.length}`);
process.exit(failed ? 1 : 0);
