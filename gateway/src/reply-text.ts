// [2026-11-16] 回复文本清洗与表情包搭配
//
// 用户要求（2026-11-16 确认）：
//   1. 回复里**禁止出现 emoji**，改用表情包表达情绪
//   2. 回复时以 10% 概率在文字后拼一个合适的表情包
//
// 这个模块只管"文本处理"，不做 IO，方便单测。

/**
 * emoji 匹配正则（按 Unicode 区块覆盖，避免漏掉冷门符号）。
 *
 * 覆盖范围：
 *   \u{1F300}-\u{1F5FF}  杂项符号与象形文字（🌀-🗿）
 *   \u{1F600}-\u{1F64F}  表情符号（😀-🙏）
 *   \u{1F680}-\u{1F6FF}  交通与地图符号（🚀-🛿）
 *   \u{1F700}-\u{1F77F}  炼金术符号
 *   \u{1F780}-\u{1F7FF}  几何形状扩展
 *   \u{1F800}-\u{1F8FF}  补充箭头
 *   \u{1F900}-\u{1F9FF}  补充符号与象形文字（🤀-🧿）
 *   \u{1FA00}-\u{1FAFF}  符号与象形文字扩展 A（🩰-🫿）
 *   \u{1F000}-\u{1F02F}  麻将牌等
 *   \u{2600}-\u{27BF}    杂项符号 + 丁巴特符号（☀-➿）
 *   \u{2B00}-\u{2BFF}    杂项符号与箭头（⬀-⯿）
 *   \u{FE0F}             变体选择符（把 ☺ 变成彩色 emoji）
 *   \u{200D}             零宽连接符（组合 emoji 如 👨‍👩‍👧）
 *   \u{E0020}-\u{E007F}  标签字符（子区域旗帜 🏴󠁧󠁢󠁳󠁣󠁴󠁿）
 *
 * 有意**不**剔除：
 *   - 中文标点、波浪号、颜文字字符（～^_^ 等是文本表情，不是 emoji）
 *   - \u{2190}-\u{21FF} 箭头、\u{2700} 以下的常见符号（°±×÷ 等正常文本会用到）
 */
const EMOJI_RE = /[\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu;

/** 是否包含 emoji */
export function hasEmoji(text: string): boolean {
  if (!text) return false;
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}

/**
 * 剔除文本中的 emoji。
 *
 * 处理细节：
 *   - 删除 emoji 后可能留下双空格或多余空格，统一压缩
 *   - 如果剔除后只剩空白或标点（例如整句只有 "😂"），返回空串，由调用方决定怎么兜底
 *   - 不剔除中文标点、波浪号等正常文本字符
 */
export function stripEmoji(text: string): string {
  if (!text) return '';
  let out = text.replace(EMOJI_RE, '');
  // 连续空格压成一个；行首行尾空白去掉（保留换行结构）
  out = out.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd()).join('\n');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * 判断剔除 emoji 后的文本是否"还有实质内容"。
 * 只有空白或纯标点（如 "。"、"！？"）就算没内容了，此时若还要发消息应由别的文字兜底。
 */
export function hasMeaningfulText(text: string): boolean {
  if (!text) return false;
  // 去掉标点与空白后还有没有字符
  return /[^\s\p{P}\p{S}]/u.test(text);
}

/** 表情包分类候选：从回复文字里粗略推断适合的分类，供"按情绪选图"用 */
const EMOTION_HINTS: Array<{ kw: RegExp; category: string }> = [
  { kw: /哈哈|笑死|草|乐|绷不住|哈{2,}/, category: '欢乐' },
  { kw: /无语|沉默|算了|随便|服了|离谱/, category: '无语' },
  { kw: /震惊|卧槽|我去|天啊|不是吧|居然|竟然/, category: '惊讶' },
  { kw: /嘲讽|就这|逊|菜|笑你|切/, category: '嘲讽' },
  { kw: /好耶|赞同|可以|没问题|对|行|好的/, category: '认同' },
  { kw: /难过|惨|呜呜|哭|寄了|完蛋/, category: '安慰' },
  { kw: /[?？]|什么|为啥|怎么|咋/, category: '疑问' },
  { kw: /可爱|萌萌|嘿嘿|贴贴|么么/, category: '卖萌' },
  { kw: /气死|生气|烦|怒|滚/, category: '生气' },
];

/**
 * 从回复文字推断建议的表情包分类。匹配不到返回 null（调用方改为全库随机）。
 * 这是轻量规则，目的是让配图更贴合语气，而不是精确情感分析。
 */
export function suggestStickerCategory(text: string): string | null {
  if (!text) return null;
  for (const { kw, category } of EMOTION_HINTS) {
    if (kw.test(text)) return category;
  }
  return null;
}

/** 按概率判定是否触发（0~1）。prob 非法时视为不触发。 */
export function rollChance(prob: number, rand: () => number = Math.random): boolean {
  const p = Number(prob);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p >= 1) return true;
  return rand() < p;
}

/**
 * [2026-11-16] 口癖连续出现闸门（代码级，配合提示词约束的双保险）：
 * 学习画像注入口头禅后，模型倾向每条回复都以同一口癖收尾（实测"笑死"）。
 * 规则：本条回复的结尾命中口癖集合、且最近 2 条回复也用过它收尾 → 剥离本条的口癖尾缀。
 * 保留"偶尔点缀"（只拦连续重复），不搞一刀切。
 *
 * @param text            待发送的回复文本
 * @param catchphrases    画像里的口癖集合（learnedProfile.catchphrases）
 * @param recentTails     本会话最近几条回复的原始文本（新的在前，至少看 2 条）
 * @returns 处理后的文本；无需处理时原样返回
 */
export function stripRepeatedTailPhrase(
  text: string,
  catchphrases: string[],
  recentTails: string[],
): string {
  const raw = String(text ?? '');
  if (!raw || catchphrases.length === 0) return raw;
  // 本条结尾（去掉引号/表情包标记后）命中的口癖
  const tail = raw.trimEnd().replace(/\s*\[表情包:[^\]]*\]\s*$/, '').trimEnd();
  const hit = catchphrases.find((p) => {
    const w = String(p ?? '').trim();
    if (!w) return false;
    // 容许结尾带少量标点/波浪号/空格
    const re = new RegExp(`${escapeRegExp(w)}\\s*[~～。！!？?、,.，\\s]*$`);
    return re.test(tail);
  });
  if (!hit) return raw;
  // 最近 2 条回复是否也以同一口癖收尾
  const endsWithHit = (s: string): boolean => {
    const t = String(s ?? '').trimEnd().replace(/\s*\[表情包:[^\]]*\]\s*$/, '').trimEnd();
    return new RegExp(`${escapeRegExp(hit)}\\s*[~～。！!？?、,.，\\s]*$`).test(t);
  };
  const repeated = recentTails.slice(0, 2).filter(endsWithHit).length >= 2;
  if (!repeated) return raw;
  // 剥离：口癖 + 其前面的连接逗号/空格
  const stripped = tail.replace(new RegExp(`[，,\\s]*${escapeRegExp(hit)}\\s*[~～。！!？?、,.，\\s]*$`), '').trimEnd();
  return stripped || raw;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
