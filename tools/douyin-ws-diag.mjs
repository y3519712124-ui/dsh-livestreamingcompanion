/**
 * 抖音 WSS 握手失败诊断：打印响应头、试 https 直取、试试不带 Cookie / 换路径。
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/dsh-livestreamingcompanion/package.json', import.meta.url));
const WebSocket = require('ws');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const jar = new Map();
function absorb(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://live.douyin.com/', ...(jar.size ? { Cookie: cookieHeader() } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  absorb(res);
  return res;
}

const home = await (await get('https://live.douyin.com/')).text();
const layouts = /id="script-layouts" data-value="([^"]+)"/.exec(home)?.[1] ?? '';
const layout = layouts ? JSON.parse(layouts.replace(/&quot;/g, '"')) : {};
const userUniqueId = String(layout.user_unique_id ?? '');

const webRid = process.argv[2] ?? '1';
const enter = await (
  await get(
    'https://live.douyin.com/webcast/room/web/enter/?' +
      new URLSearchParams({
        aid: '6383',
        app_name: 'douyin_web',
        live_id: '1',
        device_platform: 'web',
        language: 'zh-CN',
        enter_from: 'web_live',
        cookie_enabled: 'true',
        screen_width: '1920',
        screen_height: '1080',
        browser_language: 'zh-CN',
        browser_platform: 'Win32',
        browser_name: 'Chrome',
        browser_version: '130.0.0.0',
        web_rid: webRid,
      }).toString(),
  )
).json();
const roomId = enter?.data?.data?.[0]?.id_str ?? '';
const status = enter?.data?.data?.[0]?.status;
console.log(`room_id=${roomId} status=${status}`);

const params = new URLSearchParams({
  app_name: 'douyin_web',
  version_code: '180800',
  webcast_sdk_version: '1.0.14',
  update_version_code: '1.0.14',
  compress: 'gzip',
  device_platform: 'web',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Mozilla',
  browser_version: UA,
  browser_online: 'true',
  tz_name: 'Asia/Shanghai',
  cursor: '',
  internal_ext: '',
  host: 'true',
  aid: '6383',
  live_id: '1',
  did_rule: '3',
  endpoint: 'live_pc',
  support_wrds: '1',
  user_unique_id: userUniqueId,
  im_path: '/webcast/im/fetch/',
  identity: 'audience',
  need_persist_msg_count: '15',
  insert_task_id: '',
  live_reason: '',
  room_id: roomId,
  heartbeatDuration: '0',
});
const query = params.toString();
const sig = createHash('md5').update(query).digest('hex');

// 1. 同一地址用 https 取：看服务器到底回什么
for (const host of ['webcast5-ws-web-lf.douyin.com', 'webcast5-ws-web.douyin.com']) {
  const httpsUrl = `https://${host}/webcast/im/push/v2/?${query}&signature=${sig}`;
  const res = await fetch(httpsUrl, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader(), Origin: 'https://live.douyin.com', Referer: 'https://live.douyin.com/' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  console.log(`\n=== https ${host} → ${res.status} ${res.headers.get('content-type')}`);
  console.log([...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));
  console.log('body:', JSON.stringify(body.slice(0, 300)));
}

// 2. ws 握手，打印响应头
function handshake(host, path, extraHeaders) {
  return new Promise((resolve) => {
    const url = `wss://${host}${path}?${query}&signature=${sig}`;
    const ws = new WebSocket(url, { headers: { 'User-Agent': UA, ...extraHeaders }, handshakeTimeout: 8000 });
    const finish = (r) => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    ws.on('open', () => finish('101 OK'));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        finish(`HTTP ${res.statusCode} headers=${JSON.stringify(Object.fromEntries(res.headers))} body=${JSON.stringify(body.slice(0, 200))}`),
      );
    });
    ws.on('error', (e) => finish(`error ${e.message}`));
    ws.on('close', (c) => finish(`close ${c}`));
  });
}

console.log('\n=== ws handshake variants ===');
console.log('带 Cookie+Origin:', await handshake('webcast5-ws-web-lf.douyin.com', '/webcast/im/push/v2/', { Cookie: cookieHeader(), Origin: 'https://live.douyin.com' }));
console.log('不带任何头  :', await handshake('webcast5-ws-web-lf.douyin.com', '/webcast/im/push/v2/', {}));
console.log('根路径      :', await handshake('webcast5-ws-web-lf.douyin.com', '/', { Cookie: cookieHeader() }));
