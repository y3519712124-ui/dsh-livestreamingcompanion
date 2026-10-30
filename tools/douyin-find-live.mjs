/**
 * 用 Chrome 打开抖音直播首页，把页面上出现的直播间链接（web_rid）抓出来。
 *
 *   node tools/douyin-find-live.mjs
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(new URL('../packages/dsh-livestreamingcompanion/package.json', import.meta.url));
const WebSocket = require('ws');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'dy-find-'));
const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', '--disable-blink-features=AutomationControlled', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {
    /* wait */
  }
  if (!target) await sleep(250);
}
if (!target) {
  console.log('chrome not up');
  process.exit(1);
}

const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0;
const send = (method, params = {}) => cdp.send(JSON.stringify({ id: ++seq, method, params }));

cdp.on('open', () => {
  send('Page.enable');
  send('Runtime.enable');
  send('Page.navigate', { url: 'https://live.douyin.com/' });
  setTimeout(() => {
    send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        links: [...new Set([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /^\\/\\d{3,}$/.test(h)))].slice(0, 20),
        anyNumeric: [...new Set((document.body.innerHTML.match(/live\\.douyin\\.com\\/(\\d{3,})/g) || []))].slice(0, 10),
        text: document.body.innerText.slice(0, 300)
      })`,
      returnByValue: true,
    });
  }, 9000);
  setTimeout(() => {
    cdp.close();
    chrome.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 13000);
});

cdp.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.result?.result?.value) console.log(msg.result.result.value);
});
