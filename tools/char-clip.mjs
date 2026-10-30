/**
 * Encode an action's keyframes into a real alpha WebM clip (VP9, 24fps), the same shape
 * as P1's clips, and wire it into character.json as image.videos[<mood>].
 *
 *   node tools/char-clip.mjs                 # both packs, both actions
 *   node tools/char-clip.mjs --only=p2
 *   node tools/char-clip.mjs --verify        # 只用 Chrome 复核 alpha
 *
 * 注意：ffprobe 会把这种文件报成 yuv420p、ffmpeg 解帧也只有 rgb24 —— 那是解码器不认
 * 附加的 alpha stream，不代表文件没有 alpha。用 tools/webm-alpha.mjs（Chrome 采样）复核。
 *
 * 时间轴：7 个关键帧按 24fps 播放（约 292ms），最后一张再定格 160ms 收势。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const chars = join(here, '..', 'packages', 'dsh-livestreamingcompanion', 'assets', 'characters');
const tmp = join(here, '.gen');
mkdirSync(tmp, { recursive: true });

const PACKS = { p2: 'dafeiyu-p2', p3: 'dafeiyu-p3' };
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';

/** 目录里所有 <动作>-<n>.webp 分组（动作名自己发现，新增吃饭/捂笑不用改这里） */
function actionGroups(dir) {
  const groups = new Map();
  for (const f of readdirSync(dir)) {
    const m = /^(.+)-(\d+)\.webp$/.exec(f);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push(m[0]);
  }
  for (const [action, list] of groups) {
    list.sort((a, b) => Number(/(-(\d+)\.webp)$/.exec(a)[2]) - Number((/(-(\d+)\.webp)$/.exec(b)[2])));
    groups.set(action, list);
  }
  return groups;
}

for (const [key, dir] of Object.entries(PACKS)) {
  if (only && key !== only) continue;
  const packDir = join(chars, dir);
  const manifestPath = join(packDir, 'character.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.image.videos ??= {};

  for (const [action, frames] of actionGroups(packDir)) {
    if (frames.length < 8) {
      console.log(`${dir} ${action}: 帧数 ${frames.length} < 8，先不编`);
      continue;
    }
    const out = join(packDir, `${action}.webm`);
    // 关键帧编号可能是稀疏的（1,2,4,6,8,10,12），ffmpeg 的 image2 遇到空号会停，
    // 所以先按顺序拷成连续编号再喂进去
    const stage = join(tmp, `clip-${key}-${action}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    frames.forEach((file, i) => copyFileSync(join(packDir, file), join(stage, `${i + 1}.webp`)));
    const pattern = join(stage, '%d.webp');
    // 12 帧按 CLIP_FPS 播（默认 10fps ≈ 1.2s），再定格 CLIP_HOLD 秒收势。
    // 24fps 时整套动作只有 0.5s，眼睛来不及看；10fps + 定格 = 约 1.7s，接近动画「一拍三」。
    const fps = Number(process.env.CLIP_FPS ?? 10);
    const hold = Number(process.env.CLIP_HOLD ?? 0.5);
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-framerate', String(fps), '-i', pattern,
      '-vf', `tpad=stop_mode=clone:stop_duration=${hold},format=yuva420p`,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
      '-auto-alt-ref', '0', '-lag-in-frames', '0',
      '-b:v', '0', '-crf', '26', '-row-mt', '1', '-an',
      out,
    ], { timeout: 300_000 });
    const size = readFileSync(out).length;
    console.log(`${dir} ${action}.webm  ${frames.length} 帧 -> ${Math.round(size / 1024)}KB`);
    manifest.image.videos[action] = `${action}.webm`;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${dir}: videos=${Object.keys(manifest.image.videos).join(',') || '-'}`);
}
