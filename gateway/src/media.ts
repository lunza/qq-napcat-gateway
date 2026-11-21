// [2026-11-16] 媒体收集与整理
//
// 用户要求（2026-11-16）：
//   "后续一定要做好聊天记录的收集，为保证解析质量允许先收集聊天记录
//    （包括文字、图片、gif等），然后通过定期跑定时任务的方式整理表情包含义"
//
// 架构：
//   阶段一 收集（收到消息时）：登记 URL + 立刻下载原件落盘。**不做任何判断**。
//     理由：QQ 图床链接约 1 天后失效（实例：13 条记录因只存 URL 而永久不可恢复），
//     而且现场判定一旦超时就丢数据。先存下来最稳妥。
//   阶段二 整理（定时任务）：从**本地文件**读图，跑 AI 判定成表情包，再提取含义/分类。
//     读的是本地盘文件，所以晚几天整理也没关系。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatStore, MediaRecord } from './chat-store.ts';
import { downloadBytes } from './e621.ts';
import { classifySticker, detectFormat, analyzeSticker, type VisionConfig } from './sticker.ts';

export interface MediaPipelineDeps {
  store: ChatStore;
  /** 媒体原件保存目录 */
  dir: string;
  vision: VisionConfig;
  say: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/** 单张图最大体积；超过多半是长图/视频封面，下载意义不大 */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/**
 * [2026-11-17] 图片内容哈希（sha256 前 16 位）。
 * 用于判断"两张图是不是同一张表情包"：QQ 每次转发同一张图会生成不同 URL，
 * 只有按字节内容比对才可靠。
 */
export function contentHashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex').slice(0, 16);
}

/** 用**完整 URL** 的 sha256 生成文件名 —— 不能用前 N 字节（QQ 图床前缀全都一样会撞名） */
export function mediaFileName(url: string, format: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `${hash}.${ext}`;
}

/**
 * 下载一条媒体并落盘。**永不抛异常**（在消息处理路径里 fire-and-forget 调用）。
 * 返回是否成功；失败原因写入 media 表并累计尝试次数。
 */
export async function downloadMediaById(deps: MediaPipelineDeps, rec: MediaRecord): Promise<boolean> {
  const { store, dir, say } = deps;
  try {
    // 已有本地文件：直接标记完成，不重复下载
    if (rec.localPath && fs.existsSync(rec.localPath)) {
      const existing = new Uint8Array(fs.readFileSync(rec.localPath));
      store.markMediaDownloaded(rec.id, {
        localPath: rec.localPath,
        format: rec.format ?? 'unknown',
        animated: rec.animated === 1,
        bytes: existing.byteLength,
        contentHash: contentHashOf(existing),
      });
      return true;
    }
    const bytes = await downloadBytes(rec.url, deps.vision.proxy, MAX_MEDIA_BYTES);
    if (!bytes || bytes.byteLength === 0) throw new Error('下载内容为空');
    const { format, animated } = detectFormat(bytes);
    if (format === 'unknown') {
      store.markMediaDownloadFailed(rec.id, `无法识别的图片格式（${bytes.byteLength} 字节）`);
      store.bumpMediaAttempts(rec.id);
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, mediaFileName(rec.url, format));
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    store.markMediaDownloaded(rec.id, {
      localPath: file, format, animated, bytes: bytes.byteLength,
      // [2026-11-17] 内容哈希：同一张图 QQ 每次发的 URL 都不同，只能按内容识别
      contentHash: contentHashOf(bytes),
    });
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    store.markMediaDownloadFailed(rec.id, msg);
    store.bumpMediaAttempts(rec.id);
    say('warn', '媒体下载失败', { id: rec.id, url: rec.url.slice(0, 50), message: msg.slice(0, 80) });
    return false;
  }
}

/** 下载所有待下载的媒体（每轮限量，避免一次拉太多） */
export async function downloadPendingMedia(
  deps: MediaPipelineDeps, limit = 20,
): Promise<{ ok: number; failed: number }> {
  const pending = deps.store.pendingDownloads(limit);
  let ok = 0, failed = 0;
  for (const rec of pending) {
    const success = await downloadMediaById(deps, rec);
    if (success) ok++; else failed++;
  }
  if (pending.length > 0) {
    deps.say('info', `媒体下载完成：成功 ${ok}，失败 ${failed}`, { total: pending.length });
  }
  return { ok, failed };
}

