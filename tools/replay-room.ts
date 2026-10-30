// 开发工具：拿 record-room 录下来的直播间，按她真实的节奏（想 + 说）回放给注意力层，看她能接住多少、丢了什么。
// 不调模型，不出声：只回答「人很多的直播间她顾得上什么」。
// 用法：node tools/replay-room.mjs <录像.jsonl> [她的名字,逗号分隔] [想的秒数] [说的秒数]
import { readFileSync } from 'node:fs';
import { LiveAttention } from '../packages/dsh-livestreamingcompanion/src/core/attention/attention';
import { setHerNames } from '../packages/dsh-livestreamingcompanion/src/core/attention/features';
import type { Topic } from '../packages/dsh-livestreamingcompanion/src/core/attention/topics';
import type { LiveEvent } from '../packages/dsh-livestreamingcompanion/src/core/live';

const [file, names = '', thinkSec = '2.5', speakSec = '9'] = process.argv.slice(2);
setHerNames(names.split(',').filter(Boolean));
const THINK = Number(thinkSec) * 1000;
const SPEAK = Number(speakSec) * 1000;

const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { at: number; isUpdate: boolean; event: LiveEvent });
// 录像里的 ts 是平台的真实时间，回放的时钟从 0 开始：换成相对时间（礼物连击「停没停」按 ts 判断）
const t0 = rows[0].event.ts - rows[0].at;
for (const r of rows) r.event = { ...r.event, ts: r.event.ts - t0 };
const end = rows[rows.length - 1].at;
const attention = new LiveAttention(0);
attention.setRehearsal(true);

const count = (kind: string) => rows.filter((r) => r.event.kind === kind && !r.isUpdate).length;
const users = (kind: string) => new Set(rows.filter((r) => r.event.kind === kind && !r.isUpdate).map((r) => r.event.user.id || r.event.user.name)).size;
const topics: Array<{ at: number; topic: Topic }> = [];

let i = 0;
let busyUntil = 0;
for (let now = 0; now <= end + 30_000; now += 250) {
  while (i < rows.length && rows[i].at <= now) {
    attention.observe(rows[i].event, rows[i].isUpdate, rows[i].at);
    i++;
  }
  if (now < busyUntil) continue;
  if (busyUntil && now >= busyUntil) {
    attention.speechEnded(now);
    busyUntil = 0;
  }
  const topic = attention.next(now);
  if (!topic) continue;
  topics.push({ at: now, topic });
  attention.speechStarted();
  busyUntil = now + THINK + SPEAK;
}

const who = (e: LiveEvent) => e.user.name;
function line(t: Topic): string {
  switch (t.kind) {
    case 'chat': return t.picks.map((p) => `${who(p.event)}「${p.text.slice(0, 40)}」[${p.tags.join('/')}]`).join(' | ');
    case 'superchat': return `¥${t.event.valueYuan} ${who(t.event)}「${t.event.text.slice(0, 40)}」`;
    case 'thanks': return t.events.map((e) => `${who(e)} ${e.kind === 'gift' ? `${e.giftName}×${e.count}` : e.levelName} ¥${e.valueYuan}`).join(', ');
    case 'gifts': return `${t.events.map((e) => `${who(e)} ${e.giftName}×${e.count}`).join(', ')}${t.more ? ` +${t.more}人` : ''}`;
    case 'trend': return `「${t.key}」×${t.users}人：${t.samples.join(' / ')}`;
    case 'welcome': case 'follow': return `${t.users.map((u) => u.name).join(', ')}${t.more ? ` +${t.more}` : ''}`;
    default: return '';
  }
}
for (const { at, topic } of topics) console.log(`${(at / 1000).toFixed(1).padStart(6)}s [${topic.heat}] ${topic.kind.padEnd(9)} ${line(topic)}`);

const minutes = end / 60_000;
const answeredChatUsers = new Set(topics.flatMap(({ topic }) => (topic.kind === 'chat' ? topic.picks.map((p) => p.event.user.id || p.event.user.name) : [])));
const scs = rows.filter((r) => r.event.kind === 'superchat' && !r.isUpdate).length;
const scAnswered = topics.filter(({ topic }) => topic.kind === 'superchat').length;
const guards = count('membership');
const guardThanked = topics.flatMap(({ topic }) => (topic.kind === 'thanks' ? topic.events.filter((e) => e.kind === 'membership') : [])).length;
const byKind: Record<string, number> = {};
for (const { topic } of topics) byKind[topic.kind] = (byKind[topic.kind] ?? 0) + 1;
console.log('\n── 房间 ──');
console.log(`时长 ${minutes.toFixed(1)} 分钟；弹幕 ${count('chat')} 条（${(count('chat') / minutes).toFixed(0)}/分，${users('chat')} 人）；礼物事件 ${count('gift')}；醒目留言 ${scs}；上舰 ${guards}；进场 ${count('enter')}`);
console.log('── 她 ──');
console.log(`开口 ${topics.length} 次（每 ${(end / 1000 / Math.max(1, topics.length)).toFixed(1)} 秒一次）：${JSON.stringify(byKind)}`);
console.log(`回到的弹幕观众 ${answeredChatUsers.size}/${users('chat')} 人；醒目留言 ${scAnswered}/${scs}；上舰感谢 ${guardThanked}/${guards}`);
