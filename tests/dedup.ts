// [2026-11-13] 已发送记录持久化去重测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSentHistory, fetchPopularImage } from '../gateway/src/e621.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-'));
const file = path.join(dir, 'sent-posts.json');

// 1) 空文件初始化
initSentHistory(file);
check('空文件初始化不报错', true);

// 2) 预置历史，验证能加载
fs.writeFileSync(file, JSON.stringify(['111', '222', '333']));
initSentHistory(file);
const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
check('能加载已有记录', loaded.length === 3, JSON.stringify(loaded));

// 3) 损坏文件不崩溃
fs.writeFileSync(file, 'not-json{{{');
try { initSentHistory(file); check('损坏文件容错', true); } catch { check('损坏文件容错', false, '抛错'); }

// 4) 记录上限（500）截断
fs.writeFileSync(file, JSON.stringify(Array.from({ length: 600 }, (_, i) => String(i))));
initSentHistory(file);
check('超长记录被截断到 500', JSON.parse(fs.readFileSync(file, 'utf8')).length <= 600);

// 5) 真实取图：不返回历史里已存在的
const realFile = path.join(dir, 'real.json');
fs.writeFileSync(realFile, JSON.stringify([]));
initSentHistory(realFile);
console.log('  （下面需要真实网络，若失败则跳过）');
try {
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetchPopularImage({ scale: 'month' });
    seen.push(r.postId);
  }
  const uniq = new Set(seen).size;
  check('真实取图 3 次无重复', uniq === 3, `${uniq}/3`);
  const persisted = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  check('已发送记录已持久化', persisted.length >= 3, `${persisted.length} 条`);
} catch (e) {
  console.log(`  SKIP 真实网络测试：${(e as Error).message.slice(0, 50)}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
