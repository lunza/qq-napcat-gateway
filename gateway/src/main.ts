// [2026-11-12] qq-gateway 主进程
// harness 托管方式：后台 job 运行本进程；日志走 stdout（job_output 可见），
// 状态/时间线落到 state/，健康快照 state/health.json 供外部定时检查。
// 用法：
//   node gateway/src/main.ts                 # 常驻
//   node gateway/src/main.ts --once          # 自检一次（连接+探活）后退出，用于部署验证
//   node gateway/src/main.ts --report        # 打印 uptime 报告后退出
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from './config.ts';
import { OneBotClient } from './onebot.ts';
import { route, stripMention } from './router.ts';
import { Monitor, buildReport } from './monitor.ts';
import { createReplyEngine } from './reply.ts';
import { appendJsonl, todayStamp, writeJsonAtomic, loadJson } from './store.ts';
import type { InboundMessage } from './router.ts';
import { handleCommand, isOwner, type CommandContext } from './commands.ts';
import { matchSkill, renderSkillHelp, isHelpRequest, skillPromptSection } from './skills.ts';
import { fetchPopularImage, downloadAsBase64, downloadBestAsBase64, downloadBytes, initSentHistory, setGroupSentHistory } from './e621.ts';
import { fetchLatestNews, type NewsItem } from './news.ts';
import { openImageStore, type ImageStore } from './image-store.ts';
import { openChatStore, looksLikeSticker, type ChatStore, type StickerRecord } from './chat-store.ts';
import { analyze, profilePromptSection, type LearnedProfile } from './learn.ts';
import { fetchAndAnalyzeSticker, saveSticker, analyzeSticker, classifySticker, passesStickerGate } from './sticker.ts';
import { openMemeLibrary, memesPromptSection } from './memes.ts';
// [2026-11-16] 梗库世界书：纯文字消息的关键词/向量触发注入（修复"文字问梗不命中"）
import { createWorldbook, resolveWorldbookConfig, type Worldbook } from './worldbook.ts';
// [2026-11-16] 媒体收集（先落盘）与定时整理（后分析）
import { downloadMediaById as downloadOneMedia, downloadPendingMedia, organizeMedia, contentHashOf, type MediaPipelineDeps } from './media.ts';
// [2026-11-18] 表情包频率权重：高频图更容易被凑热闹选中
import { weightFor, pickWeighted, fileContentHash } from './sticker-weight.ts';
// [2026-11-16] 回复文本处理：剔除 emoji + 按概率搭配表情包
import { stripEmoji, hasMeaningfulText, hasEmoji, suggestStickerCategory, rollChance } from './reply-text.ts';
// [2026-11-16] 口癖连续出现闸门：最近 2 条都用同一口癖收尾时剥离本条的（防"句句笑死"）
import { stripRepeatedTailPhrase } from './reply-text.ts';

const args = new Set(process.argv.slice(2));
// [2026-11-12] 配置热重载：main 启动时读一次作为初始值，
// 之后每次处理消息前都会调用 reloadConfigIfChanged() 重新读取，
// 这样在设置页/文件里改的人设、规则能立即生效，无需重启 gateway。
let { config } = loadConfig();
const { configPath } = loadConfig();

/** 记录配置文件 mtime，变化时重新加载 */
let configMtimeMs = 0;
function reloadConfigIfChanged(): void {
  try {
    const st = fs.statSync(configPath);
    if (st.mtimeMs === configMtimeMs) return;
    const fresh = loadConfig();
    config = fresh.config;
    configMtimeMs = st.mtimeMs;
    // [2026-11-16] 配置替换后重建回复引擎：engine 闭包捕获的是旧 config 引用，
    // 不重建的话人设/技能/世界书的热重载全部无效（隐性 bug 修复）。
    // worldbook 的 getConfig 每次现读，无需重建。
    engine = createReplyEngine(config, { worldbookSection });
    say('info', '配置已热重载', {
      personaName: config.persona?.name ?? '',
      model: config.autoReply?.mode ?? '',
      // [2026-11-17] 把表情包相关概率也记上，便于确认热重载后实际生效的值
      groupStickerProb: config.groupSticker?.probability ?? null,
      replyStickerProb: config.replySticker?.probability ?? null,
      replyStickerOn: config.replySticker?.enabled ?? null,
    });
  } catch (e) {
    say('warn', '配置热重载失败，继续使用旧配置', { message: (e as Error).message });
  }
}
// 初始化 mtime
try { configMtimeMs = fs.statSync(configPath).mtimeMs; } catch { /* 忽略 */ }
const STATE_DIR = path.join(REPO_ROOT, 'state');
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const QUEUE_DIR = path.join(STATE_DIR, 'queued');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(QUEUE_DIR, { recursive: true });

function say(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  appendJsonl(path.join(LOG_DIR, `${todayStamp()}.jsonl`), { ts: new Date().toISOString(), kind: 'log', level, msg, ...extra });
}

if (args.has('--report')) {
  console.log(JSON.stringify(buildReport(STATE_DIR), null, 2));
  process.exit(0);
}

const selfUin = config.behavior.selfUin || process.env.QQBOT_SELF_UIN || '';
if (!selfUin) say('warn', '未配置 behavior.selfUin：@机器人 判断将只能依赖原始 CQ 码，建议在 config/qq.json 中填写机器人 QQ 号');

const history = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
// [2026-11-12] 发图记录库：记录发给谁、哪张图、附带 tag，供追问时回溯
const imageStore: ImageStore = openImageStore(path.join(STATE_DIR, 'images.db'));
// [2026-11-12] 聊天记录与表情包收集（全量，按用户要求；数据只留本机）
const chatStore: ChatStore = openChatStore(path.join(STATE_DIR, 'chat.db'));
const LEARNED_DIR = path.join(STATE_DIR, 'learned');
const STICKER_DIR = path.join(STATE_DIR, 'stickers');
// [2026-11-16] 原始媒体落盘目录：与 stickers/（已整理的表情包）分开，
// 这里存的是"还没整理"的原始素材，按 URL 哈希命名，永不覆盖。
const MEDIA_DIR = path.join(STATE_DIR, 'media');
// [2026-11-12] 网络梗库（可人工维护，优先于模型猜测）
const memeLib = openMemeLibrary(path.join(STATE_DIR, 'memes.json'));

