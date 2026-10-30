/**
 * 一次性：把 OBS 那一层的旧名字 dsh-livestream 统一成 dsh-livestreamingcompanion。
 * 只改字符串字面量，别动逻辑。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const files = ['src/body/obs.ts', 'obs-setup-mc.cjs'];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let text = before;
  text = text.split("'dsh-livestream'").join("'dsh-livestreamingcompanion'");
  text = text.split('「dsh-livestream」').join('「dsh-livestreamingcompanion」');
  text = text.split('dsh-livestream → dshlivestream').join('dsh-livestreamingcompanion → dshlivestreamingcompanion');
  text = text.split('OBS 的 dsh-livestream 配置').join('OBS 的 dsh-livestreamingcompanion 配置');
  if (text === before) {
    console.log(`${file}: unchanged`);
    continue;
  }
  writeFileSync(file, text);
  console.log(`${file}: patched`);
}
