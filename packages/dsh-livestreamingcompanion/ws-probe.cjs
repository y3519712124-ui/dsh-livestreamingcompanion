
const WebSocket = require('ws');
const { createHash } = require('node:crypto');
const c = JSON.parse(require('fs').readFileSync('C:/Users/Admin/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json', 'utf8'));
const port = c.server_port || 4455;
const ws = new WebSocket('ws://127.0.0.1:' + port);
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 20000);
ws.on('open', () => console.log('open'));
ws.on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.op === 0) {
    const identify = { rpcVersion: 1 };
    if (msg.d.authentication) {
      const secret = createHash('sha256').update(c.server_password + msg.d.authentication.salt).digest('base64');
      identify.authentication = createHash('sha256').update(secret + msg.d.authentication.challenge).digest('base64');
    }
    ws.send(JSON.stringify({ op: 1, d: identify }));
  } else if (msg.op === 2) {
    ws.send(JSON.stringify({ op: 6, d: { requestType: 'GetVersion', requestId: '1', requestData: {} } }));
  } else if (msg.op === 7) {
    console.log('WS OK obs=' + msg.d.responseData.obsVersion + ' ws=' + msg.d.responseData.obsWebSocketVersion);
    clearTimeout(timer);
    process.exit(0);
  }
});
