/**
 * Take one "real stage" thumbnail per theme: background + panels + demo chat/gift content.
 * Keeps the console gallery visually consistent and shows what a theme looks like live.
 *
 *   node tools/theme-shots.mjs
 *   node tools/theme-shots.mjs --only=forest-mist
 *   SHOT_WAIT=15000 node tools/theme-shots.mjs --only=default
 *
 * How: boots the plugin's own StageServer on a throwaway port/token, opens
 *   /?token=shots&preview=1&demo=1&template=<id>
 * so the server's hello event carries the forced template (no settings touched),
 * then screenshots 1920x1080 over CDP. PNGs land in tools/.shots/<id>.png and are
 * downscaled to each theme's preview.jpg by tools/shots-to-previews.ps1.
 *
 * ASCII-only on purpose: PowerShell 5.1 rewrote this file once and mangled the Chinese
 * comments, so the tool keeps its own output in English.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'packages', 'dsh-livestreamingcompanion');
const outDir = join(here, '.shots');
const bundle = join(pkg, '.theme-shots.mjs');

const { build } = createRequire(join(pkg, 'package.json'))('esbuild');

const entry = `
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Packs } from './src/body/packs';
import { StageServer } from './src/body/server';
import { BrowserBridge } from './src/core/platforms/douyin/douyinBridge';

const only = process.env.SHOT_ONLY ?? '';
const waitMs = Number(process.env.SHOT_WAIT ?? 9400);
const ids = ['default', 'forest-mist', 'observatory', 'sakura-cafe', 'cloud-library', 'neon-rain', 'winter-greenhouse']
  .filter((id) => !only || id === only);

const packageDir = ${JSON.stringify(pkg)};
const outDir = ${JSON.stringify(outDir)};
const packs = new Packs(packageDir, join(packageDir, '.no-user-packs'));
const server = new StageServer({
  port: 7491,
  token: 'shots',
  packageDir,
  packs,
  stage: { subscribe: () => () => {} },
  current: () => ({ character: process.env.SHOT_CHAR ?? 'dafeiyu', template: 'default' }),
  log: (level, message) => { if (level === 'warn') console.log('[stage]', message); },
});
await server.start();
console.log('stage up:', server.url);

const bridge = new BrowserBridge({ extraArgs: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (const id of ids) {
    const url = 'http://127.0.0.1:7491/?token=shots&preview=1&demo=1&template=' + encodeURIComponent(id);
    await bridge.open(url);
    // canvas is 1920x1080: force the viewport to match so the shot is a clean 16:9
    await bridge.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 40; i++) {
      const ready = await bridge.evaluate('[...document.images].every((img) => img.complete && img.naturalWidth > 0)');
      if (ready === true) break;
      await sleep(250);
    }
    // demo timeline: opening 5.2s, say at +2.7s, gift at +8.6s
    if (process.env.SHOT_TRACE === '1') {
      // 200ms sampling, print only when the drawn frame changes (frame sequences show up here)
      let last = '';
      for (let i = 0; i < Math.ceil(waitMs / 200); i++) {
        const state = await bridge.evaluate(
          "JSON.stringify([document.querySelector('.ls-character')?.dataset.mood ?? '', document.querySelector('.ls-image')?.getAttribute('src')?.split('/').pop()?.split('?')[0] ?? '', '', (()=>{const c=document.querySelector('canvas.ls-action'); if(!c) return 'nocanvas'; try { return c.getContext('2d').getImageData(1,1,1,1).data.join(',')+'|'+getComputedStyle(c).backgroundColor; } catch(e){ return 'err:'+e.message; } })()])",
        );
        if (state && state !== last) {
          console.log('  ' + ((i * 200) / 1000).toFixed(1) + 's ' + state);
          last = state;
        }
        await sleep(200);
      }
    } else {
      await sleep(waitMs);
    }
    const shot = await bridge.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (!shot?.data) throw new Error(id + ': screenshot returned no data');
    const bytes = Buffer.from(shot.data, 'base64');
    writeFileSync(join(outDir, id + '.png'), bytes);
    console.log('shot', id, bytes.length, 'bytes');
  }
} finally {
  bridge.stop();
  server.stop();
}
`;

mkdirSync(outDir, { recursive: true });

await build({
  stdin: { contents: entry, resolveDir: pkg, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundle,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';
const child = spawn(process.execPath, [bundle], { stdio: 'inherit', env: { ...process.env, SHOT_ONLY: onlyArg } });
child.on('exit', (code) => process.exit(code ?? 1));
