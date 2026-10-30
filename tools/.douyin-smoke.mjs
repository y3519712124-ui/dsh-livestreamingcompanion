import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinBridge.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var WS = require2("ws");
var CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];
function findBrowser(explicit) {
  const candidates = [explicit?.trim(), process.env.DOUYIN_CHROME, ...CHROME_CANDIDATES].filter((p) => !!p);
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
    }
  }
  return null;
}
var HOOK = `(() => {
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
})();`;
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("\u62FF\u4E0D\u5230\u7A7A\u95F2\u7AEF\u53E3")));
    });
  });
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var BrowserBridge = class {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  proc = null;
  cdp = null;
  profile = "";
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  get running() {
    return !!this.proc && !!this.cdp && this.cdp.readyState === WS.OPEN;
  }
  /** 打开页面并等直播间的弹幕客户端连上 */
  async open(url) {
    await this.launch();
    await this.call("Page.enable", {});
    await this.call("Runtime.enable", {});
    await this.call("Network.enable", {});
    await this.call("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await this.call("Page.navigate", { url });
    await sleep(this.options.warmupMs ?? 7e3);
  }
  async launch() {
    if (this.running) return;
    const browserPath = findBrowser(this.options.browserPath);
    if (!browserPath) throw new Error("\u627E\u4E0D\u5230 Chrome \u6216 Edge\uFF1A\u6296\u97F3\u5F39\u5E55\u8981\u501F\u6D4F\u89C8\u5668\u8FDE\uFF08\u8BBE\u7F6E\u91CC\u53EF\u4EE5\u586B\u6D4F\u89C8\u5668\u8DEF\u5F84\uFF09");
    const port = await freePort();
    this.profile = mkdtempSync(join(tmpdir(), "dsh-douyin-"));
    this.proc = spawn(
      browserPath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-media-suspend",
        "--disable-renderer-backgrounding",
        // 窗口挪到屏幕外：带窗口的 Chrome 才连弹幕，但别让它挡着主播
        "--window-position=-3200,-3200",
        "--window-size=1280,800",
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    this.proc.on("exit", () => {
      this.proc = null;
      this.cdp = null;
    });
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page") ?? null;
      } catch {
      }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("\u6D4F\u89C8\u5668\u6CA1\u8D77\u6765\uFF08\u8C03\u8BD5\u7AEF\u53E3\u6CA1\u54CD\u5E94\uFF09");
    this.cdp = new WS(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    this.cdp.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)?.(msg.result);
        this.pending.delete(msg.id);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("\u8FDE\u4E0D\u4E0A\u6D4F\u89C8\u5668\u7684\u8C03\u8BD5\u7AEF\u53E3")), 1e4);
      this.cdp.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.cdp.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.cdp || this.cdp.readyState !== WS.OPEN) return reject(new Error("\u6D4F\u89C8\u5668\u6865\u6CA1\u5F00"));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} \u8D85\u65F6`));
      }, 2e4);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.cdp.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 页面里跑一段 JS（返回值按 JSON 传回来） */
  async evaluate(expression, awaitPromise = true) {
    const out = await this.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (out?.exceptionDetails) return null;
    const value = out?.result?.value;
    return value ?? null;
  }
  /** 取走这次攒下的帧（base64），并报告页面连了哪些 ws（排错用） */
  async drain() {
    const raw = await this.evaluate(
      `(() => { const s = window.__dshDy || {}; const f = (s.frames || []).splice(0); return JSON.stringify({ u: s.urls || [], f }); })()`
    );
    if (!raw) return { frames: [], urls: [] };
    try {
      const parsed = JSON.parse(raw);
      return { frames: parsed.f ?? [], urls: parsed.u ?? [] };
    } catch {
      return { frames: [], urls: [] };
    }
  }
  /**
   * 打开一个页面，截下它自己发的某个接口的 JSON 响应（页面会签名，我们不签）。
   * 用于抖音视频详情这类「Node 直连被 ArgusSecurityPlugin 挡」的接口。
   */
  async captureJson(url, pattern, timeoutMs = 2e4) {
    await this.launch();
    await this.call("Page.enable", {});
    await this.call("Network.enable", {});
    let done = () => {
    };
    const found = new Promise((resolve) => {
      done = resolve;
    });
    const handler = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== "Network.responseReceived") return;
      const res = msg.params?.response;
      if (!res || !pattern.test(String(res.url))) return;
      const requestId = msg.params.requestId;
      void this.call("Network.getResponseBody", { requestId }).then((body) => {
        if (typeof body?.body !== "string") return;
        try {
          done(JSON.parse(body.body));
        } catch {
          done(null);
        }
      });
    };
    this.cdp.on("message", handler);
    await this.call("Page.navigate", { url });
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([found, timer]);
    this.cdp.off("message", handler);
    return result;
  }
  stop() {
    try {
      this.cdp?.close();
    } catch {
    }
    this.cdp = null;
    try {
      this.proc?.kill();
    } catch {
    }
    this.proc = null;
    if (this.profile) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
      } catch {
      }
      this.profile = "";
    }
  }
};

// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinDecode.ts
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// packages/dsh-livestreamingcompanion/src/core/platforms/pb.ts
function readPb(buf) {
  const fields = /* @__PURE__ */ new Map();
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (; ; ) {
      if (offset >= buf.length) throw new Error("truncated varint");
      const byte = buf[offset++];
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
      shift += 7n;
    }
  };
  while (offset < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    let value;
    switch (tag & 7) {
      case 0:
        value = varint();
        break;
      case 1:
        value = buf.readBigUInt64LE(offset);
        offset += 8;
        break;
      case 2: {
        const len = Number(varint());
        if (offset + len > buf.length) throw new Error("truncated field");
        value = buf.subarray(offset, offset + len);
        offset += len;
        break;
      }
      case 5:
        value = BigInt(buf.readUInt32LE(offset));
        offset += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${tag & 7}`);
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}
function pbNumber(msg, field) {
  const value = msg?.get(field)?.[0];
  return typeof value === "bigint" ? Number(value) : 0;
}
function pbId(msg, field) {
  const value = msg?.get(field)?.[0];
  return typeof value === "bigint" && value !== 0n ? value.toString() : "";
}
function pbString(msg, field) {
  const value = msg?.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}
