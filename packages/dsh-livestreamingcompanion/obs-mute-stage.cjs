
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
async function run() {
  const st = await call('GetInputSettings', { inputName: '直播舞台' });
  console.log('源设置 reroute_audio=' + st.inputSettings.reroute_audio);
  const mute = await call('GetInputMute', { inputName: '直播舞台' });
  console.log('当前静音: ' + mute.inputMuted);
  if (!mute.inputMuted) { await call('SetInputMute', { inputName: '直播舞台', inputMuted: true }); console.log('→ 已把 OBS 里这个源的音频静音'); }
  const streams = await call('GetStreamStatus').catch(() => null);
  if (streams) console.log('OBS 推流中: ' + streams.outputActive);
  process.exit(0);
}
