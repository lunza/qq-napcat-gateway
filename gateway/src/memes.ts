// [2026-11-12] 网络梗知识库
//
// 背景：表情包大量来自网络热梗，模型凭画面猜出处会**编造**。
// 方案：建一个可人工维护的梗库，分析时先做关键词匹配，
//       命中的梗直接作为事实注入模型；未命中的才让模型自由判断（且禁止编造出处）。
//
// 存储：state/memes.json，结构：
//   {
//     "阿伟": { "keywords": ["阿伟","彬彬","逊","杰哥"], "name": "杰哥不要", "meaning": "...", "source": "..." },
//     ...
//   }
import fs from 'node:fs';
import path from 'node:path';

export interface MemeEntry {
  /** 触发关键词（出现在画面文字或画面元素描述里） */
  keywords: string[];
  /** 梗名 */
  name: string;
  /** 含义/用法 */
  meaning: string;
  /** 出处 */
  source: string;
  /** 适用分类建议 */
  category?: string;
  /**
   * [2026-11-16] 世界书字段（SillyTavern 风格）：
   * - enabled=false：停用该条目（关键词与向量匹配都跳过）
   * - constant=true：蓝灯，每轮无条件注入、不受冷却限制（默认 false=绿灯，关键词触发）
   */
  enabled?: boolean;
  constant?: boolean;
}

export interface MemeLibrary {
  /** 全部条目 */
  all(): MemeEntry[];
  /** 按文本匹配（返回命中的条目） */
  match(text: string): MemeEntry[];
  /** 新增/覆盖（以 name 为键） */
  upsert(entry: MemeEntry): void;
  /** 删除 */
  remove(name: string): boolean;
  /** 落盘 */
  save(): void;
}

/**
 * [2026-11-16] 梗库关键词匹配（含短词防误命中）。
 *
 * 背景：原来是纯子串匹配 `t.includes(k)`。梗库里有大量单字/两字关键词
 * （「猫」「逊」「典」「绷」「瞪」等），而视觉模型给的画面描述很长，
 * 一个「猫」字就命中「猫猫震惊」——梗库命中后又会走二次分析分支，
 * 历史上正是这条路径触发了 bytes 丢失的 bug，导致 5 次分析中断。
 *
 * 规则：
 *   - 3 字及以上：仍用子串匹配（「绷不住」「破防」这类歧义小）
 *   - 2 字：要求出现在描述里，且不是更长词组的一部分也算命中（保持原有宽松度）
 *   - **单字：不再匹配**，歧义太大（「猫」会命中所有猫图，「典」会命中「字典」）
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const k = String(keyword ?? '').trim();
  if (!k) return false;
  if (k.length <= 1) return false;   // 单字关键词一律不参与匹配
  return text.includes(k);
}

const DEFAULT_MEMES: Record<string, MemeEntry> = {
  '杰哥不要': {
    keywords: ['阿伟', '彬彬', '逊', '杰哥', '不要啊'],
    name: '杰哥不要',
    meaning: '台湾性教育宣导片名场面。台词“这个阿伟就是逊啦”被网友玩梗成“这个彬彬就是逊”，用来嘲讽对方很菜、不行',
    source: '台湾宣导短片《杰哥不要》',
    category: '嘲讽',
  },
  '猫猫震惊': {
    keywords: ['猫', '睁大', '圆睁', '瞪', '震惊'],
    name: '猫猫震惊',
    meaning: '猫咪瞳孔放大、呆滞定格的图，表达极度震惊、难以置信',
    source: '网络猫咪表情包系列',
    category: '惊讶',
  },
  '就这': {
    keywords: ['就这'],
    name: '就这',
    meaning: '嘲讽对方表现远低于预期，含有“不过如此”的轻蔑',
    source: '网络流行语',
    category: '嘲讽',
  },
  '绷不住': {
    keywords: ['绷不住', '绷'],
    name: '绷不住',
    meaning: '忍不住笑了/情绪失控，常用于看到离谱或搞笑内容时',
    source: '网络流行语',
    category: '欢乐',
  },
  'yyds': {
    keywords: ['yyds', '永远的神'],
    name: 'yyds',
    meaning: '“永远的神”拼音缩写，用来吹捧某人/某事非常厉害',
    source: '网络流行语',
    category: '认同',
  },
  '典': {
    keywords: ['典', '经典'],
    name: '典',
    meaning: '“太典型了”的简写，嘲讽某种行为/言论非常符合刻板印象',
    source: '网络流行语',
    category: '嘲讽',
  },
  '破防': {
    keywords: ['破防'],
    name: '破防',
    meaning: '心理防线被击穿，指被戳到痛处或情绪崩溃',
    source: '网络流行语',
    category: '无语',
  },
  '666': {
    keywords: ['666', '六六六'],
    name: '666',
    meaning: '称赞对方操作厉害、反应快',
    source: '网络流行语',
    category: '认同',
  },
  '你礼貌吗': {
    keywords: ['你礼貌吗'],
    name: '你礼貌吗',
    meaning: '假客气地表达不满，觉得对方说的话/做的事很不合时宜',
    source: '网络流行语',
    category: '疑问',
  },
  '那咋了': {
    keywords: ['那咋了', '咋了'],
    name: '那咋了',
    meaning: '不以为然的回怼，表示“这有什么大不了的”',
    source: '网络流行语',
    category: '无语',
  },
};

/** 打开梗库（不存在则用内置默认并写入） */
export function openMemeLibrary(file: string): MemeLibrary {
  let data: Record<string, MemeEntry> = {};
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, MemeEntry>;
    }
  } catch { data = {}; }

  let dirty = false;
  if (Object.keys(data).length === 0) {
    data = { ...DEFAULT_MEMES };
    dirty = true;
  }

  const lib: MemeLibrary = {
    all: () => Object.values(data),
    match(text) {
      const t = String(text ?? '');
      if (t.trim() === '') return [];
      const hits: MemeEntry[] = [];
      for (const entry of Object.values(data)) {
        if (entry.enabled === false) continue;   // [2026-11-16] 世界书停用条目不参与匹配
        const kws = Array.isArray(entry.keywords) ? entry.keywords : [];
        if (kws.some((k) => k && matchesKeyword(t, k))) hits.push(entry);
      }
      return hits;
    },
    upsert(entry) {
      if (!entry?.name) return;
      data[entry.name] = entry;
      dirty = true;
    },
    remove(name) {
      if (!(name in data)) return false;
      delete data[name];
      dirty = true;
      return true;
    },
    save() {
      if (!dirty) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
    },
  };
  lib.save();
  return lib;
}

