// [2026-11-12] qq-gateway 的 OneBot 11 客户端
// 负责：正向 WebSocket 事件订阅（含断线自动重连、指数退避）+ HTTP API 调用 + 在线探活
// 注意：只有 gateway 一个进程连接 WS 做事件消费；发送走 HTTP，不与 WS 互抢。
import WebSocket from 'ws';
import fs from 'node:fs';
import { appendJsonl, todayStamp } from './store.ts';

export interface OneBotEvent {
  time: number;
  self_id: number;
  post_type: string;
  message_type?: 'private' | 'group' | 'guild';
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  self_id_str?: string;
  raw_message?: string;
  message?: string | Array<{ type: string; data: Record<string, unknown> }>;
  sender?: { user_id?: number; nickname?: string; card?: string };
  status?: unknown;
  meta_event_type?: string;
  target_id?: number;
  [k: string]: unknown;
}

export interface OneBotApiResponse<T = unknown> {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
}

export type EventHandler = (ev: OneBotEvent) => void;
export type ConnectionHandler = (connected: boolean, detail: string) => void;

export class OneBotClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onEvent: EventHandler;
  private readonly onConnection: ConnectionHandler;
  private readonly wsUrl: string;
  private readonly httpUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly logDir: string;

  constructor(opts: {
    wsUrl: string; httpUrl: string; token: string; timeoutMs: number;
    onEvent: EventHandler; onConnection: ConnectionHandler; logDir: string;
  }) {
    this.wsUrl = opts.wsUrl;
    this.httpUrl = opts.httpUrl;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
    this.onEvent = opts.onEvent;
    this.onConnection = opts.onConnection;
    this.logDir = opts.logDir;
  }

  get isConnected(): boolean { return this.connected; }


  connect(): void {
    this.closedByUser = false;
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const ws = new WebSocket(this.wsUrl, { headers, handshakeTimeout: this.timeoutMs });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.log('connection', { event: 'ws_open', url: this.wsUrl });
      this.onConnection(true, 'ws_open');
      // 应用层心跳：OneBot 服务端通常 30s 一个心跳，这里只做保活探测
      this.pingTimer = setInterval(() => {
        try { ws.ping(); } catch { /* 忽略 */ }
      }, 20000);
    });

    ws.on('message', (buf: Buffer) => {
      let ev: OneBotEvent;
      try { ev = JSON.parse(buf.toString('utf8')) as OneBotEvent; } catch { return; }
      // 心跳事件不打印，避免刷屏；交给上层判断
      try { this.onEvent(ev); } catch { /* 单条事件异常不中断整个 WS 流 */ }
    });


    ws.on('pong', () => { /* 活着 */ });

    ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.log('connection', { event: 'ws_close', code, reason: reason.toString() });
      this.onConnection(false, `ws_close code=${code}`);
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this.log('connection', { event: 'ws_error', message: err.message });
      // error 后通常紧跟 close，重连交给 close 处理
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    setTimeout(() => {
      if (this.closedByUser) return;
      this.log('connection', { event: 'ws_reconnect', attempt: this.reconnectAttempt, delay });
      this.connect();
    }, delay);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  /** 调用 OneBot HTTP API */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<OneBotApiResponse<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST', headers, body: JSON.stringify(params), signal: ctrl.signal,
      });
      const body = (await res.json()) as OneBotApiResponse<T>;
      if (body.status === 'failed' || body.retcode !== 0) {
        this.log('api_error', { action, retcode: body.retcode, message: body.message, params });
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendPrivate(userId: string | number, message: string): Promise<OneBotApiResponse> {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  async sendGroup(groupId: string | number, message: string): Promise<OneBotApiResponse> {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  /**
   * [2026-11-12] 发送图片。
   * OneBot11 用消息段数组表达图片：{ type:'image', data:{ file } }。
   * file 支持：http(s) URL、base64://、本地绝对路径（取决于协议端配置）。
   * 这里优先传 URL，由协议端自行下载；失败时调用方可改用 base64。
   */
  async sendPrivateImage(userId: string | number, file: string, caption = ''): Promise<OneBotApiResponse> {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: buildImageMessage(file, caption),
    });
  }

  async sendGroupImage(groupId: string | number, file: string, caption = ''): Promise<OneBotApiResponse> {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message: buildImageMessage(file, caption),
    });
  }

  /**
   * [2026-11-13] 发送合并转发消息（卡片形式）。
   *
   * 为什么需要：群里发 base64 图片经常 `read ECONNRESET`（群图片上传通道限制），
   * 改成转发卡片可以带文字 + 图片 URL，由 QQ 自己渲染，不受图片通道限制。
   */
  async sendForwardMsg(
    target: { kind: 'private'; userId: string | number } | { kind: 'group'; groupId: string | number },
    nodes: Array<{ name: string; uin: string; content: Array<Record<string, unknown>> }>,
  ): Promise<OneBotApiResponse> {
    const params: Record<string, unknown> = {
      messages: nodes.map((n) => ({ type: 'node', data: n })),
    };
    if (target.kind === 'group') params.group_id = Number(target.groupId);
    else params.user_id = Number(target.userId);
    return this.call('send_forward_msg', params);
  }

  /** 探活：能拿到 login_info 说明协议端与 QQ 状态可读；online=true 才代表真正在线 */
  async probe(): Promise<{ ok: boolean; online: boolean; uin?: string; nickname?: string; detail: string }> {
    try {
      const login = await this.call<{ user_id?: number; nickname?: string }>('get_login_info');
      const status = await this.call<{ online?: boolean; good?: boolean }>('get_status');
      // [2026-11-12 修复] 原逻辑 `online = status.online || login.status === 'ok'` 永远为真：
      // 账号离线时 get_login_info 依然返回 ok（它只是查资料，不代表在线），
      // 导致监控把"离线"记成"在线"，掉线告警与看护全部失效。
      // 现在只认 get_status 的 online 字段；拿不到该字段时保守判为离线。
      const online = status.status === 'ok' && status.data?.online === true;
      return {
        ok: login.status === 'ok' && status.status === 'ok',
        online,
        uin: login.data?.user_id ? String(login.data.user_id) : undefined,
        nickname: login.data?.nickname,
        detail: `login=${login.status} status=${status.status} online=${String(status.data?.online)}`,
      };
    } catch (e) {
      return { ok: false, online: false, detail: `probe_error: ${(e as Error).message}` };
    }
  }

  private log(kind: string, obj: Record<string, unknown>): void {
    appendJsonl(`${this.logDir}/${todayStamp()}.jsonl`, { ts: new Date().toISOString(), kind, ...obj });
  }
}

