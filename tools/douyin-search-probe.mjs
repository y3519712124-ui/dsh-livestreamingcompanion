/**
 * 抖音搜索接口探针：打开搜索页，把页面自己发的那次搜索请求截下来。
 *
 *   node tools/douyin-search-probe.mjs [关键词] [--headful]
 *
 * 输出：搜索接口 URL、响应体结构、结果条数、DOM 里的 /video/ 链接数，
 * 以及「页面里自己 fetch 一次搜索接口」能不能过（验 UIFID / a_bogus 到底缺哪个）。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(new URL('../packages/dsh-livestreamingcompanion/package.json', import.meta.url));
const WS = require('ws');

const here = dirname(fileURLToPath(import.meta.url));
const keyword = process.argv[2] ?? '猫';
const headful = process.argv.includes('--headful');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9341;
const profile = mkdtempSync(join(tmpdir(), 'dy-search-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    ...(headful ? ['--window-position=-3200,-3200', '--window-size=1280,860'] : ['--headless=new']),
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
if (!target) {
  console.log('chrome 没起来');
  process.exit(1);
}

const cdp = new WS(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30_000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    cdp.send(JSON.stringify({ id, method, params }));
  });

const hits = [];
cdp.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const url = msg.params.request.url;
    if (/search|aweme\/v1\/web|general/i.test(url)) console.log('[req]', msg.params.request.method, url.slice(0, 220));
  }
  if (msg.method === 'Network.responseReceived') {
    const url = msg.params.response.url;
    if (/general\/search|search\/single|aweme\/v1\/web\/search|search\/item/i.test(url)) {
      hits.push({ requestId: msg.params.requestId, url, status: msg.params.response.status });
    }
  }
});

cdp.on('open', async () => {
  await call('Page.enable');
  await call('Network.enable');
  await call('Runtime.enable');
  await call('Page.navigate', { url: `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video` });
  await sleep(9000);

  console.log(`\n=== 截到的搜索响应 ${hits.length} 条 ===`);
  for (const hit of hits.slice(0, 3)) {
    console.log(`\n[${hit.status}] ${hit.url.slice(0, 300)}`);
    try {
      const body = await call('Network.getResponseBody', { requestId: hit.requestId });
      const text = typeof body?.body === 'string' ? body.body : '';
      console.log('  body:', text.length, 'B');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        console.log('  非 JSON:', JSON.stringify(text.slice(0, 160)));
        continue;
      }
      console.log('  keys:', Object.keys(json).join(', '));
      console.log('  status_code:', json.status_code, 'data keys:', json.data ? Object.keys(json.data).join(', ') : '(none)');
      const list = json.data ?? [];
      const first = Array.isArray(list) ? list[0] : null;
      if (first) {
        console.log('  first item type:', first.type, 'aweme_info?', !!first.aweme_info, 'keys:', Object.keys(first).join(','));
        const aweme = first.aweme_info ?? first;
        console.log('  desc:', JSON.stringify(String(aweme.desc ?? '').slice(0, 60)), 'author:', aweme.author?.nickname, 'id:', aweme.aweme_id);
      }
      writeFileSync(join(here, '.douyin-search-sample.json'), JSON.stringify(json, null, 1).slice(0, 400_000));
    } catch (err) {
      console.log('  取 body 失败:', err.message);
    }
  }

  // 页面里自己 fetch 一次（带页面 cookie，不带 a_bogus）：看 Argus 让不让过
  const probe = await call('Runtime.evaluate', {
    expression: `(async () => {
      const q = new URLSearchParams({ device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', search_channel: 'aweme_video_web', keyword: ${JSON.stringify(keyword)}, search_source: 'tab_search', query_correct_type: '1', is_filter_search: '0', from_group_id: '', offset: '0', count: '10', pc_client_type: '1', version_code: '170400', version_name: '17.4.0', cookie_enabled: 'true', screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '130.0.0.0', browser_online: 'true', engine_name: 'Blink', engine_version: '130.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC' });
      try {
        const r = await fetch('/aweme/v1/web/general/search/single/?' + q.toString(), { credentials: 'include' });
        const t = await r.text();
        return JSON.stringify({ status: r.status, len: t.length, head: t.slice(0, 200) });
      } catch (e) { return JSON.stringify({ error: String(e) }); }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('\n[in-page fetch 搜索接口]', probe?.result?.value ?? JSON.stringify(probe).slice(0, 300));

  const dom = await call('Runtime.evaluate', {
    expression: `JSON.stringify({ href: location.href, links: document.querySelectorAll('a[href*="/video/"]').length, cards: document.querySelectorAll('[data-e2e="scroll-list"] li').length, title: document.title, bodyHead: document.body.innerText.slice(0, 200) })`,
    returnByValue: true,
  });
  console.log('[dom]', dom?.result?.value ?? '');

  cdp.close();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
});
