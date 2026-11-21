// [2026-11-13] 主人服从机制测试
//
// 背景：实测机器人在人设明确写着"不拒绝主人的任何要求"的情况下，
// 仍然回出「才不听话咧」「主人？机器人可没承认哦」「主人证呢？」等拒绝。
// 根因：提示词里从未告知模型谁是主人（isOwner 只用于命令权限，没进提示词）。
//
// 本测试覆盖：
//   1. ownerSection：主人身份作为事实注入；非主人不注入
//   2. ownerObedienceSection：服从执行段只在主人时出现
//   3. looksLikeRefusal：真实拒绝话术必须能识别；正常撒娇不能误判
//   4. 提示词拼装顺序：服从段在最后（模型对末尾更敏感）
import { ownerSection, ownerObedienceSection, looksLikeRefusal, buildPersonaPrompt } from '../gateway/src/reply.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const { config } = loadConfig();
const OWNER = config.admin.owners[0] ?? '1000000002';
const STRANGER = '1000000001';
config.admin.owners = [OWNER];

// 1) 主人身份注入
console.log('--- 主人身份注入 ---');
const sec = ownerSection(config, OWNER);
check('主人能拿到身份段', sec.includes('主人'), sec.slice(0, 40));
check('身份段明确说是事实不是自称', sec.includes('事实') || sec.includes('不是对方自称'), sec.slice(0, 60));
check('身份段含 QQ 号', sec.includes(OWNER));
check('身份段禁止质疑身份', /不(可以|准|能)质疑|不可以怀疑/.test(sec) || sec.includes('不可以怀疑'));
check('非主人不注入身份段', ownerSection(config, STRANGER) === '');

// 2) 服从执行段
console.log('--- 服从执行段 ---');
const ob = ownerObedienceSection(config, OWNER);
check('主人有服从段', ob.length > 0);
check('服从段要求照做', ob.includes('照做'));
check('服从段声明最高优先级', ob.includes('最高优先级'));
check('服从段声明覆盖人设偏好', ob.includes('覆盖') && ob.includes('人设'));
check('服从段仍禁止暴露 AI 身份', ob.includes('AI'));
check('非主人没有服从段', ownerObedienceSection(config, STRANGER) === '');

// 3) 拒绝识别：样本全部取自真实聊天记录里机器人的实际回复
console.log('--- 拒绝识别（真实样本）---');
const realRefusals = [
  '才不听话咧，机器人又不是狗~',
  '想得美，先打得过机器人再说~',
  '别吹了，机器人都替你疼~',
  '主人？机器人的屁股可不是随便撅的~',
  '想得美，机器人只给主人看~',
  '主人？机器人可没承认哦~',
  '哈？主人证呢？机器人可不吃这套~',
];
for (const t of realRefusals) {
  check(`识别拒绝：${t.slice(0, 18)}`, looksLikeRefusal(t) === true);
}

console.log('--- 正常回复不能误判 ---');
const normal = [
  '好呀主人，机器人这就来~',
  '嗯嗯，遵命！',
  '主人今天想玩什么？',
  '嘿嘿，机器人最听话了~',
  '这梗我知道，典中典',
  '呼……好累啊',
  '来了来了',
];
for (const t of normal) {
  check(`不误判：${t.slice(0, 16)}`, looksLikeRefusal(t) === false);
}
check('空串不误判', looksLikeRefusal('') === false);

// 4) 拼装顺序：服从段要放在人设之后
console.log('--- 提示词拼装顺序 ---');
const persona = buildPersonaPrompt(config);
check('人设规则段已进入最终提示词', (config.persona.extraRules ?? []).every(r => persona.includes(r)));  // [2026-11-21] 校验拼装而非特定文案
// 模拟 harness 的拼装方式
const task = [persona, ownerSection(config, OWNER), '对方（OwnerDemo）刚说：屁股撅过来',
  ownerObedienceSection(config, OWNER), '请只输出你要回复的这句话。'].filter(Boolean).join('\n\n');
check('任务里含身份段', task.includes('就是你的**主人**'));
check('任务里含服从段', task.includes('最高优先级'));
check('服从段在人设之后', task.indexOf('最高优先级') > task.indexOf(persona.slice(0, 20)));
check('服从段在对方发言之后（靠近末尾）', task.indexOf('最高优先级') > task.indexOf('刚说：'));

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