/**
 * [2026-11-12] 组装一条含图片的消息段数组。
 * caption 非空时先发文字，再发图片。
 * [2026-11-16] caption 里的 CQ 码要转成消息段：OneBot11 数组格式的 text 段
 * **不解析 CQ 码**，直接塞 "[CQ:at,qq=...]" 会以字面文本显示在聊天里（用户实测）。
 */
export function buildImageMessage(file: string, caption = ''): Array<Record<string, unknown>> {
  const segs: Array<Record<string, unknown>> = [];
  if (caption && caption.trim() !== '') {
    segs.push(...buildTextSegments(caption.trim()));
  }
  segs.push({ type: 'image', data: { file } });
  return segs;
}

/**
 * [2026-11-16] 把含 CQ 码的文本拆成消息段数组。
 * 目前 gateway 自己拼接的只有 at 码（[CQ:at,qq=数字]），逐段转换；
 * 未识别的 CQ 码按原文保留在 text 段里（宁可原样显示也不丢内容）。
 */
export function buildTextSegments(text: string): Array<Record<string, unknown>> {
  const segs: Array<Record<string, unknown>> = [];
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    segs.push({ type: 'at', data: { qq: m[1]! } });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } });
  return segs.length > 0 ? segs : [{ type: 'text', data: { text } }];
}
