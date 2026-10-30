/**
 * Reconcile character packs with what is actually on disk, then rewrite character.json.
 *
 *   node tools/char-sync.mjs
 *
 * Why: the generators write a manifest only at the end of a pack, so a mid-run timeout
 * (this image host stalls randomly) leaves real art on disk with no manifest entry.
 * This scans for <mood>.webp/png and <action>-<n>.webp, converts PNG->WebP, and rebuilds
 * image.moods / image.frames without touching reactions or anything else.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const chars = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'characters');
const PACKS = ['dafeiyu-p2', 'dafeiyu-p3'];
const MOODS = ['laugh', 'shy', 'shocked', 'sad', 'think', 'angry', 'throw-bowl', 'sword-slash'];
const ACTIONS = ['throw-bowl', 'sword-slash'];

function toWebp(png) {
  const out = png.replace(/\.png$/, '.webp');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '88', '-compression_level', '4', out], { timeout: 180_000 });
  rmSync(png, { force: true });
  return out;
}

for (const dir of PACKS) {
  const packDir = join(chars, dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = readdirSync(packDir);

  // drop leftovers from interrupted fit steps
  for (const f of files) if (/\.tmp\.png$|\.pad\.png$/.test(f)) rmSync(join(packDir, f), { force: true });

  const present = new Set(readdirSync(packDir));
  manifest.image.moods ??= {};
  manifest.image.frames ??= {};

  for (const mood of MOODS) {
    if (present.has(`${mood}.webp`)) {
      manifest.image.moods[mood] = `${mood}.webp`;
      continue;
    }
    if (present.has(`${mood}.png`)) {
      const png = join(packDir, `${mood}.png`);
      const webp = toWebp(png);
      manifest.image.moods[mood] = webp.split(/[\\/]/).pop();
      continue;
    }
    delete manifest.image.moods[mood];
  }

  // 动作组自动发现：目录里的 <动作>-<n>.webp 全部收进 frames，并用最后一帧做单张兜底
  const groups = new Map();
  for (const f of readdirSync(packDir)) {
    const m = /^(.+)-(\d+)\.webp$/.exec(f);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ n: Number(m[2]), file: f });
  }
  for (const [action, list] of groups) {
    list.sort((a, b) => a.n - b.n);
    const frames = list.map((x) => x.file);
    if (frames.length >= 2) {
      manifest.image.frames[action] = frames;
      manifest.image.moods[action] = frames[frames.length - 1];
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `${dir}: moods=${Object.keys(manifest.image.moods).join(',') || '-'} frames=${Object.entries(manifest.image.frames)
      .map(([k, v]) => `${k}:${v.length}`)
      .join(',') || '-'}`,
  );
}
