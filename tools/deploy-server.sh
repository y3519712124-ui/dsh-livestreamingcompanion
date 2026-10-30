#!/usr/bin/env bash
# 开发用：把插件部署到直播服务器（Windows，DSH 跑在登录的桌面会话里，计划任务 dsh-livestreamingcompanion）。
#   bash tools/deploy-server.sh            构建 → 打包 → 拷过去 → 换插件 → 重启服务器上的 DSH
#   bash tools/deploy-server.sh --no-build 不重新构建，直接拷现在的 lib
# 服务器上的布局：D:\dsh-livestreamingcompanion\{.runtime, packages\dsh-livestreamingcompanion, .dsh-home, tools\pnpm, start-dsh.cmd, run-hidden.vbs, stop-dsh.ps1}
# 只换插件包，不碰服务器上的 .dsh-home（密钥、设置、记忆）。
set -euo pipefail
HOST="${DSH_SERVER:-user@your-server}"
cd "$(dirname "$0")/../packages/dsh-livestreamingcompanion"
export PATH="$(cd ../../tools/node && pwd):$PATH"
if [ "${1:-}" != "--no-build" ]; then node build.mjs; fi
TMP="$(mktemp -d)"
tar -czf "$TMP/plugin.tgz" package.json cordis.patch.yml lib assets stage
scp -q -o BatchMode=yes "$TMP/plugin.tgz" "$HOST:D:/dsh-livestreamingcompanion/plugin.tgz"
rm -rf "$TMP"
ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File D:\\dsh-livestreamingcompanion\\stop-dsh.ps1 & cd /d D:\\dsh-livestreamingcompanion && rmdir /s /q packages\\dsh-livestreamingcompanion && mkdir packages\\dsh-livestreamingcompanion && tar -xzf plugin.tgz -C packages\\dsh-livestreamingcompanion && del plugin.tgz && schtasks /Run /TN dsh-livestreamingcompanion >nul && echo deployed"
