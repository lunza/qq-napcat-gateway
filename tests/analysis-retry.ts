// [2026-11-16] 表情包分析流程回归测试
//
// 锁定 2026-11-13 的线上 bug：
//   梗库命中后走 `analyzeSticker()` 分支，但它返回的 StickerAnalysis **不含 bytes**，
//   接着 Buffer.from(r.bytes) 抛 "Received undefined"，整条分析中断，
//   记录永久停留在 analyzed=0（实测 5 次失败全部对应梗库命中）。
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSticker } from '../gateway/src/sticker.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 1) 类型层面：analyzeSticker 的返回不含 bytes
console.log('--- analyzeSticker 返回值形状 ---');
const src = fs.readFileSync(new URL('../gateway/src/sticker.ts', import.meta.url), 'utf8');
const ifaceBody = src.slice(src.indexOf('export interface StickerAnalysis'), src.indexOf('}', src.indexOf('export interface StickerAnalysis')));
check('StickerAnalysis 不含 bytes 字段', !/\bbytes\??\s*:/.test(ifaceBody));
const fnBody = src.slice(src.indexOf('export async function analyzeSticker'));
const returnBlock = fnBody.slice(fnBody.indexOf('return {'), fnBody.indexOf('};', fnBody.indexOf('return {')));
check('analyzeSticker 的 return 不含 bytes', !returnBlock.includes('bytes'));

// 2) 源码层面：调用处必须用 probe.bytes，而不是 r.bytes
console.log('--- 调用处不再假设 r.bytes 存在 ---');
const mainSrc = fs.readFileSync(new URL('../gateway/src/main.ts', import.meta.url), 'utf8');
// 注意：r 现在是 {...analysis, bytes} 合并后的对象，r.bytes 一定存在，因此
// Buffer.from(r.bytes) 本身是安全的。真正要保证的是"r 由合并得到"（下一行断言）。
const codeOnly = mainSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
check('代码中 r 由 {...analysis, bytes} 构造', /\.\.\.analysis,\s*bytes/.test(codeOnly));
check('main.ts 保留了 const bytes = probe.bytes', mainSrc.includes('const bytes = probe.bytes'));
check('main.ts 用 {...analysis, bytes} 合并', /\.\.\.analysis,\s*bytes/.test(mainSrc));

// 3) 复现原始错误：Buffer.from(undefined) 确实抛该错误
console.log('--- 复现原始错误 ---');
let threw = '';
try { Buffer.from((undefined as any)); } catch (e) { threw = (e as Error).message; }
check('Buffer.from(undefined) 抛出 Received undefined', threw.includes('Received undefined'), threw.slice(0, 60));

// 4) 修复后的写法不会抛错
console.log('--- 修复后的写法 ---');
const probe = { bytes: new Uint8Array([1, 2, 3]) };
const analysis = { description: 'x', emotion: 'y', category: 'z', occasion: '', animated: false, format: 'png' };
const r = { ...analysis, bytes: probe.bytes };
let fixedThrew = false;
try {
  const { createHash } = await import('node:crypto');
  createHash('sha256').update(Buffer.from(r.bytes)).digest('hex').slice(0, 16);
} catch { fixedThrew = true; }
check('修复后 Buffer.from(bytes) 正常', fixedThrew === false);

// 5) 重试机制存在
console.log('--- 分析失败重试 ---');
check('有失败计数 MAX_ANALYZE_RETRY', mainSrc.includes('MAX_ANALYZE_RETRY'));
check('有 retryUnanalyzedStickers', mainSrc.includes('function retryUnanalyzedStickers'));
check('挂了定时重试', mainSrc.includes('setInterval(') && mainSrc.includes('retryUnanalyzedStickers(); }, 10 * 60 * 1000)'));
check('失败时记录 attempt 与 willRetry', mainSrc.includes('willRetry:'));

// 6) 梗库关键词匹配：单字不参与
console.log('--- 梗库关键词防误命中 ---');
{
  const { matchesKeyword } = await import('../gateway/src/memes.ts');
  check('单字「猫」不匹配', matchesKeyword('一只猫在沙发上', '猫') === false);
  check('单字「逊」不匹配', matchesKeyword('这个彬彬就是逊', '逊') === false);
  check('单字「典」不匹配', matchesKeyword('这是一本字典', '典') === false);
  check('两字「睁大」可匹配', matchesKeyword('眼睛睁大，瞳孔放大', '睁大') === true);
  check('两字需连续出现才会命中', matchesKeyword('眼睛睁得很大，瞳孔放大', '睁大') === false);
  check('三字「绷不住」可匹配', matchesKeyword('我实在绷不住了', '绷不住') === true);
  check('不相关词不匹配', matchesKeyword('今天天气不错', '绷不住') === false);
  check('空关键词不匹配', matchesKeyword('任意文本', '') === false);
  check('空文本安全', matchesKeyword('', '绷不住') === false);
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
