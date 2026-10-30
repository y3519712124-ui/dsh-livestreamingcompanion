/**
 * 多平台推流：一份画面，同时推到 N 个平台（每家一路 RTMP），一条 ffmpeg 命令搞定。
 *
 * 和 broadcast.ts 的分工：
 *   - broadcast.ts = 走 OBS 推 B 站，带开播/下播/人脸认证（官方开播流程）；
 *   - push.ts      = 不进平台后台、只认推流码的「并行推流」，抖音/快手/视频号/虎牙……
 *                    用各家开播工具给的推流码，一路 ffmpeg 多输出。
 *
 * 画面来源（input）：
 *   stage   抓舞台那个浏览器窗口（gdigrab title=…），适合已经把舞台单独开成一个窗口
 *   desktop 抓屏幕一块区域（gdigrab desktop + offset/size）
 *   relay   从本机已有的 RTMP/SRT 中继拉流（比如 OBS 推到 MediaMTX 再分发）
 *   test    lavfi testsrc2 彩条（没有画面源时验证链路用）
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { joinPushUrl, platformById, PUSH_PLATFORMS } from '../core/push/platforms';

export type PushInput = 'capture' | 'stage' | 'desktop' | 'relay' | 'test';

/** 推流引擎：simulate 只报状态不真的推（彩排/对参数），ffmpeg 真推 */
export type PushMode = 'simulate' | 'ffmpeg';

export interface PushTargetConfig {
  server: string;
  key: string;
  on: boolean;
}

export interface PushConfig {
  mode: PushMode;
  input: PushInput;
  /** 手动指定的 ffmpeg.exe（装了 portables 版本用）；空串走 PATH */
  ffmpegPath: string;
  /** stage 模式抓哪个窗口（标题包含即可） */
  window: string;
  /** desktop 模式的区域 */
  region: { x: number; y: number; w: number; h: number };
  /** relay 模式的输入地址 */
  relayUrl: string;
  fps: number;
  width: number;
  height: number;
  kbps: number;
  targets: Record<string, PushTargetConfig>;
}

export interface PushTargetState {
  id: string;
  label: string;
  on: boolean;
  /** 已配置好完整地址（不显示 key 本身） */
  ready: boolean;
  error: string | null;
}

export interface PushState {
  running: boolean;
  startedAt: number | null;
  mode: PushMode;
  input: PushInput;
  /** capture 模式下浏览器有没有真的在喂数据 */
  receiving: boolean;
  engine: { path: string | null; version: string | null };
  targets: PushTargetState[];
  error: string | null;
  /** 最近几行 ffmpeg 输出（排查用） */
  log: string[];
}

const EMPTY: PushConfig = {
  mode: 'ffmpeg',
  input: 'capture',
  ffmpegPath: '',
  window: '舞台',
  region: { x: 0, y: 0, w: 1920, h: 1080 },
  relayUrl: 'rtmp://127.0.0.1:1935/stage',
  fps: 30,
  width: 1920,
  height: 1080,
  kbps: 4500,
  targets: {},
};

export class Push {
  private config: PushConfig;
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private error: string | null = null;
  /** 最近一次失败像不像「推流码过期」（连接被拒/403），控制台据此给换码提示 */
  private codeExpired = false;
  private log: string[] = [];
  private engine: { path: string | null; version: string | null } = { path: null, version: null };
  /** capture 模式下浏览器最后一次喂数据的时刻 */
  private lastFeedAt = 0;
  private feedBytes = 0;

  constructor(private readonly file: string) {
    this.config = this.load();
    this.detect();
  }