// ── [2026-11-16] 梗库世界书 ──
// embedding 走 crec 的 bge-m3（1024 维，实测可用）；密钥复用 .env 的 CREC_API_KEY。
// 请求失败返回 null，向量层静默降级为纯关键词（绝不阻塞回复链路）。
async function crecEmbed(texts: string[], model: string): Promise<number[][] | null> {
  const apiKey = process.env.CREC_API_KEY ?? '';
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch('https://ai-api.crec.cn/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      say('warn', 'embedding 请求失败', { status: res.status, model, count: texts.length });
      return null;
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    const out = (data.data ?? []).map((d) => d.embedding ?? []);
    return out.every((v) => v.length > 0) ? out : null;
  } catch (e) {
    say('warn', 'embedding 请求异常（向量召回本轮停用）', { message: (e as Error).message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const worldbook: Worldbook = createWorldbook({
  lib: memeLib,
  getConfig: () => resolveWorldbookConfig(config.worldbook),
  embed: crecEmbed,
  vectorCacheFile: path.join(STATE_DIR, 'memes.vectors.json'),
  log: (level, msg, extra) => say(level, msg, extra),
});
// 后台建向量库（首次约 50 条，一次批量请求），完成前向量兜底自动不参与
void worldbook.syncVectors();
// [2026-11-13] 加载"已发送图片"记录，避免重复（持久化到磁盘，跨重启生效）
initSentHistory(path.join(STATE_DIR, 'sent-posts.json'));
// [2026-11-13] 从图片库恢复每个群已发过的图，实现"群里任何人触发都不重复"
try {
  const rows = imageStore.recentStickerSends(2000);
  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.peerKey?.startsWith('group:') || !r.postId) continue;
    const arr = byGroup.get(r.peerKey) ?? [];
    arr.push(String(r.postId));
    byGroup.set(r.peerKey, arr);
  }
  for (const [k, v] of byGroup) setGroupSentHistory(k, v);
  say('info', '已恢复群级发图记录', { groups: byGroup.size });
} catch { /* 恢复失败不影响启动 */ }
// [2026-11-12] 视觉分析配置（复用 crec 接口，密钥来自 .env）
const VISION = {
  apiKey: process.env.CREC_API_KEY ?? '',
  baseURL: 'https://ai-api.crec.cn/v1',
  model: 'deepseek-flash',
  proxy: config.proxy?.url || undefined,
};
// [2026-11-16] 媒体流水线依赖（下载 + 整理共用）
const MEDIA_DEPS: MediaPipelineDeps = {
  store: chatStore,
  dir: MEDIA_DIR,
  vision: VISION,
  say,
};

// [2026-11-16] 供 dsh 定时任务调用的一次性整理入口：
//   node gateway/src/main.ts --organize            # 跑完一轮就退出
//   node gateway/src/main.ts --organize --drain    # 一直跑到队列清空
// 与常驻进程内的定时器共享同一套函数，行为完全一致。
// [2026-11-16 移位] 原本位于 OneBotClient 创建之后——organize CLI import 本模块时
// 会先创建 client/monitor/engine 等常驻对象（日志里出现第二条"qq-gateway 启动"，
// 且 client 若完成连接就成了第二个 WS 收信者，撞上消息就是双处理）。
// 现移到 gateway 初始化之前，CLI 模式不再触碰任何常驻对象。
if (args.has('--organize')) {
  void (async () => {
    const drain = args.has('--drain');
    const started = Date.now();
    let rounds = 0;
    let totalSticker = 0, totalNot = 0, totalFailed = 0, promotedTotal = 0;
    try {
      const before = chatStore.mediaStats();
      say('info', '定时整理开始（CLI）', { ...before, drain });
      // 防止视觉密钥缺失时白跑
      if (!VISION.apiKey) {
        say('warn', '未配置视觉密钥，整理任务跳过（原件仍会照常保存）');
        console.log(JSON.stringify({ ok: false, reason: 'no-vision-key' }));
        process.exit(0);
      }
      // 先补下载，再整理；drain 模式循环直到没有待处理项
      do {
        rounds++;
        await downloadPendingMedia(MEDIA_DEPS, drain ? 50 : 20);
        const r = await organizeMedia(MEDIA_DEPS, drain ? 20 : 10);
        totalSticker += r.sticker; totalNot += r.notSticker;
        totalFailed += r.failed; promotedTotal += r.promoted.length;
        if (!drain) break;
        const st = chatStore.mediaStats();
        if (st.pendingDownload === 0 && st.new_ === 0) break;
        if (rounds > 50) { say('warn', '整理轮次超过上限，提前结束', { rounds }); break; }
      } while (true);
      const after = chatStore.mediaStats();
      say('info', '定时整理完成（CLI）', {
        rounds, sticker: totalSticker, notSticker: totalNot, failed: totalFailed,
        promoted: promotedTotal, tookMs: Date.now() - started, ...after,
      });
      // 输出结构化结果，供定时任务侧判断成功与否
      console.log(JSON.stringify({
        ok: true, rounds, sticker: totalSticker, notSticker: totalNot,
        failed: totalFailed, promoted: promotedTotal,
        tookMs: Date.now() - started, stats: after,
      }));
      process.exit(0);
    } catch (e) {
      say('error', '定时整理失败（CLI）', { message: (e as Error).message });
      console.log(JSON.stringify({ ok: false, reason: (e as Error).message }));
      process.exit(1);
    }
  })();
}

// [2026-11-16] 单实例锁：防多入口（沙盒重拉/autostart/手动）同时跑多个 gateway。
// 双实例会同时连 OneBot WS → 同一条消息双处理、双回复（2026-11-16 群里实测发生）。
// mkdir 是原子操作，天然互斥；持有者死亡（含强杀残留）时新实例接管锁。
const GATEWAY_LOCK_DIR = path.join(STATE_DIR, 'gateway.lock');
const GATEWAY_LOCK_PID = path.join(GATEWAY_LOCK_DIR, 'pid');

/**
 * [2026-11-17] 加固：原实现有"刚启动窗口"竞态——两个进程同时启动时，
 * 后者 mkdir 失败 → 读 pid 文件（前者还没写完）→ 读到 0 → 误判为残留锁 →
 * 删除重建 → 两个都拿到锁（2026-11-17 09:17:57 实测双实例，同毫秒启动）。
 * 修复：
 *   1) mkdir 成功后**先写 pid 再返回**，且 pid 用紧凑写；
 *   2) 读到空/无效 pid 时最多等 3 秒重读（等持有者写完），不立刻判残留；
 *   3) 接管残留锁用"先删再重建"，但删除前再确认一次 pid 仍无效（双检）。
 */
function acquireGatewayLock(): void {
  const writePid = (): void => {
    fs.writeFileSync(GATEWAY_LOCK_PID, String(process.pid));
    process.on('exit', () => {
      // 只删自己持有的锁（防止 pid 已被别的活实例接管后误删）
      try {
        if (Number(fs.readFileSync(GATEWAY_LOCK_PID, 'utf8')) === process.pid) {
          fs.rmSync(GATEWAY_LOCK_DIR, { recursive: true, force: true });
        }
      } catch { /* 忽略 */ }
    });
  };
  const readHolder = (): number => {
    try { return Number(fs.readFileSync(GATEWAY_LOCK_PID, 'utf8')) || 0; } catch { return 0; }
  };
  const alive = (pid: number): boolean => {
    if (!(pid > 0) || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  // 第一次尝试：mkdir 原子抢占
  try {
    fs.mkdirSync(GATEWAY_LOCK_DIR);
    writePid();
    return;
  } catch { /* 已被占用 */ }

  // 已有锁：轮询等 pid 文件落盘（最多 3s，覆盖"持有者刚 mkdir 还没写 pid"的窗口）
  let holder = readHolder();
  for (let i = 0; i < 30 && !holder; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    holder = readHolder();
  }

  if (alive(holder)) {
    say('warn', `已有 gateway 实例在运行（pid=${holder}），本实例退出以避免双回复`);
    process.exit(0);
  }

  // 残留锁：删除前再确认 pid 仍无效（双检），然后重建
  if (readHolder() === 0 || !alive(readHolder())) {
    say('warn', `发现残留锁（持有者 pid=${holder || '未知'} 已不存在），本实例接管`);
    fs.rmSync(GATEWAY_LOCK_DIR, { recursive: true, force: true });
    try {
      fs.mkdirSync(GATEWAY_LOCK_DIR);
      writePid();
      return;
    } catch { /* 对手抢先：走下面的复查 */ }
  }
  // 复查：此刻若已被活实例持有则退让
  const finalHolder = readHolder();
  if (alive(finalHolder)) {
    say('warn', `已有 gateway 实例在运行（pid=${finalHolder}），本实例退出以避免双回复`);
    process.exit(0);
  }
  // 极端兜底：宁可退出也不双开（人工介入比双回复安全）
  say('error', '无法获取 gateway 锁，为避免双回复退出');
  process.exit(1);
}
acquireGatewayLock();

/** [2026-11-16] 收到消息时立即下载单个媒体（失败不影响主流程） */
function downloadMediaById(id: number): void {
  try {
    const rec = chatStore.pendingDownloads(200).find((x) => x.id === id);
    if (!rec) return;
    void downloadOneMedia(MEDIA_DEPS, rec).then((ok) => {
      // [2026-11-17] 下载成功后再判断"是不是同一张表情包被重复发"（+1 跟图）
      if (ok) void maybeFollowSameSticker(rec.peerKey);
    });
  } catch (e) {
    say('warn', '下载媒体异常', { id, message: (e as Error).message });
  }
}

/**
 * [2026-11-17] 一次性回填：给历史上"已下载但没有内容哈希"的记录补哈希，
 * 让老图也能参与"跟图 +1"判断（否则新功能只对上线后的新图生效）。
 * 只处理本地文件还在的记录；文件缺失的跳过，不影响其它记录。
 */
function backfillMediaHashes(): void {
  try {
    const need = chatStore.mediaNeedingHash(500);
    if (need.length === 0) return;
    let done = 0, missing = 0;
    for (const rec of need) {
      if (!rec.localPath || !fs.existsSync(rec.localPath)) { missing++; continue; }
      try {
        const bytes = new Uint8Array(fs.readFileSync(rec.localPath));
        chatStore.setMediaHash(rec.id, contentHashOf(bytes));
        done++;
      } catch { missing++; }
    }
    say('info', '媒体内容哈希回填完成', { 回填: done, 文件缺失: missing, 总数: need.length });
  } catch (e) {
    say('warn', '媒体哈希回填失败', { message: (e as Error).message });
  }
}

// [2026-11-17] 跟图冷却：每群一张图只跟一次，且有全局每群冷却
const followCooldown = new Map<string, number>();
// 已跟过的 contentHash（带上群键），防止同一张图反复触发
const followedHashes = new Set<string>();

/**
 * [2026-11-17] 跟图 +1：群里有人发了某张表情包，短时间内**别人**也发了同一张，
 * 机器人就跟一张一样的（像群友接龙）。
 *
 * 用户要求："只要在群里有任何人同时发送了同一个表情包，机器人就跟着发一个一样的，
 *           类似 +1 的功能，注意只发一次"
 *
 * 关键约束：
 *   - 只发一次：同一张图在同一群只跟一次（followedHashes），外加每群冷却
 *   - 不跟自己的：发送者是自己不算
 *   - 必须是同一张（按内容哈希，不是按 URL）
 *   - 不 @ 人，纯跟图
 */
async function maybeFollowSameSticker(peerKey: string): Promise<void> {
  const fs2 = config.groupSticker?.followSameSticker;
  if (!fs2?.enabled) return;
  // 只在群聊
  if (!peerKey.startsWith('group:')) return;

  try {
    const groupKey = peerKey;
    const now = Date.now();
    // 每群跟图冷却
    const last = followCooldown.get(groupKey) ?? 0;
    if (now - last < Math.max(0, Number(fs2.followCooldownSecPerGroup ?? 600)) * 1000) return;

    // 找本群在时间窗口内"同一张图被不同人重复发送"的记录
    const cutoffIso = new Date(now - Math.max(10, Number(fs2.followWindowSec ?? 120)) * 1000).toISOString();
    const rows = chatStore.repeatedImagesInPeer(groupKey, cutoffIso, 10);
    for (const row of rows) {
      if (!row.contentHash || row.userId === selfUin) continue;
      const mark = `${groupKey}:${row.contentHash}`;
      if (followedHashes.has(mark)) continue;   // 这张图在本群已经跟过 → 只发一次
      if (!row.localPath || !fs.existsSync(row.localPath)) continue;

      const buf = fs.readFileSync(row.localPath);
      const b64 = `base64://${buf.toString('base64')}`;
      // [2026-11-18 修复] 原来错用了 sendGroup()——那是发**纯文本**的接口，
      // 结果把 "base64://xxx" 这串当文字发到群里（用户实测）。
      // 发图必须用 sendGroupImage()，它会组装成 image 消息段。
      const res = await client.sendGroupImage(String(groupKey.slice(6)), b64);
      if (res.status === 'ok') {
        followedHashes.add(mark);
        followCooldown.set(groupKey, now);
        appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
          ts: new Date().toISOString(), peerKey: groupKey, kind: 'follow-same-sticker',
          text: `[跟图+1] hash=${row.contentHash}`,
          status: res.status, retcode: res.retcode,
        });
        say('info', '跟图 +1 已发送', { group: groupKey, hash: row.contentHash });
      } else {
        say('warn', '跟图 +1 发送失败', { status: res.status, retcode: res.retcode });
      }
      return;   // 一次只跟一张
    }
  } catch (e) {
    say('warn', '跟图判断异常', { message: (e as Error).message });
  }
}

// 当前生效的"学到的聊天习惯"，由定期分析更新
let learnedProfile: LearnedProfile | null = null;
function loadLearnedProfile(): void {
  try {
    const p = path.join(LEARNED_DIR, 'profile.json');
    if (fs.existsSync(p)) learnedProfile = JSON.parse(fs.readFileSync(p, 'utf8')) as LearnedProfile;
  } catch { learnedProfile = null; }
}
loadLearnedProfile();
const replyTimes = new Map<string, number[]>();
// [2026-11-16] 各会话最近几条回复原文（供口癖连续出现闸门判断"连续用同一口癖收尾"）
const recentReplyTails = new Map<string, string[]>();

// [2026-11-13] 私密模式状态（进程内，重启即复位）。
// 只对"主人 + 私聊"生效；键是私聊会话的 peerKey。
// 为什么内存态而不是配置文件：私密模式是临时会话状态，重启后自动回到普通模式更安全，
// 避免出现"重启后悄悄还是私密模式"的情况。
export const secretModePeers = new Set<string>();

// [2026-11-16] 世界书注入的 main.ts 侧包装：
// - recentTexts 从 chatStore 取同会话最近消息（全量收集在 route() 之前，群里
//   未 @ 机器人的消息也在，能承接"上一条别人发梗、这一条才 @ 问"的场景）；
// - 排除机器人自己发的消息（自己说的内容不需要再注入）。
const WORLDBOOK_SCAN_POOL = 40;
const worldbookSection = (input: { text: string; peerKey: string; recentTexts: string[] }): Promise<string> => {
  const wb = resolveWorldbookConfig(config.worldbook);
  const recents = chatStore.recentMessages(WORLDBOOK_SCAN_POOL)
    .filter((m) => m.peerKey === input.peerKey && String(m.userId) !== String(selfUin))
    .slice(0, Math.max(0, wb.scanDepth - 1))
    .map((m) => String(m.text ?? ''))
    .filter((t) => t.trim() !== '' && !t.startsWith('[image]'));
  return worldbook.section({ ...input, recentTexts: recents });
};

// [2026-11-16] engine 改 let + 热重载后重建：createReplyEngine 的 config 是
// 构造时捕获的引用，reloadConfigIfChanged 替换 config 对象后旧 engine 仍读旧值
// （人设/技能热重载实际失效的隐性 bug）。重建让引擎每次拿到最新配置。
let engine = createReplyEngine(config, { worldbookSection });

const client = new OneBotClient({
  wsUrl: config.onebot.wsUrl,
  httpUrl: config.onebot.httpUrl,
  token: config.onebot.token,
  timeoutMs: config.onebot.timeoutMs,
  logDir: LOG_DIR,
  onConnection: (connected, detail) => {
    say(connected ? 'info' : 'warn', `OneBot WS ${connected ? '已连接' : '已断开'}`, { detail });
    monitor.noteWsState(connected);
  },
  onEvent: (ev) => { void handleEvent(ev); },
});

const monitor = new Monitor({
  heartbeatMs: config.monitor.heartbeatMs,
  probeEveryN: config.monitor.probeEveryN,
  offlineAlertMin: config.monitor.offlineAlertMin,
  stateDir: STATE_DIR,
  onOfflineAlert: async (since, detail) => {
    say('error', 'QQ 持续离线，已记录告警', { offlineSince: new Date(since).toISOString(), detail });
  },
});

function rateLimited(peerKey: string): boolean {
  const now = Date.now();
  const arr = (replyTimes.get(peerKey) ?? []).filter(t => now - t < 60000);
  if (arr.length >= config.behavior.rateLimitPerPeerPerMin) { replyTimes.set(peerKey, arr); return true; }
  arr.push(now);
  replyTimes.set(peerKey, arr);
  return false;
}

// [2026-11-12] 全量收集：在"路由判定之前"执行。
// 关键：群聊里绝大多数消息没 @ 机器人，会被 route() 直接丢弃；
// 但学习"人怎么聊天"恰恰需要这些普通聊天，所以收集必须早于路由过滤。
function collectMessage(ev: any): { pendingStickers: string[]; peerKey: string; userId: string } {
  const rawSegs: Array<{ type: string; data: Record<string, unknown> }> =
    Array.isArray(ev?.message) ? ev.message : [];
  const imgUrls: string[] = [];
  let text = '';
  let hasFace = false;
  for (const seg of rawSegs) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') text += String(seg.data?.text ?? '');
    else if (seg.type === 'image' || seg.type === 'mface') {
      const u = String(seg.data?.url ?? seg.data?.file ?? seg.data?.emoji_id ?? '');
      if (u) imgUrls.push(u);
      hasFace = hasFace || seg.type === 'mface';
      text += seg.type === 'mface' ? '[mface]' : '[image]';
    } else if (seg.type === 'face') { hasFace = true; text += '[face]'; }
  }
  if (typeof ev?.message === 'string' && text === '') text = ev.message;

  const kind = ev.message_type === 'group' ? 'group' : 'private';
  const groupId = ev.group_id ? String(ev.group_id) : undefined;
  const userId = String(ev.user_id ?? '');
  const peerKey = kind === 'group' ? `group:${groupId}` : `private:${userId}`;
  const isSticker = hasFace || imgUrls.some((u) => looksLikeSticker(u, text));
  // [2026-11-13] 命令标记：# 技能触发、/ 管理命令都算，学习时完全排除
  const trimmed = text.trim();
  const isCommand = /^[/／#＃]/.test(trimmed);
  const nickname = ev.sender?.card || ev.sender?.nickname || userId;
  const ts = new Date().toISOString();

  try {
    chatStore.addMessage({
      ts, peerKey, kind, userId, nickname,
      text: text.trim(),
      images: imgUrls,
      isSticker,
      isCommand,
    });
  } catch (e) {
    say('error', '收集消息失败', { message: (e as Error).message });
  }

  // [2026-11-16] 架构调整（用户要求：先收集、后整理）：
  //   以前是"收到就当场判定是不是表情包，不是就丢"，一旦 AI 超时/误判，数据直接丢失；
  //   而且只存 URL，QQ 图床约 1 天后失效（曾导致 13 条记录永久不可恢复）。
  //   现在：**所有媒体都先登记 + 立刻下载原件落盘**，不做任何判断。
  //   是不是表情包、属于什么含义，交给定时任务慢慢整理（见 organizeMedia）。
  const mediaIds: number[] = [];
  for (const u of imgUrls) {
    try {
      const id = chatStore.addMedia({ ts, peerKey, userId, nickname, url: u });
      mediaIds.push(id);
    } catch (e) {
      say('warn', '登记媒体失败', { message: (e as Error).message });
    }
  }
  // 立即异步下载（不阻塞消息处理）
  if (mediaIds.length > 0) {
    for (const id of mediaIds) void downloadMediaById(id);
  }

  return { mediaIds, peerKey, userId };
}

// [2026-11-12] 后台分析新收集到的表情包：视觉识别 -> 分类 -> 落库 + 存本地
// 串行执行，避免并发打爆视觉接口。
let stickerQueue: Promise<void> = Promise.resolve();

// [2026-11-16] 已移除 judgeStickerCandidate（原"收到即判定、判定不过就丢"的闸门）。
// 原因：该设计有两个硬伤——
//   1. 判定依赖 QQ 图床链接，链接约 1 天后失效，一旦当时没判成，数据永久丢失；
//   2. AI 超时按"宁缺勿滥"直接丢弃，实测丢失多张真表情包（日志中 5 次 AI 判定失败）。
// 现改为：收到即落盘（media 表），判定与分类交给定时任务 organizeMedia 慢慢做，
// 判定所需图片从本地文件读取，不再受链接有效期影响。

function enqueueStickerAnalysis(urls: string[]): void {
  if (!VISION.apiKey || urls.length === 0) return;
  for (const url of urls) {
    stickerQueue = stickerQueue.then(() => analyzeStickerNow(url));
  }
}

/**
 * [2026-11-13] 单张表情包的完整分析流程（从原 enqueueStickerAnalysis 抽出）。
 * 前提：图片已通过闸门并入库。这里只做识别/分类/去重/落盘。
 */
// [2026-11-16] 分析失败计数：同一张图最多重试 N 次，避免死循环打爆视觉接口
const analyzeFailCount = new Map<string, number>();
const MAX_ANALYZE_RETRY = 3;

async function analyzeStickerNow(url: string): Promise<void> {
  try {
    // 跳过已分析的
    const pending = chatStore.unanalyzedStickers(500).map((x) => x.url);
    if (!pending.includes(url)) return;
    say('info', '开始分析表情包', { url: url.slice(0, 80) });
    // 第一阶段：不下结论，只客观描述画面（含全部文字），用于匹配梗库
    const probe = await fetchAndAnalyzeSticker(url, VISION, '这一阶段请只客观描述画面与所有文字，不要判断情绪和分类。');
    // 第二(knowledge)阶段：用梗库匹配结果作为事实，重新分析
    const hits = memeLib.match(probe.description ?? '');
    const knownMemeText = memesPromptSection(hits);
    // [2026-11-16 修复] analyzeSticker() 的返回**不含 bytes**（只有 fetchAndAnalyzeSticker 会合并 bytes）。
    // 原来写成 `const r = knownMemeText ? await analyzeSticker(...) : probe`，
    // 一旦梗库命中，r 就只有 StickerAnalysis 没有 bytes，后面 Buffer.from(r.bytes) 抛
    // "The first argument must be of type string...Received undefined"，整条分析中断。
    // 实测 2026-11-13 共 5 次失败，全部发生在"梗库命中"之后（命中日志与失败日志时间戳一一对应）。
    // 现在把分析结果和原始字节分开保存，bytes 始终来自 probe。
    const analysis = knownMemeText
      ? await analyzeSticker(probe.bytes, VISION, '', knownMemeText)
      : probe;
    const bytes = probe.bytes;
    const r = { ...analysis, bytes };
    if (hits.length > 0) {
      say('info', `梗库命中：${hits.map((h) => h.name).join('、')}`, { url: url.slice(0, 50) });
    }
    // [2026-11-12] 按内容哈希去重：同一张图 QQ 每次发会生成不同 URL，
    // 若已有相同内容的已分析记录，直接沿用它的人工纠正结果
    const contentHash = createHash('sha256').update(Buffer.from(r.bytes)).digest('hex').slice(0, 16);
    const knownByHash = chatStore.findStickerByHash(contentHash);
    if (knownByHash?.analyzed) {
      chatStore.saveStickerAnalysis(url, {
        description: knownByHash.description ?? '', emotion: knownByHash.emotion ?? '',
        category: knownByHash.category ?? '', occasion: knownByHash.occasion ?? '',
        animated: knownByHash.animated === 1, format: knownByHash.format ?? '',
        localPath: knownByHash.localPath, contentHash,
      });
      say('info', `表情包内容重复，沿用已有分类：${knownByHash.category}`, { hash: contentHash });
      return;
    }
    const localPath = saveSticker(STICKER_DIR, url, r.bytes, r.category);
    chatStore.saveStickerAnalysis(url, {
      description: r.description, emotion: r.emotion, category: r.category,
      occasion: r.occasion, animated: r.animated, format: r.format, localPath,
    });
    say('info', `表情包分析完成：${r.category}`, {
      desc: r.description.slice(0, 40), animated: r.animated,
    });
  } catch (e) {
    // [2026-11-16] 累计失败次数，供定时重试判断是否还要再试
    const n = (analyzeFailCount.get(url) ?? 0) + 1;
    analyzeFailCount.set(url, n);
    say('warn', '表情包分析失败', {
      url: url.slice(0, 60), message: (e as Error).message, attempt: n, willRetry: n < MAX_ANALYZE_RETRY,
    });
  }
}

/**
 * [2026-11-16] 重试"卡在未分析"的表情包。
 *
 * 为什么需要：分析失败后记录会永久停留在 analyzed=0，既不能用也查不出原因。
 * 失败原因有两类：
 *   - 代码 bug（梗库命中时 bytes 丢失）—— 已修复
 *   - 网络超时（QQ 图床不稳）—— 偶发，重试通常能成功
 * 这里定期把还没分析、且失败次数未超上限的记录重新跑一遍。
 */
function retryUnanalyzedStickers(): void {
  try {
    const pending = chatStore.unanalyzedStickers(20);
    if (pending.length === 0) return;
    const retryable = pending.filter((x) => (analyzeFailCount.get(x.url) ?? 0) < MAX_ANALYZE_RETRY);
    if (retryable.length === 0) return;
    say('info', `重试未分析的表情包 ${retryable.length} 个`);
    for (const rec of retryable) {
      stickerQueue = stickerQueue.then(() => analyzeStickerNow(rec.url));
    }
  } catch (e) {
    say('warn', '重试未分析表情包失败', { message: (e as Error).message });
  }
}

// [2026-11-12] 群聊随机表情包：没人找机器人说话时，以极低概率跟一个表情包（不发文字）
const groupStickerCooldown = new Map<string, number>();
// [2026-11-17] 文字分支用独立冷却：否则表情包分支刚冷却完，文字分支又被同一时间戳拦住，
// 或者反过来——两个分支各自冷却，互不影响。
const groupChimeCooldown = new Map<string, number>();

/**
 * 判定是否要"凑个热闹"发个表情包。
 * 规则（按用户要求）：
 *   - 只在群聊
 *   - 只在**没有 @ 机器人**的消息后（没人跟它说话）
 *   - [2026-11-17] 两个独立分支（用户要求）：
 *       表情包分支：probability（默认 20%）→ 发一张表情包
 *       文字分支：  textProbability（默认 10%）→ 主动接一句话/加个评论
 *     先判表情包；表情包没命中再判文字，保证**一次事件最多触发一个**，不会既发图又说话。
 *   - 每个群有冷却，避免连续刷屏
 */
/**
 * [2026-11-18] 按"群友发送频率"加权挑一张表情包。
 *
 * 逻辑：
 *   1. 取本群最近 windowDays 天内的发送记录，按 contentHash 统计次数与不同发送人数
 *   2. 给每张图算权重（对数曲线，封顶 maxWeight）
 *   3. 以权重做加权随机；高频图更容易中，但低频图仍有机会
 *   4. 库里存在但本群没人发过的图，给基础权重 1，保证多样性
 *
 * 返回 null 表示"没有可用加权结果，请调用方退回原来的随机逻辑"。
 */
function pickStickerByFrequency(groupKey: string, categories: string[]): StickerRecord | null {
  const fw = config.groupSticker?.frequencyWeight;
  if (!fw?.enabled) return null;

  const windowDays = Math.max(1, Number(fw.windowDays ?? 30));
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();

  // 本群高频统计
  const freqs = chatStore.stickerFrequencyInPeer(groupKey, sinceIso, 200);
  const weightMap = new Map<string, number>();
  for (const f of freqs) {
    weightMap.set(f.contentHash, weightFor(f.senders, f.count));
  }

  // 候选池：库里有本地文件、且未被判为非表情包的图
  let pool = chatStore.allStickers(500).filter(
    (x) => x.localPath && fs.existsSync(x.localPath) && x.verdict !== 'rejected',
  );
  if (categories.length > 0) {
    const filtered = pool.filter((x) => categories.includes(x.category ?? ''));
    if (filtered.length > 0) pool = filtered;
  }
  if (pool.length === 0) return null;

  // 每张图的权重：有统计的用统计权重，没统计过的用基础权重 1
  const weights = pool.map((rec) => {
    const hash = rec.contentHash ?? fileContentHash(rec.localPath!);
    const w = hash ? weightMap.get(hash) : undefined;
    return w ?? 1;
  });

  const chosen = pickWeighted(pool, weights);
  if (chosen) {
    const hideas = weightMap.size;
    say('info', '按频率权重挑选表情包', {
      group: groupKey,
      poolSize: pool.length,
      withStats: hideas,
      weight: weights[pool.indexOf(chosen)]?.toFixed(2),
      category: chosen.category ?? '',
    });
  }
  return chosen;
}

/**
 * [2026-11-17] 文字分支：没人 @ 机器人时，主动接一句话/加个评论。
 *
 * 用户要求："可以在没有人艾特的时候主动回复或者发表评论"
 *
 * 与正常回复的区别：
 *   - 不 @ 任何人（它是在插话，不是在回答谁）
 *   - 提示词明确要求"接一句/加个评论"，避免变成对话应答
 *   - 有独立冷却，且不写进对话历史（避免污染后续上下文、也避免模型以为自己在对话）
 */
async function sendGroupChimeIn(rawEv: any, groupKey: string, now: number): Promise<void> {
  const gs = config.groupSticker;
  // 独立冷却（默认与表情包同为 600s，可用 textCooldownSecPerGroup 单独调）
  const cdSec = Number(gs.textCooldownSecPerGroup ?? gs.cooldownSecPerGroup ?? 600);
  const last = groupChimeCooldown.get(groupKey) ?? 0;
  if (now - last < Math.max(0, cdSec) * 1000) return;

  // [2026-11-19] 改从 chatStore 取真实群聊历史（内存 history 只在被 @ 时才写入，几乎总是空的）。
  // 用户要求：至少 10 条上下文，且要包含图片信息——否则只看最后一条会"不知所云"。
  const CTX_SIZE = 12;  // 取 12 条，确保 >= 10
  let ctxLines: string[] = [];
  let recent: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let hasImageInCtx = false;
  try {
    const rows = chatStore.recentMessagesInPeer(groupKey, CTX_SIZE);
    // 只保留有内容的消息，按时间正序拼成对话行
    const ordered = rows.slice().reverse();
    ctxLines = ordered.map((r) => {
      const who = r.nickname || r.userId || '群友';
      let line = `${who}: ${r.text && r.text.trim() ? r.text.trim() : '（发了一条消息）'}`;
      if (r.hasImage) {
        hasImageInCtx = true;
        // 有图片描述就带上，让模型真的"看到"图里是什么
        const desc = r.imageDescriptions[0];
        line += desc ? ` [图片：${desc}]` : ' [图片]';
      }
      return line;
    });
    recent = ordered.map((r) => ({
      role: 'user' as const,
      text: r.hasImage ? `${r.text || ''} [图片]`.trim() : (r.text || ''),
    }));
  } catch (e) {
    say('warn', '取群聊上下文失败，退回内存历史', { message: (e as Error).message });
    recent = (history.get(groupKey) ?? []).slice(-12);
  }

  const speaker = rawEv.sender?.card || rawEv.sender?.nickname || String(rawEv.user_id ?? '');
  const said = String(rawEv.raw_message ?? rawEv.message ?? '').slice(0, 200);
  // 上下文不足时降低插话质量预期：明确告诉模型"信息不够就别硬接"
  const enoughCtx = ctxLines.length >= 10;
  const prompt = [
    '【当前情境】群里正在进行一段对话，没有任何人在和机器人说话。',
    '你可以自然地插一句嘴：接个话茬、补一句吐槽、或者对刚才的发言加个评论。',
    '',
    '要求：',
    '  不要 @ 任何人；不要写成"回答提问"的语气；不要打招呼开场；',
    '  一句话就够，十几到三十几个字，口语化，像群友随口接话；',
    '  **先读懂下面的对话脉络再决定说什么**，不要只根据最后一句就接，容易答非所问；',
    hasImageInCtx
      ? '  对话里有图片，方括号里是图片内容的客观描述，可以据此理解大家在聊什么。'
      : '',
    enoughCtx
      ? '  如果话题实在接不上，就说一句与本群氛围相符的短感想。'
      : '  对话信息很少，如果实在不知道在聊什么，就说一句与本群氛围相符的短感想，不要硬猜。',
    '',
    ctxLines.length > 0 ? `【最近的群聊记录（按时间顺序，共 ${ctxLines.length} 条）】\n${ctxLines.join('\n')}` : '',
    '',
    `最新一条是 ${speaker} 说的：${said}`,
    '请只输出你要发到群里的那一句话。',
  ].filter(Boolean).join('\n');
  say('info', '凑热闹上下文已准备', {
    group: groupKey, ctxCount: ctxLines.length, hasImage: hasImageInCtx, enough: enoughCtx,
  });

  try {
    // 复用回复引擎，但用一个独立的临时会话键，避免污染正式对话历史
    const fakeMsg = {
      id: `chime-${Date.now()}`,
      peerKey: groupKey,
      kind: 'group' as const,
      userId: String(rawEv.user_id ?? ''),
      groupId: String(rawEv.group_id ?? ''),
      nickname: speaker,
      text: prompt,
      atSelf: false, atAll: false, isSelf: false, isAdmin: true,
      raw: {} as any,
    };
    const reply = await engine.reply(fakeMsg, recent);
    if (!reply || !reply.trim()) {
      say('info', '文字凑热闹生成结果为空，跳过');
      return;
    }
    // 清掉可能出现的 emoji（与回复策略一致），并限长
    let text = hasEmoji(reply) ? stripEmoji(reply) : reply.trim();
    if (!hasMeaningfulText(text)) { say('info', '文字凑热闹剔除后为空，跳过'); return; }
    text = text.replace(/^@\S+\s*/, '').trim();
    if (text.length > 80) text = text.slice(0, 80);
    // 不 @ 任何人：这是插话不是应答
    const res = await client.sendGroup(String(rawEv.group_id), text);
    groupChimeCooldown.set(groupKey, now);
    appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
      ts: new Date().toISOString(), peerKey: groupKey, kind: 'chime-in',
      text, status: res.status, retcode: res.retcode,
    });
    say(res.status === 'ok' ? 'info' : 'warn', `主动插话已发送`, {
      group: rawEv.group_id, text: text.slice(0, 60), status: res.status,
    });
  } catch (e) {
    say('warn', '主动插话失败', { message: (e as Error).message });
  }
}

