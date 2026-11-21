// [2026-11-12] e621 热门取图
//
// 用无头浏览器（Chrome CDP）抓 https://e621.net/popular 的页面元素，
// 不走 API。原因：该站对非浏览器请求直接重置连接，只有真实浏览器能拿到页面。
//
// 流程：
//   1. 拼 popular 链接（默认当天，支持 date/scale 参数）
//   2. 打开页面，等待 article 渲染出来
//   3. 从 article 里收集 post 详情链接，随机挑一个
//   4. 打开详情页，取 `img#image` 的原图地址（也兼容 video / download 直链）
//
// 说明：本模块只负责"拿到原图 URL"，发送由调用方通过 OneBot image 消息段完成。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * [2026-11-12] 已发送过的 postId 记录，用于避免重复发同一张图。
 * 保留最近 200 个；列表里的图通常几十个，超过 200 个说明确实该回头了。
 */
const SENT_HISTORY_MAX = 500;
let sentPostIds: string[] = [];
// [2026-11-13] 持久化到磁盘：之前只在内存里，gateway 一重启就忘，
// 导致同类图反复发送。现在写入 state/sent-posts.json，跨重启生效。
let sentHistoryFile = '';

/** 绑定持久化文件并加载历史 */
export function initSentHistory(file: string): void {
  sentHistoryFile = file;
  try {
    const raw = require('node:fs').readFileSync(file, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) sentPostIds = arr.map(String).slice(-SENT_HISTORY_MAX);
  } catch { /* 文件不存在或损坏，从空开始 */ }
}

function persistSentHistory(): void {
  if (!sentHistoryFile) return;
  try {
    require('node:fs').mkdirSync(require('node:path').dirname(sentHistoryFile), { recursive: true });
    // [2026-11-13 加固] 写入前先合并磁盘上已有的记录，避免"内存里少、磁盘里多"时被覆盖丢掉。
    // 之前测试脚本误写生产文件，把 28 条历史覆盖成了 5 条，就是这个原因。
    let onDisk: string[] = [];
    try {
      const raw = require('node:fs').readFileSync(sentHistoryFile, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) onDisk = arr.map(String);
    } catch { /* 首次写入 */ }
    const merged = [...new Set([...onDisk, ...sentPostIds])].slice(-SENT_HISTORY_MAX);
    sentPostIds = merged;
    require('node:fs').writeFileSync(sentHistoryFile, JSON.stringify(merged));
  } catch { /* 写失败不影响主流程 */ }
}

function rememberSent(postId: string): void {
  if (!postId) return;
  if (!sentPostIds.includes(postId)) sentPostIds.push(postId);
  while (sentPostIds.length > SENT_HISTORY_MAX) sentPostIds.shift();
  persistSentHistory();
}

/**
 * [2026-11-13] 群级已发送记录：群里所有人共用一个"已发过"清单。
 * 用户在群里看到的图对所有人可见，所以不管谁触发，都不能重复。
 */
const sentByGroup = new Map<string, string[]>();

/** 设置某个群已发送过的 postId（由 gateway 从数据库/文件恢复） */
export function setGroupSentHistory(groupKey: string, ids: string[]): void {
  sentByGroup.set(groupKey, ids.slice(-SENT_HISTORY_MAX));
}

/** 记录某群已发送 */
function rememberSentForGroup(groupKey: string | undefined, postId: string): void {
  if (!groupKey || !postId) return;
  const arr = sentByGroup.get(groupKey) ?? [];
  if (!arr.includes(postId)) arr.push(postId);
  while (arr.length > SENT_HISTORY_MAX) arr.shift();
  sentByGroup.set(groupKey, arr);
}

/** 清空已发送记录（测试用） */
export function clearSentHistory(): void { sentPostIds.length = 0; }

/** 当前已发送记录数量（测试用） */
export function sentHistorySize(): number { return sentPostIds.length; }

