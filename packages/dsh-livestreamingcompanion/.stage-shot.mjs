// packages/dsh-livestreamingcompanion/src/core/platforms/douyin/douyinBridge.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
var WS = WebSocket;
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
    if (/^https?:\/\//i.test(path)) continue;
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
  async launch(visible = false) {
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
        // 平时把窗口挪到屏幕外：带窗口的 Chrome 才连弹幕，但别让它挡着主播；
        // 登录时（visible）放到正常位置，让主人扫码/登录
        ...visible ? ["--window-position=80,60", "--window-size=1100,820"] : ["--window-position=-3200,-3200", "--window-size=1280,800"],
        ...this.options.extraArgs ?? [],
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: !visible }
    );
    this.proc.on("error", () => {
      this.proc = null;
      this.cdp = null;
    });
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
    this.cdp.on("error", () => {
    });
    this.cdp.on("close", () => {
      this.cdp = null;
    });
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
   * 把一串 Cookie（浏览器里复制的那种 `a=1; b=2`）塞进这个浏览器的会话。
   * 抖音的搜索/详情都要登录态：桥用临时 profile，不塞就等于没登录。
   */
  async applyCookies(cookie) {
    const pairs = cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const eq = part.indexOf("=");
      return eq > 0 ? { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() } : null;
    }).filter((p) => !!p?.name);
    let applied = 0;
    for (const pair of pairs) {
      try {
        const out = await this.call("Network.setCookie", {
          name: pair.name,
          value: pair.value,
          domain: ".douyin.com",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "None"
        });
        if (out?.success !== false) applied += 1;
      } catch {
      }
    }
    return applied;
  }
  /** 这个浏览器会话里的抖音 Cookie（整条，`a=1; b=2`） */
  async cookies() {
    const out = await this.call("Network.getAllCookies").catch(() => null) ?? await this.call("Storage.getCookies").catch(() => null);
    const list = Array.isArray(out?.cookies) ? out.cookies : [];
    return list.filter((c) => c?.name && /douyin|bytedance|zijie/i.test(String(c.domain ?? ""))).map((c) => `${c.name}=${c.value}`).join("; ");
  }
  /**
   * 开一个**看得见**的浏览器让主人自己登录抖音（扫码/短信都行），登完把整条 Cookie 取回来。
   * 插件不碰密码：只是在页面里检测到 sessionid 就说「好了」。
   */
  async login(timeoutMs = 18e4) {
    await this.launch(true);
    await this.call("Page.enable", {});
    await this.call("Network.enable", {});
    await this.call("Page.navigate", { url: "https://www.douyin.com/" });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2e3);
      const cookie = await this.cookies();
      if (/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_tt)=/.test(cookie)) return cookie;
    }
    throw new Error("\u7B49\u4E86\u4E09\u5206\u949F\u8FD8\u6CA1\u767B\u5F55\uFF08\u6CA1\u68C0\u6D4B\u5230 sessionid\uFF09\uFF1A\u7A97\u53E3\u8FD8\u5F00\u7740\u7684\u8BDD\u53EF\u4EE5\u76F4\u63A5\u518D\u70B9\u4E00\u6B21");
  }
  /**
   * 打开一个页面，截下它自己发的某个接口的 JSON 响应（页面会签名，我们不签）。
   * 用于抖音视频详情这类「Node 直连被 ArgusSecurityPlugin 挡」的接口；
   * 传了 cookie 就先塞进浏览器会话（搜索要登录态）。
   * abort：每 1.5 秒问一次页面（比如「是不是卡在验证码中间页」），返回非空就提前收手，
   * 免得在登录页/验证码页干等满超时。
   */
  async captureJson(url, pattern, timeoutMs = 2e4, cookie = "", abort) {
    await this.launch();
    await this.call("Page.enable", {});
    await this.call("Network.enable", {});
    if (cookie.trim()) await this.applyCookies(cookie);
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
      void (async () => {
        try {
          const body = await this.call("Network.getResponseBody", { requestId });
          if (typeof body?.body !== "string") return;
          try {
            done(JSON.parse(body.body));
          } catch {
            done(null);
          }
        } catch {
        }
      })();
    };
    this.cdp.on("message", handler);
    try {
      await this.call("Page.navigate", { url });
    } catch {
      this.cdp?.off("message", handler);
      return null;
    }
    const checker = abort ? setInterval(() => {
      void abort().then((reason) => {
        if (reason) done(null);
      }).catch(() => {
      });
    }, 1500) : null;
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([found, timer]);
    if (checker) clearInterval(checker);
    this.cdp?.off("message", handler);
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

// <stdin>
var bridge = new BrowserBridge({ warmupMs: 0, extraArgs: ["--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows"] });
await bridge.open("http://127.0.0.1:7390/?token=l7CssJh-l_fL4JGm&preview=1");
await bridge.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 4500));
var state = await bridge.evaluate("JSON.stringify({ title: document.title, body: document.body.className, phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '', waiting: !!document.querySelector('.ls-waiting'), char: !!document.querySelector('.ls-character'), tpl: document.querySelector('.ls-canvas')?.className ?? '' })", true);
console.log(state);
var shot = await bridge.call("Page.captureScreenshot", { format: "png" });
var fs = await import("node:fs");
fs.writeFileSync("tools\\.gen\\stage-preview.png", Buffer.from(shot.data, "base64"));
console.log("saved", "tools\\.gen\\stage-preview.png");
bridge.stop();
process.exit(0);
