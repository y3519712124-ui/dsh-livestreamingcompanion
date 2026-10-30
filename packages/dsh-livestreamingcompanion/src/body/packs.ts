/**
 * 角色包和模板：插件自带的在包里 assets/<kind>/<id>/，用户自己的在 <userDir>/<kind>/<id>/（同 id 的用户版本盖住自带的）。
 *   角色包：character.json + 片段或立绘
 *   模板：template.json + style.css（+ 背景图之类）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { CharacterManifest, TemplateManifest } from '../stage/protocol';

export type PackKind = 'characters' | 'templates';

export interface PackEntry {
  id: string;
  name: string;
  builtin: boolean;
  /** 预览图的修改时间：控制台拿它当 ?v=，重画缩略图后浏览器才会重新拉 */
  stamp?: string;
}

const MANIFEST: Record<PackKind, string> = { characters: 'character.json', templates: 'template.json' };

export class Packs {
  constructor(private readonly packageDir: string, private readonly userDir: string) {}

  private roots(kind: PackKind): Array<[string, boolean]> {
    return [[join(this.userDir, kind), false], [join(this.packageDir, 'assets', kind), true]];
  }

  /** 这个包的目录（没有返回 null） */
  dir(kind: PackKind, id: string): string | null {
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    for (const [root] of this.roots(kind)) {
      const dir = join(root, id);
      if (existsSync(join(dir, MANIFEST[kind]))) return dir;
    }
    return null;
  }

  private read<T>(kind: PackKind, id: string): T | null {
    const dir = this.dir(kind, id);
    if (!dir) return null;
    try {
      return JSON.parse(readFileSync(join(dir, MANIFEST[kind]), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  character(id: string): CharacterManifest | null {
    return this.read<CharacterManifest>('characters', id);
  }

  template(id: string): TemplateManifest | null {
    return this.read<TemplateManifest>('templates', id);
  }

  /** 能选的（用户自己的排前面） */
  list(kind: PackKind): PackEntry[] {
    const out = new Map<string, PackEntry>();
    for (const [root, builtin] of this.roots(kind).reverse()) {
      if (!existsSync(root)) continue;
      for (const id of readdirSync(root)) {
        const manifest = this.readFrom(join(root, id, MANIFEST[kind]));
        if (manifest) out.set(id, { id, name: manifest.name ?? id, builtin, stamp: this.stampOf(root, id) });
      }
    }
    return [...out.values()].sort((a, b) => Number(a.builtin) - Number(b.builtin));
  }

  /** 预览图的 mtime（没有预览就看 manifest）：控制台用它做缓存版本号 */
  private stampOf(root: string, id: string): string {
    for (const file of ['preview.jpg', 'preview.png', 'template.json', 'character.json']) {
      try {
        const time = statSync(join(root, id, file)).mtimeMs;
        if (time) return String(Math.round(time));
      } catch {
        /* 没有这个文件就看下一个 */
      }
    }
    return '0';
  }

  private readFrom(file: string): { name?: string } | null {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as { name?: string };
    } catch {
      return null;
    }
  }
}
