// [2026-11-18] 表情包权重系统
//
// 用户要求："统计聊天记录里群友高频发送的表情包，然后动态调整凑热闹时发送表情包的概率。
//           因为群友高频发送的表情包一般都是大家喜爱的。当然也不绝对，只是稍微调高发送概率即可。"
//
// 设计原则（对应"稍微微调"这个分寸）：
//   1. 权重是**有上限**的：最高 2.5 倍，不会让高频图垄断
//   2. 用**对数曲线**而不是线性：发 2 次和发 20 次的差距被压缩，避免长尾极值主导
//   3. 只在"选哪张图"时生效，不改变"发不发图"的概率
//      —— 用户说的是"调整凑热闹时发送表情包的概率"，理解为"选中某张图的概率"，而不是发图频率
//   4. 数据不足（没有高频样本）时自然退化为均匀随机
//
// 权重公式：
//   weight = 1 + (MAX_WEIGHT - 1) × min(1, log2(1 + count) / log2(1 + FULL_SCORE_COUNT))
//   count=0 时 weight=1（基础权重）
//   count=FULL_SCORE_COUNT 时 weight=MAX_WEIGHT
//   超过则封顶 MAX_WEIGHT
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** 达到满权重所需的发送次数（按"不同发送人数"计，更能代表"群体喜爱"） */
const FULL_SCORE_COUNT = 5;
/** 最高权重倍数：温和档，最多 2.5 倍 */
const MAX_WEIGHT = 2.5;
/** 默认统计窗口：最近 30 天 */
export const DEFAULT_WINDOW_DAYS = 30;

export interface StickerFrequency {
  contentHash: string;
  /** 发送次数 */
  count: number;
  /** 不同的发送人数（更抗单人刷屏） */
  senders: number;
  /** 本地文件路径（用于发送） */
  localPath?: string;
}

/**
 * 计算单张图的权重。
 * 用 senders（不同人数）优先，没有则退回 count。对数压缩 + 封顶。
 */
export function weightFor(senders: number, count: number): number {
  if (count <= 0 && senders <= 0) return 1;
  // [2026-11-18 修正] 主信号是"不同发送人数"：人多才代表群体喜爱。
  // 单人狂发只是弱信号（乘 0.4 且计入人数上限），避免"一个人刷屏"拿到和"5 人喜欢"一样的权重。
  const soloCount = Math.max(1, senders);                   // 至少 1 人
  const peopleScore = Math.min(senders, 5);                 // 人数贡献，封顶 5
  const repeatBonus = Math.min(2, (count / soloCount - 1)); // 平均每人多发的部分，最多 +2
  const score = peopleScore + repeatBonus * 0.4;
  const raw = 1 + (MAX_WEIGHT - 1) * Math.min(1, Math.log2(1 + score) / Math.log2(1 + FULL_SCORE_COUNT));
  return Math.min(MAX_WEIGHT, raw);
}

/** 按权重做一次加权随机挑选；weights 与 items 一一对应，全 0 时退化为均匀随机 */
export function pickWeighted<T>(
  items: T[], weights: number[], rand: () => number = Math.random,
): T | null {
  if (items.length === 0) return null;
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = safe.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // 全部无权重：均匀随机
    return items[Math.floor(rand() * items.length)] ?? null;
  }
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= safe[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1] ?? null;
}

/** 从本地文件算 contentHash（与 media.ts 的 contentHashOf 保持一致） */
export function fileContentHash(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 给权重结果排序，便于日志与调试 */
export function rankByWeight(freqs: StickerFrequency[]): Array<StickerFrequency & { weight: number }> {
  return freqs
    .map((f) => ({ ...f, weight: weightFor(f.senders, f.count) }))
    .sort((a, b) => b.weight - a.weight);
}
