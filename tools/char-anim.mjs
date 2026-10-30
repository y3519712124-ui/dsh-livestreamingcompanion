/**
 * Turn the still P2 / P3 sprites into short looping clips so they use the same
 * animated renderer as P1 (clips): idle breathing + talk bob, VP9 with alpha.
 *
 *   node tools/char-anim.mjs              # every pack that has idle.png
 *   node tools/char-anim.mjs --only=p2
 *
 * The sprite stays a single PNG; motion comes from ffmpeg (bob + sway on a
 * transparent canvas), which is cheap, repeatable, and keeps her on-model.
 * ASCII only: editing this file through PowerShell text cmdlets corrupts it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const chars = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'characters');

const FPS = 24;
const PACKS = {
  p2: 'dafeiyu-p2',
  p3: 'dafeiyu-p3',
};

function measure(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .toString()
    .trim()
    .split(',')
    .map(Number);
  return { w, h };
}

/**
 * idle: 3.0s loop, 6px bob + 4px sway (period 3s) - reads as breathing
 * talk: 0.8s loop, 3px bob at 2.5Hz + 2px sway - reads as talking
 */
function clips(sprite, box, out) {
  const canvas = `${box.w}x${box.h}`;
  const runs = [
    { file: join(out, 'idle.webm'), duration: 3, bob: 6, sway: 4, freq: 1 / 3 },
    { file: join(out, 'talk.webm'), duration: 0.8, bob: 3, sway: 2, freq: 2.5 },
  ];
  for (const run of runs) {
    const filter = [
      '[1:v]format=rgba[sp]',
      `[0:v][sp]overlay=x='(W-w)/2 + ${run.sway}*sin(2*PI*t*${run.freq})':y='(H-h)/2 + ${run.bob}*sin(2*PI*t*${run.freq} + PI/2)':eval=frame:format=auto[o]`,
    ].join(';');
    execFileSync(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=black@0:s=${canvas}:d=${run.duration}:r=${FPS},format=rgba`,
        '-loop', '1', '-i', sprite,
        '-filter_complex', filter,
        '-map', '[o]',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '34',
        '-auto-alt-ref', '0', '-row-mt', '1', '-an',
        run.file,
      ],
      { stdio: 'inherit', timeout: 300_000 },
    );
    console.log(`  ${run.file.split(/[\\/]/).pop()} ${run.duration}s @${FPS}fps ${canvas}`);
  }
}

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
for (const [key, dir] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, dir);
  const sprite = join(packDir, 'idle.png');
  if (!existsSync(sprite)) {
    console.log(`skip ${key}: no idle.png`);
    continue;
  }
  const src = measure(sprite);
  // leave room for the bob so the sprite never gets clipped mid-breath
  const box = { w: Math.round(src.w * 1.08), h: Math.round(src.h * 1.1) };
  console.log(`${key}: sprite ${src.w}x${src.h} -> canvas ${box.w}x${box.h}`);
  clips(sprite, box, packDir);

  const manifestPath = join(packDir, 'character.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.renderer = 'clips';
  manifest.clips = { size: [box.w, box.h], idle: 'idle.webm', talk: 'talk.webm', moods: {} };
  delete manifest.image;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${key}: manifest -> clips (idle/talk), size ${box.w}x${box.h}`);
}
