// 开发工具：看一个 UID 的主页，打印她会看到的那段话和记进记忆的那句。
import { readFileSync } from 'node:fs';
import { fetchProfile, profileSummary, profileText } from '../packages/dsh-livestreamingcompanion/src/body/biliProfile';
// 和插件一样带开播账号的 Cookie（默认 E:/bili.txt，BILI_COOKIE_FILE 可以换）
const cookie = readFileSync(process.env.BILI_COOKIE_FILE ?? 'E:/bili.txt', 'utf8').replace(/^\uFEFF/, '').trim();
for (const uid of process.argv.slice(2)) {
  const p = await fetchProfile(uid, cookie);
  console.log(p ? `${profileText(p, '舰长，粉丝牌25级')}\n记忆：${profileSummary(p)}\n` : `${uid}：没拿到`);
}
