/**
 * Capture real Douyin push frames (full base64) into a JSONL file for decoder validation.
 *
 *   node tools/douyin-capture.mjs [web_rid] [seconds] [outfile]
 *
 * Headful Chrome is required: headless never starts the chat client (verified 2026-10).
 * The window is placed off-screen; nothing is clicked.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(new URL('../packages/dsh-livestreamingcompanion/package.json', import.meta.url));
const WebSocket = require('ws');

const here = dirname(fileURLToPath(import.meta.url));
const webRid = process.argv[2] ?? '193671986973';
const seconds = Number(process.argv[3] ?? 25);
const outFile = process.argv[4] ?? join(here, 'douyin-frames.jsonl');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9340;
const profile = mkdtempSync(join(tmpdir(), 'dy-cap-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--window-position=-3200,-3200',
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {
    /* wait */
  }
  if (!target) await sleep(250);
}
if (!target) process.exit(1);

const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const call = (m, p) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method: m, params: p }));
  });
cdp.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});

const hook = `
(() => {
  const Orig = window.WebSocket;
  const store = (window.__dshDy = window.__dshDy || { urls: [], frames: [], seen: 0 });
  function Patched(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    try { store.urls.push(String(url)); } catch (e) {}
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.byteLength !== undefined) {
        const u8 = new Uint8Array(d);
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        store.frames.push(btoa(s));
        store.seen++;
      }
    });
    return ws;
  }
  Patched.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Orig[k];
  window.WebSocket = Patched;
})();
`;

let written = 0;
const lines = [];

cdp.on('open', async () => {
  await call('Page.enable', {});
  await call('Runtime.enable', {});
  await call('Page.addScriptToEvaluateOnNewDocument', { source: hook });
  await call('Page.navigate', { url: `https://live.douyin.com/${webRid}` });
  const deadline = Date.now() + seconds * 1000;
  let urlLogged = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const out = await call('Runtime.evaluate', {
      expression: `(() => { const s = window.__dshDy || {}; const f = (s.frames || []).splice(0); return JSON.stringify({ u: s.urls, n: f.length, f }); })()`,
      returnByValue: true,
    });
    const payload = JSON.parse(out?.result?.value ?? '{}');
    if (!urlLogged && payload.u?.length) {
      console.log('page websocket url:', payload.u.join('\n'));
      urlLogged = true;
    }
    for (const frame of payload.f ?? []) {
      lines.push(JSON.stringify({ at: Date.now(), b64: frame }));
      written += 1;
    }
    if (written && written % 10 === 0) console.log('captured', written, 'frames');
  }
  writeFileSync(outFile, lines.join('\n'));
  console.log(`saved ${written} frames -> ${outFile}`);
  cdp.close();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
});
