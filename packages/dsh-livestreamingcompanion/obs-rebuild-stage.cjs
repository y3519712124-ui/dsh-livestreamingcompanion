
const WebSocket = require('ws');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
const ws = new WebSocket('ws://127.0.0.1:' + (cfg.server_port || 4455));
const pending = new Map();
const call = (t, r = {}) => new Promise((res, rej) => { const id = randomUUID(); pending.set(id, { res, rej, t }); ws.send(JSON.stringify({ op: 6, d: { requestType: t, requestId: id, requestData: r } })); });
ws.on('message', (raw) => {
  const { op, d } = JSON.parse(String(raw));
  if (op === 0) { const id = { rpcVersion: 1 }; if (d.authentication) { const s = createHash('sha256').update(cfg.server_password + d.authentication.salt).digest('base64'); id.authentication = createHash('sha256').update(s + d.authentication.challenge).digest('base64'); } ws.send(JSON.stringify({ op: 1, d: id })); }
  else if (op === 2) run().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
  else if (op === 7) { const p = pending.get(d.requestId); if (!p) return; pending.delete(d.requestId); d.requestStatus.result ? p.res(d.responseData ?? {}) : p.rej(new Error(p.t + ' ' + d.requestStatus.code)); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'http://127.0.0.1:7390/?token=l7CssJh-l_fL4JGm';
const NAME = '直播舞台';
async function run() {
  const col = await call('GetSceneCollectionList');
  const scenes = await call('GetSceneList');
  const scene = scenes.currentProgramSceneName;
  // 清掉所有指向舞台的浏览器源
  const inputs = (await call('GetInputList')).inputs;
  for (const i of inputs) {
    if (i.inputKind !== 'browser_source') continue;
    try {
      const s = await call('GetInputSettings', { inputName: i.inputName });
      if (String(s.inputSettings.url || '').includes('127.0.0.1:7390')) {
        await call('RemoveInput', { inputName: i.inputName });
        console.log('删除旧源: ' + i.inputName);
      }
    } catch (e) { console.log('跳过 ' + i.inputName); }
  }
  await sleep(3000);
  await call('CreateInput', { sceneName: scene, inputName: NAME, inputKind: 'browser_source', inputSettings: { url: URL, width: 1920, height: 1080, fps_custom: false, reroute_audio: false, shutdown: false } });
  const { sceneItemId } = await call('GetSceneItemId', { sceneName: scene, sourceName: NAME });
  await call('SetSceneItemTransform', { sceneName: scene, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, boundsAlignment: 0 } });
  await call('SetSceneItemIndex', { sceneName: scene, sceneItemId, sceneItemIndex: 0 });
  await call('SetInputAudioMonitorType', { inputName: NAME, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  await sleep(1500);
  const after = await call('GetInputSettings', { inputName: NAME });
  const mon = await call('GetInputAudioMonitorType', { inputName: NAME });
  const list = await call('GetInputList');
  console.log('集合=' + col.currentSceneCollectionName + ' 场景=' + scene);
  console.log('现有浏览器源: ' + list.inputs.filter(i => i.inputKind === 'browser_source').map(i => i.inputName).join(','));
  console.log('reroute=' + after.inputSettings.reroute_audio + ' monitor=' + mon.monitorType);
  process.exit(0);
}
