/**
 * Shrink character art: PNG -> WebP (alpha kept), and point character.json at the .webp files.
 *
 *   node tools/char-webp.mjs
 *
 * 875x1494 idle goes from ~1.8 MB to ~260 KB (7x smaller) with no visible loss at stage
 * scale, which matters because the stage preloads every mood image of the current character.
 * idle.png is kept as the fitting reference for tools/char-moods.mjs; action/mood PNGs are
 * replaced (the .webp becomes the runtime file).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const chars = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'characters');
const PACKS = ['dafeiyu-p2', 'dafeiyu-p3'];

function webp(src, out) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '88', '-compression_level', '4', out], { timeout: 180_000 });
}

for (const dir of PACKS) {
  const packDir = join(chars, dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let saved = 0;

  // idle: keep the PNG (source of truth for fitting), add a webp twin and use it at runtime
  const idlePng = join(packDir, 'idle.png');
  if (existsSync(idlePng)) {
    const idleWebp = join(packDir, 'idle.webp');
    webp(idlePng, idleWebp);
    saved += readFileSync(idlePng).length - readFileSync(idleWebp).length;
    if (manifest.image) manifest.image.idle = 'idle.webp';
  }

  for (const [key, file] of Object.entries(manifest.image?.moods ?? {})) {
    if (!file.endsWith('.png')) continue;
    const src = join(packDir, file);
    if (!existsSync(src)) continue;
    const out = join(packDir, file.replace(/\.png$/, '.webp'));
    webp(src, out);
    saved += readFileSync(src).length - readFileSync(out).length;
    manifest.image.moods[key] = file.replace(/\.png$/, '.webp');
    rmSync(src, { force: true });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${dir}: saved ${Math.round(saved / 1024)} KB, moods=${Object.keys(manifest.image?.moods ?? {}).join(',') || '-'}`);
}
