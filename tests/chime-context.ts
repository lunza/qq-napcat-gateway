// [2026-11-19] 凑热闹上下文测试
//
// 用户要求："凑热闹要结合至少10条上下文，并且注意里面可能有图片，
//           否则仅针对一条消息凑热闹会导致不知所云"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore } from '../gateway/src/chat-store.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
const store = openChatStore(path.join(dir, 'c.db'));
const G = 'group:123';

function addMsg(nickname: string, text: string, images: string[] = [], ts?: string) {
  store.addMessage({
    ts: ts ?? new Date(Date.now() - Math.random() * 100000).toISOString(),
    peerKey: G, kind: 'group', userId: `u-${nickname}`, nickname, text,
    images, isSticker: images.length > 0, isCommand: false,
  });
}

console.log('--- 取群聊历史 ---');
for (let i = 1; i <= 15; i++) addMsg(`群友${i}`, `第${i}条消息`);
const rows = store.recentMessagesInPeer(G, 12);
check('能取到 12 条', rows.length === 12, String(rows.length));
check('最新的在最前面', rows[0]?.text === '第15条消息', rows[0]?.text);
check('含昵称', rows[0]?.nickname === '群友15', rows[0]?.nickname);
check('含 userId', !!rows[0]?.userId);
check('无图片时 hasImage=false', rows[0]?.hasImage === false);

console.log('--- 图片识别 ---');
addMsg('发图的人', '[image]', ['https://x/1.png']);
const withImg = store.recentMessagesInPeer(G, 3);
check('带图消息 hasImage=true', withImg[0]?.hasImage === true);
check('普通消息 hasImage=false', withImg[1]?.hasImage === false);

console.log('--- 图片描述关联 ---');
// 造一条带描述的媒体（同一群、时间接近）
const mid = store.addMedia({ ts: withImg[0]!.ts, peerKey: G, userId: 'u', nickname: '发图的人', url: 'https://x/1.png' });
store.markMediaDownloaded(mid, { localPath: path.join(dir, 'x.png'), format: 'png', animated: false, bytes: 1, contentHash: 'abc123' });
store.saveMediaAnalysis(mid, { verdict: 'sticker', category: '惊讶', description: '一只猫瞪大了眼睛' });
const withDesc = store.recentMessagesInPeer(G, 3);
check('带描述的图片能关联到消息', withDesc[0]?.imageDescriptions.length === 1, JSON.stringify(withDesc[0]?.imageDescriptions));
check('描述内容正确', (withDesc[0]?.imageDescriptions[0] ?? '').includes('猫'), withDesc[0]?.imageDescriptions[0]);

console.log('--- 空会话 ---');
check('不存在的会话返回空数组', store.recentMessagesInPeer('group:none', 10).length === 0);

console.log('--- limit 边界 ---');
check('limit=1 只取 1 条', store.recentMessagesInPeer(G, 1).length === 1);
check('limit 大于总数时返回全部', store.recentMessagesInPeer(G, 999).length === 16);

console.log('--- 源码层面：凑热闹确实用 >=10 条上下文 ---');
const src = fs.readFileSync(new URL('../gateway/src/main.ts', import.meta.url), 'utf8');
const start = src.indexOf('async function sendGroupChimeIn');
const end = src.indexOf('\n}\\n', start);
const body = src.slice(start, end > start ? end : start + 6000);
check('使用 chatStore.recentMessagesInPeer', body.includes('recentMessagesInPeer'));
check('上下文至少 10 条', /CTX_SIZE\s*=\s*(\d+)/.test(body) && Number(/CTX_SIZE\s*=\s*(\d+)/.exec(body)![1]) >= 10,
  /CTX_SIZE\s*=\s*(\d+)/.exec(body)?.[1]);
check('提示词包含图片说明', body.includes('[图片'));
check('提示词要求先读懂脉络', body.includes('脉络') || body.includes('答非所问'));
check('不再只依赖内存 history', !/recent = \(history\.get\(groupKey\) \?\? \[\]\)/.test(body.split('catch')[0] ?? '') || body.includes('退回内存历史'));

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
