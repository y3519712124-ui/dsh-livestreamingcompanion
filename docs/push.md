# 多平台推流（生态功能）

把**同一份画面**同时推到多个直播平台：一条 ffmpeg 命令，多路 RTMP 输出。
和 B 站官方开播流程（`broadcast.ts` → OBS）并行存在，互不影响。

## 平台

| 标签 | 默认服务器 | 推流码从哪儿拿 |
|---|---|---|
| 自定义 | 自己填 | 自建 RTMP / SRS / MediaMTX |
| 视频号 | `rtmp://push.weixin.qq.com/live` | 视频号助手 → 直播管理 → 推流地址 / 推流码 |
| 抖音 | `rtmp://push-douyin-pub.douyinstatic.com/live` | 抖音直播伴侣 → 设置 → 推流（每次开播刷新） |
| 快手 | `rtmp://rtmp-push.kuaishou.com/live` | 快手直播伴侣 → 推流设置 |
| 斗鱼 | `rtmp://send.douyu.com/live` | 斗鱼开播工具 / 主播中心 → 直播设置 |
| B站 | `rtmp://txy.live-send.acg.tv/live` | B站直播姬 → 设置 → 推流（房间号+密钥） |
| YY | `rtmp://rtmp.yy.com/live` | YY 开播工具 / 主播后台 |
| 虎牙 | `rtmp://open.live.huya.com/live` | 虎牙直播伴侣 → 推流设置 |
| 网易CC | `rtmp://push.cc.163.com/live` | 网易CC开播工具 → 推流地址 |

服务器地址都可以在控制台里改；平台改端点时不用改代码。

## 四种画面来源

| input | 说明 |
|---|---|
| `capture` | **浏览器采集**：摄像头 / 屏幕共享（可加画中画），控制台混音后按 WebM 分片喂给宿主 ffmpeg。最接近 OBS 的效果，也最常用 |
| `stage` | `gdigrab title=<窗口标题>` 抓舞台那个浏览器窗口 |
| `desktop` | `gdigrab` 抓屏幕一块区域（x/y/宽/高 可调） |
| `relay` | 从本机已有的 RTMP/SRT 拉流再分发（OBS → MediaMTX → 这里） |
| `test` | lavfi 彩条 + 440Hz，验证链路用 |

### capture 链路

```
getUserMedia / getDisplayMedia
        ↓  canvas 合成（屏幕 + 右下角圆形摄像头）
        ↓  captureStream(30) + AudioContext 混音（屏幕声 + 麦克风）
        ↓  MediaRecorder(video/webm;codecs=vp8,opus, 每 800ms 一片)
        ↓  POST /api/dsh-livestreamingcompanion/push/feed
        ↓  宿主 push.feed() → ffmpeg stdin（-f webm -i pipe:0）
        ↓  -c:v libx264 -preset veryfast -tune zerolatency -c:a aac
        ↓  -f flv rtmp://平台A/… -f flv rtmp://平台B/…
```

也就是**一次编码、多路输出**：选中的平台各一路，取消选中立刻停。

## 引擎

- `ffmpeg`：真推。启动时 `detect()` 找 ffmpeg（先看配置里的 `ffmpegPath`，再走 PATH）。
- `simulate`：只维护 running / 目标状态，不连平台，用来先把参数配好。

**一键安装**（Windows）：`POST /push/install`
1. 先试 `winget install --id Gyan.FFmpeg -e`；
2. 没有 winget 就下 `ffmpeg-release-essentials.zip`，用 `tar -xf` 解到 `<dataDir>/ffmpeg`，找到 `ffmpeg.exe` 写进 `push.json`。

## 配置与存储

推流码是机密，**不进 `settings.json`**，单独存 `<dataDir>/push.json`（默认 `~/.dsh/dsh-livestream/push.json`，因为是用户数据目录，插件改名也不动它）。

读接口只回 `hasKey: true/false`，值不出后端；写接口里 `key` 传空串表示「不改」。

```jsonc
{
  "mode": "ffmpeg",
  "input": "capture",
  "ffmpegPath": "",
  "fps": 30, "width": 1920, "height": 1080, "kbps": 4500,
  "targets": {
    "douyin": { "server": "rtmp://push-douyin-pub.douyinstatic.com/live", "key": "…", "on": true }
  }
}
```

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/push/platforms` | 平台目录（标签/默认服务器/获取提示） |
| GET | `/push/state` | 运行状态 + 脱敏后的配置 |
| POST | `/push/config` | 改配置（`mode`/`input`/`ffmpegPath`/`fps`/`kbps`/`region`/`target`） |
| POST | `/push/start` / `/push/stop` | 开推 / 停推 |
| POST | `/push/detect` | 重新检测 ffmpeg |
| POST | `/push/install` | 一键装 ffmpeg |
| POST | `/push/feed` | 浏览器采集分片（二进制 body） |

## 自检

```bash
node tools/push-check.mjs
```

打印组装好的 ffmpeg 参数、ffmpeg 版本，并用 `-t 0.5 -f null -` 真跑半秒验证编码链（把 `-f flv url` 输出段切掉，不联网）。

## 已知边界

- capture 走的是**转码**（VP8→H.264），多一路输出不额外编码，但 CPU 会有一次编码开销；`veryfast + zerolatency` 在 1080p30 大约 15–25% 一个核。
- 浏览器采集要求页面是安全上下文（`http://127.0.0.1` 或 https），首次会弹权限框。
- 抖音/快手等推流码会过期，报错通常是 `Connection refused` / `403`，重新在开播工具里复制即可。
