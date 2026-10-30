/**
 * 打开 DSH 的 Web UI，找出「右下角那只大肥鱼」到底是哪个元素/哪个插件画的。
 *
 *   node tools/dom-probe.mjs http://127.0.0.1:53549
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const url = process.argv[2];
if (!url) {
  console.log('usage: node tools/dom-probe.mjs <url>');
  process.exit(1);
}

const entry = `
import { BrowserBridge } from './src/core/platforms/douyin/douyinBridge';
const bridge = new BrowserBridge({ warmupMs: 0 });
await bridge.open(${JSON.stringify(url)});
await bridge.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 9000));

const script = \`(() => {
  const out = [];
  document.querySelectorAll('img, canvas, video, svg, div').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) return;
    // 只看右下角区域
    if (r.left < window.innerWidth * 0.5 || r.top < window.innerHeight * 0.3) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 120),
      id: el.id || '',
      src: el.currentSrc || el.src || '',
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      z: cs.zIndex,
      pos: cs.position,
      parentCls: (el.parentElement && el.parentElement.className ? el.parentElement.className.toString() : '').slice(0, 80),
    });
  });
  return JSON.stringify({ title: document.title, hits: out }, null, 2);
})()\`;

const res = await bridge.evaluate(script, true);
console.log(res);
bridge.stop();
process.exit(0);
`;

const bundle = join(pkg, '.dom-probe.mjs');
await build({ stdin: { contents: entry, resolveDir: pkg }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['ws', 'bufferutil', 'utf-8-validate'], logLevel: 'error' });
await import(`file://${bundle.replace(/\\/g, '/')}`);
