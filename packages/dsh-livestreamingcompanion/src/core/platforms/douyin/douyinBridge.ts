/**
 * 抖音浏览器桥：开一个「看不见的 Chrome 窗口」停在抖音直播间/视频页上，把页面自己收到的
 * 弹幕帧（base64）取回来。
 *
 * 为什么要有这一层（2026-10 实测）：
 * - Node 直连 wss://webcast*-ws-web-*.douyin.com 会被 CDN 拒：HTTP 200 + `handshake-msg: DEVICE_BLOCKED`；
 *   signature 用 md5(query) 的 hex、16 字符签名、干脆不带，三种都是同一个结果。
 * - 真 Chrome 打开直播间就能连上（截到的是 `signature=64VRjIHYpMbQkOkR` 这种 16 字符签名）。
 * - headless 的 Chrome 不会启动弹幕客户端（一帧都没有）；必须带窗口跑，所以窗口挪到屏幕外。
 *
 * 桥不去复刻签名：它在页面脚本之前挂一层 WebSocket 钩子，页面自己的客户端连上以后，
 * 收到的每一帧都被抄一份，Node 这边只负责解 protobuf。抖音改签名也不影响我们。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// ws 必须**静态** import：插件装到 profile 里时不带 devDependencies（ws 只在 devDependencies），
// 用 createRequire('ws') 运行时就会 Cannot find module 'ws'。静态 import 会被 esbuild 打进包里，
// 和 B 站那条（biliSource）一样的处理。类型上这里放宽成 any：Node 的全局 WebSocket 和 ws 的类型会打架。
const WS: any = WebSocket;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findBrowser(explicit?: string): string | null {
  const candidates = [explicit?.trim(), process.env.DOUYIN_CHROME, ...CHROME_CANDIDATES].filter((p): p is string => !!p);
  for (const path of candidates) {
    // 有人会把直播间链接填进「浏览器路径」：那不是可执行文件，跳过（后面还有自动找 Chrome）
    if (/^https?:\/\//i.test(path)) continue;
    try {
      if (existsSync(path)) return path;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 页面里挂的钩子：抄 WebSocket 收到的二进制帧 */