  private load(): PushConfig {
    try {
      if (!existsSync(this.file)) return { ...EMPTY, targets: {} };
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PushConfig>;
      return {
        ...EMPTY,
        ...raw,
        // 旧配置里的 stage / relay / test 和 simulate 已经没有 UI 了：统一收成「屏幕区域 + 真实推流」，
        // 免得面板上什么都不亮、或者点了开始却没有任何反应。
        mode: 'ffmpeg',
        input: raw.input === 'capture' ? 'capture' : 'desktop',
        region: { ...EMPTY.region, ...(raw.region ?? {}) },
        targets: { ...(raw.targets ?? {}) },
      };
    } catch {
      return { ...EMPTY, targets: {} };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.config, null, 2) + '\n');
  }

  configView(): PushConfig {
    return { ...this.config, targets: { ...this.config.targets } };
  }

  /** 记一段 ffmpeg 输出（只留最后 8 行） */
  private push(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.log = [...this.log.slice(-7), text];
  }

  detect(): { path: string | null; version: string | null } {
    const candidates = [this.config.ffmpegPath.trim(), 'ffmpeg'].filter(Boolean);
    for (const bin of candidates) {
      try {
        const out = execFileSync(bin, ['-version'], { encoding: 'utf8', timeout: 8000 });
        const first = out.split('\n')[0]?.trim() ?? '';
        this.engine = { path: bin, version: first.replace(/^ffmpeg version\s*/i, '').split(' ')[0] ?? first };
        return this.engine;
      } catch {
        /* 换下一个 */
      }
    }
    this.engine = { path: null, version: null };
    return this.engine;
  }

  update(patch: Partial<PushConfig> & { target?: { id: string; value: Partial<PushTargetConfig> } }): PushConfig {
    if (patch.target) {
      const { id, value } = patch.target;
      this.config.targets[id] = { ...(this.config.targets[id] ?? { server: platformById(id)?.server ?? '', key: '', on: false }), ...value };
    }
    for (const key of ['mode', 'input', 'ffmpegPath', 'window', 'relayUrl', 'fps', 'width', 'height', 'kbps'] as const) {
      if (patch[key] !== undefined) (this.config as unknown as Record<string, unknown>)[key] = patch[key];
    }
    if (patch.region) this.config.region = { ...this.config.region, ...patch.region };
    this.save();
    return this.configView();
  }

  state(): PushState {
    const targets: PushTargetState[] = PUSH_PLATFORMS.map((p) => {
      const cfg = this.config.targets[p.id];
      const ready = !!cfg && !!joinPushUrl(cfg.server || p.server, cfg.key);
      return { id: p.id, label: p.label, on: !!cfg?.on, ready, error: null };
    });
    return {
      running: !!this.child || (this.config.mode === 'simulate' && this.startedAt !== null),
      startedAt: this.startedAt,
      mode: this.config.mode,
      input: this.config.input,
      receiving: Date.now() - this.lastFeedAt < 3000,
      engine: this.engine,
      targets,
      error: this.error,
      log: this.log,
    };
  }

  /** 组装 ffmpeg 参数（单独抽出来，便于不启动进程地检查） */
  args(): string[] {
    const c = this.config;
    const urls = this.activeUrls();
    const input: string[] = [];
    if (c.input === 'capture') {
      // 浏览器（控制台页面）从摄像头/屏幕采到 WebM(VP8/Opus)，从 stdin 喂进来，这里转成 H.264/AAC 再分发
      input.push('-f', 'webm', '-i', 'pipe:0');
    } else if (c.input === 'test') {
      input.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${c.width}x${c.height}:rate=${c.fps}`);
      input.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
    } else if (c.input === 'relay') {
      input.push('-re', '-i', c.relayUrl);
    } else if (c.input === 'desktop') {
      input.push('-f', 'gdigrab', '-framerate', String(c.fps), '-offset_x', String(c.region.x), '-offset_y', String(c.region.y), '-video_size', `${c.region.w}x${c.region.h}`, '-i', 'desktop');
      // gdigrab 抓不到声音，也不能依赖「虚拟音频设备」一定装了：垫一路静音，保证一定能起来
      input.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    } else if (c.input === 'stage') {
      // 按「屏幕上一块区域」抓，不按窗口标题抓。
      // 原因：ffmpeg 的 gdigrab title= 在 Windows 上匹配不了中文标题（内部按 ANSI 比较），
      // 「dsh-livestreamingcompanion 舞台」这种窗口永远找不到；区域抓则稳定。
      // 用法：把独立舞台窗口铺满这块区域（默认 0,0,1920×1080），再推。
      input.push('-f', 'gdigrab', '-framerate', String(c.fps), '-offset_x', String(c.region.x), '-offset_y', String(c.region.y), '-video_size', `${c.region.w}x${c.region.h}`, '-i', 'desktop');
      input.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    } else {
      input.push('-f', 'gdigrab', '-framerate', String(c.fps), '-offset_x', String(c.region.x), '-offset_y', String(c.region.y), '-video_size', `${c.region.w}x${c.region.h}`, '-i', 'desktop');
      input.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    }

    const encode = [
      // H.264 要求宽高偶数：浏览器 canvas 一般是 1280×720，但抓屏/摄像头可能是奇数边
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-b:v', `${c.kbps}k`, '-maxrate', `${c.kbps}k`, '-bufsize', `${c.kbps * 2}k`,
      '-g', String(Math.max(2, Math.round(c.fps * 2))),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    ];

    const outputs: string[] = [];
    for (const url of urls) outputs.push('-f', 'flv', url);
    return [...input, ...encode, ...outputs];
  }

  activeUrls(): string[] {
    const urls: string[] = [];
    for (const platform of PUSH_PLATFORMS) {
      const cfg = this.config.targets[platform.id];
      if (!cfg?.on) continue;
      const url = joinPushUrl(cfg.server || platform.server, cfg.key);
      if (url) urls.push(url);
    }
    return urls;
  }

  start(): PushState {
    if (this.child) return this.state();
    const urls = this.activeUrls();
    if (!urls.length) {
      this.error = '没有选中任何已配置推流码的平台';
      return this.state();
    }
    this.error = null;
    this.codeExpired = false;
    this.log = [];

    // 模拟引擎：只维护状态，方便先把平台/参数配好再切真实推流
    if (this.config.mode === 'simulate') {
      this.startedAt = Date.now();
      this.push(`模拟推流：${urls.length} 路（未真的连平台）`);
      return this.state();
    }

    if (!this.engine.path) {
      this.error = '找不到 ffmpeg：装一个，或在设置里填 ffmpeg.exe 的路径';
      return this.state();
    }
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats', ...this.args()];
    try {
      // capture 模式要从 stdin 收浏览器喂来的 WebM
      const child = spawn(this.engine.path, args, { windowsHide: true, stdio: [this.config.input === 'capture' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const onLog = (text: string) => {
        this.push(text);
        // 抓 ffmpeg 的原话，翻成能看懂的错误（退出码 4294967291 = -5，看着像天书）
        const missing = /Can't find window '([^']*)'/.exec(text);
        if (missing) {
          this.error =
            `找不到标题含「${missing[1]}」的窗口：舞台现在只在控制台的 iframe 里，没有独立窗口。` +
            `改成「浏览器采集」，或点下面「开一个新窗口演舞台」再试。`;
        }
        if (/Error opening input files/.test(text) && !this.error) this.error = '输入打不开（窗口/设备不可用）';
        // 推流码过期 / 平台换端点：ffmpeg 原话是 Connection refused / 403 / I/O error，补一句人话
        if (/Connection refused|Connection reset|Cannot open connection|HTTP error 403|Unauthorized|Error number -138|Error number -104/.test(text) && !this.error) {
          this.error = '连不上推流服务器：多半是推流码过期了——重新打开平台的直播伴侣 → 推流设置，复制新的「推流地址 + 推流码」再推（插件不用重启）';
          this.codeExpired = true;
        }
      };
      child.stdout?.on('data', (b: Buffer) => onLog(b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => onLog(b.toString('utf8')));
      child.stdin?.on('error', () => { /* 进程先退出时写 stdin 会报错，忽略 */ });
      child.on('error', (err) => {
        this.error = err.message;
        this.push(err.message);
      });
      child.on('exit', (code, signal) => {
        // Windows 上 ffmpeg 被信号杀掉时 Node 给的是无符号大数（4294967291 = -5）
        const signed = typeof code === 'number' && code > 2_000_000_000 ? code - 4_294_967_296 : code;
        this.push(`ffmpeg 退出：code=${signed ?? '-'} signal=${signal ?? '-'}`);
        this.child = null;
        this.startedAt = null;
        if (signed && signed !== 0 && !this.error) this.error = `ffmpeg 退出（code ${signed}），看下面的日志`;
      });
      this.child = child;
      this.startedAt = Date.now();
    } catch (err) {
      this.error = (err as Error).message;
    }
    return this.state();
  }

  /**
   * capture 模式：浏览器每 ~1 秒发来一块 WebM 数据，原样写进 ffmpeg 的 stdin。
   * 返回是否写进去了（没在推就退回 false，控制台据此提示）。
   */
  feed(chunk: Uint8Array): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    this.lastFeedAt = Date.now();
    this.feedBytes += chunk.byteLength;
    try {
      stdin.write(Buffer.from(chunk));
      return true;
    } catch {
      return false;
    }
  }

  stop(): PushState {
    const child = this.child;
    this.child = null;
    this.startedAt = null;
    if (child?.pid) {
      // Windows 上 ffmpeg 是单进程，直接结束；taskkill 兜底子进程
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
        else child.kill('SIGTERM');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经没了 */
        }
      }
    }
    this.push('已停止推流');
    return this.state();
  }

  dispose(): void {
    this.stop();
  }

  /**
   * 一键装 ffmpeg（Windows）：下官方静态包 → tar 解开 → 记住 ffmpeg.exe 路径。
   * 有 winget 的话先试 winget（装到系统，PATH 里就能直接用）。
   */
  async install(): Promise<{ ok: boolean; path: string | null; version: string | null; error: string | null; note: string }> {
    if (this.detect().path) return { ok: true, path: this.engine.path, version: this.engine.version, error: null, note: '已经有 ffmpeg 了' };

    const dir = join(dirname(this.file), 'ffmpeg');
    if (process.platform !== 'win32') {
      return { ok: false, path: null, version: null, error: '自动安装目前只做了 Windows；其它系统用包管理器装 ffmpeg', note: '' };
    }

    // 1) 先试 winget（装完 PATH 里有）
    try {
      execFileSync('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'], {
        stdio: 'ignore',
        timeout: 300_000,
      });
      const again = this.detect();
      if (again.path) return { ok: true, path: again.path, version: again.version, error: null, note: '用 winget 装好了' };
    } catch {
      /* 没有 winget 或装失败，走下载 */
    }

    // 2) 下 gyan 的 essentials 静态包，解到 <dataDir>/ffmpeg
    const zip = join(dir, 'ffmpeg.zip');
    try {
      mkdirSync(dir, { recursive: true });
      const res = await fetch('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
      execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'ignore', timeout: 180_000 });
    } catch (err) {
      return { ok: false, path: null, version: null, error: `下载/解压 ffmpeg 失败：${(err as Error).message}`, note: '' };
    }

    const found = this.findExe(dir);
    if (!found) return { ok: false, path: null, version: null, error: '解压完没找到 ffmpeg.exe', note: '' };
    this.config.ffmpegPath = found;
    this.save();
    const engine = this.detect();
    return { ok: !!engine.path, path: engine.path, version: engine.version, error: engine.path ? null : '找到了 ffmpeg.exe 但启动不起来', note: `装到 ${found}` };
  }

  /** 在目录里找 ffmpeg.exe（解压后的路径带版本号，不能写死） */
  private findExe(dir: string): string | null {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of entries) {
        const path = join(current, name);
        if (name.toLowerCase() === 'ffmpeg.exe' && existsSync(path)) return path;
        try {
          if (statSync(path).isDirectory()) stack.push(path);
        } catch {
          /* 跳过 */
        }
      }
    }
    return null;
  }
}
