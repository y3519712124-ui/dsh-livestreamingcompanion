
const WebSocket = require('ws');
const { createHash, randomUUID } = require('node:crypto');
const cfg = JSON.parse(require('fs').readFileSync('C:/Users/Admin/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
const ws = new WebSocket('ws://127.0.0.1:' + (cfg.server_port || 4455));
const pending = new Map();
const call = (requestType, requestData = {}) => new Promise((res, rej) => {
  const id = randomUUID();
  pending.set(id, { res, rej, requestType });
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }));
});
ws.on('message', (raw) => {
  const { op, d } = JSON.parse(String(raw));
  if (op === 0) {
    const identify = { rpcVersion: 1 };
    if (d.authentication) {
      const secret = createHash('sha256').update(cfg.server_password + d.authentication.salt).digest('base64');
      identify.authentication = createHash('sha256').update(secret + d.authentication.challenge).digest('base64');
    }
    ws.send(JSON.stringify({ op: 1, d: identify }));
  } else if (op === 2) { run().catch((e) => { console.log('ERR ' + e.message); process.exit(1); }); }
  else if (op === 7) {
    const p = pending.get(d.requestId); if (!p) return; pending.delete(d.requestId);
    d.requestStatus.result ? p.res(d.responseData ?? {}) : p.rej(new Error(p.requestType + ': ' + d.requestStatus.code + ' ' + (d.requestStatus.comment || '')));
  }
});
ws.on('error', (e) => { console.log('WS ERR ' + e.message); process.exit(1); });
async function run() {
  const col = await call('GetSceneCollectionList');
  console.log('场景集合:', col.currentSceneCollectionName, '| 全部:', col.sceneCollections.join(', '));
  const scenes = await call('GetSceneList');
  console.log('当前场景:', scenes.currentProgramSceneName, '| 场景:', scenes.scenes.map((s) => s.sceneName).join(', '));
  const inputs = await call('GetInputList');
  console.log('源:', inputs.inputs.map((i) => i.inputName + '(' + i.inputKind + ')').join(', '));
  for (const i of inputs.inputs) {
    try {
      const st = await call('GetInputSettings', { inputName: i.inputName });
      console.log('  ' + i.inputName + ' -> ' + JSON.stringify(st.inputSettings).slice(0, 300));
    } catch {}
  }
  process.exit(0);
}