/**
 * [2026-11-13] 根据 tag 判断是否符合内容偏好。
 * e621 性别相关 tag：male / female / male/male / male/female / female/female / solo / duo / group
 */
export function matchesPreference(tags: string[], preference: string): boolean {
  if (!preference || preference === 'any') return true;
  const set = new Set(tags.map((t) => t.toLowerCase()));
  const hasMM = set.has('male/male');
  const hasFF = set.has('female/female');
  const hasMF = set.has('male/female');
  const hasSolo = set.has('solo');
  const hasFemale = set.has('female') || set.has('female anthro') || set.has('female feral');

  if (preference === 'hetero') {
    // 优先男女 / 单人，排除同性
    if (hasMM || hasFF) return false;
    return hasMF || hasSolo || hasFemale;
  }
  if (preference === 'solo') {
    return hasSolo || (!set.has('duo') && !set.has('group'));
  }
  if (preference === 'female') {
    return hasFemale && !hasMM;
  }
  return true;
}

export interface E621Options {
  /** 无头 Chrome 可执行路径 */
  chromePath?: string;
  /** 页面等待超时（毫秒） */
  timeoutMs?: number;
  /** scale：day / week / month / year */
  scale?: string;
  /** 指定基准时间（形如 2026-11-11 04:43:30 -0500）；不传用当前时间 */
  date?: string;
  /** [2026-11-13] 会话标识（如 group:123），用于按群去重 */
  groupKey?: string;
  /**
   * [2026-11-13] 内容偏好：根据 tag 过滤，避免总是抽到某一类。
   * 可选值：
   *   'hetero'  优先 男女(male/female) 为主，排除 male/male
   *   'solo'    优先单人图
   *   'female'  优先含 female 的（排除纯男男）
   *   'any'     不过滤（默认）
   */
  preference?: 'hetero' | 'solo' | 'female' | 'any';
}

export interface E621Result {
  imageUrl: string;
  /** [2026-11-12] sample 清晰度（压缩预览，体积小、加载快） */
  sampleUrl: string;
  postUrl: string;
  postId: string;
  /** 文件扩展名（jpg/png/gif 等） */
  ext: string;
  /** [2026-11-12] 该帖子的全部 tag（用于回答"这图里是什么"） */
  tags: string[];
  /** 作者相关 tag（artist/* 或 (xxx) 形式） */
  artist: string[];
  /** 物种/角色相关 tag */
  species: string[];
  /** 从列表页拿到的候选数量（已过滤掉视频） */
  candidates: number;
}

interface Cdp {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;
  close: () => void;
}

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * [2026-11-12] 只允许静态图片与 GIF，任何视频格式一律排除。
 * 依据：列表页 article 元素带有 data-file-ext 属性（实测取值 jpg/png/gif/webm/mp4/swf）。
 */
export const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
export const VIDEO_EXTS = new Set(['webm', 'mp4', 'mov', 'avi', 'mkv', 'swf', 'flv']);

/** 文件扩展名是否可发送（只有图片和 GIF） */
export function isSendableExt(ext: string): boolean {
  const e = String(ext ?? '').toLowerCase().replace(/^\./, '');
  if (VIDEO_EXTS.has(e)) return false;
  return ALLOWED_EXTS.has(e);
}

/** 构造 popular 页面 URL（与用户给的公式一致） */
/**
 * [2026-11-13] 构造热门页 URL。
 *
 * 关键修复：当 scale 是 week/month/year 时，**先在时间窗口内随机挑一天**作为 date，
 * 否则每次都请求同一个"当前时间"窗口，拿到的永远是同一批热门图。
 *
 * e621 的 popular 接口语义：`date` 是窗口的结束时间，`scale` 是窗口长度。
 *   例：date=2026-11-11&scale=month → 取 10-11 ~ 11-11 这一个月里最热的图。
 * 所以在"一个月"这个范围里随机，就是随机挑一个结束日期。
 */
