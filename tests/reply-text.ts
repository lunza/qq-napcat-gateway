// [2026-11-16] 回复文本处理测试
//
// 覆盖用户要求：
//   1. 回复里禁止 emoji -> stripEmoji 要干净且不误伤正常文本
//   2. 回复配表情包概率 -> rollChance 边界正确
//   3. 按情绪挑分类 -> suggestStickerCategory 命中合理
import {
  stripEmoji, hasEmoji, hasMeaningfulText, suggestStickerCategory, rollChance,
} from '../gateway/src/reply-text.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ---------- 1) emoji 识别 ----------
console.log('--- emoji 识别 ---');
const emojiCases = [
  ['😂', true, '笑cry'],
  ['🎉🎊', true, '庆祝'],
  ['我今天很开心😊', true, '句中表情'],
  ['👍', true, '手势'],
  ['❤️', true, '心形+变体选择符'],
  ['👨‍👩‍👧', true, '零宽连接符组合'],
  ['🚀', true, '交通符号'],
  ['🤔', true, '思考'],
  ['🩰', true, '扩展A区'],
  ['☀️', true, '杂项符号+变体'],
  ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', true, '旗帜(标签字符)'],
];
for (const [t, expect, label] of emojiCases) {
  check(`识别 ${label}`, hasEmoji(t as string) === expect, JSON.stringify(t));
}

const normalCases = [
  '你好呀',
  '好的，没问题！',
  '这个价格是 100 元 ± 5 元',
  '温度 25°C 左右',
  '嘿嘿~',
  '他说：^_^',
  '1+1=2',
  '',
];
for (const t of normalCases) {
  check(`不误判普通文本：${t || '(空)'}`, hasEmoji(t) === false, JSON.stringify(t));
}

// ---------- 2) emoji 剔除 ----------
console.log('--- emoji 剔除 ---');
check('剔除句中 emoji', stripEmoji('我今天很开心😊') === '我今天很开心', JSON.stringify(stripEmoji('我今天很开心😊')));
check('剔除多个 emoji', stripEmoji('好耶🎉🎊🎈') === '好耶', JSON.stringify(stripEmoji('好耶🎉🎊🎈')));
check('剔除后压掉多余空格', stripEmoji('好  😂  啊') === '好 啊', JSON.stringify(stripEmoji('好  😂  啊')));
check('纯 emoji 变成空串', stripEmoji('😂😂😂') === '');
check('纯 emoji 变体也清空', stripEmoji('❤️') === '');
check('保留中文标点', stripEmoji('哈哈！🎉') === '哈哈！', JSON.stringify(stripEmoji('哈哈！🎉')));
check('保留波浪号', stripEmoji('好啊~😊') === '好啊~');
check('保留换行结构', stripEmoji('第一行😊\n第二行') === '第一行\n第二行', JSON.stringify(stripEmoji('第一行😊\n第二行')));
check('保留数字与符号', stripEmoji('25°C ±5 度😊') === '25°C ±5 度');
check('无 emoji 时原样返回', stripEmoji('普通文本') === '普通文本');
check('空串安全', stripEmoji('') === '');

// ---------- 3) 内容有效性 ----------
console.log('--- 内容有效性 ---');
check('纯 emoji 剔除后无内容', hasMeaningfulText(stripEmoji('😂😂')) === false);
check('只有标点算无内容', hasMeaningfulText('。。！') === false);
check('有文字算有内容', hasMeaningfulText('好呀') === true);
check('有数字算有内容', hasMeaningfulText('123') === true);
check('空串无内容', hasMeaningfulText('') === false);

// ---------- 4) 概率 ----------
console.log('--- 概率 ---');
check('prob=0 不触发', rollChance(0) === false);
check('prob=1 必触发', rollChance(1) === true);
check('prob=0.1 且随机数 0.05 触发', rollChance(0.1, () => 0.05) === true);
check('prob=0.1 且随机数 0.5 不触发', rollChance(0.1, () => 0.5) === false);
check('prob=0.1 边界 0.1 不触发(<)', rollChance(0.1, () => 0.1) === false);
check('非法 prob 不触发', rollChance(NaN as unknown as number) === false);
check('负数不触发', rollChance(-1) === false);

// 统计验证：0.1 概率下 10000 次约 1000 次
let hits = 0;
for (let i = 0; i < 10000; i++) if (rollChance(0.1)) hits++;
check('10% 概率统计合理（850~1150）', hits >= 850 && hits <= 1150, `实测 ${hits}`);

// ---------- 5) 情绪分类 ----------
console.log('--- 情绪分类 ---');
check('哈哈 -> 欢乐', suggestStickerCategory('哈哈哈哈笑死我了') === '欢乐');
check('无语 -> 无语', suggestStickerCategory('我真的无语了') === '无语');
check('震惊 -> 惊讶', suggestStickerCategory('卧槽不是吧') === '惊讶');
check('问号 -> 疑问', suggestStickerCategory('你在说什么？') === '疑问');
check('好耶 -> 认同', suggestStickerCategory('好耶') === '认同');
check('无匹配返回 null', suggestStickerCategory('今天周三') === null);
check('空串返回 null', suggestStickerCategory('') === null);

// ---------- 6) 配置默认值 ----------
console.log('--- 配置 ---');
const { config } = loadConfig();
// [2026-11-17] 按用户要求提到 20%
check('凑热闹概率为 20%', config.groupSticker.probability === 0.2, String(config.groupSticker.probability));
check('replySticker 默认启用', config.replySticker?.enabled === true);
// [2026-11-17] 按用户要求提到 50%
check('回复配图概率 50%', config.replySticker?.probability === 0.5, String(config.replySticker?.probability));
check('默认剔除 emoji', config.replySticker?.stripEmoji === true);
check('默认按情绪选分类', config.replySticker?.byCategory === true);

// [2026-11-16] 口癖连续出现闸门（stripRepeatedTailPhrase）
import { stripRepeatedTailPhrase } from '../gateway/src/reply-text.ts';
check('闸门:首次出现口癖不剥离', stripRepeatedTailPhrase('太像了，笑死', ['笑死'], []) === '太像了，笑死');
check('闸门:仅1条历史重复不剥离', stripRepeatedTailPhrase('太像了，笑死', ['笑死'], ['好家伙笑死']) === '太像了，笑死');
check('闸门:连续2条重复则剥离', stripRepeatedTailPhrase('太像了，笑死', ['笑死'], ['a笑死', 'b笑死']) === '太像了');
check('闸门:剥离带标点尾缀', stripRepeatedTailPhrase('太像了，笑死~', ['笑死'], ['a笑死。', 'b笑死']) === '太像了');
check('闸门:带表情包标记也识别', stripRepeatedTailPhrase('太像了，笑死 [表情包:整活]', ['笑死'], ['a笑死', 'b笑死']) === '太像了');
check('闸门:非口癖结尾不动', stripRepeatedTailPhrase('就是土耳其国旗那个图', ['笑死'], ['a笑死', 'b笑死']) === '就是土耳其国旗那个图');
check('闸门:空口癖集合不动', stripRepeatedTailPhrase('太像了，笑死', [], ['a笑死', 'b笑死']) === '太像了，笑死');
check('闸门:剥离后为空则保留原文', stripRepeatedTailPhrase('笑死', ['笑死'], ['a笑死', 'b笑死']) === '笑死');


console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);