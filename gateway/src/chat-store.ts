// [2026-11-12] 聊天记录与表情包收集（全量收集，只存本机）
//
// 用户已明确要求：全量收集群聊与私聊的消息内容和表情包，用于学习人类交流方式。
// 本模块只负责"收集与索引"，不做任何外发；数据全部留在 state/ 目录下。
//
// 表结构：
//   messages   每条消息（含来源会话、发送者、文本、是否含图、是否表情包）
//   stickers   收集到的表情包（URL、来源、出现场景）
//   patterns   统计学习出的"何时发表情包"的模式（自我升级用）
//
// 隐私边界（代码层面保证）：
//   - 只在本地 SQLite，不联网上报
//   - 提供 purge() 用于随时清空
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** [2026-11-16] 单条媒体最多尝试次数（下载/整理），避免死循环 */
const MAX_MEDIA_ATTEMPTS = 3;

export interface CollectedMessage {
  ts: string;
  peerKey: string;
  kind: 'private' | 'group';
  userId: string;
  nickname: string;
  text: string;
  /** 消息里的图片/表情 URL（每个元素一项） */
  images: string[];
  /** 是否判定为表情包（小图/表情/QQ face） */
  isSticker: boolean;
  /** 触发它的技能或命令（可选） */
  tag?: string;
  /**
   * [2026-11-12] 是否为命令（# 技能触发 / / 管理命令）。
   * 用户明确要求：命令完全不能参与学习。这里记录标记，学习时双保险过滤。
   */
  isCommand?: boolean;
}

export interface StickerRecord {
  url: string;
  source: string;         // 从哪个会话/群看到
  userId: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** [2026-11-12] 视觉分析结果 */
  description?: string;
  emotion?: string;
  category?: string;
  occasion?: string;
  animated?: number;
  format?: string;
  localPath?: string;
  analyzed?: number;
  /**
   * [2026-11-13] AI 收藏闸门的判定结果：
   *   'sticker'  = 判定是表情包（已入库）
   *   'unknown'  = 存量数据，未经过闸门（老数据）
   *   'rejected' = 复检判定不是表情包（/s audit 标记，等待清理）
   */
  verdict?: string;
  /** [2026-11-13] 判定理由，便于复核误判 */
  verdictReason?: string;
}

/**
 * [2026-11-16] 媒体原件记录：消息里的每张图/GIF 一条。
 * 先入库（可能还没下载完），由下载与整理任务推进状态。
 */
export interface MediaRecord {
  id: number;
  ts: string;
  peerKey: string;
  userId: string;
  nickname: string;
  url: string;
  localPath?: string | null;
  format?: string | null;
  animated?: number;
  bytes?: number;
  downloadState: string;
  downloadError?: string | null;
  status: string;
  verdict?: string | null;
  category?: string | null;
  description?: string | null;
  emotion?: string | null;
  meme?: string | null;
  analyzedAt?: string | null;
  attempts?: number;
  /** [2026-11-17] 图片内容哈希，用于识别同一张表情包 */
  contentHash?: string | null;
}

export interface StickerCategory {
  name: string;
  createdAt: string;
  count: number;
  note?: string;
}

export interface ChatStore {
  addMessage(m: CollectedMessage): void;
  addSticker(url: string, peerKey: string, userId: string): void;
  /** 最近 n 条消息（新在前），用于自我升级分析 */
  recentMessages(n: number): CollectedMessage[];
  /** 待学习的新消息（自上次分析后） */
  unlearnedMessages(limit: number): CollectedMessage[];
  markLearned(ids: number[]): void;
  /** 表情包库：按出现次数 */
  topStickers(limit: number): StickerRecord[];
  /** 尚未分析的表情包 */
  unanalyzedStickers(limit: number): StickerRecord[];
  /** 保存分析结果 */
  saveStickerAnalysis(url: string, a: {
    description: string; emotion: string; category: string; occasion: string;
    animated: boolean; format: string; localPath?: string; contentHash?: string;
  }): void;
  /** 随机取一个某分类的表情包 */
  randomSticker(category?: string): StickerRecord | null;
  /** 分类列表（含计数） */
  listCategories(): StickerCategory[];
  /** [2026-11-12] 按内容哈希查已分析的表情包（去重用） */
  findStickerByHash(hash: string): StickerRecord | null;
  /**
   * [2026-11-13] 记录 AI 闸门判定结果。
   * 用于 /s audit 的存量复检：把判定写回记录，方便二次确认后再删。
   */
  setVerdict(url: string, verdict: string, reason: string): void;
  /** [2026-11-13] 取所有表情包记录（audit 全量复检用） */
  allStickers(limit: number): StickerRecord[];
  /** [2026-11-13] 删除一条表情包记录，返回是否删除成功 */
  deleteSticker(url: string): boolean;
  /** [2026-11-13] 列出被判为"不是表情包"(rejected) 的记录 */
  rejectedStickers(limit: number): StickerRecord[];

