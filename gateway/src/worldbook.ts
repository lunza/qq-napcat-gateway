// [2026-11-16] 梗库世界书（SillyTavern World Info 风格的关键词/向量触发注入）
//
// 背景：梗库原本只挂在表情包视觉分析链路（analyzeStickerNow），纯文字消息
// 问梗时模型只能瞎猜（实例：群里问「派大星跳伞是什么意思」，模型答成
// "跳伞姿势跟派大星似的"，而梗库里存着正确解析"土耳其国旗对比图"）。
//
// 方案：模仿 SillyTavern 世界书机制——每轮回复前扫描会话文本，
//   1. 关键词命中（绿灯 selective）：条目 keywords 出现在扫描文本里 → 注入；
//   2. 向量兜底：关键词零命中时，用 bge-m3 embedding 余弦相似度召回
//      语义相关的条目（阈值 + topK 限制），防"问法绕、关键词覆盖不到"；
//   3. 冷却：同会话同梗 N 秒内不重复注入，防群聊刷屏时提示词膨胀；
//   4. 蓝灯（constant）：条目可标记 constant=true，每轮无条件注入（不冷却）。
// 注入文本明确声明"未列出的梗不要编造出处"（代码级闸门，防模型自由发挥）。
//
// 配置：config/qq.json 的 worldbook 段（可选，缺省用 DEFAULT_WORLDBOOK）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanMemeText, type MemeEntry, type MemeLibrary } from './memes.ts';

// ── 配置 ──

export interface WorldbookVectorConfig {
  enabled: boolean;
  /** 余弦相似度阈值，低于此值不召回 */
  threshold: number;
  /** 单次最多语义召回条数 */
  topK: number;
  /** embedding 模型（crec 提供 bge-m3，1024 维） */
  model: string;
}

export interface WorldbookConfig {
  enabled: boolean;
  /** 扫描最近 N 条同会话消息（含当前消息），承接"上一条发梗图、这一条才问" */
  scanDepth: number;
  /** 同会话同梗冷却秒数，防重复注入 */
  cooldownSec: number;
  /** 单轮注入条目上限 */
  maxInject: number;
  vector: WorldbookVectorConfig;
}

export const DEFAULT_WORLDBOOK: WorldbookConfig = {
  enabled: true,
  scanDepth: 3,
  cooldownSec: 1800,
  maxInject: 3,
  vector: { enabled: true, threshold: 0.55, topK: 2, model: 'bge-m3' },
};

/** 合并用户配置（浅层 + vector 浅层），容忍旧配置缺字段 */
export function resolveWorldbookConfig(raw: unknown): WorldbookConfig {
  const r = (raw ?? {}) as Partial<WorldbookConfig>;
  const v = (r.vector ?? {}) as Partial<WorldbookVectorConfig>;
  return {
    enabled: r.enabled ?? DEFAULT_WORLDBOOK.enabled,
    scanDepth: clampNum(r.scanDepth, 1, 20, DEFAULT_WORLDBOOK.scanDepth),
    cooldownSec: clampNum(r.cooldownSec, 0, 86400, DEFAULT_WORLDBOOK.cooldownSec),
    maxInject: clampNum(r.maxInject, 1, 10, DEFAULT_WORLDBOOK.maxInject),
    vector: {
      enabled: v.enabled ?? DEFAULT_WORLDBOOK.vector.enabled,
      threshold: clampNum(v.threshold, 0.3, 0.95, DEFAULT_WORLDBOOK.vector.threshold),
      topK: clampNum(v.topK, 1, 5, DEFAULT_WORLDBOOK.vector.topK),
      model: v.model ?? DEFAULT_WORLDBOOK.vector.model,
    },
  };
}

