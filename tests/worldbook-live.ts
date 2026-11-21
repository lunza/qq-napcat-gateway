// [2026-11-16] 世界书真实链路冒烟：真实 crec bge-m3 对真实梗库（50 条）建向量，
// 验证「派大星跳伞是什么意思」能被语义召回。需要 CREC_API_KEY（.env）与网络。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openMemeLibrary, cleanMemeText } from '../gateway/src/memes.ts';
import { createWorldbook, resolveWorldbookConfig, cosine } from '../gateway/src/worldbook.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 加载 .env（KEY=VALUE 逐行，仅本进程生效）
try {
  const envFile = fs.readFileSync(path.resolve(import.meta.dirname ?? '.', '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* 无 .env 时靠环境变量 */ }

const apiKey = process.env.CREC_API_KEY ?? '';
if (!apiKey) {
  console.log('SKIP  未配置 CREC_API_KEY');
  process.exit(0);
}

async function crecEmbed(texts: string[], model: string): Promise<number[][] | null> {
  const res = await fetch('https://ai-api.crec.cn/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) { console.log('embedding HTTP', res.status); return null; }
  const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
  const out = (data.data ?? []).map((d) => d.embedding ?? []);
  return out.every((v) => v.length > 0) ? out : null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-live-'));
const REPO = path.resolve(import.meta.dirname ?? '.', '..');
// 用真实梗库文件只读构造（不写回）
const realLib = openMemeLibrary(path.join(REPO, 'state', 'memes.json'));
check('真实梗库加载', realLib.all().length >= 40, String(realLib.all().length));

const cfg = resolveWorldbookConfig({
  enabled: true, scanDepth: 3, cooldownSec: 0, maxInject: 3,
  vector: { enabled: true, threshold: 0.55, topK: 2, model: 'bge-m3' },
});
const wb = createWorldbook({
  lib: realLib,
  getConfig: () => cfg,
  embed: crecEmbed,
  vectorCacheFile: path.join(dir, 'vectors.json'),
  log: () => {},
});

const t0 = Date.now();
await wb.syncVectors();
const dt = Date.now() - t0;
check(`向量建库完成（${realLib.all().length} 条，${dt}ms）`, fs.existsSync(path.join(dir, 'vectors.json')));

// 关键词命中验证（真实条目真实文本）
const kw = await wb.section({ text: '派大星跳伞是什么意思', peerKey: 'test:kw', recentTexts: [] });
check('关键词命中:含正确解析', kw.includes('派大星跳伞') && kw.includes('土耳其国旗'), kw.slice(0, 80));

// 纯语义验证：问法不含完整梗名，看向量能否召回
const semantic = await wb.section({ text: '那个土耳其国旗和海绵宝宝的对比图是怎么回事', peerKey: 'test:vec', recentTexts: [] });
check('语义召回:绕开关键词的问法', semantic.includes('派大星跳伞'), semantic.slice(0, 100) || '(空)');

// 语义质量抽检：两条日常闲聊不应召回任何梗（阈值护栏）
const noise1 = await wb.section({ text: '今天天气不错，适合出去走走', peerKey: 'test:n1', recentTexts: [] });
const noise2 = await wb.section({ text: '晚上一起吃饭吗', peerKey: 'test:n2', recentTexts: [] });
check('护栏:日常闲聊不误召回', noise1 === '' && noise2 === '', `${noise1.slice(0, 30)} | ${noise2.slice(0, 30)}`);

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
