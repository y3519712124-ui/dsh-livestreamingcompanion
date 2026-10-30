
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
const NAME = '直播舞台';
const URL = 'http://127.0.0.1:7390/?token=l7CssJh-l_fL4JGm';

async function run() {
  const col = await call('GetSceneCollectionList');
  const scenes = await call('GetSceneList');
  const scene = scenes.currentProgramSceneName;
  console.log('当前: ' + col.currentSceneCollectionName + ' / ' + scene);

  const inputs = await call('GetInputList');
  const has = inputs.inputs.some((i) => i.inputName === NAME);
  if (has) {
    await call('SetInputSettings', { inputName: NAME, inputSettings: { url: URL, width: 1920, height: 1080, fps_custom: false, reroute_audio: false, shutdown: false } });
    console.log('已更新已有源');
  } else {
    await call('CreateInput', { sceneName: scene, inputName: NAME, inputKind: 'browser_source', inputSettings: { url: URL, width: 1920, height: 1080, fps_custom: false, reroute_audio: false, shutdown: false } });
    console.log('已创建源');
  }
  const { sceneItemId } = await call('GetSceneItemId', { sceneName: scene, sourceName: NAME });
  await call('SetSceneItemTransform', { sceneName: scene, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, boundsAlignment: 0 } });
  await call('SetSceneItemIndex', { sceneName: scene, sceneItemId, sceneItemIndex: 0 });
  await sleep(5000);
  const shot = await call('GetSourceScreenshot', { sourceName: scene, imageFormat: 'png', imageWidth: 960, imageHeight: 540 });
  fs.writeFileSync('F:/GPT-SoVITS/obs-stage.png', Buffer.from(shot.imageData.replace(/^data:image\/png;base64,/, ''), 'base64'));
  const list = await call('GetSceneItemList', { sceneName: scene });
  console.log('场景源: ' + list.sceneItems.map((i) => i.sourceName).join(' | '));
  process.exit(0);
}
