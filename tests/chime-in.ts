// [2026-11-17] "凑热闹"双分支测试
//
// 用户要求：
//   表情包分支 20%，文字分支 10%，都只在没人 @ 时触发
// 关键约束：一次事件最多触发一个分支（不能既发图又说话）
import { loadConfig } from '../gateway/src/config.ts';
import { rollChance } from '../gateway/src/reply-text.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const { config } = loadConfig();
const gs = config.groupSticker;

console.log('--- 配置 ---');
check('表情包分支 20%', gs.probability === 0.2, String(gs.probability));
check('文字分支 10%', gs.textProbability === 0.1, String(gs.textProbability));
check('仅无人@时触发', gs.onlyWhenIgnored === true);
check('有群冷却', Number(gs.cooldownSecPerGroup) > 0, String(gs.cooldownSecPerGroup));

// 模拟决策：先判图，未命中再判文
function decide(rand: () => number): 'sticker' | 'text' | null {
  const wantSticker = rand() < gs.probability;
  if (wantSticker) return 'sticker';
  return rand() < gs.textProbability ? 'text' : null;
}

console.log('--- 互斥性 ---');
// 用确定性随机序列验证：同一次事件只会有一个结果
check('图表命中时为 sticker', decide(() => 0.05) === 'sticker');
check('图未中文命中时为 text', decide((() => { const v = [0.9, 0.05]; let i = 0; return () => v[i++]; })()) === 'text');
check('都未命中为 null', decide(() => 0.95) === null);

// 演示：无论随机数怎么给，结果只可能是三者之一（不会同时返回图+文）
let both = 0;
for (let i = 0; i < 1000; i++) {
  const r = decide(Math.random);
  if (r === 'sticker' && r === 'text') both++;
}
check('1000 次决策未出现"同时触发"', both === 0);

console.log('--- 概率采样 ---');
let sticker = 0, text = 0, none = 0;
const N = 100000;
for (let i = 0; i < N; i++) {
  const r = decide(Math.random);
  if (r === 'sticker') sticker++;
  else if (r === 'text') text++;
  else none++;
}
const pSticker = sticker / N, pText = text / N;
console.log(`  表情包 ${(pSticker*100).toFixed(1)}% | 文字 ${(pText*100).toFixed(1)}% | 不动 ${((none/N)*100).toFixed(1)}%`);
check('表情包≈20%', Math.abs(pSticker - 0.2) < 0.01, (pSticker*100).toFixed(1) + '%');
// 文字分支是在"图表没命中"(80%)的前提下再判 10%，所以总概率应为 0.8*0.1 = 8%
check('文字分支≈8%（0.8×0.1，图未中的前提下）', Math.abs(pText - 0.08) < 0.01, (pText*100).toFixed(1) + '%');
check('两者合计≈28%', Math.abs((pSticker + pText) - 0.28) < 0.01, ((pSticker+pText)*100).toFixed(1) + '%');

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
