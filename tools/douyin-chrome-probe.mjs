/**
 * 用本机 Chrome（CDP）打开抖音直播间，抓它自己发的 WebSocket 帧。
 *
 *   node tools/douyin-chrome-probe.mjs [web_rid] [--headful]
 *
 * 目的：验证「真浏览器能不能连上抖音弹幕服务器」——以此决定插件里做不做浏览器桥。
 * 只读：不注入脚本、不改页面、不登录。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(new URL('../packages/dsh-livestreamingcompanion/package.json', import.meta.url));
const WebSocket = require('ws');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const webRid = process.argv[2] ?? '1';
const headful = process.argv.includes('--headful');
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'dy-chrome-'));

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    ...(headful ? [] : ['--headless=new']),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await res.json();
    if (targets.length) break;
  } catch {
    /* not up yet */
  }
  await sleep(250);
}
if (!targets?.length) {
  console.log('Chrome 没起来');
  chrome.kill();
  process.exit(1);
}
console.log('chrome targets:', targets.map((t) => `${t.type}:${t.url}`).join(' | '));

const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0;
const send = (method, params = {}) => cdp.send(JSON.stringify({ id: ++seq, method, params }));

const sockets = new Map();
let frames = 0;
let firstPayload = null;

cdp.on('open', async () => {
  send('Network.enable');
  send('Page.enable');
  send('Page.navigate', { url: `https://live.douyin.com/${webRid}` });
  setTimeout(() => {
    send('Runtime.evaluate', {
      expression: 'JSON.stringify({href:location.href,title:document.title,body:document.body.innerText.slice(0,200)})',
      returnByValue: true,
    });
  }, 7000);
  setTimeout(() => finish(), 16000);
});

cdp.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === 'Network.webSocketCreated') {
    const url = msg.params.url;
    sockets.set(msg.params.requestId, url);
    console.log('\n[ws created]', url.slice(0, 180));
  } else if (msg.method === 'Network.webSocketWillSendHandshakeRequest') {
    console.log('[ws handshake request]', sockets.get(msg.params.requestId)?.slice(0, 100), 'headers:', Object.keys(msg.params.request.headers).join(','));
  } else if (msg.method === 'Network.webSocketHandshakeResponseReceived') {
    const r = msg.params.response;
    console.log(`[ws handshake response] status=${r.status} msg=${r.statusText} headers=${JSON.stringify(r.headers).slice(0, 300)}`);
  } else if (msg.method === 'Network.webSocketFrameReceived') {
    frames += 1;
    const p = msg.params.response;
    if (!firstPayload) firstPayload = p.payloadData;
    if (frames <= 12) console.log(`[ws frame ${frames}] opcode=${p.opcode} len=${p.payloadData.length} head=${p.payloadData.slice(0, 60)}`);
  } else if (msg.method === 'Network.webSocketClosed') {
    console.log('[ws closed]', msg.params.requestId);
  } else if (msg.id && msg.result?.result?.value) {
    console.log('\n[page]', msg.result.result.value);
  }
});

function finish() {
  console.log(`\n共 ${frames} 帧，socket ${sockets.size} 个`);
  try {
    cdp.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
}
