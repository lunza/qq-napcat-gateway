// [2026-11-12] qq-gateway 存储层：JSONL 追加写 + 每日滚动 + 滚动写回
// 设计目标：
//  1. state/online-history.jsonl —— 在线状态变化时间线，用于量化"掉线频率"与计算 uptime
//  2. state/heartbeat.jsonl      —— gateway 每次心跳（含 QQ 在线状态、会话数），掉线可被精确归因
//  3. state/inbox.jsonl          —— 收到的消息（已脱敏裁剪，最多保留 500 字符）
//  4. state/outbox.jsonl         —— 发出的消息
//  5. state/queued/              —— 离线期间积压的待回复消息，恢复在线后补发
import fs from 'node:fs';
import path from 'node:path';

export function todayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function appendJsonl(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as T); } catch { /* 忽略损坏行 */ }
  }
  return out;
}

export function loadJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 计算在线时长统计：输入在线状态切换时间线，输出总在线秒数与掉线次数 */
export interface OnlineSpan { t: number; online: boolean; reason?: string }

export function computeUptime(spans: OnlineSpan[], from: number, to: number) {
  const sorted = [...spans].sort((a, b) => a.t - b.t);
  let onlineMs = 0;
  let offlineCount = 0;
  let cursor = from;
  let current = false;
  for (const s of sorted) {
    if (s.t <= from) { current = s.online; continue; }
    if (s.t > to) break;
    if (current) onlineMs += s.t - cursor;
    if (!s.online && current) offlineCount++;
    current = s.online;
    cursor = s.t;
  }
  if (current) onlineMs += Math.max(0, to - cursor);
  const totalMs = Math.max(1, to - from);
  return {
    from, to, totalMs, onlineMs,
    uptimeRatio: onlineMs / totalMs,
    offlineDrops: offlineCount,
  };
}