const HOOK = `(() => {
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BridgeOptions {
  /** 浏览器可执行文件；空则自动找 Chrome / Edge */
  browserPath?: string;
  /** 页面打开后等多久才开始取帧（抖音直播页大约 6~10 秒才连上） */
  warmupMs?: number;
  /** 额外的 Chrome 启动参数（截图工具用：关掉「窗口被遮挡就暂停渲染」，否则离屏窗口里的立绘视频是黑的） */
  extraArgs?: string[];
}

export class BrowserBridge {
  private proc: ChildProcess | null = null;
  private cdp: any = null;
  private profile = '';
  private seq = 0;
  private pending = new Map<number, (value: any) => void>();

  constructor(private readonly options: BridgeOptions = {}) {}

  get running(): boolean {
    return !!this.proc && !!this.cdp && this.cdp.readyState === WS.OPEN;
  }

  /** 打开页面并等直播间的弹幕客户端连上 */
  async open(url: string): Promise<void> {
    await this.launch();
    await this.call('Page.enable', {});
    await this.call('Runtime.enable', {});
    await this.call('Network.enable', {});
    await this.call('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await this.call('Page.navigate', { url });
    await sleep(this.options.warmupMs ?? 7000);
  }

  private async launch(visible = false): Promise<void> {
    if (this.running) return;
    const browserPath = findBrowser(this.options.browserPath);
    if (!browserPath) throw new Error('找不到 Chrome 或 Edge：抖音弹幕要借浏览器连（设置里可以填浏览器路径）');
    const port = await freePort();
    this.profile = mkdtempSync(join(tmpdir(), 'dsh-douyin-'));
    this.proc = spawn(
      browserPath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-media-suspend',
        '--disable-renderer-backgrounding',
        // 平时把窗口挪到屏幕外：带窗口的 Chrome 才连弹幕，但别让它挡着主播；
        // 登录时（visible）放到正常位置，让主人扫码/登录
        ...(visible ? ['--window-position=80,60', '--window-size=1100,820'] : ['--window-position=-3200,-3200', '--window-size=1280,800']),
        ...(this.options.extraArgs ?? []),
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: !visible },
    );
    // 进程自己出错（ENOENT、权限）时会发 'error'：没人接就会把宿主带崩
    this.proc.on('error', () => {
      this.proc = null;
      this.cdp = null;
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this.cdp = null;
    });

    let target: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        target = list.find((t) => t.type === 'page') ?? null;
      } catch {
        /* 还没起来 */
      }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('浏览器没起来（调试端口没响应）');

    this.cdp = new WS(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    // ws 的 'error' 没有监听器会变成未捕获异常：桥掉线只该重连，不该把 DSH 干掉
    this.cdp.on('error', () => {});
    this.cdp.on('close', () => {
      this.cdp = null;
    });
    this.cdp.on('message', (raw: Buffer) => {
      let msg: { id?: number; result?: unknown };
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连不上浏览器的调试端口')), 10_000);
      this.cdp.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.cdp.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.cdp || this.cdp.readyState !== WS.OPEN) return reject(new Error('浏览器桥没开'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 20_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.cdp.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 页面里跑一段 JS（返回值按 JSON 传回来） */
  async evaluate<T>(expression: string, awaitPromise = true): Promise<T | null> {
    const out = await this.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (out?.exceptionDetails) return null;
    const value = out?.result?.value;
    return (value ?? null) as T | null;
  }

  /** 取走这次攒下的帧（base64），并报告页面连了哪些 ws（排错用） */
  async drain(): Promise<{ frames: string[]; urls: string[] }> {
    const raw = await this.evaluate<string>(
      `(() => { const s = window.__dshDy || {}; const f = (s.frames || []).splice(0); return JSON.stringify({ u: s.urls || [], f }); })()`,
    );
    if (!raw) return { frames: [], urls: [] };
    try {
      const parsed = JSON.parse(raw) as { u?: string[]; f?: string[] };
      return { frames: parsed.f ?? [], urls: parsed.u ?? [] };
    } catch {
      return { frames: [], urls: [] };
    }
  }

  /**
   * 把一串 Cookie（浏览器里复制的那种 `a=1; b=2`）塞进这个浏览器的会话。
   * 抖音的搜索/详情都要登录态：桥用临时 profile，不塞就等于没登录。
   */
  async applyCookies(cookie: string): Promise<number> {
    const pairs = cookie
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return eq > 0 ? { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() } : null;
      })
      .filter((p): p is { name: string; value: string } => !!p?.name);
    let applied = 0;
    for (const pair of pairs) {
      try {
        const out = await this.call('Network.setCookie', {
          name: pair.name,
          value: pair.value,
          domain: '.douyin.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'None',
        });
        if (out?.success !== false) applied += 1;
      } catch {
        /* 单个塞不进去不影响别的 */
      }
    }
    return applied;
  }

  /** 这个浏览器会话里的抖音 Cookie（整条，`a=1; b=2`） */
  async cookies(): Promise<string> {
    const out = (await this.call('Network.getAllCookies').catch(() => null)) ?? (await this.call('Storage.getCookies').catch(() => null));
    const list: Array<{ name?: string; value?: string; domain?: string }> = Array.isArray(out?.cookies) ? out.cookies : [];
    return list
      .filter((c) => c?.name && /douyin|bytedance|zijie/i.test(String(c.domain ?? '')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * 开一个**看得见**的浏览器让主人自己登录抖音（扫码/短信都行），登完把整条 Cookie 取回来。
   * 插件不碰密码：只是在页面里检测到 sessionid 就说「好了」。
   */
  async login(timeoutMs = 180_000): Promise<string> {
    await this.launch(true);
    await this.call('Page.enable', {});
    await this.call('Network.enable', {});
    await this.call('Page.navigate', { url: 'https://www.douyin.com/' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      const cookie = await this.cookies();
      if (/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_tt)=/.test(cookie)) return cookie;
    }
    throw new Error('等了三分钟还没登录（没检测到 sessionid）：窗口还开着的话可以直接再点一次');
  }

  /**
   * 打开一个页面，截下它自己发的某个接口的 JSON 响应（页面会签名，我们不签）。
   * 用于抖音视频详情这类「Node 直连被 ArgusSecurityPlugin 挡」的接口；
   * 传了 cookie 就先塞进浏览器会话（搜索要登录态）。
   * abort：每 1.5 秒问一次页面（比如「是不是卡在验证码中间页」），返回非空就提前收手，
   * 免得在登录页/验证码页干等满超时。
   */
  async captureJson(
    url: string,
    pattern: RegExp,
    timeoutMs = 20_000,
    cookie = '',
    abort?: () => Promise<string | null>,
  ): Promise<unknown | null> {
    await this.launch();
    await this.call('Page.enable', {});
    await this.call('Network.enable', {});
    if (cookie.trim()) await this.applyCookies(cookie);
    let done: (value: unknown) => void = () => {};
    const found = new Promise<unknown>((resolve) => {
      done = resolve;
    });
    const handler = (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== 'Network.responseReceived') return;
      const res = msg.params?.response;
      if (!res || !pattern.test(String(res.url))) return;
      const requestId = msg.params.requestId;
      // 注意：这里绝不能是「没人接的 Promise」——2026-10-28 宿主就是因为
      // getResponseBody 超时抛出的 rejection 没人 catch，直接 exit 1 崩掉。
      void (async () => {
        try {
          const body: any = await this.call('Network.getResponseBody', { requestId });
          if (typeof body?.body !== 'string') return;
          try {
            done(JSON.parse(body.body));
          } catch {
            done(null);
          }
        } catch {
          /* 这一条响应没取到（页面导航取消、目标关闭）：继续等下一个 */
        }
      })();
    };
    this.cdp.on('message', handler);
    try {
      await this.call('Page.navigate', { url });
    } catch {
      this.cdp?.off('message', handler);
      return null;
    }
    const checker = abort
      ? setInterval(() => {
          void abort()
            .then((reason) => {
              if (reason) done(null);
            })
            .catch(() => {});
        }, 1500)
      : null;
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([found, timer]);
    if (checker) clearInterval(checker);
    this.cdp?.off('message', handler);
    return result;
  }

  stop(): void {
    try {
      this.cdp?.close();
    } catch {
      /* ignore */
    }
    this.cdp = null;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    if (this.profile) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
      } catch {
        /* 浏览器可能还没退干净，下次启动再删 */
      }
      this.profile = '';
    }
  }
}