/** 把命中的梗整理成注入模型的段落 */
export function memesPromptSection(entries: MemeEntry[]): string {
  if (!entries || entries.length === 0) return '';
  const lines = ['【已知网络梗（来自梗库，可确信）】'];
  for (const e of entries.slice(0, 3)) {
    lines.push(`- ${e.name}：${cleanMemeText(e.meaning)}`);
    if (e.source) lines.push(`  出处：${cleanMemeText(e.source)}`);
    if (e.category) lines.push(`  建议分类：${e.category}`);
  }
  return lines.join('\n');
}

// ── [2026-11-16] 豆包采集噪音清洗 ──
// 豆包网页采集的回答尾部会混入界面残留（"微博哔哩哔哩""免费""下载电脑客户端"
// "今天 15:07" 等），注入给模型前必须洗掉。定义在本文件以避免与 worldbook.ts 循环依赖。

/** 整行删除的噪音（采集管道固定混入的 UI 文字） */
const NOISE_LINES = new Set([
  '下载电脑客户端', '立即下载', '自动完成复杂工作任务',
  '免费', '付费', '网页', '链接', '举报',
]);

/** 尾部平台词（"微博哔哩哔哩"这类来源串），只在文末连续出现时删 */
const TAIL_PLATFORM_WORDS = ['哔哩哔哩', '微博', '抖音', 'B站', 'b站', '小红书', '知乎'];

/** 相对时间戳行：今天 15:07 / 昨天 08:31 / 11-15 09:22 */
const TIMESTAMP_LINE_RE = /^(今天|昨天|前天)?\s*\d{1,2}[-/:]\d{1,2}\s*\d{1,2}:\d{2}$/;
const TIMESTAMP_LINE_RE2 = /^(今天|昨天|前天)\s*\d{1,2}:\d{2}$/;

export function cleanMemeText(s: string): string {
  let text = String(s ?? '');
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => {
    if (!l) return true;
    if (NOISE_LINES.has(l)) return false;
    if (TIMESTAMP_LINE_RE.test(l) || TIMESTAMP_LINE_RE2.test(l)) return false;
    return true;
  });
  text = lines.join('\n').trim();
  for (let i = 0; i < 10; i++) {
    const before = text;
    for (const w of TAIL_PLATFORM_WORDS) {
      if (text.endsWith(w)) text = text.slice(0, -w.length).trim();
    }
    if (text === before) break;
  }
  return text;
}
