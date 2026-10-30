/**
 * 每个主题都带一份字体，并把 style.css 里的 @font-face 改成相对路径。
 *
 * 为什么不能指向 /templates/default/fonts/...：舞台服务器的所有请求都要带 ?token，
 * 而 stage 只会给「相对 url()」补 token（见 src/stage/main.tsx 的正则），绝对路径会 401 → 字体悄悄失效。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'templates');
const ABSOLUTE = 'url("/templates/default/fonts/ZCOOLKuaiLe.woff2")';
const RELATIVE = 'url("fonts/ZCOOLKuaiLe.woff2")';

for (const id of readdirSync(root)) {
  if (id === 'default') continue;
  const dir = join(root, id);
  const fonts = join(dir, 'fonts');
  if (!existsSync(join(fonts, 'ZCOOLKuaiLe.woff2'))) cpSync(join(root, 'default', 'fonts'), fonts, { recursive: true });
  const file = join(dir, 'style.css');
  if (!existsSync(file)) continue;
  const css = readFileSync(file, 'utf8');
  if (css.includes(ABSOLUTE)) writeFileSync(file, css.replaceAll(ABSOLUTE, RELATIVE));
  console.log(`${id}: font=${existsSync(join(fonts, 'ZCOOLKuaiLe.woff2'))} css=${readFileSync(file, 'utf8').includes(RELATIVE)}`);
}
