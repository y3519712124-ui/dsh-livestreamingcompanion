# 抖音接入（二创加强版）

> 目标：让同一个「大肥鱼」在抖音直播间也能看弹幕、谢礼物、认人、点播视频 —— 和 B 站那套用同一条链路。

## 怎么用

1. 控制台 → 设置 → 直播间：点「抖音」，填直播间号（`live.douyin.com/193671986973` 后面那串数字），点「连接」。
2. 开播推流还是走 B 站那一节（OBS）。抖音自己开播用抖音直播伴侣，把 OBS 的画面推过去即可；
   插件这边负责的是**读弹幕/礼物**、**点播抖音视频**。
3. 想看观众真名（不然是「张***」）就在「密钥」里填抖音 Cookie（可选）。
4. 浏览器路径一般不用填：自动找 Chrome / Edge。

## 为什么弹幕要开一个浏览器

2026-10 实测的几条硬事实（`tools/douyin-*.mjs` 就是当时用的探针）：

| 事实 | 证据 |
|---|---|
| Node 直连 `wss://webcast*-ws-web-*.douyin.com` 会被 CDN 拒 | HTTP 200 + `handshake-msg: DEVICE_BLOCKED`（handshake-status 415）；`signature` 换成 md5 hex、16 字符签名、不带，三种都一样 |
| 真 Chrome 打开直播间能连上 | 抓到 `wss://webcast100-ws-web-hl.douyin.com/...&signature=64VRjIHYpMbQkOkR`（16 字符签名） |
| headless 的 Chrome 不会启动弹幕 | 等了 20 秒一帧都没有；同一个页面带窗口跑，8 秒就收到帧 |
| 进房接口不带 a_bogus 也能用 | `webcast/room/web/enter` 只带 ttwid：status_code 0，拿到 room_id / status / title / online |
| 视频详情从 Node 直连被挡 | `403 Blocked by ArgusSecurityPlugin Uifid Not Found`；页面自己发这个请求是通的 |

所以插件的做法是：**借页面自己的连接**。浏览器桥在页面脚本之前挂一层 `WebSocket` 钩子，
页面自己的客户端连上以后，收到的每一帧抄一份 base64 回来，Node 这边只解 protobuf。
抖音哪天改签名算法，桥不用改。

## 结构

```
core/platforms/douyin/
  douyinBridge.ts   浏览器桥：找不到窗口就开一个（挪到屏幕外），CDP 取帧 / 截页面接口响应
  douyinApi.ts      web_rid 解析、ttwid、进房拿房间信息
  douyinDecode.ts   PushFrame → Response → 各消息体 → 统一 LiveEvent
  douyinSource.ts   LiveSource 实现：连接、取帧、保活、重连、房间信息刷新
body/douyinVideo.ts 抖音视频：短链/id → 详情 → 无水印地址 → 舞台
```

`LivePlatform` 现在有 `'bilibili' | 'douyin'`，工厂在 `core/platforms/index.ts` 里登记；
观众记忆按平台分档（`store.getViewer(platform, uid)`），换平台不会把抖音观众记进 B 站档。

## 解码（字段号来自真实抓帧）

抓帧脚本：`node tools/douyin-capture.mjs <web_rid> <秒> <输出.jsonl>`（会开一个移出屏幕的 Chrome），
再用 `node tools/douyin-decode-dump.mjs <输出.jsonl>` 看结构。实测确认：

```
PushFrame {1 seqId,2 logId,6 encoding,7 type(msg|hb),8 payload}
Response  {1 messages,2 cursor,8 heartbeatDuration(=15),9 needAck}
Message   {1 method,2 payload,3 msgId}
Chat      {1 common,2 user,3 content}
Member    {1 common,2 user,3 memberCount,10 action(1=进房,2=关注)}
Gift      {1 common,2 giftId,5 repeatCount,7 user,9 repeatEnd,11 groupId,15 gift{2 name}}
Like      {1 common,2 count,3 total,5 user}
Social    {1 common,2 user,3 shareType}
RoomUserSeq {3 total,7 totalUser,10 onlineUserForAnchor}
RoomStats {5 displayValue,9 total}
User      {1 id,3 nickname,9 avatarThumb{1 url_list},24 fansClub,38 displayId,46 secUid}
```

