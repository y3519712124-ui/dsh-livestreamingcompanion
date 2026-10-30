
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function run() {
  const inputs = (await call('GetInputList')).inputs;
  const browser = inputs.find(i => i.inputKind === 'browser_source');
  await call('SetInputMute', { inputName: browser.inputName, inputMuted: false });
  console.log('页面音频已恢复');
  await call('StartRecord');
  console.log('开始录制 14 秒（桌面音频 = 扬声器回环）…');
  await sleep(14000);
  const st = await call('StopRecord');
  console.log('录制结束: ' + st.outputPath);
  process.exit(0);
}