function clampNum(v: unknown, min: number, max: number, dft: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

// ── 噪音清洗：实现见 memes.ts 的 cleanMemeText（避免循环依赖，本文件直接复用） ──

// ── 数学 ──

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── 世界书本体 ──

export interface WorldbookDeps {
  lib: MemeLibrary;
  /** 每次调用现读配置（兼容 gateway 热重载：config 对象会被整体替换） */
  getConfig: () => WorldbookConfig;
  /** embedding 批量接口；返回 null 表示失败（向量层静默降级） */
  embed: (texts: string[], model: string) => Promise<number[][] | null>;
  /** 向量缓存落盘路径（state/memes.vectors.json） */
  vectorCacheFile?: string;
  log?: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
}

export interface WorldbookSectionInput {
  /** 当前触发回复的消息文本 */
  text: string;
  peerKey: string;
  /** 同会话更早的消息文本（按时间正序；由调用方按 scanDepth 裁剪） */
  recentTexts?: string[];
}

export interface Worldbook {
  /** 回复链路调用：返回注入段落；无命中返回 '' */
  section(input: WorldbookSectionInput): Promise<string>;
  /** 启动后调用：diff 梗库与缓存，增量补算向量（后台执行，不阻塞） */
  syncVectors(): Promise<void>;
  /** 测试辅助：清空冷却状态 */
  _resetCooldown(): void;
}

interface VectorCacheFile {
  model: string;
  entries: Record<string, { hash: string; vec: number[] }>;
}

/** 条目向量化的源文本（清洗后），hash 变化即重算 */
function entryText(e: MemeEntry): string {
  const kws = (e.keywords ?? []).filter(Boolean).join('、');
  return `${e.name}\n关键词：${kws}\n${cleanMemeText(e.meaning ?? '')}`;
}

export function createWorldbook(deps: WorldbookDeps): Worldbook {
  const { lib, getConfig, embed, log } = deps;
  const cooldown = new Map<string, number>();   // `${peerKey}::${name}` -> last inject ts
  const vecCache = new Map<string, { hash: string; vec: number[] }>();
  let vecModel = '';
  let vectorsReady = false;
  let syncing: Promise<void> | null = null;

  // ── 向量缓存载入/落盘 ──
  function loadVectorCache(): void {
    if (!deps.vectorCacheFile) return;
    try {
      if (!fs.existsSync(deps.vectorCacheFile)) return;
      const data = JSON.parse(fs.readFileSync(deps.vectorCacheFile, 'utf8')) as VectorCacheFile;
      vecModel = data.model ?? '';
      for (const [name, it] of Object.entries(data.entries ?? {})) {
        vecCache.set(name, it);
      }
      vectorsReady = vecCache.size > 0;
    } catch (e) {
      log?.('warn', '向量缓存读取失败，将重建', { message: (e as Error).message });
    }
  }

  function saveVectorCache(): void {
    if (!deps.vectorCacheFile) return;
    try {
      const data: VectorCacheFile = {
        model: vecModel,
        entries: Object.fromEntries(vecCache),
      };
      fs.mkdirSync(path.dirname(deps.vectorCacheFile), { recursive: true });
      const tmp = `${deps.vectorCacheFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, deps.vectorCacheFile);
    } catch (e) {
      log?.('warn', '向量缓存写入失败', { message: (e as Error).message });
    }
  }

  /** 后台补算：梗库里有而缓存里没有（或 hash 变了）的条目，批量 embed */
  async function syncVectors(): Promise<void> {
    if (syncing) return syncing;
    const cfg = getConfig();
    if (!cfg.vector.enabled) return;
    syncing = (async () => {
      try {
        loadVectorCache();
        const model = cfg.vector.model;
        if (vecModel && vecModel !== model) {
          vecCache.clear(); // 换模型，全部重算
          vectorsReady = false;
        }
        const need: MemeEntry[] = [];
        for (const e of lib.all()) {
          if (e.enabled === false) continue;   // 停用条目不算向量
          const txt = entryText(e);
          const hash = createHash('sha256').update(txt).digest('hex').slice(0, 16);
          const hit = vecCache.get(e.name);
          if (!hit || hit.hash !== hash) need.push(e);
        }
        if (need.length === 0) {
          vectorsReady = vecCache.size > 0;
          return;
        }
        log?.('info', '世界书向量补算', { count: need.length, model });
        const texts = need.map(entryText);
        // 批量优先，失败降级逐条（单条失败跳过该条，不拖垮整体）
        let vecs = await embed(texts, model);
        if (!vecs) {
          vecs = [];
          for (const t of texts) {
            const one = await embed([t], model);
            vecs.push(one?.[0] ?? []);
          }
        }
        let ok = 0;
        for (let i = 0; i < need.length; i++) {
          const vec = vecs[i];
          if (!vec?.length) continue;
          const hash = createHash('sha256').update(texts[i]).digest('hex').slice(0, 16);
          vecCache.set(need[i].name, { hash, vec });
          ok++;
        }
        vecModel = model;
        vectorsReady = vecCache.size > 0;
        saveVectorCache();
        log?.('info', '世界书向量就绪', { total: vecCache.size, computed: ok });
      } catch (e) {
        log?.('warn', '世界书向量同步失败（本轮仅用关键词）', { message: (e as Error).message });
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  /** 语义召回：query 向量 vs 条目向量，超阈值按相似度降序取 topK */
  async function vectorRecall(query: string, excludeNames: Set<string>, cfg: WorldbookConfig): Promise<MemeEntry[]> {
    if (!vectorsReady || vecCache.size === 0) return [];
    const qv = (await embed([query], cfg.vector.model))?.[0];
    if (!qv?.length) return [];
    const byName = new Map(lib.all().map((e) => [e.name, e]));
    const scored: Array<{ name: string; score: number }> = [];
    for (const [name, it] of vecCache) {
      if (excludeNames.has(name)) continue;
      const e = byName.get(name);
      if (!e || e.enabled === false) continue;
      const score = cosine(qv, it.vec);
      if (score >= cfg.vector.threshold) scored.push({ name, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, cfg.vector.topK)
      .map((s) => byName.get(s.name))
      .filter((e): e is MemeEntry => Boolean(e));
  }

  function underCooldown(peerKey: string, name: string, now: number, cfg: WorldbookConfig): boolean {
    if (cfg.cooldownSec <= 0) return false;
    const last = cooldown.get(`${peerKey}::${name}`);
    return last !== undefined && now - last < cfg.cooldownSec * 1000;
  }

  function markCooldown(peerKey: string, name: string, now: number): void {
    cooldown.set(`${peerKey}::${name}`, now);
    // 防膨胀：超过 1000 个 key 时清掉一半最旧的
    if (cooldown.size > 1000) {
      const entries = [...cooldown.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of entries.slice(0, entries.length - 500)) cooldown.delete(k);
    }
  }

  function formatEntries(entries: MemeEntry[], viaVector: Set<string>): string {
    const lines: string[] = [];
    for (const e of entries) {
      const tag = viaVector.has(e.name) ? '（语义关联）' : '';
      lines.push(`- ${e.name}${tag}：${cleanMemeText(e.meaning ?? '')}`);
      if (e.source) lines.push(`  出处：${cleanMemeText(e.source)}`);
    }
    return lines.join('\n');
  }

  async function section(input: WorldbookSectionInput): Promise<string> {
    const cfg = getConfig();
    if (!cfg.enabled) return '';
    const now = Date.now();
    const scanText = [input.text, ...(input.recentTexts ?? [])]
      .slice(0, Math.max(1, cfg.scanDepth))
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .join('\n');
    if (!scanText.trim()) return '';

    // 1) 关键词命中（绿灯；memes.ts 的 match 已跳过 enabled=false 条目）
    const kwHits = lib.match(scanText)
      .filter((e) => !underCooldown(input.peerKey, e.name, now, cfg));

    // 2) 语义兜底：关键词不足 maxInject 时用向量补（也要过冷却）
    const viaVector = new Set<string>();
    let finalEntries = kwHits.slice(0, cfg.maxInject);
    if (finalEntries.length < cfg.maxInject && cfg.vector.enabled && vectorsReady) {
      const exclude = new Set(finalEntries.map((e) => e.name));
      const recalled = await vectorRecall(scanText, exclude, cfg);
      for (const e of recalled) {
        if (finalEntries.length >= cfg.maxInject) break;
        if (underCooldown(input.peerKey, e.name, now, cfg)) continue;
        viaVector.add(e.name);
        finalEntries = [...finalEntries, e];
      }
    }
    if (finalEntries.length === 0) return '';

    // 3) 记冷却（constant 条目豁免：每轮常驻注入）
    for (const e of finalEntries) {
      if (e.constant === true) continue;
      markCooldown(input.peerKey, e.name, now);
    }

    const header = viaVector.size > 0
      ? '【梗库世界书 · 本轮命中（本地梗库事实，含语义关联条目，均可确信）】'
      : '【梗库世界书 · 本轮命中（本地梗库事实，可确信）】';
    const body = [
      header,
      formatEntries(finalEntries, viaVector),
      '以上是已核实的梗背景。对方问起命中的梗时，按知识问答来回答：讲清这个梗指什么、出自哪里、怎么用，信息要完整，语气可以口语化；不要只顾玩梗一笔带过。未列出的梗不要编造出处。',
    ].join('\n');
    log?.('info', '世界书注入', {
      peer: input.peerKey,
      entries: finalEntries.map((e) => e.name),
      viaVector: [...viaVector],
    });
    return body;
  }

  loadVectorCache();
  return {
    section,
    syncVectors,
    _resetCooldown: () => cooldown.clear(),
  };
}
