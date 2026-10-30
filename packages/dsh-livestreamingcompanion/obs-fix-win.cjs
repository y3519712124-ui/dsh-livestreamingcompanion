
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
const SCENE = '直播';
const WINDOW = 'Minecraft 1.21.11 - 多人游戏（第三方服务器）:GLFW30:java.exe';

async function run() {
  await call('SetInputSettings', { inputName: '游戏窗口', inputSettings: { window: WINDOW, method: 2, client_area: true, cursor: false, compatibility: false }, overlay: true });
  await sleep(2500);
  const winId = (await call('GetSceneItemId', { sceneName: SCENE, sourceName: '游戏窗口' })).sceneItemId;
  const t = await call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: winId });
  console.log('窗口源尺寸: ' + t.sceneItemTransform.sourceWidth + 'x' + t.sceneItemTransform.sourceHeight);

  const stageId = (await call('GetSceneItemId', { sceneName: SCENE, sourceName: '舞台' })).sceneItemId;
  await call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: stageId, sceneItemEnabled: false });
  await sleep(1200);
  const shot = await call('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'png', imageWidth: 960, imageHeight: 540 });
  fs.writeFileSync('F:/GPT-SoVITS/obs-preview2.png', Buffer.from(shot.imageData.replace(/^data:image\/png;base64,/, ''), 'base64'));
  await call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: stageId, sceneItemEnabled: true });
  console.log('ok');
  process.exit(0);
}
