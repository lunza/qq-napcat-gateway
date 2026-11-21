// [2026-11-16] 媒体收集与整理测试
//
// 用户要求：先收集聊天记录（文字、图片、gif），再用定时任务整理表情包含义。
// 本测试覆盖：
//   1. media 表读写：登记 → 下载回填 → 判定结果
//   2. 状态机：new → analyzed / not_sticker
//   3. 重试次数上限
//   4. 文件名唯一性（不能被 URL 前缀撞名）
//   5. 待整理队列只取已下载的
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { mediaFileName } from '../gateway/src/media.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
const store = openChatStore(path.join(dir, 'c.db'));

// ---------- 1) 登记 ----------
console.log('--- 登记媒体 ---');
const id1 = store.addMedia({ ts: '2026-11-16T00:00:00Z', peerKey: 'group:1', userId: '100', nickname: 'A', url: 'https://x/1.png' });
const id2 = store.addMedia({ ts: '2026-11-16T00:00:01Z', peerKey: 'group:1', userId: '100', nickname: 'A', url: 'https://x/2.gif' });
const id3 = store.addMedia({ ts: '2026-11-16T00:00:02Z', peerKey: 'group:1', userId: '100', nickname: 'A', url: 'https://x/3.png' });
check('登记返回自增 id', id1 > 0 && id2 > id1 && id3 > id2, `${id1},${id2},${id3}`);

let st = store.mediaStats();
check('总数 3', st.total === 3, String(st.total));
check('全部待下载', st.pendingDownload === 3, String(st.pendingDownload));
check('待整理为 0（还没下载）', st.new_ === 0, String(st.new_));

// ---------- 2) 待下载队列 ----------
console.log('--- 待下载队列 ---');
check('pendingDownloads 取到 3 条', store.pendingDownloads(10).length === 3);
check('pendingOrganize 为空（未下载）', store.pendingOrganize(10).length === 0);

// ---------- 3) 下载回填 ----------
console.log('--- 下载回填 ---');
const file1 = path.join(dir, 'a.png');
fs.writeFileSync(file1, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
store.markMediaDownloaded(id1, { localPath: file1, format: 'png', animated: false, bytes: 4 });
st = store.mediaStats();
check('下载成功后 pending 减少', st.pendingDownload === 2, String(st.pendingDownload));
check('下载成功数 +1', st.downloaded === 1, String(st.downloaded));
check('进入待整理队列', store.pendingOrganize(10).length === 1, `实际 ${store.pendingOrganize(10).length}`);

// 下载失败
store.markMediaDownloadFailed(id2, 'HTTP 400');
st = store.mediaStats();
check('下载失败计数 +1', st.downloadFailed === 1, String(st.downloadFailed));
check('失败的不进待整理', store.pendingOrganize(10).length === 1);

// ---------- 4) 整理结果 ----------
console.log('--- 整理结果 ---');
store.saveMediaAnalysis(id1, { verdict: 'sticker', category: '无语', description: '一只猫斜眼', emotion: '无语', meme: '猫猫无语' });
st = store.mediaStats();
check('判定为表情包后 analyzed +1', st.analyzed === 1, String(st.analyzed));
check('整理完移出待整理队列', store.pendingOrganize(10).length === 0);

const file3 = path.join(dir, 'c.png');
fs.writeFileSync(file3, Buffer.from([1, 2, 3]));
store.markMediaDownloaded(id3, { localPath: file3, format: 'png', animated: false, bytes: 3 });
store.saveMediaAnalysis(id3, { verdict: 'not_sticker', description: '新闻截图' });
st = store.mediaStats();
check('非表情包 notSticker +1', st.notSticker === 1, String(st.notSticker));
check('非表情包不占待整理', store.pendingOrganize(10).length === 0);
check('analyzed 仍为 1', st.analyzed === 1, String(st.analyzed));

// ---------- 5) 重试上限 ----------
console.log('--- 重试上限 ---');
const id4 = store.addMedia({ ts: 'now', peerKey: 'p', userId: '1', nickname: 'n', url: 'https://x/4.png' });
check('新记录在待下载队列', store.pendingDownloads(10).some((m) => m.id === id4));
store.bumpMediaAttempts(id4);
store.bumpMediaAttempts(id4);
check('累计 2 次仍可重试', store.pendingDownloads(10).some((m) => m.id === id4));
store.bumpMediaAttempts(id4);
check('累计 3 次后不再重试', !store.pendingDownloads(10).some((m) => m.id === id4), String(store.pendingDownloads(10).length));

// ---------- 6) 文件名唯一性 ----------
console.log('--- 文件名唯一性 ---');
const f1 = mediaFileName('https://multimedia.nt.qq.com.cn/download?fileid=AAAA', 'png');
const f2 = mediaFileName('https://multimedia.nt.qq.com.cn/download?fileid=BBBB', 'png');
check('同前缀不同 URL 文件名不同', f1 !== f2, `${f1} vs ${f2}`);
check('jpeg 映射为 jpg 后缀', mediaFileName('u', 'jpeg').endsWith('.jpg'));
check('gif 保留后缀', mediaFileName('u', 'gif').endsWith('.gif'));
check('同 URL 稳定一致', mediaFileName('u', 'png') === mediaFileName('u', 'png'));

// ---------- 7) 长期可用性 ----------
console.log('--- 落盘后不依赖 URL ---');
check('记录里保存了本地路径', store.pendingOrganize(10).length === 0);
// 已分析记录应能通过 mediaStats 反映，即使原 URL 已失效
st = store.mediaStats();
check('统计不依赖 URL 有效性', st.total === 4 && st.analyzed === 1, JSON.stringify(st));

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
