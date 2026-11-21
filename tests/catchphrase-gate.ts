import { gateCatchphrase } from '../gateway/src/reply.ts';
let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 最近 2 条都带"笑死" → 新回复里的"笑死"应被剔除
const r1 = gateCatchphrase('笑死，这也可以', ['笑死', '真的笑死']);
check('连续复读被剔除', !r1.text.includes('笑死') && r1.stripped === '笑死', r1.text);
// 剔除后只剩标点 → 置空
const r2 = gateCatchphrase('笑死', ['笑死', '又笑死']);
check('剔除后为空则置空', r2.text === '', JSON.stringify(r2));
// 最近没用过 → 保留
const r3 = gateCatchphrase('笑死，太离谱了', ['今天天气不错', '好的']);
check('非复读则保留', r3.text.includes('笑死') && r3.stripped === null, r3.text);
// 只用过 1 次 → 保留（阈值 ≥2）
const r4 = gateCatchphrase('笑死', ['昨天笑死过一次', '无关']);
check('只用过1次保留', r4.text.includes('笑死'), r4.text);
// 多词分别判断
const r5 = gateCatchphrase('哈哈哈绝了', ['哈哈哈', '绝了', '哈哈哈绝了']);
check('多词同时剔除', !r5.text.includes('哈哈') && !r5.text.includes('绝了'), r5.text);
// 不动正常内容
const r6 = gateCatchphrase('我去看看', ['笑死', '又笑死']);
check('无关内容不动', r6.text === '我去看看', r6.text);

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
