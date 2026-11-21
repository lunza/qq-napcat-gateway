// [2026-11-12] /reset 彻底重置测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { openImageStore } from '../gateway/src/image-store.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
const chat = openChatStore(path.join(dir, 'chat.db'));
const img = openImageStore(path.join(dir, 'images.db'));

const peerA = 'private:111';
const peerB = 'group:222';
for (let i = 0; i < 5; i++) {
  chat.addMessage({ ts: `2026-11-12T10:0${i}:00Z`, peerKey: peerA, kind: 'private', userId: '111', nickname: 'A', text: `A消息${i}`, images: [], isSticker: false });
  chat.addMessage({ ts: `2026-11-12T10:1${i}:00Z`, peerKey: peerB, kind: 'group', userId: '222', nickname: 'B', text: `B消息${i}`, images: [], isSticker: false });
}
chat.addSticker('https://x/a.png', peerA, '111');
chat.addSticker('https://x/b.png', peerB, '222');
img.add({ ts: '2026-11-12T10:00:00Z', peerKey: peerA, postUrl: 'u1', postId: '1', imageUrl: 'i1', ext: 'png', tags: [] });
img.add({ ts: '2026-11-12T10:01:00Z', peerKey: peerB, postUrl: 'u2', postId: '2', imageUrl: 'i2', ext: 'png', tags: [] });

check('初始消息数', chat.counts().messages === 10, String(chat.counts().messages));
check('初始图片数', img.count() === 2, String(img.count()));

// 只重置 peerA
const msgDeleted = chat.purgePeer(peerA);
const imgDeleted = img.purgePeer(peerA);

check('清除了 peerA 的 5 条消息', msgDeleted === 5, String(msgDeleted));
check('清除了 peerA 的 1 条图片', imgDeleted === 1, String(imgDeleted));
check('剩余消息 5 条（peerB 保留）', chat.counts().messages === 5, String(chat.counts().messages));
check('剩余图片 1 条', img.count() === 1, String(img.count()));

const left = chat.recentMessages(50).filter(m => m.peerKey === peerB);
check('peerB 消息完好', left.length === 5);
check('peerA 已无消息', chat.recentMessages(50).filter(m => m.peerKey === peerA).length === 0);

// 重复重置不报错
const again = chat.purgePeer(peerA);
check('重复重置返回 0', again === 0);

chat.close(); img.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
