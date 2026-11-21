// [2026-11-12] 自我升级：定期分析聊天记录，学习"人怎么聊天、什么时候发表情包"
//
// 设计（按用户要求：开创示例消息区域 + 定期整理分析更新）：
//   1. 每轮积累原始消息（chat-store）
//   2. 定时（默认 6 小时）跑一次分析：
//        - 统计平均回复长度、常用口头禅、表情包使用时机
//        - 产出结构化"沟通画像"
//   3. 画像写入 patterns 表，并**导出成示例消息文件**（state/learned/examples.md），
//      供模型在回复时参考（注入提示词）
//
// 重要：分析结果只影响"怎么说话"，不自动改人设与规则；改人设仍由用户在设置页操作。
import fs from 'node:fs';
import path from 'node:path';
import type { ChatStore, CollectedMessage } from './chat-store.ts';

export interface LearnedProfile {
  /** 分析样本条数 */
  sampleSize: number;
  /** 平均消息长度（字） */
  avgLength: number;
  /** 短句占比（<=10 字） */
  shortRatio: number;
  /** 高频口头禅/口癖 */
  catchphrases: string[];
  /** 表情包出现前的典型文字 */
  stickerTriggers: Array<{ before: string; count: number }>;
  /** 表情包使用频率（每百条消息） */
  stickerRate: number;
  /** 典型对话片段（示例消息区域） */
  examples: Array<{ speaker: string; text: string; followedBySticker: boolean }>;
  updatedAt: string;
}

/**
 * [2026-11-12] 把一条消息转成"语气样本"（简化可靠版）。
 *
 * 用户要求：学**语气**，不学**内容**。
 * 做法：不遮罩原文，而是**只抽取语气要素**，拼成一句"语气描述"。
 * 这样既不会泄漏具体内容，又保留了可利用的语气信息。
 *
 * 例：
 *   "我今天去吃了火锅哈哈哈" → "长句 + 结尾大笑"
 *   "这游戏也太难了吧？？"   → "中句 + 疑问语气(？？) + 语气词'吧'"
 *   "好家伙，原来是这么回事" → "中句 + 开头感叹'好家伙'"
 */