export interface OrganizeResult {
  sticker: number;
  notSticker: number;
  failed: number;
  /** 新收录进表情包库的条目 */
  promoted: Array<{ id: number; category: string; localPath: string; description: string }>;
}


/**
 * [2026-11-16] 带一次重试的判定。
 *
 * 背景：整理流水线是串行的，单张图超时后这一轮就跳过它，要等下一个周期（5 分钟）才再见。
 * 而实测超时多为接口长尾而非图片本身问题（同一张图单独跑 1.8s 就能成）。
 * 所以这里在抛出前补一次立即重试，显著降低"好图卡在队列里"的概率。
 */
async function classifyWithRetry(
  bytes: Uint8Array, vision: VisionConfig, retries = 1,
): Promise<Awaited<ReturnType<typeof classifySticker>>> {
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await classifySticker(bytes, vision);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message ?? '';
      // 只有"超时/网络"类错误值得立即重试；返回不可解析这类错误重试也无益
      const retryable = /aborted|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
      if (i === retries || !retryable) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 整理：从**本地文件**判定是不是表情包，并提取含义与分类。
 * 通过判定的会同时登记进 stickers 表，成为可发送的表情包。
 */
export async function organizeMedia(
  deps: MediaPipelineDeps, limit = 10,
): Promise<OrganizeResult> {
  const { store, vision, say } = deps;
  const pending = store.pendingOrganize(limit);
  const promoted: OrganizeResult['promoted'] = [];
  let sticker = 0, notSticker = 0, failed = 0;

  for (const rec of pending) {
    try {
      if (!rec.localPath || !fs.existsSync(rec.localPath)) {
        store.markMediaDownloadFailed(rec.id, '本地文件不存在');
        store.bumpMediaAttempts(rec.id);
        failed++;
        continue;
      }
      const bytes = new Uint8Array(fs.readFileSync(rec.localPath));

      // [2026-11-16] 判定加一次原地重试：实测接口偶发长尾（正常 1~4s，偶发 >25s 被 abort），
      // 一次超时就放弃会让好图白白留在队列里多等一个周期。
      const verdict = await classifyWithRetry(bytes, vision);
      if (!verdict.isSticker || verdict.confidence < 0.6) {
        store.saveMediaAnalysis(rec.id, {
          verdict: 'not_sticker',
          description: `${verdict.kind}：${verdict.reason}`.slice(0, 200),
        });
        notSticker++;
        continue;
      }

      // 第二关：提取含义与分类
      const analysis = await analyzeSticker(bytes, vision);
      store.saveMediaAnalysis(rec.id, {
        verdict: 'sticker',
        category: analysis.category,
        description: analysis.description,
        emotion: analysis.emotion,
        meme: analysis.meme,
      });
      sticker++;

      // 登记进可发送的表情包库（复用同一份本地文件，不重复存盘）
      // [2026-11-18 修复] 原来这里存的是 mediaFileName()（URL 哈希 + ".jpg" 后缀），
      // 而 media 表存的是**内容哈希**（sha256 前 16 位，无后缀）——两套格式永不相等，
      // 导致频率权重系统永远匹配不到统计数据。现在统一用内容哈希。
      const key = rec.contentHash ?? contentHashOf(bytes);
      const existing = store.allStickers(1000).find((s) => s.url === rec.url);
      if (!existing) {
        store.addSticker(rec.url, rec.peerKey, rec.userId);
        store.saveStickerAnalysis(rec.url, {
          description: analysis.description, emotion: analysis.emotion,
          category: analysis.category, occasion: analysis.occasion ?? '',
          animated: analysis.animated, format: analysis.format,
          localPath: rec.localPath, contentHash: key,
        });
        store.setVerdict(rec.url, 'sticker', `media#${rec.id} 定时整理`);
      }
      promoted.push({
        id: rec.id, category: analysis.category,
        localPath: rec.localPath, description: analysis.description,
      });
      say('info', `整理出表情包：${analysis.category}`, {
        id: rec.id, desc: (analysis.description ?? '').slice(0, 40),
      });
    } catch (e) {
      failed++;
      store.bumpMediaAttempts(rec.id);
      say('warn', '整理媒体失败', { id: rec.id, message: (e as Error).message.slice(0, 100) });
    }
  }

  if (pending.length > 0) {
    say('info', `整理完成：表情包 ${sticker}，非表情包 ${notSticker}，失败 ${failed}`, {
      total: pending.length, promoted: promoted.length,
    });
  }
  return { sticker, notSticker, failed, promoted };
}
