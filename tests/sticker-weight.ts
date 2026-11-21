// [2026-11-18] 表情包频率权重测试
//
// 用户要求："统计群友高频发送的表情包，动态调整凑热闹时发送概率"
// 关键分寸（用户："稍微调高即可"）：
//   - 权重封顶 2.5 倍，高频图不能垄断
//   - 低频图仍有机会被选中
//   - 无统计数据时退化为均匀随机
import fs from 'node:fs';
import { weightFor, pickWeighted, rankByWeight } from '../gateway/src/sticker-weight.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

console.log('--- 权重曲线 ---');
check('无人发送 → 基础权重 1', weightFor(0, 0) === 1, String(weightFor(0, 0)));
check('1 人发 1 次 < 基础×2', weightFor(1, 1) < 2, weightFor(1, 1).toFixed(2));
check('2 人发 → 有明显提升', weightFor(2, 2) > weightFor(1, 1), `${weightFor(2,2).toFixed(2)} > ${weightFor(1,1).toFixed(2)}`);
check('3 人发 → 更高', weightFor(3, 3) > weightFor(2, 2), `${weightFor(3,3).toFixed(2)}`);
check('5 人发 → 达到封顶 2.5', Math.abs(weightFor(5, 5) - 2.5) < 0.01, weightFor(5,5).toFixed(2));
check('10 人发 → 仍封顶 2.5（不无限增长）', weightFor(10, 10) === 2.5, String(weightFor(10,10)));
check('100 人发 → 仍封顶 2.5', weightFor(100, 100) === 2.5, String(weightFor(100,100)));
check('权重永不超过 2.5', [weightFor(1,1),weightFor(3,3),weightFor(50,50),weightFor(999,999)].every(w => w <= 2.5));
check('权重永不低于 1', [weightFor(0,0),weightFor(1,1),weightFor(1,5)].every(w => w >= 1));

console.log('--- 单人刷屏不应等同于群体喜爱 ---');
const groupLove = weightFor(5, 5);      // 5 个人各发一次
const soloSpam = weightFor(1, 10);      // 1 个人发 10 次
check('群体喜爱权重大于单人刷屏', groupLove > soloSpam, `群体 ${groupLove.toFixed(2)} > 单人 ${soloSpam.toFixed(2)}`);

console.log('--- 加权随机 ---');
// 确定性测试：两张图，权重 3:1，随机数 0.1 应选中第一个
check('低随机数选中高权重项', pickWeighted(['A','B'], [3,1], () => 0.1) === 'A');
check('高随机数选中低权重项', pickWeighted(['A','B'], [3,1], () => 0.9) === 'B');
check('空数组返回 null', pickWeighted([], [], () => 0.5) === null);

// 全零权重 → 均匀随机
const uni = pickWeighted(['A','B'], [0,0], () => 0.9);
check('全零权重退化为均匀随机', uni === 'B', String(uni));

// 统计验证：3:1 权重，高权重项应约占 75%
let a = 0;
const N = 100000;
for (let i = 0; i < N; i++) if (pickWeighted(['A','B'], [3,1]) === 'A') a++;
const ratio = a / N;
console.log(`  3:1 权重下，A 被选中 ${(ratio*100).toFixed(1)}%`);
check('加权比例正确（约75%）', Math.abs(ratio - 0.75) < 0.01, (ratio*100).toFixed(1)+'%');

console.log('--- 重要：高频图不能垄断 ---');
// 模拟真实场景：1 张高频图（权重2.5）+ 19 张普通图（权重1）
const items = Array.from({length: 20}, (_, i) => i);
const weights = [2.5, ...Array(19).fill(1)];
let high = 0;
for (let i = 0; i < N; i++) if (pickWeighted(items, weights) === 0) high++;
const highRatio = high / N;
console.log(`  20 张图库中，高频图占比 ${(highRatio*100).toFixed(1)}%（均匀应为5%）`);
check('高频图被选中率确实提高', highRatio > 0.05, (highRatio*100).toFixed(1)+'%');
check('高频图未垄断（<15%）', highRatio < 0.15, (highRatio*100).toFixed(1)+'%');
check('普通图仍有大量机会（>85%）', 1 - highRatio > 0.85, ((1-highRatio)*100).toFixed(1)+'%');

console.log('--- 排序辅助 ---');
const ranked = rankByWeight([
  { contentHash: 'hot', count: 10, senders: 8 },
  { contentHash: 'mid', count: 3, senders: 2 },
  { contentHash: 'cold', count: 0, senders: 0 },
]);
check('排序：高频在首位', ranked[0]?.contentHash === 'hot');
check('排序：低频在末位', ranked[2]?.contentHash === 'cold');

console.log('--- 配置 ---');
const { config } = loadConfig();
const fw = config.groupSticker.frequencyWeight;
check('权重系统默认启用', fw?.enabled === true);
check('统计窗口 30 天', fw?.windowDays === 30, String(fw?.windowDays));
check('权重上限 2.5', fw?.maxWeight === 2.5, String(fw?.maxWeight));

// ---------- 回归：contentHash 格式必须一致 ----------
console.log('--- contentHash 格式一致性（2026-11-18 修复回归）---');
{
  const mediaSrc = fs.readFileSync(new URL('../gateway/src/media.ts', import.meta.url), 'utf8');
  // media 表存"内容哈希"= sha256 前16位十六进制（无后缀）
  // stickers 表也必须存同样格式，否则频率统计永远匹配不上
  check('media.ts 不再把文件名当 contentHash', !/contentHash:\s*key\b/.test(mediaSrc) || /const key = rec\.contentHash \?\? contentHashOf\(bytes\)/.test(mediaSrc));
  check('media.ts 用 contentHashOf 生成哈希', mediaSrc.includes('contentHashOf(bytes)'));

  // 实际校验格式：contentHash 应是 16 位十六进制
  const { contentHashOf } = await import('../gateway/src/media.ts');
  const h = contentHashOf(new Uint8Array([1, 2, 3]));
  check('contentHash 为 16 位十六进制', /^[0-9a-f]{16}$/.test(h), h);
  check('contentHash 不含扩展名', !h.includes('.'));
  check('相同内容哈希一致', contentHashOf(new Uint8Array([1,2,3])) === h);
  check('不同内容哈希不同', contentHashOf(new Uint8Array([4,5,6])) !== h);
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