export function buildPopularUrl(opts: E621Options = {}): string {
  const scale = opts.scale ?? 'day';
  const date = opts.date ?? randomDateForScale(scale);
  return `https://e621.net/popular?date=${encodeURIComponent(date)}&scale=${scale}`;
}

/** 每个 scale 对应多少天（用于在窗口内随机） */
const SCALE_DAYS: Record<string, number> = {
  day: 1, week: 7, month: 30, year: 365,
};

/**
 * [2026-11-13] 在时间窗口内**真随机**挑一个结束时间。
 * day → 今天往前 1 天内随机；month → 往前 30 天内随机。
 * 这样每次取图覆盖的范围不同，不会老是同一批图。
 */
export function randomDateForScale(scale: string): string {
  const days = SCALE_DAYS[scale] ?? 1;
  // 随机往前推 0~days 天（ms 级随机，含时分秒）
  const backMs = Math.floor(Math.random() * days * 24 * 60 * 60 * 1000);
  return formatTime(new Date(Date.now() - backMs));
}

/** 生成时间串：YYYY-MM-DD HH:mm:ss ±HHmm */
export function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${ymd} ${hms} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/** 启动无头 Chrome 并连上 CDP */
/**
 * [2026-11-12] 启动前清理历史遗留的无头 Chrome。
 * 之前只 kill 主进程，Helpers 会变孤儿；累积多个后新请求抢不到资源会超时。
 */
// [2026-11-12] 全局串行锁：同一时刻只允许一个无头 Chrome 在跑。
// 并发启动会互相抢端口/资源，导致 "CDP 未就绪" 失败。
let chromeLock: Promise<void> = Promise.resolve();
function withChromeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chromeLock.then(fn, fn);
  chromeLock = run.then(() => undefined, () => undefined);
  return run;
}

function reapStaleChromes(): void {
  try {
    const { execSync } = require('node:child_process');
    execSync('pkill -9 -f "e621-cdp-"', { stdio: 'ignore' });
  } catch { /* 没有匹配进程属正常 */ }
}

/**
 * [2026-11-12] 常驻无头 Chrome 单例。
 * 每次取图都冷启动 Chrome 要 3~5 秒；复用实例后这部分开销摊销掉。
 * 空闲超过 IDLE_MS 自动关闭，避免长期占内存。
 */
const IDLE_MS = 5 * 60 * 1000;
let persistent: { cdp: Cdp; kill: () => void; chromePath: string; lastUsed: number } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (persistent) {
      try { persistent.cdp.close(); } catch { /* 忽略 */ }
      try { persistent.kill(); } catch { /* 忽略 */ }
      persistent = null;
    }
  }, IDLE_MS);
}

async function getChrome(chromePath: string): Promise<{ cdp: Cdp; kill: () => void }> {
  // 已有实例且路径一致 -> 复用（先探活）
  if (persistent && persistent.chromePath === chromePath) {
    try {
      // 探活：不仅问版本，还确认能列 targets（能正常开页面）
      const v = await persistent.cdp.send('Browser.getVersion');
      const t = await persistent.cdp.send('Target.getTargets');
      if (v?.result && t?.result) {
        persistent.lastUsed = Date.now();
        return { cdp: persistent.cdp, kill: () => { /* 常驻，不在这里关 */ } };
      }
    } catch { /* 实例已死，重建 */ }
    try { persistent.kill(); } catch { /* 忽略 */ }
    persistent = null;
  }
  const fresh = await launchChrome(chromePath);
  persistent = { cdp: fresh.cdp, kill: fresh.kill, chromePath, lastUsed: Date.now() };
  return { cdp: fresh.cdp, kill: () => { /* 常驻 */ } };
}

/** 关闭常驻实例（进程退出时调用） */
export function shutdownChrome(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (persistent) {
    try { persistent.cdp.close(); } catch { /* 忽略 */ }
    try { persistent.kill(); } catch { /* 忽略 */ }
    persistent = null;
  }
}

