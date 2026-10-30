/**
 * 多平台推流的平台目录（来自 dsh-live 的生态清单，端点按各平台公开的通用模板填）。
 *
 * 每个平台只需要两段：服务器地址（推流域名）+ 推流码（stream key），拼起来是
 * `rtmp://host/app/key`。推流码是平台发给某个主播的私有串，必须从开播工具里拿，
 * 所以这里只给默认服务器和「去哪儿拿」的提示，主人自己在控制台里填。
 */

export interface PushPlatform {
  id: string;
  /** 界面上的标签 */
  label: string;
  /** 默认服务器地址（可以改） */
  server: string;
  /** 推流码从哪儿来 */
  hint: string;
}

export const PUSH_PLATFORMS: PushPlatform[] = [
  { id: 'custom', label: '自定义', server: '', hint: '手动填服务器地址与推流码，适合自建 RTMP/SRS/MediaMTX' },
  { id: 'weixin', label: '视频号', server: 'rtmp://push.weixin.qq.com/live', hint: '电脑端「视频号助手」→ 直播管理 → 推流地址 / 推流码' },
  { id: 'douyin', label: '抖音', server: 'rtmp://push-douyin-pub.douyinstatic.com/live', hint: '「抖音直播伴侣」→ 设置 → 推流（每次开播刷新）' },
  { id: 'kuaishou', label: '快手', server: 'rtmp://rtmp-push.kuaishou.com/live', hint: '「快手直播伴侣」→ 推流设置' },
  { id: 'douyu', label: '斗鱼', server: 'rtmp://send.douyu.com/live', hint: '斗鱼开播工具 / 主播中心 → 直播设置 → 推流地址' },
  { id: 'bilibili', label: 'B站', server: 'rtmp://txy.live-send.acg.tv/live', hint: '「B站直播姬」→ 设置 → 推流（含房间号+密钥）' },
  { id: 'yy', label: 'YY', server: 'rtmp://rtmp.yy.com/live', hint: 'YY 开播工具 / 主播后台 → 推流地址' },
  { id: 'huya', label: '虎牙', server: 'rtmp://open.live.huya.com/live', hint: '「虎牙直播伴侣」→ 推流设置（含直播间密钥）' },
  { id: 'cc', label: '网易CC', server: 'rtmp://push.cc.163.com/live', hint: '「网易CC开播工具」→ 推流地址' },
];

export function platformById(id: string): PushPlatform | null {
  return PUSH_PLATFORMS.find((p) => p.id === id) ?? null;
}

/**
 * B 站直播姬的「第三方推流」页面把服务器显示成 `rtmpsrt://live-push.bilivideo.com/live-bvc/`
 * —— 那是「RTMP 或 SRT」的占位写法，OBS / ffmpeg 都不认（OBS 会直接报 `Unknown protocol!`）。
 * 复制过来一律还原成 `rtmp://`（想要 SRT 就自己写成 `srt://`）。
 */
export function normalizePushServer(server: string): string {
  return server.trim().replace(/^rtmpsrt:\/\//i, 'rtmp://').replace(/^rtmp\+srt:\/\//i, 'rtmp://');
}

/** 把服务器地址和推流码拼成完整地址 */
export function joinPushUrl(server: string, key: string): string {
  const s = normalizePushServer(server);
  const k = key.trim();
  if (!s || !k) return '';
  return `${s.replace(/\/+$/, '')}/${k.replace(/^\/+/, '')}`;
}

/** 只显示推流码的尾巴，别把完整密钥画到界面上 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return '';
  if (k.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(6, k.length - 4))}${k.slice(-4)}`;
}
