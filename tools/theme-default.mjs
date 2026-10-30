/**
 * 重新生成「海边小屋」（default）的背景：接口回 url，再下图，写成 default/bg.png，
 * 并把 default/style.css 里的背景从 room.jpg 换到 bg.png。
 *
 *   node tools/theme-default.mjs
 *   node tools/theme-default.mjs --prompt "自定义描述"
 *
 * 传输要点（和 theme-gen.mjs 一致）：
 *  - curl 必须 -4：这个域名有 AAAA，v6 连接会 15s 超时
 *  - response_format=url：b64 流太慢会被 max-time 截断
 */

import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'templates', 'default');
const TMP_JSON = join(here, '.default-out.json');
const TMP_BODY = join(here, '.default-body.json');

const BASE = process.env.IMAGE_BASE ?? 'https://88cf.scxai.top/v1';
const KEY = process.env.IMAGE_KEY ?? 'sk-3cfe0e715273e15e225e3afc34f61d27f3ab054175cd5a4fd7232bb744f27e88';
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-2.5-sunburst';
const FALLBACK = process.env.IMAGE_FALLBACK ?? 'gpt-image-2.5-flare';
const SIZE = '1536x1024';

const STYLE = 'anime illustration, cel shading, soft cinematic lighting, detailed background art, '
  + 'no people, no characters, no text, no watermark, 16:9 widescreen, '
  + 'clean left and right thirds for UI overlays, gentle depth of field';

const promptArg = process.argv.find((a) => a.startsWith('--prompt='))?.slice('--prompt='.length);
const PROMPT = promptArg
  ? `${promptArg}, ${STYLE}`
  : `cozy seaside cottage living room interior, huge arched window opening to a turquoise sea and bright sky, `
    + `sheer white curtains lifting in the breeze, wicker sofa with cushions, potted monstera and hanging plants, `
    + `warm wooden floorboards, sunbeams and dust motes, shells and books on a low shelf, `
    + `soft blue and cream palette, ${STYLE}`;

function curl(args, timeoutMs) {
  return execFileSync('curl.exe', ['-4', '-s', ...args], { encoding: 'utf8', timeout: timeoutMs });
}

async function genOnce(model) {
  writeFileSync(TMP_BODY, JSON.stringify({ model, prompt: PROMPT, n: 1, size: SIZE, response_format: 'url' }), 'ascii');
  rmSync(TMP_JSON, { force: true });
  curl(
    [
      '--max-time', '180', '--connect-timeout', '15',
      '-o', TMP_JSON,
      '-X', 'POST', `${BASE}/images/generations`,
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${KEY}`,
      '--data-binary', `@${TMP_BODY}`,
    ],
    200_000,
  );
  const json = JSON.parse(readFileSync(TMP_JSON, 'utf8'));
  const url = json?.data?.[0]?.url;
  if (!url) throw new Error(`no url: ${JSON.stringify(json?.error ?? json).slice(0, 140)}`);
  const target = join(dir, 'bg.png');
  rmSync(target, { force: true });
  curl(['--max-time', '120', '--connect-timeout', '15', '-o', target, url], 150_000);
  const buf = readFileSync(target);
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error(`not png (${buf.length} bytes)`);
  return { model, bytes: buf.length, size: `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` };
}

let result = null;
let lastErr = null;
for (const model of [MODEL, FALLBACK]) {
  try {
    result = await genOnce(model);
    break;
  } catch (err) {
    lastErr = err;
    console.log(`  ${model} 失败：${err.message}`);
  }
}
if (!result) {
  console.log('生成失败：', lastErr?.message);
  process.exit(1);
}
console.log(`ok default [${result.model}]: ${result.bytes} bytes ${result.size}`);

// 背景从 room.jpg 换成 bg.png（保留相对路径，舞台会自动补 token）
const cssPath = join(dir, 'style.css');
const css = readFileSync(cssPath, 'utf8');
if (css.includes('url("room.jpg")')) {
  writeFileSync(cssPath, css.replace('url("room.jpg")', 'url("bg.png")'));
  console.log('style.css: room.jpg → bg.png');
} else {
  console.log('style.css 已经指向别的图，跳过替换');
}

const legacy = join(dir, 'room.jpg');
if (existsSync(legacy)) {
  rmSync(legacy);
  console.log('removed room.jpg（背景改由 bg.png 提供）');
}