  // [2026-11-16] 媒体原件库：先收集、后整理
  /** 登记一条媒体（收到消息时立刻调用，此时还没下载） */
  addMedia(m: { ts: string; peerKey: string; userId: string; nickname: string; url: string }): number;
  /** 下载成功后回填本地路径与格式（[2026-11-17] 增加 contentHash：同一张图的稳定标识） */
  markMediaDownloaded(id: number, info: {
    localPath: string; format: string; animated: boolean; bytes: number; contentHash?: string;
  }): void;
  /** 下载失败记录原因 */
  markMediaDownloadFailed(id: number, error: string): void;
  /** 取待下载的媒体（downloadState=pending 且 attempts 未超限） */
  pendingDownloads(limit: number): MediaRecord[];
  /** 取待整理的媒体：已下载但还没判定（status=new） */
  pendingOrganize(limit: number): MediaRecord[];
  /** 写入整理结果 */
  saveMediaAnalysis(id: number, r: {
    verdict: 'sticker' | 'not_sticker'; category?: string; description?: string;
    emotion?: string; meme?: string;
  }): void;
  /** 累计尝试次数（用于限制无限重试） */
  bumpMediaAttempts(id: number): void;
  /** 媒体库统计 */
  mediaStats(): { total: number; pendingDownload: number; downloaded: number; downloadFailed: number; new_: number; analyzed: number; notSticker: number };

  /**
   * [2026-11-17] 跟图 +1 用：查某群里"同一张图被不同人重复发送"的记录。
   * 条件：同群、下载完成、ts 不早于 sinceIso、按 contentHash 分组后计数 >1。
   * 返回每张重复图最近的一条记录（含 contentHash 与本地路径）。
   */
  repeatedImagesInPeer(peerKey: string, sinceIso: string, limit?: number): MediaRecord[];

  /**
   * [2026-11-19] 取某群最近 N 条消息（新→旧），含发送者昵称与是否带图。
   * 供"凑热闹"拼上下文用：只看最后一条容易不知所云，需要真实对话历史。
   */
  recentMessagesInPeer(peerKey: string, limit: number): Array<{
    ts: string; nickname: string; userId: string; text: string;
    hasImage: boolean; isSticker: boolean; imageDescriptions: string[];
  }>;

  /**
   * [2026-11-18] 权重系统用：统计某群最近窗口内各表情包的发送频次。
   * 返回按"不同发送人数"降序的记录，带 localPath 供发送使用。
   */
  stickerFrequencyInPeer(peerKey: string, sinceIso: string, limit?: number): Array<{
    contentHash: string; count: number; senders: number; localPath?: string;
  }>;

  /**
   * [2026-11-17] 回填 contentHash：给"已下载但还没有哈希"的历史记录补上哈希。
   * 用于新功能上线后让老图也能参与"跟图 +1"判断。
   */
  mediaNeedingHash(limit: number): MediaRecord[];
  setMediaHash(id: number, contentHash: string): void;
  /** 按分类统计 */
  stickerStatsByCategory(): Array<{ category: string; count: number }>;
  counts(): { messages: number; stickers: number; patterns: number };
  /** 保存学习出的模式 */
  savePattern(key: string, value: string): void;
  loadPatterns(): Array<{ key: string; value: string; updatedAt: string }>;
  purge(): void;
  /** [2026-11-12] 清理某个会话的消息与表情包，返回删除的消息数 */
  purgePeer(peerKey: string): number;
  close(): void;
  backend: 'sqlite' | 'jsonl';
}