async function launchChrome(chromePath: string): Promise<{ cdp: Cdp; kill: () => void; wsUrl: string }> {
  reapStaleChromes();
  const profile = path.join(os.tmpdir(), `e621-cdp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等待 CDP 就绪
  const deadline = Date.now() + 15000;
  let wsUrl = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json() as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
      }
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  // [2026-11-12] 必须清理整个进程组：Chrome 会派生 Helper 子进程，
  // 只 kill 主进程会留下孤儿，越积越多导致后续取图超时。
  const kill = () => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    // 杀掉以该 profile 目录为 --user-data-dir 的所有残留进程
    try {
      const { execSync } = require('node:child_process');
      execSync(`pkill -9 -f "user-data-dir=${profile}"`, { stdio: 'ignore' });
    } catch { /* 没有匹配进程时 pkill 返回非 0，忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
  if (!wsUrl) { kill(); throw new Error('无法启动无头 Chrome（CDP 未就绪）'); }
  const cdp = await connect(wsUrl);
  return { cdp, kill, wsUrl };
}

/** 建立 CDP 连接（兼容 Node 自带 WebSocket 与 ws 包两种事件接口） */
async function connect(wsUrl: string): Promise<Cdp> {
  const WS: any = (globalThis as any).WebSocket ?? (await import('ws' as string)).default;
  const ws = new WS(wsUrl);
  let id = 0;
  const pending = new Map<number, (v: any) => void>();

  // 统一事件订阅：标准 WebSocket 用 addEventListener，ws 包用 on
  const on = (event: string, fn: (arg: any) => void) => {
    if (typeof ws.addEventListener === 'function') ws.addEventListener(event, (e: any) => fn(e));
    else ws.on(event, fn);
  };
  const sendRaw = (text: string) => {
    if (typeof ws.send === 'function') ws.send(text);
  };

  on('message', (raw: any) => {
    const data = raw?.data ?? raw;
    const text = typeof data === 'string' ? data : String(data);
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });

  await new Promise<void>((resolve, reject) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e: any) => reject(new Error(String(e?.message ?? 'websocket error'))));
    } else {
      ws.on('open', () => resolve());
      ws.on('error', (e: Error) => reject(e));
    }
  });

  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        sendRaw(JSON.stringify({ id: i, method, params, sessionId }));
      });
    },
    close() { try { ws.close(); } catch { /* 忽略 */ } },
  };
}

/** 在目标页里执行表达式 */
async function evaluate(cdp: Cdp, sessionId: string, expression: string): Promise<any> {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId);
  return r?.result?.result?.value;
}

/** 打开一个页面并返回它的 session */
/**
 * [2026-11-12] 打开页面并**轮询等待条件成立**，取代固定 sleep。
 * 原来列表页固定等 9 秒、详情页等 8 秒，实际 2-4 秒就够了，白白浪费 10 秒以上。
 *
 * @param readyExpr 页面内表达式，返回真值即认为加载完成
 * @param maxMs 最长等待
 */
async function openPageReady(
  cdp: Cdp, url: string, readyExpr: string, maxMs = 12000,
): Promise<{ sessionId: string; targetId: string; ready: boolean }> {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = String(created?.result?.targetId ?? '');
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached?.result?.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  // [2026-11-12] 禁用缓存：常驻 Chrome 复用实例时，缓存会让每次拿到同一份热门列表
  try { await cdp.send('Network.enable', {}, sessionId); } catch { /* 忽略 */ }
  try { await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId); } catch { /* 忽略 */ }
  await cdp.send('Page.navigate', { url }, sessionId);

  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 250));   // 250ms 轮询，比一刀切 sleep 快得多
    try {
      const ok = await evaluate(cdp, sessionId, `Boolean(${readyExpr})`);
      if (ok) return { sessionId, targetId, ready: true };
    } catch { /* 页面还在导航，忽略 */ }
  }
  return { sessionId, targetId, ready: false };
}

/**
 * [2026-11-12] 真正关闭一个页面 target。
 * 之前误用 Target.detachFromTarget —— 那只断开调试连接，页面仍在，
 * 导致 target 越积越多、内存上涨、后续取图变慢甚至卡死。
 */
async function closeTarget(cdp: Cdp, targetId: string): Promise<void> {
  if (!targetId) return;
  try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 忽略 */ }
}

/**
 * 抓一张热门图的原图地址。
 * @throws 页面里没有候选、详情页没有原图、或浏览器启动失败
 */
/**
 * [2026-11-13] 带"候选充足"重试的取图。
 * 随机日期可能撞到冷清时段（只有 1~3 张图），那样很容易重复。
 * 这里最多尝试 3 次，优先采用候选数 >= minCandidates 的那一次。
 */
export async function fetchPopularImage(
  opts: E621Options = {}, minCandidates = 8, attempts = 3,
): Promise<E621Result> {
  return withChromeLock(async () => {
    let best: E621Result | null = null;
    let lastErr: Error | null = null;
    for (let i = 0; i < Math.max(1, attempts); i++) {
      try {
        const r = await fetchPopularImageInner(opts);
        if (!best || r.candidates > best.candidates) best = r;
        if (r.candidates >= minCandidates) return r;
      } catch (e) {
        // 冷清时段可能整页都是视频/没有可发的图：换个随机日期继续试
        lastErr = e as Error;
      }
    }
    if (best) return best;
    throw lastErr ?? new Error('取图失败：多次尝试均无可用图片');
  });
}

async function fetchPopularImageInner(opts: E621Options = {}): Promise<E621Result> {
  const chromePath = opts.chromePath ?? DEFAULT_CHROME;
  const timeoutMs = opts.timeoutMs ?? 45000;
  if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome：${chromePath}`);

  const { cdp, kill } = await getChrome(chromePath);
  const started = Date.now();
  let listSession = '';
  let detailSession = '';
  let listTargetId = '';
  let detailTargetId = '';
  try {
    const baseUrl = buildPopularUrl(opts);
    // [2026-11-12] 加随机参数，彻底绕开缓存（服务器会忽略未知参数）
    const popularUrl = `${baseUrl}&_t=${Date.now()}`;
    const listOpen = await openPageReady(
      cdp, popularUrl,
      `document.querySelectorAll('article a[href*="/posts/"]').length > 0`,
      12000,
    );
    listSession = listOpen.sessionId;
    listTargetId = listOpen.targetId;

    // 等 article 出现，最多到超时
    // 收集 article：同时取 post id 与 data-file-ext，用于排除视频
    let raw = '[]';
    let items: Array<{ id: string; ext: string }> = [];
    while (Date.now() - started < timeoutMs) {
      raw = await evaluate(cdp, listSession, `
        JSON.stringify([...document.querySelectorAll('article')].map(art => {
          const a = art.querySelector('a[href*="/posts/"]');
          const href = a && a.getAttribute('href');
          const m = href && href.match(/^\\/posts\\/(\\d+)$/);
          if (!m) return null;
          const ext = art.getAttribute('data-file-ext')
            || art.querySelector('[data-file-ext]')?.getAttribute('data-file-ext')
            || '';
          return { id: m[1], ext: String(ext).toLowerCase() };
        }).filter(Boolean))
      `) ?? '[]';
      items = JSON.parse(raw) as Array<{ id: string; ext: string }>;
      if (items.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (items.length === 0) throw new Error('热门页没有解析到任何 post（页面可能为空或结构变化）');

    // [2026-11-12] 只保留静态图片与 GIF；视频（webm/mp4/swf 等）全部剔除
    const sendable = items.filter((it) => it.id && isSendableExt(it.ext));
    if (sendable.length === 0) {
      throw new Error(`热门页共 ${items.length} 个帖子，但没有可发送的图片（全部是视频或未知格式）`);
    }
    const uniqueMap = new Map<string, string>();
    for (const it of sendable) if (!uniqueMap.has(it.id)) uniqueMap.set(it.id, it.ext);
    let entries = [...uniqueMap.entries()];

    // [2026-11-13] 排除已发送过的：
    //   ① 全局记录（跨群/跨重启）
    //   ② **本群记录**——群里所有人共用一个清单，谁触发都算
    const groupSent = opts.groupKey ? (sentByGroup.get(opts.groupKey) ?? []) : [];
    const fresh = entries.filter(([id]) => !sentPostIds.includes(id) && !groupSent.includes(id));
    if (fresh.length > 0) {
      entries = fresh;
    } else if (entries.length > 0) {
      // 列表里的图都发过了：清空历史，允许下一轮重复
      sentPostIds.length = 0;
    }

    // [2026-11-13] 内容偏好过滤：抽到的图 tag 不符就换下一张。
    // 之前完全随机，e621 热门榜里 male/male 占比不低，导致经常抽到同性向的图。
    const preference = opts.preference ?? 'any';
    const tagExpr = `(() => {
      const links = [...document.querySelectorAll('#tag-list a[href*="posts?tags="]')];
      return links.map(a => ((a.textContent || '').trim().split('\\n')[0] || '').trim()).filter(Boolean);
    })()`;

    const tried = new Set<string>();
    let pick = '';
    let listExt = 'jpg';
    let postUrl = '';
    let tags: string[] = [];
    let detailSession = '';
    let detailTargetId = '';

    for (let attempt = 0; attempt < 6; attempt++) {
      const remain = entries.filter(([id]) => !tried.has(id));
      const pool = remain.length > 0 ? remain : entries;
      const cand = pool[Math.floor(Math.random() * pool.length)]!;
      pick = cand[0];
      listExt = cand[1];
      tried.add(pick);
      postUrl = `https://e621.net/posts/${pick}`;

      if (detailTargetId) { try { await closeTarget(cdp, detailTargetId); } catch { /* 忽略 */ } }
      const detailOpen = await openPageReady(
        cdp,
        `${postUrl}?_t=${Date.now()}`,
        `(document.querySelector('#image')?.src || '').length > 0
          || document.querySelectorAll('a[href*="/data/"]').length > 0`,
        12000,
      );
      detailSession = detailOpen.sessionId;
      detailTargetId = detailOpen.targetId;

      try {
        const rawTags = await evaluate(cdp, detailSession, tagExpr);
        tags = Array.isArray(rawTags) ? rawTags.map((t) => String(t).trim()).filter((t) => t !== '') : [];
      } catch { tags = []; }

      if (matchesPreference(tags, preference)) break;
      // 不符 -> 本轮 continue，下一轮换图
    }


    // 注意：这段代码经 JSON 字符串送进页面执行，正则里不要用反斜杠转义，
    // 改用 indexOf / startsWith 等纯字符串判断，避免多层转义出错。
    const pickExpr = `(() => {
      const all = [...new Set(
        [...document.querySelectorAll('a, img, video, video source')]
          .map(e => e.href || e.src || e.currentSrc || '')
          .filter(Boolean)
      )];
      const isDerived = (u) =>
        u.indexOf('/data/sample/') >= 0 ||
        u.indexOf('/data/preview/') >= 0 ||
        u.indexOf('/data/avatars/') >= 0 ||
        u.indexOf('/data/thumb/') >= 0;
      const dl = all.find(u => u.indexOf('/data/download/') >= 0);
      if (dl) return [dl, 'download'];
      const orig = all.find(u => u.indexOf('/data/') >= 0 && !isDerived(u));
      if (orig) return [orig, 'original'];
      const vid = all.find(u => u.endsWith('.webm') || u.endsWith('.mp4'));
      if (vid) return [vid, 'video'];
      const img = document.querySelector('#image');
      return img && img.src ? [img.src, 'fallback'] : ['', 'none'];
    })()`;
    let imageUrl = '';
    let source = 'none';
    while (Date.now() - started < timeoutMs) {
      const got = await evaluate(cdp, detailSession, pickExpr);
      if (Array.isArray(got) && got[0]) { imageUrl = String(got[0]); source = String(got[1]); break; }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!imageUrl) throw new Error(`详情页没有找到原图：${postUrl}`);

    // 兜底来源（img#image）可能是 sample 路径：把派生目录换成原图目录
    if (source === 'fallback') {
      imageUrl = imageUrl.replace('/data/sample/', '/data/').replace('/data/preview/', '/data/');
    }

    // 详情页拿到的是原图地址，以其真实扩展名为准再校验一遍（防止列表页标记与实际不符）
    const urlExt = (imageUrl.split('?')[0]!.match(/\.([a-z0-9]+)$/i)?.[1] ?? listExt).toLowerCase();
    if (!isSendableExt(urlExt)) {
      throw new Error(`抽到的帖子是暂不支持的格式（.${urlExt}）：${postUrl}，请重试`);
    }

    // 主站 tag 链接文本形如 "wolf"，也可能带 "(artist)" 后缀，这里做简单归类
    const artist = tags.filter((t) => /artist|\bmodeler\b|\bowner\b/i.test(t) || /\((artist|modeler|owner)\)$/i.test(t));
    const species = tags.filter((t) => /^(wolf|fox|cat|dog|dragon|horse|bird|bear|lion|tiger|rabbit|human|humanoid)\b/i.test(t));
    // [2026-11-12] 同时给出 sample 地址：同 hash，只是目录从 /data/ 换成 /data/sample/
    const sampleUrl = imageUrl
      .replace('/data/download/', '/data/sample/')
      .replace(/\/data\/(?!(download|sample|preview|avatars)\b)/, '/data/sample/');
    // 记录已发送，供后续去重（全局 + 本群）
    rememberSent(pick);
    rememberSentForGroup(opts.groupKey, pick);
    return {
      imageUrl, sampleUrl, postUrl, postId: pick, ext: urlExt,
      tags, artist, species,
      candidates: entries.length,
    };
  } finally {
    // [2026-11-12] 常驻模式下关闭本次打开的两个页面（避免 target 堆积），
    // 但保留 Chrome 本体；空闲 5 分钟后自动回收。
    try { await closeTarget(cdp, listTargetId); } catch { /* 忽略 */ }
    try { await closeTarget(cdp, detailTargetId); } catch { /* 忽略 */ }
    scheduleIdleShutdown();
  }
}

/**
 * [2026-11-12] 下载图片并转成 base64 data URL。
 *
 * 为什么需要：e621 的图片 CDN（static1.e621.net）在部分网络下不可达，
 * 让 NapCat 自己下载会报 `read ECONNRESET`。改由 gateway 先下载（可走代理），
 * 再以 base64 交给 NapCat，彻底绕开它的网络环境。
 *
 * @param url 图片地址
 * @param proxy 可选代理，如 http://127.0.0.1:7897
 * @param maxBytes 大小上限，超过则放弃（QQ 对超大图片支持有限）
 */
export async function downloadAsBase64(url: string, proxy?: string, maxBytes = 15 * 1024 * 1024): Promise<string> {
  const bytes = await downloadBytes(url, proxy, maxBytes);
  const b64 = Buffer.from(bytes).toString('base64');
  return `base64://${b64}`;
}

/**
 * [2026-11-12] 优先下载 sample 版本，404 时自动回退原图。
 * 部分图片（GIF/小图）没有 sample，直接用原图即可。
 */
export async function downloadBest(
  imageUrl: string, sampleUrl: string | undefined, proxy?: string, maxBytes = 8 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; usedSample: boolean }> {
  // [2026-11-13] sample 失败（404 不存在 / 连接重置 / 超时）一律回退到原图。
  // 之前只处理 404，其它错误会直接失败，导致"图没取到"。
  if (sampleUrl && sampleUrl !== imageUrl) {
    try {
      const bytes = await downloadBytes(sampleUrl, proxy, maxBytes);
      return { bytes, usedSample: true };
    } catch (e) {
      const msg = (e as Error).message || '';
      // 记录一下便于排查：sample 不可用就换原图
      process.stderr.write(`[e621] sample 失败，回退原图：${msg.slice(0, 80)}\n`);
    }
  }
  // [2026-11-13] 回退原图时给更保守的上限：原图常是 sample 的 3~5 倍。
  // [2026-11-17] 6MB → 10MB：e621 原图 GIF 常 6~10MB，6MB 直接拒绝导致"抽到的图全下不下来"。
  const fallbackMax = Math.min(maxBytes, 10 * 1024 * 1024);
  const bytes = await downloadBytes(imageUrl, proxy, fallbackMax);
  return { bytes, usedSample: false };
}

/** 下载并转 base64（优先 sample，404 回退原图） */
export async function downloadBestAsBase64(
  imageUrl: string, sampleUrl: string | undefined, proxy?: string, maxBytes = 8 * 1024 * 1024,
): Promise<string> {
  const { bytes } = await downloadBest(imageUrl, sampleUrl, proxy, maxBytes);
  return `base64://${Buffer.from(bytes).toString('base64')}`;
}

/** 下载为字节数组（支持走代理） */
export async function downloadBytes(url: string, proxy?: string, maxBytes = 15 * 1024 * 1024, timeoutMs = 90000): Promise<Uint8Array> {
  const ctrl = new AbortController();
  // [2026-11-17] 用户要求放开超时：原 30s 对 e621 原图（GIF 常 3~8MB）偏紧，
  // 多次因"下载不完整→aborted→换图→又抽到大图"而整轮失败。改为 90s。
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    if (proxy) {
      res = await fetchViaProxy(url, proxy, ctrl.signal);
    } else {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dsh-qq-ops/0.1.0)' },
      });
    }
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    // [2026-11-12] 头部就能看到大小：超限直接放弃，不用白等下载完
    if (len > maxBytes) throw new Error(`图片过大（${(len / 1048576).toFixed(1)}MB > ${(maxBytes/1048576).toFixed(1)}MB），跳过`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`图片过大（${(buf.byteLength / 1048576).toFixed(1)}MB），跳过`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过 HTTP 代理发起请求。
 * 对 https 目标使用 CONNECT 隧道（Node 的 http 模块不支持 https-over-proxy 直连）。
 */
async function fetchViaProxy(url: string, proxy: string, signal: AbortSignal): Promise<Response> {
  const tls = await import('node:tls');
  const net = await import('node:net');
  const http = await import('node:http');
  const target = new URL(url);
  const proxyUrl = new URL(proxy);
  const proxyPort = Number(proxyUrl.port || 8080);
  const proxyHost = proxyUrl.hostname;

  if (target.protocol !== 'https:') {
    // http 目标：直接带绝对 URL 发到代理
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({
        host: proxyHost, port: proxyPort, method: 'GET',
        path: url, headers: { Host: target.host, 'User-Agent': 'Mozilla/5.0' },
        signal,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
          }));
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // https 目标：CONNECT 建隧道，再在其上做 TLS
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const req = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      signal,
    });
    req.on('connect', (res, sock) => {
      if (res.statusCode !== 200) { reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`)); return; }
      resolve(sock);
    });
    req.on('error', reject);
    req.end();
  });

  const tlsSocket = tls.connect({ socket, servername: target.hostname, signal });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('secureConnect', () => resolve());
    tlsSocket.once('error', reject);
  });

  return new Promise<Response>((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        Host: target.host,
        'User-Agent': 'Mozilla/5.0 (compatible; dsh-qq-ops/0.1.0)',
        Accept: 'image/*,*/*',
        Connection: 'close',
      },
      createConnection: () => tlsSocket,
      signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
        }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
