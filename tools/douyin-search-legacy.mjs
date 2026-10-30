/**
 * 无登录也能用的抖音搜索接口排查：试几个历史接口 / 不同域名，看有没有一个还开着。
 *   node tools/douyin-search-legacy.mjs 猫
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const keyword = process.argv[2] ?? '猫';

// 拿一个匿名 ttwid，有些接口要
const jar = new Map();
const home = await fetch('https://www.douyin.com/', { headers: { 'User-Agent': UA } });
for (const line of typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : []) {
  const pair = line.split(';')[0];
  const eq = pair.indexOf('=');
  if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
}
void (await home.text());
const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
console.log('cookie:', [...jar.keys()].join(', '));

const common = new URLSearchParams({
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '170400',
  version_name: '17.4.0',
  cookie_enabled: 'true',
  platform: 'PC',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '130.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '130.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  keyword,
  count: '10',
  offset: '0',
});

const targets = [
  ['iesdouyin general/search', `https://www.iesdouyin.com/web/api/v2/general/search/single/?${new URLSearchParams({ keyword, count: '10', offset: '0' })}`, UA],
  ['iesdouyin aweme/v1', `https://www.iesdouyin.com/aweme/v1/web/general/search/single/?${common}`, UA],
  ['m.douyin search', `https://m.douyin.com/aweme/v1/web/general/search/single/?${common}`, MOBILE_UA],
  ['aweme.snssdk general', `https://aweme.snssdk.com/aweme/v1/general/search/single/?${new URLSearchParams({ keyword, count: '10', offset: '0', aid: '1128', device_platform: 'android' })}`, MOBILE_UA],
  ['douyin general/search/single', `https://www.douyin.com/aweme/v1/web/general/search/single/?${common}&search_channel=aweme_video_web&search_source=tab_search&query_correct_type=1&is_filter_search=0`, UA],
];

for (const [label, url, ua] of targets) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Referer: 'https://www.douyin.com/', ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(12_000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    const count = json?.data?.length ?? json?.data?.data?.length ?? 0;
    console.log(`${label.padEnd(28)} HTTP ${res.status} ${String(text.length).padStart(6)}B status=${json?.status_code ?? '?'} items=${count} ${json?.status_msg ? JSON.stringify(json.status_msg) : ''}`);
    if (count) console.log('   first:', JSON.stringify(json.data?.[0] ?? json.data?.data?.[0]).slice(0, 200));
  } catch (err) {
    console.log(`${label.padEnd(28)} ERR ${err.message}`);
  }
}
