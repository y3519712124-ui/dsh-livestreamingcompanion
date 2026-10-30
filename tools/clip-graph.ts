// 开发工具：给角色包算「片段之间怎么切最不显眼」的表，写进角色包的 transitions.json（舞台换片段时用，见 src/stage/widgets.tsx ClipPlayer）。
// 换片段时，旧片段停在哪一帧是随机的。从第 0 帧开播的新片段如果姿势差得远，切的那一下就看得出来（交叉淡化会叠出两个头）。
//   - 切到循环片段（待机、说话）：不从第 0 帧开播，从和旧片段当前帧最像的那一帧开播（best）
//   - 切到要从头播的片段（表情、放下/拿起饭碗）：最多再等 WAIT_SEC，等旧片段转到和新片段第 0 帧最像的那一帧再切（wait）
// best 要求片段能快速跳到中间某帧：编码时每 8 帧一个关键帧（libvpx-vp9 加 -g 8 -keyint_min 8）。只有开头一个关键帧的话，跳到 4 秒处要解码将近一秒
// 用法：npx esbuild tools/clip-graph.ts --bundle --platform=node --format=esm --outfile=tools/clip-graph.mjs && node tools/clip-graph.mjs <角色包目录>
// 解码带透明通道的 VP9 要 libvpx：环境变量 DSH_FFMPEG 指向带 libvpx 的 ffmpeg（默认 PATH 里的 ffmpeg）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FFMPEG = process.env.DSH_FFMPEG || 'ffmpeg';
const W = 31;
const H = 54;
const WAIT_SEC = 0.35;
/** 每多等一帧算多少差异：一样像的话少等一点 */
const WAIT_COST = 0.4;

const dir = process.argv[2];
if (!dir) throw new Error('用法：node tools/clip-graph.mjs <角色包目录>');
const manifest = JSON.parse(readFileSync(join(dir, 'character.json'), 'utf8'));
const clips = manifest.clips;
const fps = 24;

/** 一段片段的每一帧：缩小、按透明度垫在灰底上，取 RGB */
function frames(file: string): Float32Array[] {
  const args = (codec: boolean) => [...(codec ? ['-c:v', 'libvpx-vp9'] : []), '-i', join(dir, file), '-vf', `fps=${fps},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  let raw: Buffer;
  try {
    raw = execFileSync(FFMPEG, ['-v', 'error', ...args(true)], { maxBuffer: 1 << 28 });
  } catch {
    raw = execFileSync(FFMPEG, ['-v', 'error', ...args(false)], { maxBuffer: 1 << 28 });
  }
  const size = W * H * 4;
  const out: Float32Array[] = [];
  for (let off = 0; off + size <= raw.length; off += size) {
    const f = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const a = raw[off + i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) f[i * 3 + c] = raw[off + i * 4 + c] * a + 128 * (1 - a);
    }
    out.push(f);
  }
  return out;
}

function dist(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const loops = [clips.idle, clips.talk].filter(Boolean) as string[];
const fromStart = [clips.out, clips.in, ...Object.values(clips.moods ?? {}), ...Object.values(clips.talkMoods ?? {})].filter(Boolean) as string[];
const all = [...new Set([...loops, ...fromStart])];
const data = new Map(all.map((name) => [name, frames(name)] as const));
console.log(all.map((n) => `${n} ${data.get(n)!.length} 帧`).join('，'));

const best: Record<string, number[]> = {};
const wait: Record<string, number[]> = {};
for (const src of all) {
  const s = data.get(src)!;
  for (const dst of loops) {
    if (dst === src) continue;
    const d = data.get(dst)!;
    best[`${src}>${dst}`] = s.map((f) => {
      let bi = 0;
      let bd = Infinity;
      d.forEach((g, j) => { const x = dist(f, g); if (x < bd) { bd = x; bi = j; } });
      return bi;
    });
  }
  for (const dst of fromStart) {
    if (dst === src) continue;
    const first = data.get(dst)![0];
    const near = s.map((f) => dist(f, first));
    const span = Math.round(WAIT_SEC * fps);
    wait[`${src}>${dst}`] = s.map((_, k) => {
      let bj = 0;
      let bc = Infinity;
      for (let j = 0; j <= span; j++) {
        const cost = near[(k + j) % s.length] + j * WAIT_COST;
        if (cost < bc) { bc = cost; bj = j; }
      }
      return bj;
    });
  }
}

writeFileSync(join(dir, 'transitions.json'), JSON.stringify({ format: 1, fps, best, wait }));
console.log(`→ ${join(dir, 'transitions.json')}：${Object.keys(best).length} 组「切到最像的那一帧」，${Object.keys(wait).length} 组「等一等再切」`);