async function maybeSendGroupSticker(rawEv: any): Promise<void> {
  const gs = config.groupSticker;
  if (!gs?.enabled) return;
  if (rawEv?.message_type !== 'group') return;
  // 自己发的不算
  if (String(rawEv?.user_id ?? '') === selfUin) return;

  // 只有没人叫它时才凑热闹
  if (gs.onlyWhenIgnored) {
    const segs = Array.isArray(rawEv?.message) ? rawEv.message : [];
    const mentioned = segs.some((sg: any) => sg?.type === 'at' && String(sg.data?.qq ?? '') === selfUin);
    const raw = String(rawEv?.raw_message ?? '');
    if (mentioned || (selfUin && raw.includes(`[CQ:at,qq=${selfUin}]`))) return;
  }

  const groupKey = `group:${rawEv.group_id}`;
  const now = Date.now();
  const last = groupStickerCooldown.get(groupKey) ?? 0;
  if (now - last < Math.max(0, Number(gs.cooldownSecPerGroup ?? 600)) * 1000) return;

  const prob = Math.max(0, Math.min(1, Number(gs.probability ?? 0.2)));
  const textProb = Math.max(0, Math.min(1, Number(gs.textProbability ?? 0.1)));
  // 先判表情包分支；没命中再判文字分支。两个都不命中就直接返回。
  const wantSticker = Math.random() < prob;
  if (!wantSticker) {
    if (Math.random() < textProb) {
      await sendGroupChimeIn(rawEv, groupKey, now);
    }
    return;
  }

  const categories = Array.isArray(gs.categories) ? gs.categories : [];
  let pick = null;
  try {
    // [2026-11-18] 频率加权：先按本群最近 N 天的高频表情包算权重，再加权随机挑
    const weighted = pickStickerByFrequency(groupKey, categories);
    if (weighted) {
      pick = weighted;
    } else if (categories.length > 0) {
      pick = chatStore.randomSticker(categories[Math.floor(Math.random() * categories.length)]);
    } else {
      pick = chatStore.randomSticker();
    }
  } catch (e) {
    say('warn', '取随机表情包失败', { message: (e as Error).message });
    return;
  }
  if (!pick?.localPath) {
    say('info', '概率命中但表情包库为空，跳过');
    return;
  }

  try {
    // 从本地文件读成 base64 发送（表情包在本地，避免网络问题）
    const buf = fs.readFileSync(pick.localPath);
    const b64 = `base64://${buf.toString('base64')}`;
    const res = await client.sendGroupImage(String(rawEv.group_id), b64);
    groupStickerCooldown.set(groupKey, now);
    appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
      ts: new Date().toISOString(), peerKey: groupKey, kind: 'sticker-auto',
      text: `[表情包] ${pick.category ?? ''} ${pick.description?.slice(0, 30) ?? ''}`,
      status: res.status, retcode: res.retcode,
    });
    say(res.status === 'ok' ? 'info' : 'warn', `随机表情包已发送（${pick.category ?? '未分类'}）`, {
      group: rawEv.group_id, prob, status: res.status,
    });
  } catch (e) {
    say('warn', '随机表情包发送失败', { message: (e as Error).message });
  }
}

