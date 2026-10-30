/** 直播平台适配器工厂：新增平台在这里登记 */

import type { LiveConnection } from '../live';
import type { LiveSource } from './source';
import { BiliLiveSource } from './bilibili/biliSource';
import { DouyinLiveSource } from './douyin/douyinSource';

export type { LiveSource, LiveSourceListener } from './source';

export function createLiveSource(config: LiveConnection): LiveSource {
  switch (config.platform) {
    case 'bilibili':
      return new BiliLiveSource(config.roomId, config.cookie);
    case 'douyin':
      return new DouyinLiveSource(config.roomId, {
        cookie: config.cookie,
        ...(config.browserPath ? { browserPath: config.browserPath } : {}),
      });
    default:
      throw new Error(`不支持的直播平台：${String(config.platform)}`);
  }
}
