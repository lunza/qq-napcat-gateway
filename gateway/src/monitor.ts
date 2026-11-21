// [2026-11-12] qq-gateway 掉线监控
// 为什么需要它：NapCat 自身的恢复链路有已知断点（详见 docs/掉线问题排查.md）：
//   1) KickedOffLine/SelfOffline 触发的 Worker 重启调用 startWorker(false) —— 不传快速登录参数
//   2) 自动重启的 Worker 不再读 `-q <uin>`，也不读 WebUI 的 autoLoginAccount，只能出二维码
//   3) 无人扫码 → 长期"在线但未登录"→ 表现为"经常掉线"
// 因此本监控独立于 NapCat，做三件事：
//   A. 持续心跳探活（get_login_info + get_status），把在线状态写成时间线
//   B. 连续离线超过阈值 → 写 alerts.jsonl 并调用恢复钩子（onOfflineAlert）
//   C. 输出静态报告：uptime 比例、掉线次数、每次掉线时长，用于验证"新版是否还掉线"
import fs from 'node:fs';
import path from 'node:path';
import type { OneBotClient } from './onebot.ts';
import { appendJsonl, readJsonl, todayStamp, computeUptime, writeJsonAtomic } from './store.ts';
import type { OnlineSpan } from './store.ts';

export interface MonitorOptions {
  heartbeatMs: number;
  probeEveryN: number;
  offlineAlertMin: number;
  stateDir: string;
  onOfflineAlert?: (offlineSince: number, detail: string) => void | Promise<void>;
}

export class Monitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private beat = 0;
  private lastOnline = false;
  private lastKnownOnline: boolean | null = null;
  private offlineSince: number | null = null;
  private alerted = false;
  private consecutiveFailures = 0;
  private readonly opts: MonitorOptions;
  private client: OneBotClient | null = null;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
    fs.mkdirSync(opts.stateDir, { recursive: true });
  }

  start(client: OneBotClient): void {
    this.client = client;
    this.timer = setInterval(() => void this.tick(), this.opts.heartbeatMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 记录 ws 层连接状态。
   *  注意：ws 连上 ≠ 账号在线，这里只用于"收到消息/心跳事件"时把状态刷成在线；
   *  ws 断开不直接判离线——真正的在线与否由 probe() 的 get_status 判定，
   *  避免每次重连都误记一次掉线。 */
  noteWsState(connected: boolean): void {
    if (!connected) return;
    this.lastKnownOnline = true;
    this.record(true, 'ws_activity');
  }

  private async tick(): Promise<void> {
    this.beat++;
    const now = Date.now();
    let online = false;
    let detail = 'no_client';
    if (this.client && this.client.isConnected && (this.beat === 1 || this.beat % Math.max(1, this.opts.probeEveryN) === 0)) {
      const r = await this.client.probe();
      online = r.ok && r.online;
      detail = r.detail;
      if (!online) this.consecutiveFailures++; else this.consecutiveFailures = 0;
    } else if (this.client?.isConnected) {
      // 非探活心跳：沿用最近一次的确定状态
      online = this.lastKnownOnline ?? false;
      detail = 'cached';
    } else {
      online = false;
      detail = 'ws_not_connected';
    }

    if (detail !== 'cached') this.lastKnownOnline = online;
    this.record(online, detail);

    appendJsonl(path.join(this.opts.stateDir, 'heartbeat.jsonl'), {
      ts: new Date().toISOString(), beat: this.beat, online, detail,
      wsConnected: this.client?.isConnected ?? false,
      offlineForSec: this.offlineSince ? Math.round((now - this.offlineSince) / 1000) : 0,
    });

    if (!online && this.offlineSince === null) this.offlineSince = now;
    if (online) { this.offlineSince = null; this.alerted = false; }

    if (!online && this.offlineSince !== null && !this.alerted) {
      const offlineForMin = (now - this.offlineSince) / 60000;
      if (offlineForMin >= this.opts.offlineAlertMin) {
        this.alerted = true;
        appendJsonl(path.join(this.opts.stateDir, 'alerts.jsonl'), {
          ts: new Date().toISOString(), kind: 'offline', offlineSince: this.offlineSince,
          offlineForMin: Number(offlineForMin.toFixed(1)), detail,
        });
        void this.opts.onOfflineAlert?.(this.offlineSince, detail);
      }
    }

    // 每次心跳刷新一个供外部读取的快照
    writeJsonAtomic(path.join(this.opts.stateDir, 'health.json'), {
      updatedAt: new Date().toISOString(),
      online, detail, wsConnected: this.client?.isConnected ?? false,
      offlineSince: this.offlineSince, beat: this.beat,
    });
  }

  private record(online: boolean, reason: string): void {
    if (online === this.lastOnline && this.lastKnownOnline !== null) return;
    this.lastOnline = online;
    fromHistorySafe(path.join(this.opts.stateDir, 'online-history.jsonl'), {
      t: Date.now(), online, reason,
    });
  }
}

function fromHistorySafe(file: string, span: OnlineSpan): void {
  const last = readJsonl<OnlineSpan>(file).at(-1);
  if (last && last.online === span.online) { span.reason = span.reason; }
  appendJsonl(file, span);
}

/** 生成静态 uptime 报告（供 CLI 与 harness 读取） */
export function buildReport(stateDir: string, fromMs?: number, toMs?: number): Record<string, unknown> {
  const spans = readJsonl<OnlineSpan>(path.join(stateDir, 'online-history.jsonl'));
  const beats = readJsonl<{ ts: string; online: boolean }>(path.join(stateDir, 'heartbeat.jsonl'));
  const alerts = readJsonl<unknown>(path.join(stateDir, 'alerts.jsonl'));
  const to = toMs ?? Date.now();
  const from = fromMs ?? (spans[0]?.t ?? beats[0] ? Date.parse(beats[0]!.ts) : to);
  const uptime = computeUptime(spans, from, to);
  // 逐次离线片段
  const outages: Array<{ start: string; end: string | null; minutes: number }> = [];
  let start: number | null = null;
  for (const s of [...spans].sort((a, b) => a.t - b.t)) {
    if (s.t < from) { start = s.online ? null : s.t; continue; }
    if (!s.online && start === null) start = s.t;
    if (s.online && start !== null) {
      outages.push({ start: new Date(start).toISOString(), end: new Date(s.t).toISOString(), minutes: Number(((s.t - start) / 60000).toFixed(1)) });
      start = null;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    uptimeRatio: Number((uptime.uptimeRatio * 100).toFixed(2)) + '%',
    offlineDrops: uptime.offlineDrops,
    offlineMinutesTotal: Number(((uptime.totalMs - uptime.onlineMs) / 60000).toFixed(1)),
    outages,
    alerts: alerts.length,
    heartbeatBeats: beats.length,
    todayLog: `${todayStamp()}.jsonl`,
  };
}