async function handleEvent(ev: Parameters<OneBotClient['constructor']> extends never ? never : any): Promise<void> {
  // [2026-11-12] 每条消息都检查配置是否变更，确保改完立即生效
  reloadConfigIfChanged();
  if (ev.post_type === 'meta_event') {
    if (ev.meta_event_type === 'heartbeat') {
      const st = ev.status as { online?: boolean } | undefined;
      if (st && typeof st.online === 'boolean') monitor.noteWsState(true);
    }
    return;
  }
  if (ev.post_type !== 'message') return;

  // [2026-11-12] 先收集再加路由过滤：群里未 @ 的普通聊天也是学习样本
  if (!config.behavior.ignoreSelfMessages || String(ev.user_id ?? '') !== selfUin) {
    // [2026-11-16] 收集即在内部完成登记与下载，这里不再需要额外处理
    collectMessage(ev);
  }

  const msg = route(ev, config, selfUin);
  if (!msg) {
    // [2026-11-12] 没人找它说话时的"凑热闹"机会
    void maybeSendGroupSticker(ev);
    return;
  }

  // 收到消息本身即证明在线：刷新在线状态，避免心跳间隔内误判
  monitor.noteWsState(true);

  const clipped = msg.text.length > 500 ? msg.text.slice(0, 500) + '…' : msg.text;
  appendJsonl(path.join(STATE_DIR, 'inbox.jsonl'), {
    ts: new Date().toISOString(), id: msg.id, peerKey: msg.peerKey,
    userId: msg.userId, groupId: msg.groupId, nickname: msg.nickname, text: clipped, atSelf: msg.atSelf,
  });
  say('info', `收到消息 ${msg.peerKey}`, { from: msg.nickname, text: clipped.slice(0, 120) });

  if (rateLimited(msg.peerKey)) {
    say('warn', `会话 ${msg.peerKey} 触发限流，跳过回复`);
    return;
  }

  // [2026-11-13] 私密模式判定：只有主人 + 私聊 + 已开启才算。
  // 三重条件写在代码里，模型无法绕过，也不会因为群里有人冒充主人而触发。
  const inSecretMode = msg.kind === 'private'
    && isOwner(config, msg.userId)
    && secretModePeers.has(msg.peerKey);
  // 历史按模式隔离：私密与普通各用一条独立历史，避免两种语气互相污染
  const historyKey = inSecretMode ? `${msg.peerKey}#secret` : msg.peerKey;
  const peerHistory = history.get(historyKey) ?? [];
  const cleanText = msg.kind === 'group' ? stripMention(msg.text, selfUin) : msg.text;
  const ctxMsg: InboundMessage = { ...msg, text: cleanText };

  // [2026-11-12] 静默窗口：/silence N 生效期间除了开静默的主管本人，其他消息一律忽略
  const silenceUntil = config.behavior.silenceUntil ?? 0;
  if (silenceUntil > Date.now() && !isOwner(config, msg.userId)) {
    say('info', `静默中，忽略 ${msg.peerKey} 的消息`);
    return;
  }

  // [2026-11-12] 命令优先于模型：命中命令直接执行并返回，不进入对话历史
  const cmdOut = await handleCommand(cleanText, cmdCtx, msg);
  if (cmdOut !== null) {
    const text = cmdOut.join('\n');
    appendJsonl(path.join(LOG_DIR, `${todayStamp()}.jsonl`), {
      ts: new Date().toISOString(), kind: 'command', peerKey: msg.peerKey, userId: msg.userId,
      input: cleanText, output: text,
    });
    await deliverCmd(msg, text);
    return;
  }

  // [2026-11-12] #help：列出所有可用技能（面向所有人，不做权限限制）
  if (isHelpRequest(cleanText)) {
    const help = renderSkillHelp(config);
    appendJsonl(path.join(LOG_DIR, `${todayStamp()}.jsonl`), {
      ts: new Date().toISOString(), kind: 'skill-help', peerKey: msg.peerKey, output: help,
    });
    await deliverCmd(msg, help);
    return;
  }

  // [2026-11-12] 取图类技能（type=e621）：先匹配，命中就直接抓图发送，不走模型
  const imgHit = matchSkill(cleanText, config, msg.peerKey);
  if (imgHit && imgHit.skill.type === 'e621') {
    await handleE621Skill(msg, imgHit.skill as { name: string; e621?: { scale?: string; date?: string; preference?: string } });
    return;
  }
  // [2026-11-13] 新闻类技能
  if (imgHit && imgHit.skill.type === 'news') {
    await handleNewsSkill(msg, imgHit.skill as { name: string; news?: { maxAgeHours?: number; requireImage?: boolean } });
    return;
  }

  // [2026-11-12] 取该会话最近发过的图作为上下文，便于回答"这图里是什么"
  let recentImages: ReturnType<typeof imageStore.recent> = [];
  try {
    recentImages = imageStore.recent(msg.peerKey, 3);
  } catch (e) {
    say('error', '读取图片库失败', { message: (e as Error).message });
  }

  // [2026-11-12] 对方刚发的图片：优先用已分析的结果；没有就现场分析一次（让模型"看到"图）
  let incomingInfos: Array<{ description: string; emotion: string; category: string; occasion?: string; animated?: boolean }> = [];
  try {
    const rawSegs = (msg.raw?.message as Array<{ type: string; data: Record<string, unknown> }> | undefined) ?? [];
    const urls: string[] = [];
    for (const seg of Array.isArray(rawSegs) ? rawSegs : []) {
      if (seg?.type === 'image' || seg?.type === 'mface') {
        const u = String(seg.data?.url ?? seg.data?.file ?? '');
        if (u && /^https?:/.test(u)) urls.push(u);
      }
    }
    if (urls.length > 0 && VISION.apiKey) {
      const analyzed = new Map(chatStore.unanalyzedStickers(500).map((x) => [x.url, x]));
      for (const u of urls.slice(0, 2)) {
        // 已分析过就直接用库里的
        const known = chatStore.topStickers(500).find((x) => x.url === u && x.analyzed);
        if (known) {
          incomingInfos.push({
            description: known.description ?? '', emotion: known.emotion ?? '',
            category: known.category ?? '', animated: known.animated === 1,
          });
          continue;
        }
        // 未分析：现场分析（最多等 30 秒）
        try {
          const r = await fetchAndAnalyzeSticker(u, VISION);
          const localPath = saveSticker(STICKER_DIR, u, r.bytes, r.category);
          chatStore.saveStickerAnalysis(u, {
            description: r.description, emotion: r.emotion, category: r.category,
            occasion: r.occasion, animated: r.animated, format: r.format, localPath,
          });
          incomingInfos.push({
            description: r.description, emotion: r.emotion,
            category: r.category, occasion: r.occasion, animated: r.animated,
          });
          say('info', `现场识别对方图片：${r.category}`, { desc: r.description.slice(0, 40) });
        } catch (e) {
          say('warn', '现场识别图片失败', { message: (e as Error).message });
        }
      }
      void analyzed;
    }
  } catch (e) {
    say('warn', '处理对方图片出错', { message: (e as Error).message });
  }

  const hered = await engine.reply(
    ctxMsg, peerHistory, recentImages,
    // 私密模式不注入普通模式的学习画像（对外聊天习惯不该污染私密口吻）
    inSecretMode ? '' : profilePromptSection(learnedProfile),
    incomingInfos,
    { secret: inSecretMode },
  );

  if (!hered) { queueMessage(msg); return; }
  // [2026-11-16] 口癖连续出现闸门：最近 2 条回复都用同一口癖收尾时，剥离本条尾缀。
  // （画像注入口头禅后模型句句模仿，提示词约束压不住，按纪律加代码级闸门。）
  const heredFinal = stripRepeatedTailPhrase(
    hered,
    (learnedProfile?.catchphrases ?? []).map(String),
    recentReplyTails.get(historyKey) ?? [],
  );
  {
    const tails = recentReplyTails.get(historyKey) ?? [];
    tails.unshift(hered);
    recentReplyTails.set(historyKey, tails.slice(0, 4));
  }
  await deliver(msg, heredFinal, peerHistory, historyKey, inSecretMode);
}