export function toToneSample(text: string): string {
  let t = String(text ?? '').trim();
  if (t === '') return '';
  if (/^[/／#＃]/.test(t)) return '';                       // 命令不学
  t = t.replace(/@\d+\s*/g, '').replace(/\[(image|face|mface|record|video|file)\]/gi, '');
  t = t.trim();
  if (t === '') return '';

  const parts: string[] = [];

  // 1) 句长
  const len = t.length;
  parts.push(len <= 5 ? '短句' : len <= 15 ? '中句' : len <= 30 ? '长句' : '超长句');

  // 2) 开头语气词
  const leadWords = ['好家伙', '不是吧', '我去', '我靠', '说真的', '啊这', '确实', '真的', '无语', '绝了', '笑死'];
  for (const w of leadWords) {
    if (t.startsWith(w)) { parts.push(`开头"${w}"`); break; }
  }

  // 3) 句中/句尾语气词
  const tailWords = ['哈哈哈', '哈哈', '嘿嘿', '嘻嘻', '呜呜', '笑死', '绷不住', '离谱', '绝了', '无语', '难绷', '就这'];
  for (const w of tailWords) {
    if (t.includes(w)) { parts.push(`含"${w}"`); break; }
  }

  // 4) 句末标点语气
  if (/[?？]{2,}/.test(t)) parts.push('叠问号');
  else if (/[?？]$/.test(t)) parts.push('疑问语气');
  if (/[!！]{2,}/.test(t)) parts.push('叠感叹号');
  else if (/[!！]$/.test(t)) parts.push('感叹语气');
  if (/[.…]{2,}|。{2,}/.test(t)) parts.push('省略号结尾');
  if (/[~～]/.test(t)) parts.push('波浪号');

  // 5) 句尾语气助词
  const tailParticles = ['吧', '呢', '啦', '呀', '嘛', '呗', '哦', '哈', '咯'];
  const stripped = t.replace(/[?？!！~～。…\s]+$/g, '');
  for (const p2 of tailParticles) {
    if (stripped.endsWith(p2)) { parts.push(`句尾"${p2}"`); break; }
  }

  // 6) emoji
  const emojis = (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []);
  if (emojis.length > 0) parts.push(`emoji${[...new Set(emojis)].slice(0, 3).join('')}`);

  // 7) 重复字（如"哈哈哈""啊啊"）
  if (/(.)\1{2,}/.test(t)) parts.push('有叠字');

  return parts.length > 1 ? parts.join(' + ') : '';
}

/**
 * [2026-11-12] 提取"语气口头禅"——**只保留语气词，不提取实词内容**。
 *
 * 用户要求：只学语气。所以这里不统计"火锅""游戏"这类实词，
 * 只统计语气词/口头禅，如"哈哈""好家伙""绝了""笑死"。
 */
const TONE_WORDS = [
  '哈哈哈', '哈哈', '嘿嘿', '呵呵', '嘻嘻', '啊啊', '呜呜', '呜呜呜',
  '好家伙', '笑死', '绝了', '离谱', '绷不住', '无语', '真服了', '服了',
  '确实', '有点', '真的', '不是吧', '我去', '我靠', '草', '啊这', 'emmm',
  '嗯嗯', '好的', '行吧', '算了', '就这', '绷', '乐', '典', '难绷',
  'www', 'hhh', 'hhh', 'qwq', 'xswl', 'yyds', '666',
];

export function extractCatchphrases(messages: CollectedMessage[], topN = 8): string[] {
  const counter = new Map<string, number>();
  for (const m of messages) {
    const text = String(m.text ?? '').replace(/\[[a-z]+\]/gi, ' ').trim();
    if (text === '') continue;
    // 只统计白名单里的语气词
    for (const w of TONE_WORDS) {
      if (text.includes(w)) counter.set(w, (counter.get(w) ?? 0) + 1);
    }
  }
  // [2026-11-16] 口癖多样化修复：门槛从「出现 ≥2 次」改为「占比 ≥3% 且 ≥5 次」。
  // 根因：281 条群消息里"笑死"只出现 2 次（0.7%），旧门槛把它包装成"群口头禅"
  // 注入模型 → 模型句句复读（用户指出这是口癖多样化漏洞：没有多个词可选，
  // 模型只会把注入的那个词当万能语气词）。统计上不成立的口癖就不该注入。
  const total = messages.length;
  const minCount = Math.max(5, Math.ceil(total * 0.03));
  return [...counter.entries()]
    .filter(([, c]) => total > 0 && c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

/** 分析：表情包一般跟在什么文字后面 */
export function analyzeStickerTriggers(messages: CollectedMessage[]): Array<{ before: string; count: number }> {
  const asc = [...messages].reverse(); // 旧 -> 新
  const counter = new Map<string, number>();
  for (let i = 1; i < asc.length; i++) {
    const cur = asc[i]!;
    const prev = asc[i - 1]!;
    if (!cur.isSticker) continue;
    if (prev.peerKey !== cur.peerKey) continue;
    // [2026-11-12] 只记语气样本，不记原文（避免学习具体内容）
    const tone = toToneSample(String(prev.text ?? ''));
    if (tone === '' || tone === '……') continue;
    counter.set(tone, (counter.get(tone) ?? 0) + 1);
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([before, count]) => ({ before, count }));
}

/** 生成示例消息区域（Markdown） */
export function renderExamples(profile: LearnedProfile): string {
  const lines: string[] = [];
  lines.push('# 学习到的聊天示例');
  lines.push('');
  lines.push(`> 自动生成于 ${profile.updatedAt}，样本 ${profile.sampleSize} 条。仅供模型参考表达方式，不要照抄。`);
  lines.push('');
  lines.push('## 沟通特征');
  lines.push('');
  lines.push(`- 平均消息长度：**${profile.avgLength} 字**`);
  lines.push(`- 短句占比（≤10 字）：**${Math.round(profile.shortRatio * 100)}%**`);
  lines.push(`- 表情包使用频率：**每百条 ${profile.stickerRate.toFixed(1)} 次**`);
  lines.push('');
  if (profile.catchphrases.length > 0) {
    lines.push('## 高频口头禅');
    lines.push('');
    lines.push(profile.catchphrases.map((c) => `\`${c}\``).join('、'));
    lines.push('');
    // [2026-11-16] 防口癖固化：口头禅列表每轮注入会让模型句句模仿同一个词
    // （实测每条回复都以"笑死"收尾）。写明使用约束。
    lines.push('> 口癖只参考表达方式、偶尔点缀；不要每条消息都用同一个口头禅开头或收尾。');
    lines.push('');
  }
  if (profile.stickerTriggers.length > 0) {
    lines.push('## 表情包常见触发场景（这些话之后常跟表情包）');
    lines.push('');
    for (const s of profile.stickerTriggers) lines.push(`- 「${s.before}」（${s.count} 次）`);
    lines.push('');
  }
  if (profile.examples.length > 0) {
    lines.push('## 示例对话片段');
    lines.push('');
    for (const e of profile.examples) {
      lines.push(`${e.speaker}：${e.text}${e.followedBySticker ? '  [随后发了表情包]' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 跑一次分析，返回画像并落盘 */
export function analyze(store: ChatStore, outDir: string, selfUin = ''): LearnedProfile {
  const raw = store.recentMessages(2000);
  // [2026-11-12] 只学习**别人**发的消息：显式排除机器人自己
  const sample = selfUin ? raw.filter((m) => String(m.userId) !== String(selfUin)) : raw;
  // [2026-11-12] 只学习"真人聊天"——三重保险：
  //   ① analyze 入口已按 selfUin 排除机器人自己
  //   ② 收集时打了 isCommand 标记的，这里再排除一次
  //   ③ 文本以 # 或 / 开头的，再兜底排除一次
  const real = sample.filter((m) => {
    const txt = String(m.text ?? '').trim();
    if (txt === '') return false;
    if (m.isCommand === true) return false;                        // ② 命令标记
    if (/^[/／#＃]/.test(txt)) return false;                        // ③ 前缀兜底
    if (/^\[(image|face|mface)\]$/i.test(txt)) return false;      // 纯表情不学
    return toToneSample(txt) !== '';
  });

  const totalLen = real.reduce((s, m) => s + String(m.text).length, 0);
  const avgLength = real.length > 0 ? Math.round((totalLen / real.length) * 10) / 10 : 0;
  const shortCount = real.filter((m) => String(m.text).length <= 10).length;
  // [2026-11-12] 表情包统计也只基于"已排除自身与命令"的样本
  const stickerCount = real.filter((m) => m.isSticker).length;

  const profile: LearnedProfile = {
    // [2026-11-12] 修正：样本数应为"排除自身与命令后"的实际学习样本
    sampleSize: real.length,
    avgLength,
    shortRatio: real.length > 0 ? shortCount / real.length : 0,
    catchphrases: extractCatchphrases(real),
    stickerTriggers: analyzeStickerTriggers(real),
    stickerRate: real.length > 0 ? (stickerCount / real.length) * 100 : 0,
    // [2026-11-17 二次修改] 按用户要求彻底简化：/learn = 抓最近 50 条真实聊天**原文**，
    // 不做统计分析、不做抽象化——原样作为语气参考塞给模型（"像这样说话"）。
    // 每次执行 /learn 都会重新抓取刷新。
    // 仍保留的过滤（用户此前明确要求）：机器人自己的消息、# / 命令、纯表情占位。
    examples: real
      // [2026-11-18] 相同/相近消息只保留一条：重复条目（连发"？"、同一段复读）
      // 会放大模型对个别词的印象，导致"句句笑死"式固定口头禅（用户实测）。
      .filter(((seen) => (m: { text?: string }) => {
        const key = String(m.text ?? '').replace(/\s+/g, '').toLowerCase();
        if (key === '' || seen.has(key)) return false;
        seen.add(key);
        return true;
      })(new Set()))
      .slice(0, 50)
      .map((m) => {
        let t = String(m.text ?? '')
          .replace(/@\d+\s*/g, '')
          .replace(/\[(image|face|mface|record|video|file)\]/gi, '')
          .replace(/\s+/g, ' ')               // 仅折叠空白，保证编号列表格式完整
          .trim();
        if (t.length > 100) t = t.slice(0, 100) + '…';
        return { speaker: '群友', text: t, followedBySticker: false };
      })
      .filter((e) => e.text !== ''),
    updatedAt: new Date().toISOString(),
  };

  // 落盘：画像 JSON + 示例 Markdown（"示例消息区域"）
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'examples.md'), renderExamples(profile), 'utf8');

  // 摘要存进 patterns 表
  store.savePattern('learned.summary', JSON.stringify({
    sampleSize: profile.sampleSize,
    avgLength: profile.avgLength,
    shortRatio: Number(profile.shortRatio.toFixed(3)),
    stickerRate: Number(profile.stickerRate.toFixed(2)),
    catchphrases: profile.catchphrases.slice(0, 10),
    stickerTriggers: profile.stickerTriggers.slice(0, 5),
  }));
  store.savePattern('learned.updatedAt', profile.updatedAt);

  return profile;
}

/** 把语气参考压成可注入提示词的一段话（[2026-11-17] 按用户要求：原文直出，像这样说话） */
export function profilePromptSection(profile: LearnedProfile | null): string {
  if (!profile || profile.examples.length === 0) return '';
  const lines = profile.examples
    .slice(0, 50)
    .map((e, i) => `${i + 1}. ${e.text}`);
  return [
    '【语气参考】以下是这个群最近的真实聊天记录（已排除命令和机器人自己的消息）。',
    '请模仿这种说话的语气和节奏来回复：像群友一样自然、口语化。',
    '可以不带主语、单纯凑热闹（比如只回一个"？"），不是每条都要完整句子。',
    '示例里的词不是你的固定口头禅：像"笑死""哈哈哈"这种词只在真的好笑时偶尔用一次，'
    + '绝对不要每条回复都用同一个语气词，大多数回复不需要任何语气词。',
    '只参考语气和说话方式，不要照抄内容，不要每条都模仿。',
    '',
    ...lines,
  ].join('\n');
}
