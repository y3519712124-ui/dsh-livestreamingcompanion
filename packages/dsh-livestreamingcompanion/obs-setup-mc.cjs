
const WebSocket = require('ws');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
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
  } else if (op === 2) run().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
  else if (op === 7) {
    const p = pending.get(d.requestId); if (!p) return; pending.delete(d.requestId);
    d.requestStatus.result ? p.res(d.responseData ?? {}) : p.rej(new Error(p.requestType + ': ' + d.requestStatus.code + ' ' + (d.requestStatus.comment || '')));
  }
});
ws.on('error', (e) => { console.log('WS ERR ' + e.message); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCENE = '直播';
const WIN = '游戏窗口';
const HUD = '游戏 HUD';
const STAGE = '舞台';
const TITLE = 'Minecraft 1.21.11 - 多人游戏（第三方服务器）';
const STAGE_URL = 'http://127.0.0.1:7390/?token=l7CssJh-l_fL4JGm';

async function run() {
  // 1) 专用配置 + 场景集合
  const prof = await call('GetProfileList');
  if (!prof.profiles.includes('dsh-livestreamingcompanion')) { await call('CreateProfile', { profileName: 'dsh-livestreamingcompanion' }); await sleep(800); }
  else if (prof.currentProfileName !== 'dsh-livestreamingcompanion') { await call('SetCurrentProfile', { profileName: 'dsh-livestreamingcompanion' }); await sleep(800); }
  const col = await call('GetSceneCollectionList');
  if (!col.sceneCollections.includes('dsh-livestreamingcompanion')) { await call('CreateSceneCollection', { sceneCollectionName: 'dsh-livestreamingcompanion' }); await sleep(2000); }
  else if (col.currentSceneCollectionName !== 'dsh-livestreamingcompanion') { await call('SetCurrentSceneCollection', { sceneCollectionName: 'dsh-livestreamingcompanion' }); await sleep(1500); }

  await call('SetVideoSettings', { fpsNumerator: 30, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 });

  // 2) 场景
  let scenes = await call('GetSceneList');
  if (!scenes.scenes.some((s) => s.sceneName === SCENE)) { await call('CreateScene', { sceneName: SCENE }); await sleep(800); }
  await call('SetCurrentProgramScene', { sceneName: SCENE });

  // 3) 源
  const inputs = await call('GetInputList');
  const has = (n) => inputs.inputs.some((i) => i.inputName === n);
  const put = async (name, kind, settings) => {
    if (has(name)) await call('SetInputSettings', { inputName: name, inputSettings: settings });
    else await call('CreateInput', { sceneName: SCENE, inputName: name, inputKind: kind, inputSettings: settings });
    const { sceneItemId } = await call('GetSceneItemId', { sceneName: SCENE, sourceName: name });
    return sceneItemId;
  };
  const fill = { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, boundsAlignment: 0 };

  const winId = await put(WIN, 'window_capture', { window: 'title:' + TITLE, method: 2, client_area: true, cursor: false, compatibility: false });
  await call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: winId, sceneItemTransform: fill });
  await call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: winId, sceneItemIndex: 0 });
  await sleep(1500);

  const t = await call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: winId });
  console.log('窗口捕获原始尺寸: ' + t.sceneItemTransform.sourceWidth + 'x' + t.sceneItemTransform.sourceHeight);

  const hudId = await put(HUD, 'browser_source', {
    url: 'http://127.0.0.1:7391/', width: t.sceneItemTransform.sourceWidth || 1280, height: t.sceneItemTransform.sourceHeight || 720,
    fps_custom: false, reroute_audio: false, shutdown: false,
    css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
  });
  await call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: hudId, sceneItemTransform: fill });
  await call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: hudId, sceneItemIndex: 1 });

  const stageId = await put(STAGE, 'browser_source', {
    url: STAGE_URL, width: 1920, height: 1080, fps_custom: false, reroute_audio: true, shutdown: false,
    css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
  });
  await call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: stageId, sceneItemTransform: fill });
  await call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: stageId, sceneItemIndex: 2 });

  // 4) 游戏声音
  const audioName = '游戏声音';
  if (has(audioName)) await call('SetInputSettings', { inputName: audioName, inputSettings: { window: 'title:' + TITLE, priority: 2 } });
  else await call('CreateInput', { sceneName: SCENE, inputName: audioName, inputKind: 'wasapi_process_output_capture', inputSettings: { window: 'title:' + TITLE, priority: 2 } });

  await sleep(4000);
  const shot = await call('GetSourceScreenshot', { sourceName: SCENE, imageFormat: 'png', imageWidth: 960, imageHeight: 540, imageCompressionQuality: 90 });
  fs.writeFileSync('F:/GPT-SoVITS/obs-preview.png', Buffer.from(shot.imageData.replace(/^data:image\/png;base64,/, ''), 'base64'));
  console.log('预览已存: F:/GPT-SoVITS/obs-preview.png');
  const list = await call('GetSceneItemList', { sceneName: SCENE });
  console.log('场景内的源: ' + list.sceneItems.map((i) => i.sourceName).join(' | '));
  process.exit(0);
}