function pbChild(msg, field) {
  const value = msg?.get(field)?.[0];
  if (!Buffer.isBuffer(value)) return void 0;
  try {
    return readPb(value);
  } catch {
    return void 0;
  }
}

// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinDecode.ts
var GIFT_NAMES = {
  "1": "\u5C0F\u5FC3\u5FC3",
  "5655": "\u73AB\u7470",
  "33666": "\u7C89\u4E1D\u56E2\u706F\u724C",
  "10134": "\u6296\u97F3",
  "309": "\u4EBA\u6C14\u7968",
  "16560": "\u5927\u5564\u9152",
  "16169": "\u5496\u5561",
  "31038": "\u5609\u5E74\u534E",
  "31037": "\u706B\u7BAD"
};
var GIFT_DIAMONDS = {
  "1": 1,
  "5655": 1,
  "33666": 1,
  "10134": 1,
  "309": 1,
  "16560": 10,
  "16169": 20,
  "31037": 1e4,
  "31038": 3e4
};
var seq = 0;
var nextId = (prefix) => `dy:${prefix}:${Date.now().toString(36)}${(++seq).toString(36)}`;
function chatId(common, user, text) {
  const msgId = pbId(common, 2);
  const digest = createHash("md5").update(`${user.id}|${text}`).digest("hex").slice(0, 10);
  return `dy:dm:${msgId || "x"}:${digest}`;
}
function userOf(msg, ctx) {
  const id = pbId(msg, 1);
  const name = pbString(msg, 3);
  const avatar = pbChild(msg, 9);
  const urls = avatar?.get(1) ?? [];
  const face = urls.map((u) => Buffer.isBuffer(u) ? u.toString("utf8") : "").find((u) => u.startsWith("http"));
  const club = pbChild(pbChild(msg, 24), 1);
  const clubName = pbString(club, 1);
  const clubLevel = pbNumber(club, 2);
  const user = { id, name };
  if (face) user.face = face.replace(/^http:/, "https:");
  if (!id || id === "111111" || name.includes("***")) user.masked = true;
  if (clubName && clubLevel) user.medal = { name: clubName, level: clubLevel, ofThisRoom: true };
  if (pbNumber(msg, 6) >= 0) {
  }
  void ctx;
  return user;
}
function chat(body, ctx, now) {
  const text = pbString(body, 3);
  const user = userOf(pbChild(body, 2), ctx);
  if (!text) return null;
  return { id: chatId(pbChild(body, 1), user, text), platform: "douyin", kind: "chat", ts: now, user, text };
}
function member(body, ctx, now) {
  const action = pbNumber(body, 10);
  const user = userOf(pbChild(body, 2), ctx);
  const count = pbNumber(body, 3);
  const out = [];
  if (action === 1) out.push({ type: "event", event: { id: nextId("enter"), platform: "douyin", kind: "enter", ts: now, user } });
  else if (action === 2) out.push({ type: "event", event: { id: nextId("follow"), platform: "douyin", kind: "follow", ts: now, user } });
  if (count > 0) out.push({ type: "stats", stats: { online: count } });
  return out;
}
function gift(body, ctx, now) {
  const g = pbChild(body, 15);
  const giftId = pbId(body, 2) || pbId(g, 5);
  const name = pbString(g, 2) || pbString(g, 16) || GIFT_NAMES[giftId] || `\u793C\u7269 ${giftId}`;
  const diamond = pbNumber(g, 12) || pbNumber(g, 19) || 0;
  const unit = diamond || GIFT_DIAMONDS[giftId] || 0;
  const count = pbNumber(body, 5) || pbNumber(body, 4) || 1;
  const group = pbId(body, 11) || pbString(body, 11) || pbId(body, 16);
  const user = userOf(pbChild(body, 7), ctx);
  const combo = group ? `${user.id}:${giftId}:${group}` : "";
  return {
    id: combo ? `dy:gift:${combo}` : nextId("gift"),
    platform: "douyin",
    kind: "gift",
    ts: now,
    user,
    giftName: name,
    count,
    // 抖币 → 元：1 元 = 10 抖币
    valueYuan: Math.round(unit * count / 10 * 100) / 100
  };
}
function like(body, ctx, now) {
  const total = pbNumber(body, 3);
  const out = [];
  if (total > 0) out.push({ type: "stats", stats: { likes: total } });
  out.push({ type: "event", event: { id: nextId("like"), platform: "douyin", kind: "like", ts: now, user: userOf(pbChild(body, 5), ctx) } });
  return out;
}
function social(body, ctx, now) {
  const user = userOf(pbChild(body, 2), ctx);
  const share = pbNumber(body, 3);
  if (share > 0) return { id: nextId("share"), platform: "douyin", kind: "share", ts: now, user };
  return { id: nextId("follow"), platform: "douyin", kind: "follow", ts: now, user };
}
function roomUserSeq(body) {
  const online = pbNumber(body, 10) || pbNumber(body, 7);
  const total = pbNumber(body, 7);
  const stats = {};
  if (online > 0) stats.online = online;
  if (total > 0) stats.watched = total;
  return Object.keys(stats).length ? [{ type: "stats", stats }] : [];
}
function roomStats(body) {
  const value = pbNumber(body, 9) || pbNumber(body, 5);
  return value > 0 ? [{ type: "stats", stats: { online: value } }] : [];
}
function decodeDouyinMessage(method, body, ctx, now = Date.now()) {
  const event = (e) => e ? [{ type: "event", event: e }] : [];
  switch (method) {
    case "WebcastChatMessage":
      return event(chat(body, ctx, now));
    case "WebcastGiftMessage":
      return event(gift(body, ctx, now));
    case "WebcastMemberMessage":
      return member(body, ctx, now);
    case "WebcastLikeMessage":
      return like(body, ctx, now);
    case "WebcastSocialMessage":
      return event(social(body, ctx, now));
    case "WebcastRoomUserSeqMessage":
      return roomUserSeq(body);
    case "WebcastRoomStatsMessage":
      return roomStats(body);
    case "WebcastRoomMessage": {
      const title = pbString(body, 3);
      return title ? [{ type: "room", title }] : [];
    }
    case "WebcastControlMessage": {
      const status = pbNumber(body, 2);
      if (status === 3) return [{ type: "stats", stats: { live: false } }];
      return [];
    }
    case "WebcastEmojiChatMessage": {
      const user = userOf(pbChild(body, 2), ctx);
      const text = pbString(body, 5);
      const image = pbString(body, 4);
      if (!text && !image) return [];
      return [
        {
          type: "event",
          event: { id: chatId(pbChild(body, 1), user, text || image || ""), platform: "douyin", kind: "chat", ts: now, user, text: text || "[\u8868\u60C5]", ...image ? { stickerUrl: image, emoteOnly: true } : {} }
        }
      ];
    }
    case "WebcastFansclubMessage": {
      const user = userOf(pbChild(body, 4), ctx);
      return event({ id: nextId("membership"), platform: "douyin", kind: "membership", ts: now, user, levelName: "\u7C89\u4E1D\u56E2", level: 1, count: 1, valueYuan: 0 });
    }
    default:
      return [];
  }
}
function decodePushFrame(raw, ctx, now = Date.now()) {
  let frame;
  try {
    frame = readPb(raw);
  } catch {
    return [];
  }
  const type = pbString(frame, 7);
  if (type === "hb") return [];
  let payload = frame.get(8)?.[0];
  if (!Buffer.isBuffer(payload) || !payload.length) return [];
  if (payload[0] === 31 && payload[1] === 139) {
    try {
      payload = gunzipSync(payload);
    } catch {
      return [];
    }
  }
  let res;
  try {
    res = readPb(payload);
  } catch {
    return [];
  }
  const messages = (res.get(1) ?? []).filter((m) => Buffer.isBuffer(m));
  const out = [];
  for (const m of messages) {
    let msg;
    try {
      msg = readPb(m);
    } catch {
      continue;
    }
    const method = pbString(msg, 1);
    const body = msg.get(2)?.[0];
    if (!method || !Buffer.isBuffer(body)) continue;
    try {
      out.push(...decodeDouyinMessage(method, readPb(body), ctx, now));
    } catch {
    }
  }
  return out;
}

// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinApi.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var TIMEOUT_MS = 12e3;
function cookieJar(cookie) {
  return cookie.trim().replace(/;\s*$/, "");
}
async function ensureTtwid(cookie) {
  if (/ttwid=/.test(cookie)) return cookieJar(cookie);
  try {
    const res = await fetch("https://live.douyin.com/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const ttwid = raw.map((line) => /^ttwid=([^;]+)/.exec(line)?.[1]).find(Boolean);
    void res.body?.cancel();
    return ttwid ? `${cookieJar(cookie)}${cookie ? "; " : ""}ttwid=${ttwid}` : cookieJar(cookie);
  } catch {
    return cookieJar(cookie);
  }
}
function pickString(value) {
  return typeof value === "string" && value ? value : void 0;
}
function toRoom(room, anchor) {
  const status = Number(room.status ?? 0);
  const avatarList = anchor?.avatar_thumb?.url_list;
  return {
    roomId: String(room.id_str ?? room.id ?? ""),
    status,
    live: status === 2,
    title: String(room.title ?? ""),
    ...pickString(anchor?.nickname) ? { anchorName: String(anchor?.nickname) } : {},
    ...pickString(anchor?.id_str) ? { anchorId: String(anchor?.id_str) } : {},
    ...Array.isArray(avatarList) && typeof avatarList[0] === "string" ? { avatar: avatarList[0] } : {},
    ...Number(room.user_count_str?.replace?.(/\D/g, "")) > 0 ? { online: Number(room.user_count_str.replace(/\D/g, "")) } : {}
  };
}
function enterUrl(webRid2) {
  return "https://live.douyin.com/webcast/room/web/enter/?" + new URLSearchParams({
    aid: "6383",
    app_name: "douyin_web",
    live_id: "1",
    device_platform: "web",
    language: "zh-CN",
    enter_from: "web_live",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Chrome",
    browser_version: "130.0.0.0",
    web_rid: String(webRid2)
  }).toString();
}
async function enterRoom(webRid2, cookie) {
  try {
    const jar = await ensureTtwid(cookie);
    const res = await fetch(enterUrl(webRid2), {
      headers: {
        "User-Agent": UA,
        Referer: `https://live.douyin.com/${webRid2}`,
        Accept: "application/json",
        ...jar ? { Cookie: jar } : {}
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const body = await res.json();
    const room = body.data?.data?.[0];
    if (body.status_code !== 0 || !room) return null;
    const anchor = room.owner ?? void 0;
    const parsed = toRoom(room, anchor);
    if (!parsed.anchorName) {
      const name = await anchorFromHtml(webRid2, jar);
      if (name) parsed.anchorName = name;
    }
    return parsed;
  } catch {
    return null;
  }
}
async function anchorFromHtml(webRid2, cookie) {
  try {
    const res = await fetch(`https://live.douyin.com/${webRid2}`, {
      headers: { "User-Agent": UA, ...cookie ? { Cookie: cookie } : {} },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const store = /"roomStore":(\{.*?"roomInfo":\{.*?\}\})/.exec(html)?.[1];
    if (store) {
      try {
        const info = JSON.parse(store)?.roomInfo;
        const name = info?.anchor?.nickname ?? info?.owner?.nickname;
        if (typeof name === "string" && name) return name;
      } catch {
      }
    }
    const alt = /"nickname":"([^"]{1,40}"?)/.exec(html)?.[1];
    return typeof alt === "string" && alt ? alt : null;
  } catch {
    return null;
  }
}

// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinSource.ts
var POLL_MS = 900;
var ROOM_REFRESH_MS = 6e4;
var SILENCE_LIMIT_MS = 1e4;
var MAX_BACKOFF_MS = 3e4;
var DouyinLiveSource = class {
  constructor(webRid2, options) {
    this.webRid = webRid2;
    this.options = options;
  }
  webRid;
  options;
  platform = "douyin";
  listener = null;
  bridge = null;
  pollTimer = null;
  roomTimer = null;
  retryTimer = null;
  backoffMs = 1e3;
  lastFrameAt = 0;
  stopped = true;
  room = null;
  ctx = { roomId: "", anchorId: "" };
  openedAt = 0;
  log(level, message) {
    this.options.log?.(level, message);
  }
  start(listener) {
    this.listener = listener;
    this.stopped = false;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.retryTimer = this.pollTimer = this.roomTimer = null;
    this.bridge?.stop();
    this.bridge = null;
    this.listener?.state("idle");
    this.listener = null;
  }
  async connect() {
    const listener = this.listener;
    if (this.stopped || !listener) return;
    listener.state(this.backoffMs > 1e3 ? "reconnecting" : "connecting");
    let room = await enterRoom(this.webRid, this.options.cookie);
    if (!room) this.log("warn", "\u6296\u97F3\u8FDB\u623F\u63A5\u53E3\u6CA1\u8FD4\u56DE\uFF0C\u76F4\u63A5\u7528\u6D4F\u89C8\u5668\u6865\uFF08\u623F\u95F4\u4FE1\u606F\u4ECE\u9875\u9762\u91CC\u53D6\uFF09");
    this.room = room;
    this.ctx = { roomId: room?.roomId ?? "", anchorId: room?.anchorId ?? "" };
    if (room) this.announce(room);
    const bridge = new BrowserBridge({ browserPath: this.options.browserPath });
    this.bridge = bridge;
    try {
      await bridge.open(`https://live.douyin.com/${this.webRid}`);
    } catch (err) {
      bridge.stop();
      this.bridge = null;
      this.scheduleRetry(err.message);
      return;
    }
    if (this.stopped) {
      bridge.stop();
      return;
    }
    if (!this.room) {
      const pageRoom = await this.roomFromPage(bridge);
      if (pageRoom) {
        this.room = pageRoom;
        this.ctx = { roomId: pageRoom.roomId, anchorId: pageRoom.anchorId ?? "" };
        this.announce(pageRoom);
      }
    }
    this.openedAt = Date.now();
    this.lastFrameAt = this.openedAt;
    this.startPolling(bridge);
    this.startRoomRefresh();
    this.backoffMs = 1e3;
    listener.state("connected", {
      loggedIn: false,
      error: this.room?.live === false ? "\u8FD9\u4E2A\u76F4\u64AD\u95F4\u73B0\u5728\u6CA1\u5728\u64AD\uFF08\u5F39\u5E55\u8981\u7B49\u5F00\u64AD\u624D\u4F1A\u6765\uFF09" : void 0
    });
    this.log("info", `\u6296\u97F3\u76F4\u64AD\u95F4 ${this.webRid} \u5DF2\u8FDE\u4E0A\uFF08\u6D4F\u89C8\u5668\u6865\uFF09`);
  }
  /** 页面里问一次进房接口：带页面 Cookie，比 Node 直连不容易被挡 */
  async roomFromPage(bridge) {
    const raw = await bridge.evaluate(`(async () => {
      const r = await fetch('/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&web_rid=${this.webRid}', { credentials: 'include' });
      const j = await r.json();
      const room = j?.data?.data?.[0];
      if (!room) return '';
      return JSON.stringify({ roomId: room.id_str, status: room.status, title: room.title, anchorName: room.owner?.nickname, anchorId: room.owner?.id_str, avatar: room.owner?.avatar_thumb?.url_list?.[0], online: Number(String(room.user_count_str || '').replace(/\\D/g, '')) });
    })()`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const status = Number(parsed.status ?? 0);
      return {
        roomId: String(parsed.roomId ?? ""),
        status,
        live: status === 2,
        title: String(parsed.title ?? ""),
        ...parsed.anchorName ? { anchorName: parsed.anchorName } : {},
        ...parsed.anchorId ? { anchorId: String(parsed.anchorId) } : {},
        ...parsed.avatar ? { avatar: parsed.avatar } : {},
        ...parsed.online ? { online: parsed.online } : {}
      };
    } catch {
      return null;
    }
  }
  announce(room) {
    const listener = this.listener;
    if (!listener) return;
    const info = {
      platform: "douyin",
      roomId: this.webRid,
      title: room.title || void 0,
      anchorName: room.anchorName,
      anchorId: room.anchorId
    };
    listener.room(info);
    listener.stats({
      live: room.live,
      ...room.online ? { online: room.online } : {}
    });
  }
  startPolling(bridge) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.poll(bridge);
    }, POLL_MS);
  }
  async poll(bridge) {
    const listener = this.listener;
    if (this.stopped || !listener || this.bridge !== bridge) return;
    let frames = [];
    try {
      const drained = await bridge.drain();
      frames = drained.frames;
    } catch (err) {
      this.scheduleRetry(`\u53D6\u5E27\u5931\u8D25\uFF1A${err.message}`);
      return;
    }
    const now = Date.now();
    if (!frames.length) {
      if (this.room?.live && now - this.lastFrameAt > SILENCE_LIMIT_MS && now - this.openedAt > 15e3) {
        this.scheduleRetry("10 \u79D2\u6CA1\u6709\u6536\u5230\u5F39\u5E55");
      }
      return;
    }
    this.lastFrameAt = now;
    for (const b64 of frames) {
      let outputs;
      try {
        outputs = decodePushFrame(Buffer.from(b64, "base64"), this.ctx, now);
      } catch (err) {
        this.log("warn", `\u89E3\u6296\u97F3\u5E27\u5931\u8D25\uFF1A${err.message}`);
        continue;
      }
      for (const out of outputs) {
        if (out.type === "event") listener.event(out.event);
        else if (out.type === "stats") listener.stats(out.stats);
        else if (out.type === "room" && out.title) listener.room({ platform: "douyin", roomId: this.webRid, title: out.title });
      }
    }
  }
  startRoomRefresh() {
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.roomTimer = setInterval(() => {
      void (async () => {
        if (this.stopped) return;
        const room = await enterRoom(this.webRid, this.options.cookie);
        if (!room) return;
        this.room = room;
        this.ctx = { roomId: room.roomId, anchorId: room.anchorId ?? this.ctx.anchorId };
        this.announce(room);
      })();
    }, ROOM_REFRESH_MS);
  }
  scheduleRetry(reason) {
    this.bridge?.stop();
    this.bridge = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.pollTimer = this.roomTimer = null;
    if (this.stopped) return;
    this.log("warn", `\u6296\u97F3\u76F4\u64AD\uFF1A${reason}\uFF0C${this.backoffMs / 1e3}s \u540E\u91CD\u8FDE`);
    this.listener?.state("reconnecting", { error: reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
};

// <stdin>
var webRid = Number(process.argv[2] ?? "0");
var seconds = Number(process.argv[3] ?? 35);
if (!webRid) {
  console.log("need web_rid");
  process.exit(2);
}
var source = new DouyinLiveSource(webRid, { cookie: "", log: (level, message) => console.log("[" + level + "]", message) });
var events = 0;
var kinds = /* @__PURE__ */ new Map();
source.start({
  event(event) {
    events += 1;
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    if (events <= 8) console.log("event", event.kind, JSON.stringify(event.user?.name), JSON.stringify(event.text ?? event.giftName ?? ""));
  },
  stats(stats) {
    if (Object.keys(stats).length) console.log("stats", JSON.stringify(stats));
  },
  room(info) {
    console.log("room", JSON.stringify(info));
  },
  state(state, detail) {
    console.log("state", state, detail?.error ?? "");
  }
});
setTimeout(() => {
  console.log("TOTAL events", events, JSON.stringify([...kinds.entries()]));
  source.stop();
  setTimeout(() => process.exit(events > 0 ? 0 : 3), 500);
}, seconds * 1e3);
