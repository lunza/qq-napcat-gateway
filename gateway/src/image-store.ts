// [2026-11-12] 发图记录数据库（SQLite）
//
// 用途：
//   1. 记录每次发给谁、哪张图、原图链接、tag、文件属性
//   2. 当对方追问"这图里是什么"时，按会话查出最近发过的图，作为上下文交给模型
//
// 只用 Node 自带的 node:sqlite（Node 22+ 内置），不引第三方依赖。
// 若运行时不支持，则降级为 JSONL 文件，功能不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// node:sqlite 是 Node 内置模块，用 createRequire 便于在 ESM 下同步加载并做降级判断
const require = createRequire(import.meta.url);

export interface ImageRecord {
  id?: number;
  ts: string;             // ISO 时间
  peerKey: string;        // private:<uin> / group:<gid>
  postUrl: string;        // https://e621.net/posts/<id>
  postId: string;
  imageUrl: string;       // 原图地址
  ext: string;            // jpg/png/gif...
  sizeBytes?: number;
  tags: string[];         // 全部 tag
  artist?: string;        // 作者相关 tag
  species?: string;       // 物种/角色相关 tag
  query?: string;         // 触发它的原文，如 #来点色图
}

export interface ImageStore {
  add(rec: ImageRecord): void;
  /** 某会话最近的 n 条（新的在前） */
  recent(peerKey: string, n: number): ImageRecord[];
  /** 全部条数 */
  count(): number;
  close(): void;
  /** [2026-11-12] 清理某会话的图片记录，返回删除数 */
  purgePeer(peerKey: string): number;
  /** [2026-11-13] 最近的图片发送记录（用于恢复群级去重） */
  recentStickerSends(limit: number): Array<{ peerKey: string; postId: string }>;
  /** 实际使用的后端：sqlite 或 jsonl */
  backend: 'sqlite' | 'jsonl';
}

/** SQLite 实现 */
function openSqlite(file: string): ImageStore {
  // 同步加载，不支持时抛错 -> 上层降级为 JSONL
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => any };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      peerKey TEXT NOT NULL,
      postUrl TEXT NOT NULL,
      postId TEXT NOT NULL,
      imageUrl TEXT NOT NULL,
      ext TEXT NOT NULL,
      sizeBytes INTEGER,
      tags TEXT NOT NULL,
      artist TEXT,
      species TEXT,
      query TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_images_peer_ts ON images (peerKey, ts DESC);
  `);
  const insert = db.prepare(`
    INSERT INTO images (ts, peerKey, postUrl, postId, imageUrl, ext, sizeBytes, tags, artist, species, query)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecent = db.prepare(`
    SELECT * FROM images WHERE peerKey = ? ORDER BY ts DESC, id DESC LIMIT ?
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM images');
  const selSends = db.prepare('SELECT peerKey, postId FROM images ORDER BY id DESC LIMIT ?');
  return {
    backend: 'sqlite',
    add(rec) {
      insert.run(
        rec.ts, rec.peerKey, rec.postUrl, rec.postId, rec.imageUrl, rec.ext,
        rec.sizeBytes ?? null, JSON.stringify(rec.tags ?? []),
        rec.artist ?? null, rec.species ?? null, rec.query ?? null,
      );
    },
    recent(peerKey, n) {
      return (selectRecent.all(peerKey, n) as any[]).map((r) => ({
        ...r,
        tags: safeParse(r.tags),
      })) as ImageRecord[];
    },
    count() {
      return Number((countStmt.get() as any)?.c ?? 0);
    },
    purgePeer(peerKey) {
      const r = db.prepare('DELETE FROM images WHERE peerKey = ?').run(peerKey);
      return Number(r?.changes ?? 0);
    },
    recentStickerSends(limit) {
      return (selSends.all(limit) as any[]).map((r) => ({ peerKey: String(r.peerKey), postId: String(r.postId) }));
    },
    close() { try { db.close(); } catch { /* 忽略 */ } },
  };
}

/** JSONL 降级实现 */
function openJsonl(file: string): ImageStore {
  const jsonl = file.replace(/\.db$/, '.jsonl');
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  const readAll = (): ImageRecord[] => {
    try {
      return fs.readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as ImageRecord; } catch { return null; } })
        .filter((x): x is ImageRecord => x !== null);
    } catch { return []; }
  };
  return {
    backend: 'jsonl',
    add(rec) { fs.appendFileSync(jsonl, JSON.stringify(rec) + '\n', 'utf8'); },
    recent(peerKey, n) {
      return readAll().filter((r) => r.peerKey === peerKey).slice(-n).reverse();
    },
    count() { return readAll().length; },
    recentStickerSends(limit) {
      return readAll().slice(-limit).reverse().map((r) => ({ peerKey: r.peerKey, postId: r.postId }));
    },
    purgePeer(peerKey) {
      const all = readAll();
      const kept = all.filter((r) => r.peerKey !== peerKey);
      fs.writeFileSync(jsonl, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      return all.length - kept.length;
    },
    close() { /* 无需关闭 */ },
  };
}

function safeParse(s: unknown): string[] {
  if (Array.isArray(s)) return s as string[];
  try { const v = JSON.parse(String(s ?? '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** 打开数据库：优先 SQLite，失败降级 JSONL */
export function openImageStore(file: string): ImageStore {
  try {
    return openSqlite(file);
  } catch (e) {
    process.stderr.write(`[image-store] SQLite 不可用，降级 JSONL：${(e as Error).message}\n`);
    return openJsonl(file);
  }
}
