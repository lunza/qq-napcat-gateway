// [2026-11-12] 表情包分析 + 随机机制测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectFormat, BASE_CATEGORIES } from '../gateway/src/sticker.ts';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { incomingImageSection } from '../gateway/src/reply.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 格式识别
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]);
check('识别 JPEG', detectFormat(jpeg).format === 'jpeg');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
check('识别 PNG', detectFormat(png).format === 'png');
// 单帧 GIF
const gif1 = new Uint8Array([71,73,70,56,57,97, 0,0,0,0, 0x21,0xf9, 0x3b]);
check('识别单帧 GIF', detectFormat(gif1).format === 'gif' && detectFormat(gif1).animated === false);
// 多帧 GIF
const gif2 = new Uint8Array([71,73,70,56,57,97, 0,0,0,0, 0x21,0xf9, 0,0, 0x21,0xf9, 0,0, 0x21,0xf9, 0x3b]);
check('识别动图 GIF', detectFormat(gif2).format === 'gif' && detectFormat(gif2).animated === true);

// 分类
check('预置分类数量', BASE_CATEGORIES.length >= 10, String(BASE_CATEGORIES.length));
check('含欢乐', BASE_CATEGORIES.includes('欢乐'));
check('含尴尬', BASE_CATEGORIES.includes('尴尬'));

// 数据库：分析结果存取 + 分类自驱动扩充
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
const st = openChatStore(path.join(dir, 'c.db'));
st.addSticker('https://x/1.png', 'group:1', '1001');
st.addSticker('https://x/2.gif', 'group:1', '1002');
st.addSticker('https://x/3.png', 'group:1', '1003');
check('表情包入库', st.topStickers(10).length === 3);
check('待分析数', st.unanalyzedStickers(10).length === 3);

st.saveStickerAnalysis('https://x/1.png', { description: '熊猫头发呆', emotion: '无语', category: '无语', occasion: '对方说蠢话时', animated: false, format: 'png', localPath: '/tmp/a.png' });
st.saveStickerAnalysis('https://x/2.gif', { description: '猫跳舞', emotion: '开心', category: '欢乐', occasion: '好消息时', animated: true, format: 'gif', localPath: '/tmp/b.gif' });
// 新类目（自驱动扩充）
st.saveStickerAnalysis('https://x/3.png', { description: '我裂开了', emotion: '崩溃', category: '破防', occasion: '被打击时', animated: false, format: 'png', localPath: '/tmp/c.png' });

check('分析后待分析归零', st.unanalyzedStickers(10).length === 0);
const cats = st.listCategories().map(c => c.name);
check('新分类自动入库', cats.includes('破防'), cats.join(','));
check('预置分类仍在', cats.includes('欢乐') || cats.includes('尴尬'));
const stats = st.stickerStatsByCategory();
check('分类统计正确', stats.some(s => s.category === '破防' && s.count === 1), JSON.stringify(stats));

const r1 = st.randomSticker();
check('可随机取已分析表情', r1 !== null && r1.analyzed === 1);
const r2 = st.randomSticker('欢乐');
check('可按分类取', r2 !== null && r2.category === '欢乐');
const r3 = st.randomSticker('不存在的分类');
check('无匹配返回 null', r3 === null);

// 对方发图上下文
const sec = incomingImageSection([
  { description: '熊猫头发呆', emotion: '无语', category: '无语', animated: false },
]);
check('图片上下文含描述', sec.includes('熊猫头发呆'));
check('图片上下文含情绪', sec.includes('无语'));
check('静态图标注正确', sec.includes('静态图'));
const sec2 = incomingImageSection([{ description: '猫跳舞', emotion: '开心', category: '欢乐', animated: true }]);
check('动图标注正确', sec2.includes('动图'));
check('空数组返回空', incomingImageSection([]) === '');

st.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
