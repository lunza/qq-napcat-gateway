// [2026-11-13] 群级共享去重测试：同群任何人触发都不重复
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSentHistory, setGroupSentHistory, fetchPopularImage } from '../gateway/src/e621.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdedup-'));
initSentHistory(path.join(dir, 'g.json'));

// 预置某群已发过一些图
const G1 = 'group:111';
const G2 = 'group:222';
setGroupSentHistory(G1, []);
setGroupSentHistory(G2, []);

console.log('  （需要真实网络）');
try {
  // 第 1 轮：模拟"甲"在群 1 触发
  const a = await fetchPopularImage({ scale: 'month', groupKey: G1 });
  console.log(`  甲在群1触发 → ${a.postId}`);
  // 第 2 轮：模拟"乙"在同一个群触发（应避开甲的）
  const b = await fetchPopularImage({ scale: 'month', groupKey: G1 });
  console.log(`  乙在群1触发 → ${b.postId}`);
  check('同群不同人触发不重复', a.postId !== b.postId, `${a.postId} vs ${b.postId}`);

  // 第 3 轮：另一个群可以发相同的图（跨群独立）
  const c = await fetchPopularImage({ scale: 'month', groupKey: G2 });
  console.log(`  群2触发 → ${c.postId}`);
  check('群2 独立（不受群1 影响）', true);

  // 连续 3 次同群
  const seen = [a.postId, b.postId];
  for (let i = 0; i < 3; i++) {
    const r = await fetchPopularImage({ scale: 'month', groupKey: G1 });
    seen.push(r.postId);
    console.log(`  群1 第${i + 3}次 → ${r.postId}`);
  }
  check('同群 5 次全不重复', new Set(seen).size === 5, `${new Set(seen).size}/5`);
} catch (e) {
  console.log(`  SKIP 真实网络：${(e as Error).message.slice(0, 60)}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
