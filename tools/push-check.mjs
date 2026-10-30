/**
 * 自检：不真的开播，只看多平台推流的参数拼得对不对、两条链路能不能出帧。
 *
 *   node tools/push-check.mjs
 *
 * 1) test 画面：lavfi 彩条 → H.264/AAC，0.5 秒，输出丢 null；
 * 2) capture 链路：浏览器那种 WebM → pipe:0 → H.264/AAC，0.6 秒，输出丢 null。
 * 两步都不联网，只验证编码/转码链。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const dir = mkdtempSync(join(tmpdir(), 'push-check-'));
const file = join(dir, 'push.mjs');
await build({
  entryPoints: [join(pkg, 'src/body/push.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: file,
  logLevel: 'error',
});

const { Push } = await import(`file://${file.split('\\').join('/')}`);
const configPath = join(dir, 'push.json');
writeFileSync(configPath, JSON.stringify({ targets: {} }));

const push = new Push(configPath);
console.log('engine:', push.detect());

push.update({ input: 'test' });
push.update({ target: { id: 'douyin', value: { server: 'rtmp://push-douyin-pub.douyinstatic.com/live', key: 'STREAM-KEY-A', on: true } } });
push.update({ target: { id: 'huya', value: { server: 'rtmp://open.live.huya.com/live', key: 'STREAM-KEY-B', on: true } } });
push.update({ target: { id: 'douyu', value: { server: 'rtmp://send.douyu.com/live', key: 'STREAM-KEY-C', on: false } } });

const args = push.args();
console.log('\nffmpeg args:\n' + args.join(' ') + '\n');
console.log('active targets:', push.activeUrls().map((u) => u.replace(/STREAM-KEY-[A-Z]/, '***')));

/** 把「-f flv url…」输出段切掉，换成 null 输出 */
function encodeOnly(list) {
  const cut = list.findIndex((a, i) => a === 'flv' && list[i - 1] === '-f');
  return (cut > 1 ? list.slice(0, cut - 1) : list).filter((a) => a !== '-re');
}

// 1) test 画面
try {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', ...encodeOnly(args), '-t', '0.5', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  console.log('\nencode check (test): OK');
} catch (err) {
  console.log('\nencode check (test): FAILED\n' + String(err.stderr?.toString?.() ?? err.message).slice(0, 500));
}

// 2) capture 链路：先造一段浏览器同款 WebM(VP8/Opus)，再从 stdin 喂进去
const sample = join(dir, 'sample.webm');
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '1', '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-b:a', '96k', sample,
], { timeout: 120_000 });

push.update({ input: 'capture' });
const captureArgs = encodeOnly(push.args());
try {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', ...captureArgs, '-t', '0.6', '-f', 'null', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
    input: readFileSync(sample),
  });
  console.log('capture check: OK（WebM(pipe:0) → H.264/AAC）');
} catch (err) {
  console.log('capture check: FAILED\n' + String(err.stderr?.toString?.() ?? err.message).slice(0, 500));
}

console.log('\n配置写入：', join(configPath));
