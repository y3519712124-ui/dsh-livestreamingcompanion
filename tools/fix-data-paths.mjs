/**
 * 一次性：把新数据目录 settings.json 里的旧路径改成新目录名。
 * 只动 <user>\.dsh\dsh-livestream\ 这一段，不碰别的。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.log('usage: node tools/fix-data-paths.mjs <settings.json>');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
const before = JSON.parse(raw);
const fixed = raw.split('\\dsh-livestream\\').join('\\dsh-livestreamingcompanion\\');
writeFileSync(file, fixed);
const after = JSON.parse(readFileSync(file, 'utf8'));
console.log('asrPython:', before.asrPython);
console.log('      ->:', after.asrPython);
console.log('other changed keys:', Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).join(', ') || '(none)');
