// 开发工具：用 E:\bili.txt 的 Cookie 搜视频、看第一个的详情和字幕、取播放地址，打印她会看到的那几段话。
// node tools/video-check.mjs "关键词" [UP 主]
import { readFileSync } from 'node:fs';
import { BiliVideos, infoText, searchText, subtitleText } from '../packages/dsh-livestreamingcompanion/src/body/biliVideo';

const cookie = readFileSync(process.env.BILI_COOKIE_FILE ?? 'E:/bili.txt', 'utf8').replace(/^\uFEFF/, '').trim();
const videos = new BiliVideos(async () => cookie);
const [query = '大肥鱼', up] = process.argv.slice(2);
console.log('登录：', await videos.loggedIn());
const result = await videos.search(query, { up });
if (!result) throw new Error('搜索没返回');
console.log(`${searchText(query, result, { up })}\n`);
const first = result.hits[0];
if (first) {
  const info = await videos.info({ bvid: first.bvid });
  if (!info) throw new Error('详情没返回');
  const part = info.parts[0];
  console.log(infoText(info, part));
  console.log(subtitleText(info, part, await videos.subtitles(info.bvid, part.cid), 0, '').slice(0, 600));
  const url = await videos.playUrl(info.bvid, part.cid);
  console.log('\n播放地址：', url ? `${new URL(url).host}（MP4）` : '没有');
}