/** SQLite 实现 */
function openSqlite(file: string): ChatStore {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => any };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      peerKey TEXT NOT NULL,
      kind TEXT NOT NULL,
      userId TEXT NOT NULL,
      nickname TEXT NOT NULL,
      text TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      isSticker INTEGER NOT NULL DEFAULT 0,
      tag TEXT,
      learned INTEGER NOT NULL DEFAULT 0,
      isCommand INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_learned ON messages (learned, id);
    CREATE INDEX IF NOT EXISTS idx_msg_peer ON messages (peerKey, id DESC);

    CREATE TABLE IF NOT EXISTS stickers (
      url TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      userId TEXT NOT NULL,
      firstSeen TEXT NOT NULL,
      lastSeen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      emotion TEXT,
      category TEXT,
      occasion TEXT,
      animated INTEGER,
      format TEXT,
      localPath TEXT,
      analyzed INTEGER NOT NULL DEFAULT 0,
      contentHash TEXT
    );

    -- [2026-11-12] 表情包分类（可自驱动扩充）
    CREATE TABLE IF NOT EXISTS sticker_categories (
      name TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS patterns (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- [2026-11-16] 媒体原件库：收到消息时**立刻下载**图片/GIF 并落盘，
    -- 不再依赖 QQ 图床链接（实测约 1 天后返回 HTTP 400，曾导致 13 条记录永久失效）。
    -- 本表只负责"存下来"，不做任何判定；表情包识别交给定时任务。
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      peerKey TEXT NOT NULL,
      userId TEXT NOT NULL,
      nickname TEXT NOT NULL,
      url TEXT NOT NULL,                -- 原始链接（可能过期，仅供追溯）
      localPath TEXT,                   -- 已落盘的文件路径（稳定可读）
      format TEXT,                      -- jpeg/png/gif/webp
      animated INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      downloadState TEXT NOT NULL DEFAULT 'pending',  -- pending|ok|failed
      downloadError TEXT,
      -- 表情包识别与整理（由定时任务填写）
      status TEXT NOT NULL DEFAULT 'new',  -- new|analyzed|not_sticker|ignored
      verdict TEXT,                        -- sticker|not_sticker
      category TEXT,
      description TEXT,
      emotion TEXT,
      meme TEXT,
      analyzedAt TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      -- [2026-11-17] 图片内容哈希（sha256 前 16 位）：用于识别"同一个表情包"，
      -- 因为 QQ 每次发送同一张图会生成不同的 URL，只能按内容比对。
      contentHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_media_status ON media(status, downloadState);
  `);

  // [2026-11-12] 迁移：为早前创建的 stickers 表补齐分析相关列
  try {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(stickers)').all() as any[]).map((c) => String(c.name)),
    );
    const addCol = (name: string, ddl: string) => {
      if (!cols.has(name)) db.exec(`ALTER TABLE stickers ADD COLUMN ${ddl}`);
    };
    addCol('description', 'description TEXT');
    addCol('emotion', 'emotion TEXT');
    addCol('category', 'category TEXT');
    addCol('occasion', 'occasion TEXT');
    addCol('animated', 'animated INTEGER');
    addCol('format', 'format TEXT');
    addCol('localPath', 'localPath TEXT');
    addCol('analyzed', 'analyzed INTEGER NOT NULL DEFAULT 0');
    addCol('contentHash', 'contentHash TEXT');
    // [2026-11-13] AI 收藏闸门判定结果；老数据默认 'unknown'
    addCol('verdict', "verdict TEXT NOT NULL DEFAULT 'unknown'");
    addCol('verdictReason', 'verdictReason TEXT');
  } catch { /* 迁移失败不阻塞启动 */ }

  // [2026-11-17] media 表迁移：补 contentHash 列（用于"跟图 +1"功能）
  try {
    const mcols2 = new Set(
      (db.prepare('PRAGMA table_info(media)').all() as any[]).map((c) => String(c.name)),
    );
    if (!mcols2.has('contentHash')) db.exec('ALTER TABLE media ADD COLUMN contentHash TEXT');
  } catch { /* 迁移失败不阻塞启动 */ }

  // [2026-11-12] messages 表迁移：补 isCommand 列并回填历史数据
  try {
    const mcols = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as any[]).map((c) => String(c.name)),
    );
    if (!mcols.has('isCommand')) {
      db.exec('ALTER TABLE messages ADD COLUMN isCommand INTEGER NOT NULL DEFAULT 0');
      // 回填：文本以 # 或 / 开头的标记为命令（含全角）
      db.exec(`UPDATE messages SET isCommand = 1
               WHERE text LIKE '#%' OR text LIKE '/%' OR text LIKE '＃%' OR text LIKE '／%'`);
    }
  } catch { /* 迁移失败不阻塞启动 */ }

  // 预置分类（若表为空）
  try {
    const cnt = db.prepare('SELECT COUNT(*) c FROM sticker_categories').get() as any;
    if (Number(cnt?.c ?? 0) === 0) {
      const ins = db.prepare('INSERT INTO sticker_categories (name, createdAt, count) VALUES (?, ?, 0)');
      const now = new Date().toISOString();
      for (const name of ['欢乐', '疑问', '尴尬', '无语', '嘲讽', '惊讶', '安慰', '生气', '卖萌', '认同', '告别', '求助']) {
        ins.run(name, now);
      }
    }
  } catch { /* 忽略 */ }

  const insMsg = db.prepare(`
    INSERT INTO messages (ts, peerKey, kind, userId, nickname, text, images, isSticker, tag, isCommand)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insSticker = db.prepare(`
    INSERT INTO stickers (url, source, userId, firstSeen, lastSeen, count) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(url) DO UPDATE SET count = count + 1, lastSeen = excluded.lastSeen
  `);
  const selRecent = db.prepare(`SELECT * FROM messages ORDER BY id DESC LIMIT ?`);
  const selUnlearned = db.prepare(`SELECT * FROM messages WHERE learned = 0 AND isCommand = 0 ORDER BY id ASC LIMIT ?`);
  const updLearned = db.prepare(`UPDATE messages SET learned = 1 WHERE id = ?`);
  const selTop = db.prepare(`SELECT * FROM stickers ORDER BY count DESC, lastSeen DESC LIMIT ?`);
  const selUnanalyzed = db.prepare(`SELECT * FROM stickers WHERE analyzed = 0 LIMIT ?`);
  const updAnalysis = db.prepare(`UPDATE stickers SET description=?, emotion=?, category=?, occasion=?, animated=?, format=?, localPath=?, analyzed=1, contentHash=COALESCE(?, contentHash) WHERE url=?`);
  const selByHash = db.prepare(`SELECT * FROM stickers WHERE contentHash = ? AND analyzed = 1 LIMIT 1`);
  const selRandom = db.prepare(`SELECT * FROM stickers WHERE analyzed = 1 AND (? IS NULL OR category = ?) ORDER BY RANDOM() LIMIT 1`);
  const selCats = db.prepare(`SELECT * FROM sticker_categories ORDER BY count DESC, name`);
  const insCat = db.prepare(`INSERT INTO sticker_categories (name, createdAt, count) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING`);
  const bumpCat = db.prepare(`
    INSERT INTO sticker_categories (name, createdAt, count) VALUES (?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET count = count + 1
  `);
  const selByCat = db.prepare(`SELECT category, COUNT(*) c FROM stickers WHERE analyzed = 1 GROUP BY category ORDER BY c DESC`);
  const cntMsg = db.prepare(`SELECT COUNT(*) c FROM messages`);
  const cntSt = db.prepare(`SELECT COUNT(*) c FROM stickers`);
  const cntPat = db.prepare(`SELECT COUNT(*) c FROM patterns`);
  const insPat = db.prepare(`
    INSERT INTO patterns (key, value, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
  `);
  const selPat = db.prepare(`SELECT * FROM patterns ORDER BY updatedAt DESC`);
  // [2026-11-13] AI 闸门 / audit 相关语句
  const updVerdict = db.prepare(`UPDATE stickers SET verdict = ?, verdictReason = ? WHERE url = ?`);
  const selAllSt = db.prepare(`SELECT * FROM stickers ORDER BY count DESC, lastSeen DESC LIMIT ?`);
  const delSt = db.prepare(`DELETE FROM stickers WHERE url = ?`);
  const selRejected = db.prepare(`SELECT * FROM stickers WHERE verdict = 'rejected' ORDER BY count DESC, lastSeen DESC LIMIT ?`);
  // [2026-11-16] 媒体原件库语句
  const insMedia = db.prepare(`
    INSERT INTO media (ts, peerKey, userId, nickname, url) VALUES (?, ?, ?, ?, ?)
  `);
  const updMediaDownloaded = db.prepare(`
    UPDATE media SET localPath=?, format=?, animated=?, bytes=?, contentHash=COALESCE(?, contentHash),
      downloadState='ok', downloadError=NULL WHERE id=?
  `);
  // [2026-11-17] 找"同群同一张图被不同人重复发送"：按 contentHash 分组，组内不同发送者 >= 2 才算
  // 参数顺序：peerKey, sinceIso, limit
  // [2026-11-18] 按群统计表情包频次（不同发送人数作为分组指标）
  // [2026-11-19] 取群聊最近 N 条消息
  const selRecentInPeer = db.prepare(`
    SELECT ts, nickname, userId, text, images, isSticker
    FROM messages WHERE peerKey = ? ORDER BY id DESC LIMIT ?
  `);
  // 按时间取这些消息对应的图片分析结果（同一会话、相同时间范围内）
  const selFreqInPeer = db.prepare(`
    SELECT contentHash,
           COUNT(*) AS cnt,
           COUNT(DISTINCT userId) AS senders,
           MAX(localPath) AS localPath
    FROM media
    WHERE peerKey = ? AND downloadState = 'ok' AND contentHash IS NOT NULL AND ts >= ?
    GROUP BY contentHash
    ORDER BY senders DESC, cnt DESC
    LIMIT ?
  `);
  const selNeedHash = db.prepare(`
    SELECT * FROM media WHERE downloadState='ok' AND contentHash IS NULL
      AND localPath IS NOT NULL AND localPath <> '' ORDER BY id ASC LIMIT ?
  `);
  const updMediaHash = db.prepare(`UPDATE media SET contentHash = ? WHERE id = ?`);
  const selRepeatedInPeer = db.prepare(`
    SELECT m.* FROM media m
    JOIN (
      SELECT contentHash, MAX(ts) AS latestTs, COUNT(DISTINCT userId) AS senders
      FROM media
      WHERE peerKey = ? AND downloadState = 'ok' AND contentHash IS NOT NULL AND ts >= ?
      GROUP BY contentHash
      HAVING senders >= 2
    ) g ON m.contentHash = g.contentHash AND m.ts = g.latestTs
    WHERE m.peerKey = ? AND m.downloadState = 'ok'
    ORDER BY m.ts DESC LIMIT ?
  `);
  const updMediaFailed = db.prepare(`UPDATE media SET downloadState='failed', downloadError=? WHERE id=?`);
  const selPendingDownload = db.prepare(`
    SELECT * FROM media WHERE downloadState='pending' AND attempts < ? ORDER BY id ASC LIMIT ?
  `);
  const selPendingOrganize = db.prepare(`
    SELECT * FROM media WHERE status='new' AND downloadState='ok' AND attempts < ? ORDER BY id ASC LIMIT ?
  `);
  const updMediaAnalysis = db.prepare(`
    UPDATE media SET status=?, verdict=?, category=?, description=?, emotion=?, meme=?, analyzedAt=? WHERE id=?
  `);
  const bumpMediaAttempt = db.prepare(`UPDATE media SET attempts = attempts + 1 WHERE id = ?`);
  const cntMediaTotal = db.prepare(`SELECT COUNT(*) c FROM media`);
  const cntMediaPendingDl = db.prepare(`SELECT COUNT(*) c FROM media WHERE downloadState='pending'`);
  const cntMediaDlOk = db.prepare(`SELECT COUNT(*) c FROM media WHERE downloadState='ok'`);
  const cntMediaDlFail = db.prepare(`SELECT COUNT(*) c FROM media WHERE downloadState='failed'`);
  // [2026-11-16] "待整理"必须是已下载完成的记录；只登记没下载的不算
  const cntMediaNew = db.prepare(`SELECT COUNT(*) c FROM media WHERE status='new' AND downloadState='ok'`);
  const cntMediaAnalyzed = db.prepare(`SELECT COUNT(*) c FROM media WHERE status='analyzed'`);
  const cntMediaNotSticker = db.prepare(`SELECT COUNT(*) c FROM media WHERE status='not_sticker'`);

  return {
    backend: 'sqlite',
    addMessage(m) {
      insMsg.run(m.ts, m.peerKey, m.kind, m.userId, m.nickname, m.text,
        JSON.stringify(m.images ?? []), m.isSticker ? 1 : 0, m.tag ?? null, m.isCommand ? 1 : 0);
    },
    addSticker(url, peerKey, userId) {
      const now = new Date().toISOString();
      insSticker.run(url, peerKey, userId, now, now);
    },
    recentMessages(n) {
      return (selRecent.all(n) as any[]).map(toMessage);
    },
    unlearnedMessages(limit) {
      return (selUnlearned.all(limit) as any[]).map(toMessage);
    },
    markLearned(ids) {
      for (const id of ids) updLearned.run(id);
    },
    topStickers(limit) {
      return selTop.all(limit) as StickerRecord[];
    },
    unanalyzedStickers(limit) {
      return selUnanalyzed.all(limit) as StickerRecord[];
    },
    saveStickerAnalysis(url, a) {
      updAnalysis.run(a.description, a.emotion, a.category, a.occasion,
        a.animated ? 1 : 0, a.format, a.localPath ?? null, a.contentHash ?? null, url);
      // 分类自驱动扩充：新类目自动创建
      bumpCat.run(a.category, new Date().toISOString());
    },
    randomSticker(category) {
      const c = category ?? null;
      const r = selRandom.get(c, c) as StickerRecord | undefined;
      return r ?? null;
    },
    listCategories() {
      return selCats.all() as StickerCategory[];
    },
    findStickerByHash(hash) {
      if (!hash) return null;
      return (selByHash.get(hash) as StickerRecord | undefined) ?? null;
    },
    // [2026-11-13] AI 闸门判定与 audit 支持
    setVerdict(url, verdict, reason) {
      updVerdict.run(verdict, reason ?? '', url);
    },
    allStickers(limit) {
      return selAllSt.all(limit) as StickerRecord[];
    },
    deleteSticker(url) {
      return Number(delSt.run(url)?.changes ?? 0) > 0;
    },
    rejectedStickers(limit) {
      return selRejected.all(limit) as StickerRecord[];
    },
    stickerStatsByCategory() {
      return (selByCat.all() as any[]).map((r) => ({ category: String(r.category), count: Number(r.c) }));
    },
    counts() {
      return {
        messages: Number((cntMsg.get() as any)?.c ?? 0),
        stickers: Number((cntSt.get() as any)?.c ?? 0),
        patterns: Number((cntPat.get() as any)?.c ?? 0),
      };
    },
    savePattern(key, value) {
      insPat.run(key, value, new Date().toISOString());
    },
    loadPatterns() {
      return selPat.all() as Array<{ key: string; value: string; updatedAt: string }>;
    },
    purge() {
      db.exec('DELETE FROM messages; DELETE FROM stickers; DELETE FROM patterns;');
    },
    purgePeer(peerKey) {
      const r = db.prepare('DELETE FROM messages WHERE peerKey = ?').run(peerKey);
      // 该会话来源的表情包也清掉（同一表情包可能被多人发过，这里按 source 清）
      db.prepare('DELETE FROM stickers WHERE source = ?').run(peerKey);
      return Number(r?.changes ?? 0);
    },
    // [2026-11-16] 媒体原件库实现
    addMedia(m) {
      const r = insMedia.run(m.ts, m.peerKey, m.userId, m.nickname, m.url);
      return Number(r?.lastInsertRowid ?? 0);
    },
    markMediaDownloaded(id, info) {
      updMediaDownloaded.run(info.localPath, info.format, info.animated ? 1 : 0, info.bytes,
        info.contentHash ?? null, id);
    },
    repeatedImagesInPeer(peerKey, sinceIso, limit) {
      return selRepeatedInPeer.all(
        peerKey, sinceIso, peerKey, Math.max(1, limit ?? 5),
      ) as unknown as MediaRecord[];
    },
    mediaNeedingHash(limit) {
      return selNeedHash.all(Math.max(1, limit)) as unknown as MediaRecord[];
    },
    recentMessagesInPeer(peerKey, limit) {
      const rows = selRecentInPeer.all(peerKey, Math.max(1, limit)) as any[];
      // 图片描述：从 media 表按同会话 + 时间接近的记录里找（用于让模型"看到"图里是什么）
      const descRows = db.prepare(`
        SELECT ts, description FROM media
        WHERE peerKey = ? AND description IS NOT NULL AND description <> ''
        ORDER BY ts DESC LIMIT 60
      `).all(peerKey) as any[];
      const descByTs = new Map<string, string>();
      for (const d of descRows) descByTs.set(String(d.ts).slice(0, 19), String(d.description));
      return rows.map((r) => {
        let images: string[] = [];
        try { images = JSON.parse(r.images ?? '[]'); } catch { images = []; }
        const key = String(r.ts).slice(0, 19);
        const desc = descByTs.get(key);
        return {
          ts: String(r.ts), nickname: String(r.nickname ?? ''),
          userId: String(r.userId ?? ''), text: String(r.text ?? ''),
          hasImage: Array.isArray(images) && images.length > 0,
          isSticker: r.isSticker === 1,
          imageDescriptions: desc ? [desc.slice(0, 120)] : [],
        };
      });
    },
    stickerFrequencyInPeer(peerKey, sinceIso, limit) {
      const rows = selFreqInPeer.all(peerKey, sinceIso, Math.max(1, limit ?? 200)) as any[];
      return rows.map((r) => ({
        contentHash: String(r.contentHash),
        count: Number(r.cnt),
        senders: Number(r.senders),
        localPath: r.localPath ? String(r.localPath) : undefined,
      }));
    },
    setMediaHash(id, contentHash) {
      updMediaHash.run(contentHash, id);
    },
    markMediaDownloadFailed(id, error) {
      updMediaFailed.run(String(error ?? '').slice(0, 300), id);
    },
    pendingDownloads(limit) {
      return selPendingDownload.all(MAX_MEDIA_ATTEMPTS, limit) as unknown as MediaRecord[];
    },
    pendingOrganize(limit) {
      return selPendingOrganize.all(MAX_MEDIA_ATTEMPTS, limit) as unknown as MediaRecord[];
    },
    saveMediaAnalysis(id, r) {
      updMediaAnalysis.run(
        r.verdict === 'sticker' ? 'analyzed' : 'not_sticker',
        r.verdict, r.category ?? null, r.description ?? null,
        r.emotion ?? null, r.meme ?? null, new Date().toISOString(), id,
      );
    },
    bumpMediaAttempts(id) { bumpMediaAttempt.run(id); },
    mediaStats() {
      const n = (st: any) => Number(st.get()?.c ?? 0);
      return {
        total: n(cntMediaTotal),
        pendingDownload: n(cntMediaPendingDl),
        downloaded: n(cntMediaDlOk),
        downloadFailed: n(cntMediaDlFail),
        new_: n(cntMediaNew),
        analyzed: n(cntMediaAnalyzed),
        notSticker: n(cntMediaNotSticker),
      };
    },
    close() { try { db.close(); } catch { /* 忽略 */ } },
  };
}

function toMessage(r: any): CollectedMessage {
  let images: string[] = [];
  try { images = JSON.parse(r.images ?? '[]'); } catch { images = []; }
  return {
    ts: r.ts, peerKey: r.peerKey, kind: r.kind, userId: String(r.userId),
    nickname: r.nickname, text: r.text, images,
    isSticker: r.isSticker === 1, tag: r.tag ?? undefined,
    isCommand: r.isCommand === 1,
  };
}

/** JSONL 降级实现（SQLite 不可用时） */
function openJsonl(file: string): ChatStore {
  const base = file.replace(/\.db$/, '');
  const msgFile = `${base}-messages.jsonl`;
  const stFile = `${base}-stickers.json`;
  const mediaFile = `${base}-media.json`;  // [2026-11-16] 媒体原件库（降级实现）
  const readMedia = (): MediaRecord[] => {
    try { return JSON.parse(fs.readFileSync(mediaFile, 'utf8')); } catch { return []; }
  };
  const writeMedia = (v: MediaRecord[]) => fs.writeFileSync(mediaFile, JSON.stringify(v, null, 2));
  const patFile = `${base}-patterns.json`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const readMsgs = (): Array<CollectedMessage & { _learned?: boolean }> => {
    try {
      return fs.readFileSync(msgFile, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean) as any[];
    } catch { return []; }
  };
  const readSt = (): StickerRecord[] => {
    try { return JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch { return []; }
  };
  const writeSt = (v: StickerRecord[]) => fs.writeFileSync(stFile, JSON.stringify(v, null, 2));
  const readPat = (): Array<{ key: string; value: string; updatedAt: string }> => {
    try { return JSON.parse(fs.readFileSync(patFile, 'utf8')); } catch { return []; }
  };
  return {
    backend: 'jsonl',
    addMessage(m) { fs.appendFileSync(msgFile, JSON.stringify(m) + '\n'); },
    addSticker(url, peerKey, userId) {
      const now = new Date().toISOString();
      const list = readSt();
      const hit = list.find((x) => x.url === url);
      if (hit) { hit.count++; hit.lastSeen = now; } else {
        list.push({ url, source: peerKey, userId, firstSeen: now, lastSeen: now, count: 1 });
      }
      writeSt(list);
    },
    recentMessages(n) { return readMsgs().slice(-n).reverse(); },
    unlearnedMessages(limit) { return readMsgs().filter((m) => !m._learned).slice(0, limit); },
    markLearned(ids) {
      const all = readMsgs();
      // JSONL 简化实现：按位置标记
      for (const id of ids) if (all[id]) all[id]._learned = true;
      fs.writeFileSync(msgFile, all.map((m) => JSON.stringify(m)).join('\n') + '\n');
    },
    topStickers(limit) { return readSt().sort((a, b) => b.count - a.count).slice(0, limit); },
    // [2026-11-13] AI 闸门判定与 audit 支持（JSONL 降级实现）
    setVerdict(url, verdict, reason) {
      const list = readSt();
      const hit = list.find((x) => x.url === url);
      if (!hit) return;
      hit.verdict = verdict;
      hit.verdictReason = reason ?? '';
      writeSt(list);
    },
    allStickers(limit) {
      return readSt().sort((a, b) => b.count - a.count).slice(0, limit);
    },
    deleteSticker(url) {
      const list = readSt();
      const kept = list.filter((x) => x.url !== url);
      if (kept.length === list.length) return false;
      writeSt(kept);
      return true;
    },
    rejectedStickers(limit) {
      return readSt().filter((x) => x.verdict === 'rejected').slice(0, limit);
    },
    // [2026-11-16] 媒体原件库（JSONL 降级实现，语义与 SQLite 一致）
    addMedia(m) {
      const list = readMedia();
      const id = (list.reduce((mx, x) => Math.max(mx, x.id), 0) || 0) + 1;
      list.push({
        id, ts: m.ts, peerKey: m.peerKey, userId: m.userId, nickname: m.nickname, url: m.url,
        downloadState: 'pending', status: 'new', attempts: 0,
      });
      writeMedia(list);
      return id;
    },
    markMediaDownloaded(id, info) {
      const list = readMedia();
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.localPath = info.localPath; hit.format = info.format;
      hit.animated = info.animated ? 1 : 0; hit.bytes = info.bytes;
      if (info.contentHash) hit.contentHash = info.contentHash;
      hit.downloadState = 'ok'; hit.downloadError = null;
      writeMedia(list);
    },
    recentMessagesInPeer(peerKey, limit) {
      const msgs = readMsgs().filter((m) => m.peerKey === peerKey).slice(-Math.max(1, limit)).reverse();
      const media = readMedia();
      return msgs.map((m: any) => {
        const images = Array.isArray(m.images) ? m.images : [];
        // 找同一会话中时间最接近、且有描述的媒体
        const t = new Date(m.ts).getTime();
        let best: MediaRecord | null = null;
        let bestDiff = Infinity;
        for (const md of media) {
          if (md.peerKey !== peerKey || !md.description) continue;
          const diff = Math.abs(new Date(md.ts).getTime() - t);
          if (diff < bestDiff) { bestDiff = diff; best = md; }
        }
        return {
          ts: String(m.ts), nickname: String(m.nickname ?? ''), userId: String(m.userId ?? ''),
          text: String(m.text ?? ''), hasImage: images.length > 0,
          isSticker: m.isSticker === true,
          imageDescriptions: best && bestDiff < 120000 ? [String(best.description).slice(0, 120)] : [],
        };
      });
    },
    stickerFrequencyInPeer(peerKey, sinceIso, limit) {
      const list = readMedia().filter((x) =>
        x.peerKey === peerKey && x.downloadState === 'ok' && x.contentHash && x.ts >= sinceIso);
      const groups = new Map<string, { count: number; users: Set<string>; localPath?: string }>();
      for (const x of list) {
        const g = groups.get(x.contentHash!) ?? { count: 0, users: new Set<string>(), localPath: undefined };
        g.count++;
        g.users.add(x.userId);
        if (!g.localPath && x.localPath) g.localPath = x.localPath;
        groups.set(x.contentHash!, g);
      }
      return [...groups.entries()]
        .map(([contentHash, g]) => ({
          contentHash, count: g.count, senders: g.users.size, localPath: g.localPath,
        }))
        .sort((a, b) => b.senders - a.senders || b.count - a.count)
        .slice(0, Math.max(1, limit ?? 200));
    },
    mediaNeedingHash(limit) {
      return readMedia()
        .filter((x) => x.downloadState === 'ok' && !x.contentHash && x.localPath)
        .slice(0, Math.max(1, limit));
    },
    setMediaHash(id, contentHash) {
      const list = readMedia();
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.contentHash = contentHash;
      writeMedia(list);
    },
    repeatedImagesInPeer(peerKey, sinceIso, limit) {
      const list = readMedia().filter((x) =>
        x.peerKey === peerKey && x.downloadState === 'ok' && x.contentHash && x.ts >= sinceIso);
      // 按 contentHash 分组，统计不同发送者数量
      const groups = new Map<string, MediaRecord[]>();
      for (const x of list) {
        const g = groups.get(x.contentHash!) ?? [];
        g.push(x);
        groups.set(x.contentHash!, g);
      }
      const out: MediaRecord[] = [];
      for (const [, g] of groups) {
        if (new Set(g.map((x) => x.userId)).size < 2) continue;
        g.sort((a, b) => (a.ts < b.ts ? 1 : -1));
        out.push(g[0]!);
      }
      return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, Math.max(1, limit ?? 5));
    },
    markMediaDownloadFailed(id, error) {
      const list = readMedia();
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.downloadState = 'failed'; hit.downloadError = String(error ?? '').slice(0, 300);
      writeMedia(list);
    },
    pendingDownloads(limit) {
      return readMedia().filter((x) => x.downloadState === 'pending' && (x.attempts ?? 0) < MAX_MEDIA_ATTEMPTS).slice(0, limit);
    },
    pendingOrganize(limit) {
      return readMedia().filter((x) => x.status === 'new' && x.downloadState === 'ok' && (x.attempts ?? 0) < MAX_MEDIA_ATTEMPTS).slice(0, limit);
    },
    saveMediaAnalysis(id, r) {
      const list = readMedia();
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.status = r.verdict === 'sticker' ? 'analyzed' : 'not_sticker';
      hit.verdict = r.verdict; hit.category = r.category ?? null;
      hit.description = r.description ?? null; hit.emotion = r.emotion ?? null;
      hit.meme = r.meme ?? null; hit.analyzedAt = new Date().toISOString();
      writeMedia(list);
    },
    bumpMediaAttempts(id) {
      const list = readMedia();
      const hit = list.find((x) => x.id === id);
      if (!hit) return;
      hit.attempts = (hit.attempts ?? 0) + 1;
      writeMedia(list);
    },
    mediaStats() {
      const list = readMedia();
      return {
        total: list.length,
        pendingDownload: list.filter((x) => x.downloadState === 'pending').length,
        downloaded: list.filter((x) => x.downloadState === 'ok').length,
        downloadFailed: list.filter((x) => x.downloadState === 'failed').length,
        new_: list.filter((x) => x.status === 'new' && x.downloadState === 'ok').length,
        analyzed: list.filter((x) => x.status === 'analyzed').length,
        notSticker: list.filter((x) => x.status === 'not_sticker').length,
      };
    },
    counts() {
      return { messages: readMsgs().length, stickers: readSt().length, patterns: readPat().length };
    },
    savePattern(key, value) {
      const list = readPat().filter((p) => p.key !== key);
      list.push({ key, value, updatedAt: new Date().toISOString() });
      fs.writeFileSync(patFile, JSON.stringify(list, null, 2));
    },
    loadPatterns() { return readPat(); },
    purgePeer(peerKey) {
      const all = readMsgs();
      const kept = all.filter((m) => m.peerKey !== peerKey);
      fs.writeFileSync(msgFile, kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''));
      const st2 = readSt().filter((x) => x.source !== peerKey);
      writeSt(st2);
      return all.length - kept.length;
    },
    purge() {
      try { fs.rmSync(msgFile, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(stFile, { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(patFile, { force: true }); } catch { /* 忽略 */ }
    },
    close() { /* 无需关闭 */ },
  };
}

export function openChatStore(file: string): ChatStore {
  try {
    return openSqlite(file);
  } catch (e) {
    process.stderr.write(`[chat-store] SQLite 不可用，降级 JSONL：${(e as Error).message}\n`);
    return openJsonl(file);
  }
}

/**
 * [2026-11-12] 判断一条消息里的图片是不是"表情包"。
 * 依据：URL 含 qq_expression（QQ 表情）、尺寸标签、或消息体很小且带图片。
 */
export function looksLikeSticker(url: string, text: string): boolean {
  const u = String(url ?? '');
  if (u.includes('qq_expression')) return true;
  // OneBot 会给出 [图片] 这类占位；纯图无文字更可能是表情
  if (text.trim() === '' || /^\[(image|face|mface)\]$/.test(text.trim())) return true;
  return false;
}