function queueMessage(msg: InboundMessage): void {
  // 离线或以 off 模式运行：把消息存进队列，恢复在线后再补答
  writeJsonAtomic(path.join(QUEUE_DIR, `${Date.now()}-${msg.id.replace(/[^\w-]/g, '_')}.json`), {
    peerKey: msg.peerKey, kind: msg.kind, userId: msg.userId, groupId: msg.groupId,
    nickname: msg.nickname, text: msg.text, ts: Date.now(),
  });
  say('info', `已入队（离线积压）${msg.peerKey}`);
}

/**
 * [2026-11-16] 为一条回复挑选要搭配的表情包。
 *
 * 规则：
 *   - 配置关闭 / 概率没命中 -> 返回 null（不配图）
 *   - 优先按回复情绪推断分类，在该分类里随机取一张
 *   - 该分类没有可用图 -> 退回到全库随机
 *   - 整条回复只有 emoji（emojiOnlyReply=true）时必定配图，否则用户什么都收不到
 *   - 只挑有本地文件、且经过 AI 闸门确认是表情包的记录（verdict 不是 rejected）
 */
function pickReplySticker(text: string, emojiOnly: boolean): StickerRecord | null {
  const rs = config.replySticker;
  if (!rs?.enabled) return null;
  // emoji-only：必须配图；否则按概率
  if (!emojiOnly && !rollChance(Number(rs.probability ?? 0.1))) return null;

  const usable = (rec: StickerRecord | null): StickerRecord | null =>
    rec && rec.localPath && fs.existsSync(rec.localPath) && rec.verdict !== 'rejected' ? rec : null;

  try {
    // 1) 按情绪分类挑
    if (rs.byCategory !== false) {
      const cat = suggestStickerCategory(text);
      if (cat) {
        const byCat = usable(chatStore.randomSticker(cat));
        if (byCat) return byCat;
      }
    }
    // 2) 全库随机（最多试几次，跳过文件缺失/被判定为非表情包的记录）
    for (let i = 0; i < 5; i++) {
      const any = usable(chatStore.randomSticker());
      if (any) return any;
    }
  } catch (e) {
    say('warn', '挑选表情包失败', { message: (e as Error).message });
  }
  return null;
}

async function deliver(
  msg: InboundMessage,
  reply: string,
  peerHistory: Array<{ role: 'user' | 'assistant'; text: string }>,
  historyKey: string = msg.peerKey,
  secretMode = false,
): Promise<void> {
  // [2026-11-16] 回复是否只有 emoji（剔除后没有文字内容）
  let emojiOnlyReply = false;
  let text = (config.behavior.replyPrefix ?? '') + reply;

  // [2026-11-16] 按用户要求：回复里禁止出现 emoji，用表情包代替表情。
  // 放在截断之前做，避免 emoji 占掉字数配额。
  const rs = config.replySticker;
  if (rs?.stripEmoji !== false && hasEmoji(text)) {
    const hadEmoji = text;
    const cleaned = stripEmoji(text);
    if (hasMeaningfulText(cleaned)) {
      say('info', '已从回复中剔除 emoji', {
        peer: msg.peerKey, before: hadEmoji.slice(0, 60), after: cleaned.slice(0, 60),
      });
      text = cleaned;
    } else {
      // 整句只有 emoji（如 "😂"），剔除后没有内容可发：交给表情包兜底。
      // 这里保留原文本，若后面成功配图则只发图；配图失败也至少不会发空消息。
      emojiOnlyReply = true;
    }
  }

  // [2026-11-13] 私密模式允许更长回复：RP 需要完整段落，长度由提示词里的字数要求控制。
  // secretPersona.maxReplyChars 为 0/未设时不做代码截断；普通模式仍用 behavior.maxReplyChars。
  const secretLimit = Number(config.secretPersona?.maxReplyChars ?? 0);
  const limit = secretMode && secretLimit <= 0 ? 0 : (secretMode ? secretLimit : config.behavior.maxReplyChars);
  if (limit > 0 && text.length > limit) text = text.slice(0, limit) + '…';
  // 群聊回复必须 @ 回提问者，否则看不出在回谁
  if (msg.kind === 'group' && msg.userId) text = `[CQ:at,qq=${msg.userId}] ${text}`;

  // [2026-11-16] 按概率给回复配一个表情包（文字 + 图片同一条消息）
  const sticker = pickReplySticker(text, emojiOnlyReply);

  let r;
  if (sticker?.localPath) {
    try {
      // 从本地文件读成 base64 发送，避免图床链接过期（表情包都在本机）
      const buf = fs.readFileSync(sticker.localPath);
      const b64 = `base64://${buf.toString('base64')}`;
      // emoji-only 且配图成功：只发图，不发那段只剩 emoji 的文字
      const caption = emojiOnlyReply ? '' : text;
      r = msg.kind === 'group'
        ? await client.sendGroupImage(msg.groupId!, b64, caption)
        : await client.sendPrivateImage(msg.userId, b64, caption);
      appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
        ts: new Date().toISOString(), peerKey: msg.peerKey, text: `${text} [表情包:${sticker.category ?? ''}]`,
        status: r?.status, retcode: r?.retcode, replyTo: msg.id, kind: 'reply-with-sticker',
      });
      if (r?.status === 'ok') {
        say('info', `已回复(含表情包) ${msg.peerKey}`, {
          text: text.slice(0, 80), sticker: sticker.category ?? '', desc: (sticker.description ?? '').slice(0, 30),
        });
      } else {
        // 带图发送失败：退回纯文字，不能让消息丢了
        say('warn', '带表情包发送失败，退回纯文字', { retcode: r?.retcode, message: r?.message });
        r = msg.kind === 'group'
          ? await client.sendGroup(msg.groupId!, text)
          : await client.sendPrivate(msg.userId, text);
      }
    } catch (e) {
      say('warn', '表情包附件发送异常，退回纯文字', { message: (e as Error).message });
      r = msg.kind === 'group'
        ? await client.sendGroup(msg.groupId!, text)
        : await client.sendPrivate(msg.userId, text);
    }
  } else {
    r = msg.kind === 'group'
      ? await client.sendGroup(msg.groupId!, text)
      : await client.sendPrivate(msg.userId, text);
  }

  appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
    ts: new Date().toISOString(), peerKey: msg.peerKey, text, status: r.status, retcode: r.retcode, replyTo: msg.id,
  });
  if (r.status === 'ok') {
    say('info', `已回复 ${msg.peerKey}`, { text: text.slice(0, 120) });
    peerHistory.push({ role: 'user', text: msg.text }, { role: 'assistant', text });
    history.set(historyKey, peerHistory.slice(-20));
  } else {
    say('error', `回复失败 ${msg.peerKey}`, { retcode: r.retcode, message: r.message });
    queueMessage(msg);
  }
}

