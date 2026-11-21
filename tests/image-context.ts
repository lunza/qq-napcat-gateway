// [2026-11-12] 图片上下文测试：数据库读写 + 模型提示词注入
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openImageStore } from '../gateway/src/image-store.ts';
import { imageContextSection } from '../gateway/src/reply.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgstore-'));
const db = openImageStore(path.join(dir, 'images.db'));
check('后端可用', db.backend === 'sqlite' || db.backend === 'jsonl', db.backend);

db.add({ ts: '2026-11-12T10:00:00Z', peerKey: 'private:1', postUrl: 'https://e621.net/posts/111', postId: '111',
  imageUrl: 'https://x/111.png', ext: 'png', tags: ['wolf', 'anthro', 'beach'], artist: 'tony (artist)', species: 'wolf', query: '#来点色图' });
db.add({ ts: '2026-11-12T10:05:00Z', peerKey: 'private:1', postUrl: 'https://e621.net/posts/222', postId: '222',
  imageUrl: 'https://x/222.gif', ext: 'gif', tags: ['fox', 'snow'], species: 'fox' });
db.add({ ts: '2026-11-12T10:06:00Z', peerKey: 'private:2', postUrl: 'https://e621.net/posts/333', postId: '333',
  imageUrl: 'https://x/333.jpg', ext: 'jpg', tags: ['cat'] });

check('总条数', db.count() === 3, String(db.count()));
const r1 = db.recent('private:1', 3);
check('按会话隔离', r1.length === 2 && r1.every(x => x.peerKey === 'private:1'));
check('新的在前', r1[0]?.postId === '222', r1[0]?.postId);
check('tags 正确解析', Array.isArray(r1[1]?.tags) && r1[1]!.tags.includes('wolf'));
const r2 = db.recent('private:2', 5);
check('其他会话独立', r2.length === 1 && r2[0]!.postId === '333');
check('空会话返回空', db.recent('private:999', 5).length === 0);

// 上下文段落
const sec = imageContextSection(db.recent('private:1', 3));
check('包含原帖链接', sec.includes('https://e621.net/posts/111'));
check('包含物种标签', sec.includes('wolf'));
check('包含全部标签', sec.includes('beach'));
check('包含作者标签', sec.includes('tony'));
check('有给模型的指引', sec.includes('描述画面'));
check('空图片时返回空串', imageContextSection([]) === '');
check('最多只取 3 条', imageContextSection(new Array(5).fill({
  ts: '2026-11-12T10:00:00Z', postUrl: 'u', imageUrl: 'i', ext: 'png', tags: [],
})).split('发送时间').length - 1 === 3);

// 持久化：重开后还在
db.close();
const db2 = openImageStore(path.join(dir, 'images.db'));
check('重开后数据仍在', db2.count() === 3, String(db2.count()));
db2.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
