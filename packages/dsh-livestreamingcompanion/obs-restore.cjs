
const WebSocket = require('ws');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
const ws = new WebSocket('ws://127.0.0.1:' + (cfg.server_port || 4455));
const pending = new Map();
const call = (t, requestData = {}) => new Promise((res, rej) => { const id = randomUUID(); pending.set(id, { res, rej, t }); ws.send(JSON.stringify({ op: 6, d: { requestType: t, requestId: id, requestData } })); });
ws.on('message', (raw) => {
  const { op, d } = JSON.parse(String(raw));
  if (op === 0) { const identify = { rpcVersion: 1 }; if (d.authentication) { const s = createHash('sha256').update(cfg.server_password + d.authentication.salt).digest('base64'); identify.authentication = createHash('sha256').update(s + d.authentication.challenge).digest('base64'); } ws.send(JSON.stringify({ op: 1, d: identify })); }
  else if (op === 2) run().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
  else if (op === 7) { const p = pending.get(d.requestId); if (!p) return; pending.delete(d.requestId); d.requestStatus.result ? p.res(d.responseData ?? {}) : p.rej(new Error(p.t + ': ' + d.requestStatus.code + ' ' + (d.requestStatus.comment || ''))); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await call('SetCurrentSceneCollection', { sceneCollectionName: '未命名' }).catch((e) => console.log('切场景集合失败: ' + e.message));
  await sleep(1500);
  await call('SetCurrentProfile', { profileName: '未命名' }).catch((e) => console.log('切配置失败: ' + e.message));
  await sleep(1000);
  const col = await call('GetSceneCollectionList');
  const prof = await call('GetProfileList');
  const scenes = await call('GetSceneList');
  console.log('当前场景集合: ' + col.currentSceneCollectionName + ' | 全部: ' + col.sceneCollections.join(', '));
  console.log('当前配置: ' + prof.currentProfileName + ' | 全部: ' + prof.profiles.join(', '));
  console.log('当前场景: ' + scenes.currentProgramSceneName + ' | 场景: ' + scenes.scenes.map(s => s.sceneName).join(', '));
  const inputs = await call('GetInputList');
  console.log('源: ' + inputs.inputs.map(i => i.inputName).join(', '));
  process.exit(0);
}
