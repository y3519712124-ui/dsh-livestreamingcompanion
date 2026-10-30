/**
 * 本地 RTMP 中继（MediaMTX）：给「多平台推流 → 自定义」一个能推、能拉、能验收的落点。
 *
 * 插件只负责「起 / 停 / 看状态」，不打包二进制：先找下面几个位置有没有 mediamtx.exe，
 * 找到就用；找不到就把提示给主人（下载地址写在 note 里）。
 *
 *   <dataDir>/relay/mediamtx.exe
 *   %USERPROFILE%\dsh-relay\mediamtx.exe
 *   环境变量 DSH_RELAY_EXE
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface RelayState {
  running: boolean;
  exe: string | null;
  port: number;
  /** 推流地址模板（把 <name> 换成自己的名字） */
  url: string;
  log: string[];
  error: string | null;
}

export class Relay {
  private child: ReturnType<typeof spawn> | null = null;
  private log: string[] = [];
  private error: string | null = null;
  private lastPid: number | null = null;

  constructor(private readonly dataDir: string, private readonly port = 1935) {}

  /** mediamtx.exe 可能在哪（按顺序找；老目录名留着，旧机器升级时不用重新装） */
  candidates(): string[] {
    return [
      process.env.DSH_RELAY_EXE ?? '',
      join(this.dataDir, 'relay', 'mediamtx.exe'),
      join(homedir(), 'dsh-livestreamingcompanion-relay', 'mediamtx.exe'),
      join(homedir(), 'dsh-relay', 'mediamtx.exe'),
    ].filter(Boolean);
  }

  find(): string | null {
    for (const path of this.candidates()) {
      if (existsSync(path)) return path;
    }
    return null;
  }

  async reachable(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: this.port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(1200);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  async state(): Promise<RelayState> {
    const exe = this.find();
    const running = await this.reachable();
    return {
      running,
      exe,
      port: this.port,
      url: `rtmp://127.0.0.1:${this.port}/live/<名字>`,
      log: this.log,
      error: this.error,
    };
  }

  async start(): Promise<RelayState> {
    if (await this.reachable()) return this.state();
    const exe = this.find();
    if (!exe) {
      this.error = '没有 mediamtx.exe：下载 https://github.com/bluenviron/mediamtx/releases → 解压到 ~/dsh-relay/（或 <dataDir>/relay/）再点一次';
      return this.state();
    }
    this.error = null;
    this.log = [];
    try {
      const child = spawn(exe, [], { cwd: join(exe, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const onLog = (b: Buffer) => {
        const text = b.toString('utf8').trim();
        if (text) this.log = [...this.log.slice(-7), text];
      };
      child.stdout?.on('data', onLog);
      child.stderr?.on('data', onLog);
      child.on('error', (err) => { this.error = err.message; });
      child.on('exit', (code) => {
        this.log = [...this.log.slice(-7), `mediamtx 退出：code=${code ?? '-'}`];
        this.child = null;
      });
      this.child = child;
      this.lastPid = child.pid ?? null;
    } catch (err) {
      this.error = (err as Error).message;
      return this.state();
    }
    // 等端口起来（最多 6 秒）
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.reachable()) break;
    }
    return this.state();
  }

  async stop(): Promise<RelayState> {
    const { execFileSync } = await import('node:child_process');
    if (this.lastPid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(this.lastPid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
        else this.child?.kill('SIGTERM');
      } catch {
        /* 已经没了 */
      }
      this.lastPid = null;
    } else if (process.platform === 'win32') {
      // 不是插件起的（比如开机自启脚本起的）：按进程名收掉
      try {
        execFileSync('taskkill', ['/IM', 'mediamtx.exe', '/F'], { stdio: 'ignore', timeout: 8000 });
      } catch {
        /* 没在跑 */
      }
    }
    this.child = null;
    await new Promise((r) => setTimeout(r, 400));
    return this.state();
  }
}
