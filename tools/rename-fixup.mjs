/**
 * 改名后的定点还原：这些地方的 "dsh-livestream" 不是插件身份，而是
 *   - 用户数据目录（里面有 asr-venv / 模型 / 记忆库，不能跟着改名）
 *   - OBS 的配置文件/场景集合名（改名会让 OBS 里现有场景和浏览器源找不到）
 *   - 另一台直播机上的部署路径
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = join(import.meta.dirname, '..', 'packages', 'dsh-livestreamingcompanion');
const OLD = 'dsh-livestream';
const NEW = 'dsh-livestreamingcompanion';

/** [文件, 把 NEW 换回 OLD 的匹配片段（含足够上下文，避免误伤）] */
const FIXES = [
  ['src/dsh/runtime.ts', [
    [`DSH_HOME/${NEW}/settings.json`, `DSH_HOME/${OLD}/settings.json`],
    [`join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '${NEW}')`, `join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '${OLD}')`],
  ]],
  ['src/body/asr.ts', [[`DSH_HOME/${NEW}/transcripts/`, `DSH_HOME/${OLD}/transcripts/`]]],
  ['src/core/memory/store.ts', [[`DSH_HOME/${NEW}/live-memory.db`, `DSH_HOME/${OLD}/live-memory.db`]]],
  ['src/console/console.tsx', [[`DSH 主目录的 ${NEW}/templates/`, `DSH 主目录的 ${OLD}/templates/`]]],
  ['src/body/obs.ts', [
    [`export const OBS_NAME = '${NEW}'`, `export const OBS_NAME = '${OLD}'`],
    [`配置文件/场景集合「${NEW}」`, `配置文件/场景集合「${OLD}」`],
    [`（会去掉「-」之类的字符，${NEW} →`, `（会去掉「-」之类的字符，${OLD} →`],
    [`找不到 OBS 的 ${NEW} 配置文件目录`, `找不到 OBS 的 ${OLD} 配置文件目录`],
  ]],
  ['obs-setup-mc.cjs', [
    [`profiles.includes('${NEW}')`, `profiles.includes('${OLD}')`],
    [`profileName: '${NEW}'`, `profileName: '${OLD}'`],
    [`currentProfileName !== '${NEW}'`, `currentProfileName !== '${OLD}'`],
    [`SetCurrentProfile', { profileName: '${NEW}' }`, `SetCurrentProfile', { profileName: '${OLD}' }`],
    [`col.sceneCollections.includes('${NEW}')`, `col.sceneCollections.includes('${OLD}')`],
    [`sceneCollectionName: '${NEW}'`, `sceneCollectionName: '${OLD}'`],
    [`currentSceneCollectionName !== '${NEW}'`, `currentSceneCollectionName !== '${OLD}'`],
    [`SetCurrentSceneCollection', { sceneCollectionName: '${NEW}' }`, `SetCurrentSceneCollection', { sceneCollectionName: '${OLD}' }`],
    [`OBS_V2_PROFILE_NAME = '${NEW}'`, `OBS_V2_PROFILE_NAME = '${OLD}'`],
  ]],
];

let total = 0;
for (const [rel, pairs] of FIXES) {
  const path = join(pkg, rel);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.log(`skip ${rel} (missing)`);
    continue;
  }
  let n = 0;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) continue;
    const count = text.split(from).length - 1;
    text = text.split(from).join(to);
    n += count;
  }
  if (n) writeFileSync(path, text);
  total += n;
  console.log(`${rel}: ${n} revert(s)`);
}
console.log(`total ${total}`);
