// [2026-11-17] 跟图 +1 测试
//
// 场景：群里 A 发了一张表情包，B 又发了同一张 → 机器人跟着发一张一样的（只发一次）
// 依赖：按 contentHash（图片内容）识别，因为 QQ 同一张图每次 URL 都不同
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { contentHashOf } from '../gateway/src/media.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-'));
const store = openChatStore(path.join(dir, 'c.db'));
const G = 'group:2000000001';
const nowIso = () => new Date().toISOString();

// 造两张内容不同的图
const imgA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]);
const imgB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 2, 2, 2]);
const fileA = path.join(dir, 'a.png'); fs.writeFileSync(fileA, imgA);
const fileB = path.join(dir, 'b.png'); fs.writeFileSync(fileB, imgB);

function addMedia(userId: string, url: string, img: Buffer, peerKey = G): number {
  const id = store.addMedia({ ts: nowIso(), peerKey, userId, nickname: `u${userId}`, url });
  const f = path.join(dir, `m${id}.png`);
  fs.writeFileSync(f, img);
  store.markMediaDownloaded(id, { localPath: f, format: 'png', animated: false, bytes: img.length, contentHash: contentHashOf(img) });
  return id;
}

console.log('--- 内容哈希 ---');
check('相同内容哈希相同', contentHashOf(imgA) === contentHashOf(imgA));
check('不同内容哈希不同', contentHashOf(imgA) !== contentHashOf(imgB));

console.log('--- 只有一个人发：不触发 ---');
addMedia('1001', 'https://x/1.png', imgA);
let rep = store.repeatedImagesInPeer(G, new Date(Date.now() - 120000).toISOString(), 10);
check('单人发送不算接龙', rep.length === 0, `实际 ${rep.length}`);

console.log('--- 两个人发同一张：触发 ---');
addMedia('1002', 'https://x/2.png', imgA);   // 同内容，不同 URL、不同人
rep = store.repeatedImagesInPeer(G, new Date(Date.now() - 120000).toISOString(), 10);
check('两人发同图被识别', rep.length === 1, `实际 ${rep.length}`);
check('返回记录带 contentHash', rep[0]?.contentHash === contentHashOf(imgA));
check('返回记录带本地路径', !!rep[0]?.localPath && fs.existsSync(rep[0]!.localPath!));

console.log('--- 不同群互不影响 ---');
addMedia('1003', 'https://x/3.png', imgA, 'group:999');
const repG = store.repeatedImagesInPeer(G, new Date(Date.now() - 120000).toISOString(), 10);
const repOther = store.repeatedImagesInPeer('group:999', new Date(Date.now() - 120000).toISOString(), 10);
check('本群仍只算 1 组', repG.length === 1, `实际 ${repG.length}`);
check('其它群只有 1 人发，不触发', repOther.length === 0, `实际 ${repOther.length}`);

console.log('--- 不同内容不误判 ---');
addMedia('1004', 'https://x/4.png', imgB);
addMedia('1005', 'https://x/5.png', imgB);
rep = store.repeatedImagesInPeer(G, new Date(Date.now() - 120000).toISOString(), 10);
check('两组重复图都识别', rep.length === 2, `实际 ${rep.length}`);
check('两组 hash 不同', rep[0]?.contentHash !== rep[1]?.contentHash);

console.log('--- 时间窗口 ---');
const oldIso = new Date(Date.now() - 120000).toISOString();
const futureWindow = store.repeatedImagesInPeer(G, new Date(Date.now() + 10000).toISOString(), 10);
check('窗口外（未来）查不到', futureWindow.length === 0, `实际 ${futureWindow.length}`);
check('窗口内查得到', store.repeatedImagesInPeer(G, oldIso, 10).length === 2);

console.log('--- 同一人连发两次不算接龙 ---');
const G2 = 'group:555';
addMedia('2001', 'https://y/1.png', imgA, G2);
addMedia('2001', 'https://y/2.png', imgA, G2);   // 同一个人
check('同一人发两次不触发', store.repeatedImagesInPeer(G2, oldIso, 10).length === 0);

console.log('--- 配置 ---');
const { config } = loadConfig();
const fs2 = config.groupSticker.followSameSticker;
check('跟图默认启用', fs2?.enabled === true);
check('默认窗口 120 秒', fs2?.followWindowSec === 120, String(fs2?.followWindowSec));
check('默认每群冷却 600 秒', fs2?.followCooldownSecPerGroup === 600, String(fs2?.followCooldownSecPerGroup));

store.close();
fs.rmSync(dir, { recursive: true, force: true });
// ---------- 7) [2026-11-18] 发送接口选择：必须用 sendGroupImage 而不是 sendGroup ----------
console.log('--- 发送接口（修复回归）---');
{
  const src = fs.readFileSync(new URL('../gateway/src/main.ts', import.meta.url), 'utf8');
  // 定位跟图函数体
  const start = src.indexOf('async function maybeFollowSameSticker');
  const end = src.indexOf('\n}', src.indexOf('跟图 +1 发送失败', start));
  const body = src.slice(start, end > start ? end : start + 3000);
  check('跟图函数内用 sendGroupImage', body.includes('sendGroupImage('));
  check('跟图函数内没有误用 sendGroup(', !/client\.sendGroup\b(?!Image)/.test(body.replace(/sendGroupImage/g, '')));

  // 全局检查：任何把 b64/base64 传给 sendGroup 的地方都是 bug
  const lines = src.split('\n');
  let misuse = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/client\.sendGroup\(/.test(l) || /sendGroupImage/.test(l)) continue;
    if (l.trim().startsWith('//')) continue;
    if (/\bb64\b|base64:\/\//.test(l)) misuse++;
  }
  check('全局无"把 base64 交给 sendGroup"的误用', misuse === 0, `发现 ${misuse} 处`);

  // 反向确认：sendGroupImage 接收的是图片消息段
  const onebot = fs.readFileSync(new URL('../gateway/src/onebot.ts', import.meta.url), 'utf8');
  check('sendGroupImage 组装 image 消息段', /send_group_msg[\s\S]{0,200}buildImageMessage/.test(onebot));
  check('buildImageMessage 产生 type:image', /type:\s*'image'/.test(onebot));
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
