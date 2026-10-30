/**
 * 一次性改名：dsh-livestreamingcompanion -> dsh-livestreamingcompanioningcompanion
 *
 *   node tools/rename-plugin.mjs --dry-run
 *   node tools/rename-plugin.mjs
 *
 * 只改「插件身份」相关的文本（包名、cordis id、路由前缀、日志标签、模块 id、preset id），
 * 用户数据目录 DSH_HOME/dsh-livestreamingcompanion 和 OBS 的配置名保持不动（里面有 venv / 模型 / 记忆库，
 * 还有你已经在用的 OBS 场景），改完再手动把这几处还原。
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(join(import.meta.dirname, '..'));
const OLD = 'dsh-livestreamingcompanion';
const NEW = 'dsh-livestreamingcompanioningcompanion';
const dry = process.argv.includes('--dry-run');

const SKIP_DIRS = new Set(['node_modules', '.git', '.gen', '.shots', 'dist', 'lib', '.pnpm-store']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|md|css|html|ps1|sh|py|txt)$/;

let changed = 0;
let scanned = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path);
      continue;
    }
    if (!TEXT.test(name)) continue;
    scanned++;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(OLD)) continue;
    const next = text.split(OLD).join(NEW);
    changed++;
    if (dry) {
      console.log(`would rewrite ${path.slice(root.length + 1)}`);
    } else {
      writeFileSync(path, next);
    }
  }
}

walk(root);
console.log(`${dry ? '[dry] ' : ''}scanned ${scanned} text files, ${changed} contain "${OLD}"`);

const pkgOld = join(root, 'packages', OLD);
const pkgNew = join(root, 'packages', NEW);
if (existsSync(pkgOld) && !existsSync(pkgNew)) {
  if (dry) console.log(`would rename packages/${OLD} -> packages/${NEW}`);
  else {
    renameSync(pkgOld, pkgNew);
    console.log(`renamed packages/${OLD} -> packages/${NEW}`);
  }
} else {
  console.log(`package dir: old=${existsSync(pkgOld)} new=${existsSync(pkgNew)}`);
}
