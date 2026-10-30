#!/usr/bin/env bash
# 开发用：把直播值班（tools/live-guard.ts）打包、拷到推流服务器、在后台启动（断开 SSH 也接着跑）。
#   bash tools/start-guard.sh --hours 6            播 6 小时后自动下播
#   bash tools/start-guard.sh --end 04:30          服务器时间 04:30 下播
#   bash tools/start-guard.sh --hours 6 --follow-back   顺便自动回关（默认不回关，她自己有 follow 工具）
#   bash tools/start-guard.sh --stop               停掉正在跑的值班
# 参数原样交给 live-guard（见它开头的说明）。服务器布局同 deploy-server.sh。
set -euo pipefail
HOST="${DSH_SERVER:-user@your-server}"
cd "$(dirname "$0")/.."
export PATH="$(cd tools/node && pwd):$PATH"
STOP="Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Where-Object { \$_.CommandLine -like '*live-guard*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; 'stopped guard ' + \$_.ProcessId }"
if [ "${1:-}" = "--stop" ]; then
  ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -Command \"$STOP\""
  exit 0
fi
(cd packages/dsh-livestreamingcompanion && npx esbuild ../../tools/live-guard.ts --bundle --platform=node --format=esm --outfile=../../tools/live-guard.mjs --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);")
ssh -o BatchMode=yes "$HOST" "if not exist D:\\dsh-livestreamingcompanion\\monitor mkdir D:\\dsh-livestreamingcompanion\\monitor"
scp -q -o BatchMode=yes tools/live-guard.mjs "$HOST:D:/dsh-livestreamingcompanion/monitor/live-guard.mjs"
# 用 WMI 启动：不挂在这次 SSH 会话上，断开也不会跟着退出
ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -Command \"$STOP; \$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'D:\\Software\\nodejs\\node.exe D:\\dsh-livestreamingcompanion\\monitor\\live-guard.mjs --home D:\\dsh-livestreamingcompanion\\.dsh-home $*'; CurrentDirectory = 'D:\\dsh-livestreamingcompanion\\monitor' }; 'guard pid ' + \$r.ProcessId\""
