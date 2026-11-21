// [2026-11-16] 梗库世界书测试：关键词扫描 / 冷却 / 向量兜底 / 噪音清洗 / 配置解析
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openMemeLibrary, cleanMemeText } from '../gateway/src/memes.ts';
import {
  createWorldbook, resolveWorldbookConfig, DEFAULT_WORLDBOOK, cosine,
} from '../gateway/src/worldbook.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ── 噪音清洗 ──
{
  const noisy = `「派大星跳伞」是什么梗
指什么：土耳其国旗和派大星跳伞画面的对比图。微博哔哩哔哩
出处：2026 年 10 月中外网友争论。微博微博
免费
今天 15:07
下载电脑客户端
自动完成复杂工作任务
立即下载`;
  const cleaned = cleanMemeText(noisy);
  check('清洗:删除下载按钮行', !cleaned.includes('下载电脑客户端') && !cleaned.includes('立即下载'));
  check('清洗:删除免费行', !cleaned.includes('\n免费'));
  check('清洗:删除时间戳行', !cleaned.includes('今天 15:07'));
  check('清洗:删除尾部平台词串', !cleaned.endsWith('微博') && !cleaned.endsWith('哔哩哔哩'));
  check('清洗:保留正文', cleaned.includes('土耳其国旗') && cleaned.includes('对比图'));
  check('清洗:普通文本不动', cleanMemeText('猫猫图，表达无语') === '猫猫图，表达无语');
  check('清洗:空串安全', cleanMemeText('') === '');
}

// ── 配置解析 ──
{
  const d = resolveWorldbookConfig(undefined);
  check('配置:缺省=默认', d.enabled === true && d.scanDepth === 3 && d.cooldownSec === 1800 && d.vector.model === 'bge-m3');
  const c = resolveWorldbookConfig({ scanDepth: 99, vector: { threshold: 0.1 } });
  check('配置:越界被 clamp', c.scanDepth === 20 && c.vector.threshold === 0.3);
  const k = resolveWorldbookConfig({ cooldownSec: 0 });
  check('配置:冷却0=允许(不报错)', k.cooldownSec === 0);
}

// ── 库与条目 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbook-'));
const lib = openMemeLibrary(path.join(dir, 'memes.json'));
lib.upsert({
  keywords: ['派大星跳伞'], name: '派大星跳伞',
  meaning: '土耳其国旗与派大星跳伞画面的对比图，2026年10月中外网友争论时爆火',
  source: 'B站梗指南', category: '热梗',
});
lib.upsert({
  keywords: ['猫猫震惊'], name: '猫猫震惊',
  meaning: '猫咪瞳孔放大，表达极度震惊', source: '网络表情包', category: '惊讶',
});
lib.upsert({
  keywords: ['停用梗'], name: '停用梗', meaning: '不应被注入', source: '',
  enabled: false,
});

// ── match 尊重 enabled ──
check('enabled=false 不参与关键词匹配', !lib.match('这是停用梗啊').some((m) => m.name === '停用梗'));

// ── mock embed ──
const embedCalls: string[][] = [];
let mockVecs = new Map<string, number[]>();
function mockEmbed(texts: string[], _model: string): Promise<number[][] | null> {
  embedCalls.push([...texts]);
  return Promise.resolve(texts.map((t) => mockVecs.get(t) ?? [1, 0, 0]));
}

// ── 世界书实例（向量开启，冷却 60s 便于测试） ──
const cfg = resolveWorldbookConfig({
  enabled: true, scanDepth: 3, cooldownSec: 60, maxInject: 3,
  vector: { enabled: true, threshold: 0.5, topK: 2, model: 'bge-m3' },
});
const wb = createWorldbook({
  lib,
  getConfig: () => cfg,
  embed: mockEmbed,
  vectorCacheFile: path.join(dir, 'vectors.json'),
  log: () => {},
});

// ── 向量同步（缓存落盘） ──
await wb.syncVectors();
check('向量同步:缓存文件生成', fs.existsSync(path.join(dir, 'vectors.json')));
const cached = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')) as { entries: Record<string, unknown> };
check('向量同步:启用条目全部入缓存', '派大星跳伞' in cached.entries && '猫猫震惊' in cached.entries);
check('向量同步:停用条目不入缓存', !('停用梗' in cached.entries));
const callsAfterFirst = embedCalls.length;
await wb.syncVectors();
check('向量同步:二次调用零请求', embedCalls.length === callsAfterFirst, `${embedCalls.length} vs ${callsAfterFirst}`);

