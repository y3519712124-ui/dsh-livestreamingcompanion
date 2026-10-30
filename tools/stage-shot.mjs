/**
 * 抓一张正在运行的舞台（不改任何东西），用于对比 ?preview=1 与不带参数的差别。
 *
 *   node tools/stage-shot.mjs <url> <out.png>
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const url = process.argv[2];
const out = process.argv[3] ?? join(here, '.gen', 'stage.png');
if (!url) {
  console.log('usage: node tools/stage-shot.mjs <url> [out.png]');
  process.exit(1);
}

const entry = `
import { BrowserBridge } from './src/core/platforms/douyin/douyinBridge';
const bridge = new BrowserBridge({ warmupMs: 0, extraArgs: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'] });
await bridge.open(${JSON.stringify(url)});
await bridge.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 4500));
const state = await bridge.evaluate("JSON.stringify({ title: document.title, body: document.body.className, phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '', waiting: !!document.querySelector('.ls-waiting'), char: !!document.querySelector('.ls-character'), tpl: document.querySelector('.ls-canvas')?.className ?? '' })", true);
console.log(state);
const shot = await bridge.call('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(${JSON.stringify(out)}, Buffer.from(shot.data, 'base64'));
console.log('saved', ${JSON.stringify(out)});
bridge.stop();
process.exit(0);
`;

const bundle = join(pkg, '.stage-shot.mjs');
await build({ entryPoints: [], stdin: { contents: entry, resolveDir: pkg }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['ws', 'bufferutil', 'utf-8-validate'], logLevel: 'error' });
await import(`file://${bundle.replace(/\\/g, '/')}`);
