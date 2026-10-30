/**
 * 抖音直播接口探针：验证「取 ttwid → 首页找房间 → 进房接口」这条链路在本机网络下是否可用、
 * 以及不带签名（a_bogus）时接口还回不回数据。只读，不写任何文件。
 *
 *   node tools/douyin-probe.mjs [web_rid]
 *
 * 输出每一步的 HTTP 状态、关键字段，失败时贴出前 300 字响应体。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 极简 cookie 罐：只记 name=value */
const jar = new Map();

function absorbCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function get(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://live.douyin.com/',
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...extraHeaders,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  absorbCookies(res);
  return res;
}

function show(label, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const [webRidArg] = process.argv.slice(2);

// 1. 首页：拿 ttwid / msToken 这类匿名 Cookie
try {
  const res = await get('https://live.douyin.com/');
  const html = await res.text();
  show('GET live.douyin.com', res.ok, `HTTP ${res.status}，${html.length} 字节，cookie: ${[...jar.keys()].join(', ') || '无'}`);
  if (!webRidArg) {
    const rids = [...html.matchAll(/live\.douyin\.com\/(\d{3,})/g)].map((m) => m[1]);
    const uniq = [...new Set(rids)].slice(0, 5);
    console.log(`  首页里看到的房间号（前 5 个）：${uniq.join(', ') || '没找到（可能要渲染后才出现）'}`);
  }
} catch (err) {
  show('GET live.douyin.com', false, err.message);
}

const webRid = webRidArg || '1';
const enterUrl =
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
  }).toString();

try {
  const res = await get(enterUrl);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  const room = body?.data?.data?.[0];
  show('GET webcast/room/web/enter', res.ok && !!room, `HTTP ${res.status}，status_code=${body?.status_code ?? '?'}`);
  if (room) {
    console.log(
      `  room_id=${room.id_str ?? room.id} 标题=${JSON.stringify(room.title)} 主播=${room.owner?.nickname} 开播状态=${room.status} 在线=${room.user_count_str ?? room.stats?.total_user ?? '?'}`,
    );
  } else {
    console.log(`  响应体前 300 字：${text.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
} catch (err) {
  show('GET webcast/room/web/enter', false, err.message);
}

// 3. 顺便看看分享短链能不能解析（不传参数就跳过）
const share = process.env.DOUYIN_SHARE;
if (share) {
  try {
    const res = await fetch(share, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    show('resolve share link', true, `HTTP ${res.status} → ${res.headers.get('location')?.slice(0, 160)}`);
  } catch (err) {
    show('resolve share link', false, err.message);
  }
}