// 命令回复：不走限流、不截断、群聊里 @ 回操作者
async function deliverCmd(msg: InboundMessage, text: string): Promise<void> {
  const body = msg.kind === 'group' && msg.userId ? `[CQ:at,qq=${msg.userId}] ${text}` : text;
  const r = msg.kind === 'group'
    ? await client.sendGroup(msg.groupId!, body)
    : await client.sendPrivate(msg.userId, body);
  appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
    ts: new Date().toISOString(), peerKey: msg.peerKey, text, status: r.status, retcode: r.retcode, kind: 'command',
  });
  say(r.status === 'ok' ? 'info' : 'error', `命令已回复 ${msg.peerKey}`, { text: text.slice(0, 120) });
}

function setAutoReplyMode(mode: string): void {
  config.autoReply.mode = mode as typeof config.autoReply.mode;
  const p = configPath;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    raw.autoReply = { ...(raw.autoReply ?? {}), mode };
    fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    say('info', `回复模式已写入配置：${mode}`);
  } catch (e) {
    say('error', '写入配置失败', { message: (e as Error).message });
  }
}

/**
 * [2026-11-13] /s audit：用 AI 复检**存量**表情包，找出闸门上线前混进来的新闻/截图类。
 *
 * 用法：
 *   /s audit              复检全部存量（串行，AI 慢，图多时要等）
 *   /s audit list         只看上次复检结果里被判"不是表情包"的条目
 *   /s audit del <序号>   删掉第 N 条被判"不是表情包"的记录（含本地文件）
 *
 * 设计：复检只**打标记**（verdict='rejected'），不自动删除——避免 AI 误判直接毁数据。
 * 删除必须由主管二次确认，且是按 list 里的序号显式指定。
 */
async function auditStickers(args: string[]): Promise<string> {
  const sub = (args[0] ?? '').toLowerCase();

  // 删除被判"不是表情包"的记录
  if (sub === 'del') {
    const idx = parseInt(args[1] ?? '', 10);
    const rejected = chatStore.rejectedStickers(200);
    if (rejected.length === 0) return '没有待清理的记录，先发 /s audit 复检。';
    if (!Number.isFinite(idx) || idx < 1 || idx > rejected.length) {
      return `序号超出范围（1~${rejected.length}），先发 /s audit list 看列表。`;
    }
    const target = rejected[idx - 1]!;
    // 先删本地文件，再删记录；文件删不掉不阻碍记录删除
    let fileNote = '';
    try {
      if (target.localPath && fs.existsSync(target.localPath)) {
        fs.unlinkSync(target.localPath);
        fileNote = '，本地文件已删';
      }
    } catch (e) {
      fileNote = `，本地文件删除失败：${(e as Error).message}`;
    }
    const ok = chatStore.deleteSticker(target.url);
    say('info', `audit 删除记录${ok ? '成功' : '失败'}`, { url: target.url.slice(0, 60), localPath: target.localPath ?? '' });
    return ok
      ? `已删除第 ${idx} 条：${(target.description ?? target.url).slice(0, 40)}${fileNote}`
      : '删除失败：记录不存在。';
  }

  // 只看已有复检结果
  if (sub === 'list') {
    const rejected = chatStore.rejectedStickers(200);
    const all = chatStore.allStickers(500);
    const marked = all.filter((x) => x.verdict === 'rejected').length;
    if (rejected.length === 0) {
      return marked === 0 && all.length > 0
        ? `复检过了，没有发现混进的非表情包内容（共 ${all.length} 个）。`
        : '表情包库是空的，或还没复检（发 /s audit 开始）。';
    }
    const lines = [`【AI 判定不是表情包的条目】共 ${rejected.length} 个`];
    rejected.forEach((x, i) => {
      const desc = (x.description ?? '').trim() || '(无描述)';
      lines.push(`${i + 1}. [${x.category ?? '?'}] ${desc.slice(0, 28)}`);
      if (x.verdictReason) lines.push(`     判定：${x.verdictReason.slice(0, 46)}`);
    });
    lines.push('', '删除：/s audit del <序号>');
    lines.push('（只打标记不自动删，确认后再删）');
    return lines.join('\n');
  }

  // 开始复检
  if (!VISION.apiKey) return '未配置视觉密钥，无法复检。';
  const all = chatStore.allStickers(500);
  if (all.length === 0) return '表情包库是空的，没什么可复检。';

  say('info', `开始 audit 复检，共 ${all.length} 个`, {});
  let rejected = 0;
  let kept = 0;
  let failed = 0;
  const failedList: Array<{ desc: string; why: string }> = [];
  const min = Number(config.stickerFilter?.minConfidence ?? 0.6);
  for (const rec of all) {
    try {
      // 有本地文件就直接读，避免重新下载（图床链接可能已过期）
      let bytes: Uint8Array | null = null;
      if (rec.localPath && fs.existsSync(rec.localPath)) {
        bytes = new Uint8Array(fs.readFileSync(rec.localPath));
      } else {
        bytes = await downloadBytes(rec.url, config.proxy?.url || undefined, 8 * 1024 * 1024);
      }
      const verdict = await classifySticker(bytes, VISION);
      const pass = passesStickerGate(verdict, min);
      chatStore.setVerdict(rec.url, pass ? 'sticker' : 'rejected',
        `${verdict.kind}/${verdict.confidence.toFixed(2)} ${verdict.reason}`.trim());
      if (pass) kept++; else rejected++;
    } catch (e) {
      // 单条失败不影响整体；保持原状态，计为"未判定"
      failed++;
      const msg = (e as Error).message;
      const expired = /400|403|404|410/.test(msg);
      failedList.push({ desc: (rec.description ?? '').slice(0, 30) || '(无描述)', why: expired ? '图床链接已过期' : msg.slice(0, 40) });
      say('warn', 'audit 单条复检失败', { url: rec.url.slice(0, 60), message: msg });
    }
  }
  say('info', 'audit 复检完成', { total: all.length, kept, rejected, failed });
  const lines = [
    `复检完成：共 ${all.length} 个`,
    `  确认是表情包：${kept}`,
    `  判定不是表情包：${rejected}`,
  ];
  if (failed > 0) {
    lines.push(`  无法判定：${failed}（这些图的图床链接已过期或接口失败，没被复检到）`);
    // 最多列 5 条，避免消息过长
    for (const f of failedList.slice(0, 5)) {
      lines.push(`    · ${f.desc} —— ${f.why}`);
    }
    if (failedList.length > 5) lines.push(`    · …另有 ${failedList.length - 5} 条`);
  }
  if (rejected > 0) {
    lines.push('', `查看：/s audit list`, `删除：/s audit del <序号>`);
  }
  if (failed > 0 && rejected === 0) {
    lines.push('', '提示：过期的图无法复检，但也不影响新收集的图；新图会先过 AI 判定再入库。');
  }
  return lines.join('\n');
}

