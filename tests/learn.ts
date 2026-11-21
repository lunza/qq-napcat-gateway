// [2026-11-12] 聊天收集 + 表情包识别 + 自我升级分析测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore, looksLikeSticker } from '../gateway/src/chat-store.ts';
import { analyze, extractCatchphrases, analyzeStickerTriggers, renderExamples, profilePromptSection } from '../gateway/src/learn.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 表情包识别
check('qq_expression 判定为表情', looksLikeSticker('https://p.qpic.cn/qq_expression/123/abc', '') === true);
check('纯图无文字判定为表情', looksLikeSticker('https://x/a.jpg', '') === true);
check('带文字的图不算', looksLikeSticker('https://x/a.jpg', '看这个') === false);
check('普通消息不算', looksLikeSticker('', '你好') === false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-'));
const store = openChatStore(path.join(dir, 'chat.db'));
check('后端可用', store.backend === 'sqlite' || store.backend === 'jsonl', store.backend);

const mk = (i: number, text: string, opts: any = {}) => ({
  ts: `2026-11-12T10:${String(i).padStart(2, '0')}:00Z`,
  peerKey: opts.peerKey ?? 'group:111', kind: 'group' as const,
  userId: opts.userId ?? '1001', nickname: opts.nick ?? '小明',
  text, images: opts.images ?? [], isSticker: opts.isSticker ?? false,
});

// 造一批数据
store.addMessage(mk(1, '哈哈哈笑死我了'));
store.addMessage(mk(2, '', { isSticker: true, images: ['https://p.qpic.cn/qq_expression/1/a'] }));
store.addMessage(mk(3, '确实离谱啊这'));
store.addMessage(mk(4, '哈哈哈'));
store.addMessage(mk(5, '', { isSticker: true, images: ['https://p.qpic.cn/qq_expression/1/a'] }));
store.addMessage(mk(6, '好家伙'));
store.addMessage(mk(7, '今天天气不错'));
store.addSticker('https://p.qpic.cn/qq_expression/1/a', 'group:111', '1001');
store.addSticker('https://p.qpic.cn/qq_expression/1/a', 'group:111', '1002');
store.addSticker('https://p.qpic.cn/qq_expression/2/b', 'group:111', '1003');

const c1 = store.counts();
check('消息已记录', c1.messages === 7, String(c1.messages));
check('表情包已记录', c1.stickers === 2, String(c1.stickers));

const top = store.topStickers(5);
check('表情包按次数排序', top[0]?.count === 2, JSON.stringify(top[0]?.count));

const recent = store.recentMessages(3);
check('最近消息新在前', recent.length === 3 && recent[0]!.text === '今天天气不错');

const all = store.recentMessages(50);
// [2026-11-16] 口癖多样化修复：门槛改为「占比 ≥3% 且 ≥5 次」。
// 小样本（7 条消息里"哈哈哈"1 次 = 0.7%）在统计上不构成群口癖，不应注入。
const phrases = extractCatchphrases(all);
check('低频词不入选（新门槛：≥3% 且 ≥5 次）', !phrases.some(p => p.includes('哈')), JSON.stringify(phrases.slice(0, 5)));

// 大样本对照：300 条里 60 条含"哈哈哈"（20%，远超门槛）→ 应入选
const bigStore = openChatStore(path.join(dir, 'big.db'));
for (let i = 0; i < 300; i++) {
  bigStore.addMessage(mk(i % 60, i < 60 ? '哈哈哈真好玩' : '普通消息内容', { userId: String(1000 + i) }));
}
const many = extractCatchphrases(bigStore.recentMessages(500));
check('高频词入选（新门槛）', many.some(p => p.includes('哈哈')), JSON.stringify(many.slice(0, 5)));

const triggers = analyzeStickerTriggers(all);
check('分析出表情包触发场景', triggers.length > 0 && triggers.some(t => t.before.includes('哈哈') || t.before.includes('确实') || t.before.includes('好家伙')), JSON.stringify(triggers));

// 跑分析
const profile = analyze(store, path.join(dir, 'learned'));
// [2026-11-12] 新语义：样本只统计"真人聊天"（有文字、非命令），纯表情消息不计入
check('画像样本数（4 条带文字）', profile.sampleSize === 4, String(profile.sampleSize));
check('平均长度为正', profile.avgLength > 0);
check('短句占比合理', profile.shortRatio > 0 && profile.shortRatio <= 1);
// 纯表情消息不算学习样本，因此表情包率为 0；这里断言统计口径正确
check('表情包率基于学习样本(此处为0)', profile.stickerRate === 0, profile.stickerRate.toFixed(1));
check('示例文件已生成', fs.existsSync(path.join(dir, 'learned', 'examples.md')));
check('画像文件已生成', fs.existsSync(path.join(dir, 'learned', 'profile.json')));
const md = fs.readFileSync(path.join(dir, 'learned', 'examples.md'), 'utf8');
check('示例含沟通特征', md.includes('平均消息长度'));
// [2026-11-16] 小样本下口癖区块不再输出（新门槛），改为验证大样本才有
check('小样本示例不含口头禅区块', !md.includes('高频口头禅'));
const bigProfile = analyze(bigStore, path.join(dir, 'learned-big'));
const bigMd = fs.readFileSync(path.join(dir, 'learned-big', 'examples.md'), 'utf8');
check('大样本示例含口头禅区块', bigMd.includes('高频口头禅'));

const sec = profilePromptSection(profile);
// [2026-11-17] 新行为：注入段 = 「语气参考」+ 最近真实聊天原文编号列表
check('提示词段含语气参考', sec.includes('语气参考') && sec.includes('模仿'), sec.slice(0, 120));
check('提示词段含编号原文', /\n1\. /.test(sec), sec.slice(0, 150));
check('空画像返回空串', profilePromptSection(null) === '');

const pats = store.loadPatterns();
check('模式已存库', pats.some(p => p.key === 'learned.summary'));

// 清空
store.purge();
check('purge 清空消息', store.counts().messages === 0);
store.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