礼物：`diamond_count` 是抖币，**1 元 = 10 抖币**，所以 `valueYuan = diamond*count/10`；
连击每帧都是累计值，只有 `repeatEnd=1` 才结算，合并 key 是 `user.id + giftId + groupId`。

测试用的就是真抓帧：`test/fixtures/douyin/*.jsonl`（一个 138 条弹幕的房间 + 一个只有点赞关注的房间）。

## 搜索（douyin_search）

抖音的搜索接口只对**登录用户**开放：未登录时 `/aweme/v1/web/general/search/single/` 固定返回
`{"status_code":2483,"status_msg":"请先登录，再继续搜索吧"}`（2026-10 实测：Node 直连、页面里 fetch、m. 子域、aweme.snssdk 全一样）。
所以顺序是：

1. **先登**：控制台 → 设置 → 密钥 →「用浏览器登录抖音」→ 弹一个看得见的 Chrome → 扫码/短信登录 →
   插件检测到 `sessionid` 就把整条 Cookie 存进 DSH 凭据（`DOUYIN_COOKIE`）。也可以直接手填。
2. **搜**：`douyin_search` 先走 Node 直连（~0.3s）；回 2483 就提示去登录；被拦才换成页面抓取（~5-8s）。

| 路 | 条件 | 代价 | 备注 |
|---|---|---|---|
| Node 直连 `general/search/single` | 有登录 Cookie | ~0.3s | 参数照抄网页搜索页（`search_channel=aweme_video_web`、`sort_type`、`offset/count`） |
| 页面抓取 | Cookie 有效但接口被拦 | 5~8s | 带 Cookie 打开 `/search/<kw>?type=video`，截页面自己那次请求的响应；卡登录/验证码会提前收手 |

错误分级（都是实跑出来的判定）：
- `2483` / 页面上是登录提示 → 「要登录，去填 Cookie」
- 页面标题或正文出现「验证码 / 安全验证」→ 「先用你自己的浏览器搜一次过掉验证码」
- 10 秒页面一条 `/video/` 链接都没有 → 提前结束（实测 16.4s 而不是干等满 20s），提示网络被限、建议让观众直接发链接

`searchQuery(keyword, page, order)` 是纯函数，测试里断言它的参数（`offset=12`、`sort_type=2`、`search_channel=aweme_video_web`）；
`parseSearch()` 只留带 `aweme_id` 的视频项（用户/直播/话题/空项都跳过，合集取第一条）。

## 验证（2026-10-28 实跑）

`node tools/douyin-live-smoke.mjs <web_rid> 40` 真连两个直播间，输出：

```
room {"platform":"douyin","roomId":70228402579,"title":"林妹在幽兰赶集","anchorName":"林妹妹（晴书追梦大舞台10.30开幕）"}
stats {"live":true,"online":1000}
state connected
event chat "Y(^_^)Y" "这个主播不错 我关注了"
event enter "LuoCh水"
stats {"likes":46348}
stats {"online":1247}
```

弹幕、进场、点赞、在线人数、本场点赞都对得上；另一个房间只有进场/点赞，也正常解出来。
单元测试用的是同一批真抓帧：`test/fixtures/douyin/chat.jsonl`（138 条弹幕）和 `social.jsonl`。

## 已知边界

- **在线人数**：进房接口给的是 `1000+` 这种粗值，实时靠 `RoomUserSeq`；都拿不到时不显示，别当 0。
- **观众名字**：没登录就是「张***」+ uid `111111`（平台的匿名约定），这时观众记忆按名字存。
- **视频搜索**：要先登录（见上面「搜索」一节）。登录后先走接口，接口被拦才开页面；未登录直接提示去填 Cookie，不浪费一次浏览器启动。
- **搜索分页**：接口那条路支持 `page`（`offset=12*page`）；页面抓取只拿第一页。
- **抖音开播**：走抖音直播伴侣 + OBS，插件不碰抖音的开播接口（那个要实名和风控验证）。
- **浏览器**：桥要一个真实的 Chrome/Edge 可执行文件；没装就把路径填进设置。