const cmdCtx: CommandContext = {
  config,
  repoRoot: REPO_ROOT,
  configPath,
  stateDir: STATE_DIR,
  logDir: LOG_DIR,
  startedAt: Date.now(),
  send: async () => true,
  clearHistory: (peerKey: string) => {
    // [2026-11-12] 彻底重置：内存历史 + 数据库消息 + 图片记录 + 重建学习画像
    const had = history.delete(peerKey);
    // [2026-11-13] 连同私密模式的历史与状态一起清掉，避免重置后仍残留私密上下文
    history.delete(`${peerKey}#secret`);
    secretModePeers.delete(peerKey);
    let messages = 0;
    let images = 0;
    let profile = false;
    try {
      messages = chatStore.purgePeer(peerKey);
    } catch (e) {
      say('error', '清理聊天记录失败', { message: (e as Error).message });
    }
    try {
      images = imageStore.purgePeer(peerKey);
    } catch (e) {
      say('error', '清理图片记录失败', { message: (e as Error).message });
    }
    try {
      // 重新生成学习画像（避免旧画像里残留本会话内容）
      runLearn('会话重置');
      profile = true;
    } catch { profile = false; }
    say('info', `会话已重置 ${peerKey}`, { memory: had, messages, images });
    return { memory: had, messages, images, profile };
  },
  setAutoReplyMode,
  // [2026-11-13] 私密模式开关：代码级校验"主人 + 私聊"，不依赖模型判断
  secret: (on: boolean, msg: InboundMessage) => {
    // 群聊一律拒绝：私密内容绝不能落到群里
    if (msg.kind !== 'private') {
      return { ok: false, text: '私密模式只能在私聊里开启。' };
    }
    // 二次校验归属（命令层已按 ownerOnly 拦过一次，这里是纵深防御）
    if (!isOwner(config, msg.userId)) {
      return { ok: false, text: '你没有权限使用这个命令。' };
    }
    const key = msg.peerKey;
    if (on) {
      secretModePeers.add(key);
      say('info', `进入私密模式 ${key}`);
      return {
        ok: true,
        text: [
          '已进入私密模式。',
          '现在起使用独立人设（/secret off 退出）。',
        ].join('\n'),
      };
    }
    secretModePeers.delete(key);
    say('info', `退出私密模式 ${key}`);
    return { ok: true, text: '已退出私密模式，恢复普通对话。' };
  },
  report: () => buildReport(STATE_DIR),
  learn: () => {
    // [2026-11-17] 按用户要求简化：/learn = 刷新"最近 50 条真实聊天原文"语气参考，不做统计分析
    runLearn('手动 /learn');
    const c = chatStore.counts();
    if (!learnedProfile || learnedProfile.examples.length === 0) return '没有可学习的聊天记录（样本为空）。';
    return [
      '语气参考已更新',
      `已抓取最近 ${learnedProfile.examples.length} 条真实聊天记录（上限 50 条，已排除命令和机器人自己的消息）`,
      `累计消息 ${c.messages} · 表情包 ${c.stickers}`,
      '机器人将模仿这些消息的语气说话。再执行一次 /learn 即可刷新。',
    ].join('\n');
  },
  sticker: async (args: string[]) => {
    const sub = (args[0] ?? 'list').toLowerCase();

    // [2026-11-13] /s audit —— 用 AI 复检存量表情包，找出混进来的新闻/截图类
    if (sub === 'audit') {
      return auditStickers(args.slice(1));
    }

    // /sticker stats —— 分类统计
    if (sub === 'stats') {
      const byCat = chatStore.stickerStatsByCategory();
      if (byCat.length === 0) return '表情包库还是空的。';
      const total = byCat.reduce((a, b) => a + b.count, 0);
      return [`【表情包分类统计】共 ${total} 个`, ...byCat.map((c) => `  ${c.category}：${c.count} 个`)].join('\n');
    }

    // /sticker fix <序号> <分类> 或 /sticker fix <分类>（=最近一个）
    if (sub === 'fix') {
      const recent = chatStore.topStickers(50);
      if (recent.length === 0) return '表情包库是空的。';

      // 两种形式：fix 分类 / fix 序号 分类
      let idx = 1;
      let cat = (args[1] ?? '').trim();
      if (/^\d+$/.test(cat)) {
        idx = parseInt(cat, 10);
        cat = (args[2] ?? '').trim();
      }
      if (!cat) {
        return [
          '用法：',
          '/s fix <序号> <分类>              只改分类',
          '/s fix <序号> <分类> | <描述>      同时纠正画面描述',
          '例：/s fix 3 黄暴 | 熊猫头手捧一堆粉色避孕套，配文“至死方休”',
          '',
          '（先发 /s 看序号）',
        ].join('\n');
      }
      if (idx < 1 || idx > recent.length) return `序号超出范围（1~${recent.length}），先发 /s 看列表。`;

      // 支持 "分类 | 描述" 形式：pipe 后面是人工纠正的画面描述
      let descOverride = '';
      const pipeAt = cat.indexOf('|');
      if (pipeAt >= 0) {
        descOverride = cat.slice(pipeAt + 1).trim();
        cat = cat.slice(0, pipeAt).trim();
      }
      if (!cat) return '分类不能为空。';

      const target = recent[idx - 1]!;
      try {
        chatStore.saveStickerAnalysis(target.url, {
          description: descOverride || target.description || '',
          emotion: target.emotion ?? '',
          category: cat, occasion: target.occasion ?? '',
          animated: target.animated === 1, format: target.format ?? '', localPath: target.localPath,
        });
        const lines = [
          `已把第 ${idx} 个表情包改为「${cat}」`,
          `原判：${target.category ?? '(空)'}`,
        ];
        if (descOverride) lines.push(`描述已修正为：${descOverride}`);
        else lines.push(`画面：${(target.description ?? '').slice(0, 40)}`);
        return lines.join('\n');
      } catch (e) {
        return `纠正失败：${(e as Error).message}`;
      }
    }

    // /sticker list —— 带序号列表
    const list = chatStore.topStickers(10);
    if (list.length === 0) return '表情包库还是空的。';
    const lines = [`【表情包列表】共 ${chatStore.topStickers(500).length} 个，显示前 ${list.length} 个`];
    list.forEach((x, i) => {
      const flag = x.analyzed ? '' : ' (未分析)';
      const anim = x.animated === 1 ? '🎞' : '';
      lines.push(`${i + 1}. [${x.category ?? '?'}]${anim} ${(x.description ?? '').slice(0, 32)}${flag}`);
    });
    list.push('', '纠正分类：/s fix <序号> <分类>');
    lines.push('例：/s fix 2 震惊');
    // [2026-11-13] 未知子命令兜底：以前 /s audit 会静默走 list，看起来像"无效"。
    // 现在除了 list 本身，其它不认识的子命令都要明确提示。
    if (sub && sub !== 'list') {
      return [
        `未知子命令「${args[0]}」`,
        '',
        '/s                 看表情包列表',
        '/s stats           分类统计',
        '/s fix <序号> <分类>  纠正分类',
        '/s audit           用 AI 复检存量，找出混进来的新闻/截图',
      ].join('\n');
    }
    return lines.join('\n');
  },
  // [2026-11-16] 媒体流水线进度
  media: () => {
    const st = chatStore.mediaStats();
    const byCat = chatStore.stickerStatsByCategory();
    const lines = [
      '【媒体收集与整理】',
      `  已登记媒体：${st.total}`,
      `  已下载落盘：${st.downloaded}（下载失败 ${st.downloadFailed}，待下载 ${st.pendingDownload}）`,
      `  待整理：${st.new_}`,
      `  已判定为表情包：${st.analyzed}`,
      `  已排除（非表情包）：${st.notSticker}`,
      '',
      `【可发送表情包库】共 ${byCat.reduce((a, b) => a + b.count, 0)} 个`,
    ];
    for (const c of byCat.slice(0, 10)) lines.push(`  ${c.category}：${c.count}`);
    if (st.pendingDownload > 0) {
      lines.push('', `提示：还有 ${st.pendingDownload} 张等待下载，定时任务每 5 分钟补一批（链接会过期，越早越好）。`);
    }
    if (st.new_ > 0) {
      lines.push(`提示：还有 ${st.new_} 张待整理，每 15 分钟处理最多 10 张。`);
    }
    return lines.join('\n');
  },
  meme: (args: string[]) => {
    const sub = (args[0] ?? 'list').toLowerCase();
    if (sub === 'list') {
      const all = memeLib.all();
      if (all.length === 0) return '梗库是空的。';
      const lines = [`【梗库】共 ${all.length} 条`];
      for (const m of all.slice(0, 20)) {
        lines.push(`  ${m.name}：${m.meaning.slice(0, 30)}`);
      }
      lines.push('', '添加：/meme add <梗名> | <关键词,逗号分隔> | <含义> | <出处>');
      return lines.join('\n');
    }
    if (sub === 'add') {
      const rest = args.slice(1).join(' ');
      const parts = rest.split('|').map((x) => x.trim());
      if (parts.length < 3) {
        return [
          '用法：/meme add <梗名> | <关键词,逗号分隔> | <含义> | <出处>',
          '例：/meme add 杰哥不要 | 阿伟,彬彬,逊 | 这个彬彬就是逊，嘲讽对方很菜 | 台湾宣导短片《杰哥不要》',
        ].join('\n');
      }
      const [name, kws, meaning, source = ''] = parts;
      if (!name || !kws) return '梗名和关键词不能为空。';
      memeLib.upsert({
        name,
        keywords: kws.split(/[,，]/).map((k) => k.trim()).filter(Boolean),
        meaning: meaning ?? '',
        source,
      });
      memeLib.save();
      return `已加入梗库：${name}\n关键词：${kws}\n以后遇到相关表情包会优先按这个判断。`;
    }
    if (sub === 'del') {
      const name = args.slice(1).join(' ').trim();
      if (!name) return '用法：/meme del <梗名>';
      const ok2 = memeLib.remove(name);
      memeLib.save();
      return ok2 ? `已删除：${name}` : `梗库里没有：${name}`;
    }
    return '用法：/meme list | /meme add ... | /meme del <梗名>';
  },
  stats: () => {
    const c = chatStore.counts();
    const top = chatStore.topStickers(5);
    const lines = [
      `累计收集消息：${c.messages} 条`,
      `表情包缓存：${c.stickers} 个`,
      `学习画像：${c.patterns > 0 ? '已生成' : '尚未生成'}`,
      learnedProfile ? `最近分析：${learnedProfile.updatedAt}` : '',
    ].filter(Boolean);
    if (top.length > 0) {
      lines.push('最常出现的表情包：');
      for (const t of top) lines.push(`  ${t.count}次 ${t.url.slice(0, 60)}`);
    }
    return lines.join('\n');
  },
};

// [2026-11-12] 处理 e621 取图技能：抓热门页 -> 随机原图 -> 发送图片消息
async function handleE621Skill(msg: InboundMessage, skill: { name: string; e621?: { scale?: string; date?: string; preference?: string } }): Promise<void> {
  say('info', `技能「${skill.name}」触发：开始抓取图片`, { peer: msg.peerKey });
  const t0 = Date.now();
  try {
    const groupKey = msg.kind === 'group' ? msg.peerKey : undefined;
    const r = await fetchPopularImage({
      scale: skill.e621?.scale ?? 'day',
      date: skill.e621?.date,
      groupKey,
      preference: (skill.e621?.preference as 'hetero' | 'solo' | 'female' | 'any') ?? 'any',
    });
    say('info', `取图成功（${((Date.now() - t0) / 1000).toFixed(1)}s）`, { post: r.postUrl, ext: r.ext });

    // [2026-11-12] 由 gateway 自己下载图片再以 base64 发送。
    // 原因：图片 CDN（static1.e621.net）在部分网络下 NapCat 直连会 ECONNRESET，
    // 而 gateway 可以走配置的代理下载，彻底绕开 NapCat 的网络环境。
    const proxyUrl = config.proxy?.url || '';
    // [2026-11-12] 限制单图 8MB：超过就换下一张，避免大图下载拖慢整体
    const MAX_IMG_BYTES = 12 * 1024 * 1024;
    let file = r.imageUrl;
    let finalPost = r.postUrl;
    let finalExt = r.ext;
    try {
      const dlStart = Date.now();
      // [2026-11-17] 下载失败（404 / 超时 / 过大）都换一张重试，最多 3 次。
      // 修复两个真 bug：
      //   ① 原来重试抽到同一张会原地打转（失败日志里 3 次全是 gif）——记录失败 postId 并排除；
      //   ② 图片上限 8MB 太严，e621 原图 GIF 常 3~8MB，配合旧 30s 超时基本必失败。
      //      上限放到 12MB（NapCat base64 通道可承受），超时已在 e621.ts 放宽到 90s。
      let ok = false;
      let lastErr: unknown = null;
      let cur = r;
      const failedIds = new Set<string>();
      const MAX_IMG_RETRY = 3;
      for (let attempt = 0; attempt < MAX_IMG_RETRY && !ok; attempt++) {
        try {
          file = await downloadBestAsBase64(cur.imageUrl, cur.sampleUrl, proxyUrl || undefined, MAX_IMG_BYTES);
          finalPost = cur.postUrl;
          finalExt = cur.ext;
          ok = true;
        } catch (e) {
          lastErr = e;
          const pid = String(cur.postUrl ?? '').match(/posts\/(\d+)/)?.[1] ?? '';
          if (pid) failedIds.add(pid);
          say('warn', `下载失败，换一张重试（${attempt + 1}/${MAX_IMG_RETRY}）`, {
            message: (e as Error).message.slice(0, 60), post: cur.postUrl, ext: cur.ext,
          });
          // 换一张：连续抽到已失败的图就再试（最多额外 3 次抽签）
          let next: typeof cur | null = null;
          for (let pick = 0; pick < 3 && !next; pick++) {
            try {
              const cand = await fetchPopularImage({
                scale: skill.e621?.scale ?? 'day', date: skill.e621?.date, groupKey,
                preference: (skill.e621?.preference as 'hetero' | 'solo' | 'female' | 'any') ?? 'any',
              });
              const cid = String(cand.postUrl ?? '').match(/posts\/(\d+)/)?.[1] ?? '';
              if (!cid || !failedIds.has(cid)) next = cand;
            } catch { /* 抽签失败就继续试 */ }
          }
          if (next) cur = next;
          else say('warn', '换图抽签失败，沿用当前图再试');
        }
      }
      if (!ok) throw lastErr ?? new Error('下载失败');
    } catch (e) {
      // 3 次都失败：只能让 NapCat 自己拉 URL（它有时能通）
      say('warn', 'gateway 下载多次失败，改用 URL 直传', { message: (e as Error).message.slice(0, 80) });
      file = r.imageUrl;
    }

    // [2026-11-12] 图片 + 原图链接一起发（链接方便对方自己去看原帖）
    const caption = `原图链接：${finalPost}`;
    // [2026-11-13] 群聊优先用「合并转发卡片」：
    // 群里直接发 base64 图片经常 read ECONNRESET（群图片通道限制），
    // 转发卡片由 QQ 自己渲染，稳定性高得多。私聊仍用普通图片消息。
    let res;
    if (msg.kind === 'group') {
      res = await client.sendForwardMsg({ kind: 'group', groupId: msg.groupId! }, [{
        name: '图片',
        uin: selfUin || '0',
        content: [
          { type: 'text', data: { text: caption } },
          { type: 'image', data: { file } },
        ],
      }]);
      // 转发失败再退回普通图片消息
      if (res.status !== 'ok') {
        say('warn', '群转发失败，改回直发图片', { retcode: res.retcode, message: res.message });
        res = await client.sendGroupImage(msg.groupId!, file, caption);
      }
    } else {
      res = await client.sendPrivateImage(msg.userId, file, caption);
      // 私聊直发失败也试一下转发
      if (res.status !== 'ok') {
        say('warn', '私聊图片直发失败，改用合并转发', { retcode: res.retcode, message: res.message });
        const fwd = await client.sendForwardMsg({ kind: 'private', userId: msg.userId }, [{
          name: '图片',
          uin: selfUin || '0',
          content: [
            { type: 'text', data: { text: caption } },
            { type: 'image', data: { file } },
          ],
        }]);
        if (fwd.status === 'ok') res = fwd;
      }
    }

    appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
      ts: new Date().toISOString(), peerKey: msg.peerKey, kind: 'image',
      text: `[图片] ${finalPost} (.${finalExt})`, status: res.status, retcode: res.retcode,
    });

    // 记录到本地数据库（供后续"这图里是什么"追问使用）
    if (res.status === 'ok') {
      try {
        imageStore.add({
          ts: new Date().toISOString(),
          peerKey: msg.peerKey,
          postUrl: r.postUrl,
          postId: r.postId,
          imageUrl: r.imageUrl,
          ext: r.ext,
          tags: r.tags,
          artist: r.artist.join(', ') || undefined,
          species: r.species.join(', ') || undefined,
          query: msg.text,
        });
        say('info', `已记录到图片库（共 ${imageStore.count()} 条）`, { backend: imageStore.backend });
      } catch (e) {
        say('error', '写入图片库失败', { message: (e as Error).message });
      }
    }
    if (res.status !== 'ok') {
      // 图片 URL 直传失败时，回一句说明（不把内部错误细节发出去）
      say('error', '图片发送失败', { retcode: res.retcode, message: res.message });
      await deliverCmd(msg, '图没取到，稍后再试试~');
    } else {
      say('info', `图片已发送 ${msg.peerKey}`, { post: r.postUrl });
    }
  } catch (e) {
    const m = (e as Error).message || String(e);
    say('error', '取图失败', { message: m });
    appendJsonl(path.join(LOG_DIR, `${todayStamp()}.jsonl`), {
      ts: new Date().toISOString(), kind: 'skill-error', skill: skill.name, peerKey: msg.peerKey, message: m,
    });
    // 面向用户只说"暂时取不到"，不透出内部错误
    await deliverCmd(msg, '这次没抽到能发的图，再试一次吧~');
  }
}