// ── 关键词命中注入 ──
{
  wb._resetCooldown();
  const out = await wb.section({ text: '@bot 派大星跳伞是什么意思', peerKey: 'group:1', recentTexts: [] });
  check('关键词:命中注入', out.includes('派大星跳伞'), out.slice(0, 60));
  check('关键词:正文含正确解析', out.includes('土耳其国旗'));
  check('关键词:含出处', out.includes('梗指南'));
  check('关键词:含防编造边界声明', out.includes('不要编造出处'));
}

// ── 冷却 ──
{
  wb._resetCooldown();
  const first = await wb.section({ text: '派大星跳伞', peerKey: 'group:2', recentTexts: [] });
  check('冷却:首次命中', first.includes('派大星跳伞'));
  const second = await wb.section({ text: '派大星跳伞', peerKey: 'group:2', recentTexts: [] });
  check('冷却:同会话立即二问不再注入', second === '', second.slice(0, 40));
  const otherPeer = await wb.section({ text: '派大星跳伞', peerKey: 'group:3', recentTexts: [] });
  check('冷却:不同会话独立', otherPeer.includes('派大星跳伞'));
}

// ── scanDepth：上一条消息里的梗也能命中 ──
{
  wb._resetCooldown();
  const out = await wb.section({ text: '这什么意思啊', peerKey: 'group:4', recentTexts: ['哈哈哈派大星跳伞笑死'] });
  check('scanDepth:最近消息命中', out.includes('派大星跳伞'));
  const none = await wb.section({ text: '这什么意思啊', peerKey: 'group:4b', recentTexts: [] });
  check('scanDepth:无文本不凭空命中', none === '' || !none.includes('派大星跳伞'));
}

// ── 向量兜底（mock 相似向量） ──
{
  wb._resetCooldown();
  // 构造：查询文本与"猫猫震惊"条目向量相近（单位向量 [0,1,0]），与派大星 [1,0,0] 正交
  mockVecs = new Map([['这图真让人无语', [0, 1, 0]]]);
  // 条目向量在 syncVectors 时已算出——重新设置 mock 后再 sync 不会重算（hash 未变）。
  // 直接改缓存文件不可行（loadVectorCache 只在构造时读一次），改用新实例验证。
  const wb2 = createWorldbook({
    lib,
    getConfig: () => cfg,
    embed: (texts) => {
      embedCalls.push([...texts]);
      // 条目文本以梗名开头（entryText 格式 `${name}\n关键词：...`）；
      // 查询文本走 mockVecs 查表。条目向量：只有"猫猫震惊"与查询同向，
      // 其余条目全部与查询正交（不应召回）。
      return Promise.resolve(texts.map((t) => {
        if (t.startsWith('猫猫震惊')) return [0, 1, 0];
        if (t.startsWith('派大星跳伞')) return [1, 0, 0];
        if (t.includes('\n关键词：')) return [1, 0, 0];   // 其余条目：与查询正交
        return mockVecs.get(t) ?? [0, 1, 0];               // 查询文本
      }));
    },
    vectorCacheFile: path.join(dir, 'vectors2.json'),
    log: () => {},
  });
  await wb2.syncVectors();
  const out = await wb2.section({ text: '这图真让人无语', peerKey: 'group:5', recentTexts: [] });
  check('向量:无关键词时语义召回', out.includes('猫猫震惊'), out.slice(0, 80));
  check('向量:标注语义关联', out.includes('语义关联'));
  check('向量:不召回正交条目', !out.includes('派大星跳伞'));
}

// ── cosine ──
check('cosine:相同向量=1', Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
check('cosine:正交=0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
check('cosine:维度不符=0', cosine([1], [1, 2]) === 0);
check('cosine:零向量=0', cosine([0, 0], [1, 1]) === 0);

// ── 总开关 ──
{
  const wbOff = createWorldbook({
    lib,
    getConfig: () => ({ ...cfg, enabled: false }),
    embed: mockEmbed,
    log: () => {},
  });
  wbOff._resetCooldown();
  const out = await wbOff.section({ text: '派大星跳伞是什么梗', peerKey: 'group:6', recentTexts: [] });
  check('总开关:关闭后不注入', out === '');
}

// ── 常量蓝灯（constant）豁免冷却 ──
{
  lib.upsert({
    keywords: ['常驻梗'], name: '常驻梗', meaning: '每轮都该出现', source: '',
    constant: true,
  });
  wb._resetCooldown();
  await wb.section({ text: '常驻梗', peerKey: 'group:7', recentTexts: [] });
  const again = await wb.section({ text: '常驻梗', peerKey: 'group:7', recentTexts: [] });
  check('蓝灯:constant 每轮注入不受冷却', again.includes('常驻梗'));
  lib.remove('常驻梗');
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
