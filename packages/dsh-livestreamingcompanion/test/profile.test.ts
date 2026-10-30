import { describe, expect, it } from 'vitest';
import { profileSummary, profileText, type BiliProfile } from '../src/body/biliProfile';

const base: BiliProfile = {
  uid: '42', name: '考研的阿杰', level: 5, sex: '', sign: '上岸！', fans: 12, following: 230, videos: 3, official: '', vip: false,
  recent: [{ title: '复习日记 Day 30', bvid: 'BV1xx', views: 1234, pubdate: 1_790_000_000 }], pinned: null, masterpieces: [], notice: '', live: null,
};

describe('viewer profile text', () => {
  it('lists the public facts and wraps what the viewer wrote', () => {
    const text = profileText(base, '粉丝牌21级');
    expect(text).toContain('5 级');
    expect(text).toContain('在这个直播间：粉丝牌21级');
    expect(text).toContain('<签名>上岸！</签名>');
    expect(text).toContain('「复习日记 Day 30」（BV1xx，1234播放');
  });
  it('says so when the page is empty', () => {
    expect(profileText({ ...base, videos: 0, sign: '', recent: [] })).toContain('主页很空');
  });
  it('remembers a short line for the viewer card', () => {
    expect(profileSummary(base)).toBe('5级，投稿3个，最近一个是「复习日记 Day 30」，签名「上岸！」');
  });
});