// [2026-11-12] 自我升级：定期整理分析聊天记录
// 默认每 6 小时分析一次；也可用 /learn 命令手动触发。
const LEARN_INTERVAL_MS = 6 * 60 * 60 * 1000;
let learnTimer: ReturnType<typeof setInterval> | null = null;

function runLearn(reason: string): void {
  try {
    const before = chatStore.counts();
    const profile = analyze(chatStore, LEARNED_DIR, selfUin);
    learnedProfile = profile;
    const after = chatStore.counts();
    say('info', `自我升级完成（${reason}）`, {
      样本: profile.sampleSize,
      平均长度: profile.avgLength,
      表情包率: profile.stickerRate.toFixed(1),
      累计消息: `${before.messages}->${after.messages}`,
      累计表情包: after.stickers,
    });
  } catch (e) {
    say('error', '自我升级分析失败', { message: (e as Error).message });
  }
}

function startLearnTimer(): void {
  if (learnTimer) clearInterval(learnTimer);
  learnTimer = setInterval(() => runLearn('定时'), LEARN_INTERVAL_MS);
  // 启动后 60 秒先跑一次，便于首次就有画像
  setTimeout(() => { if (!learnedProfile) runLearn('首次'); }, 60000);
}

// [2026-11-13] 处理「新鲜事」技能：抓最近新闻 -> 图文并茂发送
async function handleNewsSkill(
  msg: InboundMessage,
  skill: { name: string; news?: { maxAgeHours?: number; requireImage?: boolean } },
): Promise<void> {
  say('info', `技能「${skill.name}」触发：开始抓取新闻`, { peer: msg.peerKey });
  const t0 = Date.now();
  try {
    const list = await fetchLatestNews({
      maxAgeHours: skill.news?.maxAgeHours ?? 48,
      requireImage: skill.news?.requireImage ?? true,
      perSource: 8,
    });
    if (list.length === 0) {
      await deliverCmd(msg, '这会儿没抓到新鲜的新闻，过会儿再试试~');
      return;
    }
    // 随机挑一条（在最近的一批里选，避免总是同一条）
    const top = list.slice(0, 8);
    const pick: NewsItem = top[Math.floor(Math.random() * top.length)]!;
    say('info', `选中新闻：${pick.source}`, { title: pick.title.slice(0, 40), ageH: pick.ageHours.toFixed(1) });

    const ago = pick.ageHours < 1
      ? `${Math.max(1, Math.round(pick.ageHours * 60))} 分钟前`
      : `${Math.round(pick.ageHours)} 小时前`;
    const lines = [
      `【${pick.source}·${ago}】`,
      pick.title,
      '',
      pick.summary ? pick.summary.slice(0, 120) + (pick.summary.length > 120 ? '…' : '') : '',
      '',
      pick.link,
    ].filter((x, i, arr) => x !== '' || (i > 0 && arr[i - 1] !== '')).join('\n');

    // 群聊用转发卡片（图文并茂 + 链接），私聊直发图片
    let res;
    if (msg.kind === 'group') {
      const nodes = [{
        name: '新鲜事',
        uin: selfUin || '0',
        content: [
          { type: 'text', data: { text: lines } },
          ...(pick.imageUrl ? [{ type: 'image', data: { file: pick.imageUrl } }] : []),
        ],
      }];
      res = await client.sendForwardMsg({ kind: 'group', groupId: msg.groupId! }, nodes);
      if (res.status !== 'ok') {
        say('warn', '新闻转发失败，改发文字', { retcode: res.retcode, message: res.message });
        res = await client.sendGroup(msg.groupId!, lines);
      }
    } else {
      if (pick.imageUrl) {
        res = await client.sendPrivateImage(msg.userId, pick.imageUrl, lines);
      } else {
        res = await client.sendPrivate(msg.userId, lines);
      }
    }

    appendJsonl(path.join(STATE_DIR, 'outbox.jsonl'), {
      ts: new Date().toISOString(), peerKey: msg.peerKey, kind: 'news',
      text: `[新闻] ${pick.source} ${pick.title}`.slice(0, 200),
      status: res.status, retcode: res.retcode,
    });
    say('info', `新闻已发送（${((Date.now() - t0) / 1000).toFixed(1)}s）`, { title: pick.title.slice(0, 40) });
  } catch (e) {
    const m = (e as Error).message || String(e);
    say('error', '抓新闻失败', { message: m });
    await deliverCmd(msg, '新闻源这会儿连不上，过会儿再试试~');
  }
}

async function flushQueue(): Promise<void> {
  const files = fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json')).sort() : [];
  if (files.length === 0) return;
  say('info', `恢复在线，处理积压消息 ${files.length} 条`);
  for (const f of files) {
    const full = path.join(QUEUE_DIR, f);
    const q = loadJson<{ peerKey: string; kind: 'private' | 'group'; userId: string; groupId?: string; nickname: string; text: string } | null>(full, null);
    if (!q) { fs.rmSync(full, { force: true }); continue; }
    fs.rmSync(full, { force: true });
  }
}

async function selfTest(): Promise<void> {
  say('info', '自检模式：连接 OneBot 并探活一次');
  const r = await client.probe();
  say(r.ok ? 'info' : 'error', '探活结果', r as unknown as Record<string, unknown>);
  writeJsonAtomic(path.join(STATE_DIR, 'selftest.json'), { ts: new Date().toISOString(), ...r });
  process.exit(r.ok ? 0 : 1);
}

if (args.has('--once')) {
  await selfTest();
}

say('info', 'qq-gateway 启动', {
  ws: config.onebot.wsUrl, http: config.onebot.httpUrl,
  autoReply: config.autoReply.mode, groupRequireMention: config.behavior.groupRequireMention, selfUin,
});
client.connect();
monitor.start(client);
startLearnTimer();
setInterval(() => { if (client.isConnected) void flushQueue(); }, 60000);
// [2026-11-16] 每 10 分钟重试一次"未分析"的表情包（网络超时导致的失败通常可恢复）
setInterval(() => { if (client.isConnected) retryUnanalyzedStickers(); }, 10 * 60 * 1000);

// [2026-11-16] 媒体流水线定时任务（用户要求：先收集，再定期整理表情包含义）
//
//   下载任务：解决"当时网络不好没下成"，每 5 分钟补下一批。
//     注意链接有有效期，所以下载要尽早、且失败要快重试，不能等到整理阶段才发现过期。
//   整理任务：读本地文件做 AI 判定+分类，每 15 分钟一批，每批 10 张，
//     避免一次性打爆视觉接口；进度写日志，可用 /media 命令查看。
let mediaTimerBusy = false;
async function runMediaPipeline(): Promise<void> {
  if (mediaTimerBusy) return;   // 上一轮还没跑完，跳过本轮（避免叠加）
  mediaTimerBusy = true;
  try {
    if (!VISION.apiKey) {
      say('warn', '未配置视觉密钥，媒体整理任务跳过（原件仍会照常保存）');
      return;
    }
    // 0) 每轮都记一条，便于确认定时任务确实在跑（队列为空也要可观测）
    const before = chatStore.mediaStats();
    say('info', '媒体流水线巡检', {
      total: before.total, pendingDownload: before.pendingDownload, pendingOrganize: before.new_,
    });
    // 1) 补下载（先保证原件都在本地）
    await downloadPendingMedia(MEDIA_DEPS, 20);
    // 2) 整理（从本地文件判定+分类）
    await organizeMedia(MEDIA_DEPS, 10);
  } catch (e) {
    say('warn', '媒体流水线执行失败', { message: (e as Error).message });
  } finally {
    mediaTimerBusy = false;
  }
}
// 启动 1 分钟后先跑一轮（把停机期间积压的补齐），之后每 5 分钟一轮
// 启动 5 秒后回填历史哈希（让老图也能参与跟图 +1）
setTimeout(() => backfillMediaHashes(), 5000);
setTimeout(() => { void runMediaPipeline(); }, 60 * 1000);
setInterval(() => { void runMediaPipeline(); }, 5 * 60 * 1000);

process.on('SIGINT', () => { say('info', '收到 SIGINT，退出'); monitor.stop(); client.close(); if (learnTimer) clearInterval(learnTimer); try { chatStore.close(); } catch { /* 忽略 */ } try { imageStore.close(); } catch { /* 忽略 */ } process.exit(0); });
process.on('SIGTERM', () => { say('info', '收到 SIGTERM，退出'); monitor.stop(); client.close(); if (learnTimer) clearInterval(learnTimer); try { chatStore.close(); } catch { /* 忽略 */ } try { imageStore.close(); } catch { /* 忽略 */ } process.exit(0); });
