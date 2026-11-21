// [2026-11-12] 表情包分析器
//
// 职责：
//   1. 下载表情包图片（支持代理）
//   2. 识别格式；GIF 取首帧 + 记录帧数/时长，让模型知道"这是动态表情"
//   3. 调用视觉模型分析：画面内容、情绪、适合在什么场合发送
//   4. 归类到分类体系（可自驱动扩充）
//
// 分类设计：预置基础类目，模型可返回新类目；新类目自动入库并参与后续归类。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadBytes } from './e621.ts';

/** 预置分类（可被模型扩充） */
export const BASE_CATEGORIES = [
  '欢乐', '疑问', '尴尬', '无语', '嘲讽', '惊讶',
  '安慰', '生气', '卖萌', '认同', '告别', '求助',
] as const;

export interface StickerAnalysis {
  /** 画面描述（一句话） */
  description: string;
  /** 表达的情绪 */
  emotion: string;
  /** 所属分类（可能是新类目） */
  category: string;
  /** 适合在什么场合发（一句话） */
  occasion: string;
  /** 是否动图 */
  animated: boolean;
  /** 格式 */
  format: string;
  /** [2026-11-12] 网络热梗识别 */
  meme?: string;
  /** [2026-11-12] 诊断信息 */
  eyes?: string;
  mouth?: string;
  candidates?: string[];
}

/**
 * [2026-11-12] 超大图缩小：长边压到 1024、转 JPEG。
 * 视觉模型不需要原分辨率的巨大图，压缩后既快又不容易超限。
 */
export async function downscaleIfHuge(bytes: Uint8Array, maxBytes = 1_500_000): Promise<Uint8Array> {
  if (bytes.byteLength <= maxBytes) return bytes;
  try {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { format } = detectFormat(bytes);
    if (!['jpeg', 'png', 'gif', 'webp'].includes(format)) return bytes;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-ds-'));
    const ext = format === 'jpeg' ? 'jpg' : format;
    const src = path.join(dir, `s.${ext}`);
    fs.writeFileSync(src, bytes);
    const out = path.join(dir, 'o.jpg');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '1024', src, '--out', out], { stdio: 'ignore' });
    const small = new Uint8Array(fs.readFileSync(out));
    fs.rmSync(dir, { recursive: true, force: true });
    return small.byteLength < bytes.byteLength ? small : bytes;
  } catch {
    return bytes;
  }
}

/** 读取图片宽度（用 sips，失败返回 0） */
async function imageWidth(bytes: Uint8Array): Promise<number> {
  return (await imageSize(bytes)).width;
}

/** [2026-11-13] 读取图片高度；与宽度合并成一次 sips 调用 */
async function imageHeight(bytes: Uint8Array): Promise<number> {
  return (await imageSize(bytes)).height;
}

/**
 * [2026-11-13] 一次调用取宽高。原来只取了宽度，而表情包判定还需要宽高比。
 * 失败返回 {0,0}，调用方据此跳过预筛、直接交给模型。
 */
export async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { format } = detectFormat(bytes);
    if (!['jpeg', 'png', 'gif', 'webp'].includes(format)) return { width: 0, height: 0 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-wh-'));
    const ext = format === 'jpeg' ? 'jpg' : format;
    const f = path.join(dir, `w.${ext}`);
    fs.writeFileSync(f, bytes);
    const out = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return {
      width: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0),
      height: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0),
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 动图提示语 */
function animeHint(animated: boolean): string {
  return animated
    ? '注意：这是**动态GIF**，你看到的是首帧，请结合常见动图表现推断它的动态含义。'
    : '';
}

export interface VisionConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  proxy?: string;
}

/** 从字节识别图片格式 */
export function detectFormat(buf: Uint8Array): { format: string; mime: string; animated: boolean } {
  const b = buf;
  const ascii = (s: number, e: number) => String.fromCharCode(...Array.from(b.slice(s, e)));
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return { format: 'jpeg', mime: 'image/jpeg', animated: false };
  if (b.length > 8 && ascii(0, 4) === '\x89PNG') return { format: 'png', mime: 'image/png', animated: false };
  if (b.length > 6 && ascii(0, 3) === 'GIF') {
    // 统计 GIF 里的图像描述符数量，>1 视为动图
    let frames = 0;
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
    }
    return { format: 'gif', mime: 'image/gif', animated: frames > 1 };
  }
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { format: 'webp', mime: 'image/webp', animated: false };
  }
  return { format: 'unknown', mime: 'application/octet-stream', animated: false };
}

/**
 * 调视觉模型分析表情包。
 * GIF 动图无法把整个动效传给模型，这里补充"这是N帧动图"的提示，
 * 让模型基于首帧 + 动图属性做判断。
 */
export async function analyzeSticker(
  imageBytes: Uint8Array,
  opts: VisionConfig,
  extraHint = '',
  knownMemes = '',
): Promise<StickerAnalysis> {
  const { format, animated } = detectFormat(imageBytes);
  // [2026-11-12] 小图先放大，显著提升表情/五官判断准确率
  // [2026-11-12] 图太大（>1.5MB）先压到合适尺寸，避免 base64 过大导致接口报错
  const bounded = await downscaleIfHuge(imageBytes);
  const upscaled = await upscaleForVision(bounded);
  const srcW = await imageWidth(imageBytes);
  const lowRes = srcW > 0 && srcW < 256;
  const { mime } = detectFormat(upscaled);
  const b64 = Buffer.from(upscaled).toString('base64');

  const categoriesText = BASE_CATEGORIES.join('、');
  const prompt = [
    '这是一张 QQ 表情包。请分析它，并按下面的格式输出严格的 JSON（不要加代码块标记）：',
    '{"eyes":"眼睛的形态：睁大/圆睁/微眯/闭眼/斜视，以及眉毛状态",'
    + '"mouth":"嘴巴形态：张开/闭合/嘴角上扬/下撇/咬唇",'
    + '"description":"画面内容一句话",'
    + '"candidates":["最可能的情绪","第二可能","第三可能"],'
    + '"objects":"手中/身旁的具体物品（看不清时写【不确定】+你看到的形状颜色）",'
    + '"meme":"这个表情包出自什么网络热梗（梗名+含义）；不认识写【未识别出梗】",'
    + '"source":"出处（作品名/人物/事件）。**只有在你能确信时才填**，不确定必须填【不确定】",'
    + '"sourceConfidence":"high|medium|low —— 你对出处的确信程度",'
    + '"emotion":"最终判断的情绪","category":"分类","occasion":"适合在什么场合发"}',
    '',
    lowRes
      ? [
        '**注意：这张图分辨率很低（约 ' + srcW + 'px 宽），很多细节是糊的。请严格遵守：**',
        '  - 手里的**小物件**不要武断下结论（不要因为是红的就说是钞票，可能是包装袋、卡片、其他物品）。',
        '  - 看不清就描述**形状与颜色**（如"捧着一沓粉色小袋"），不要编造具体物品名。',
        '  - 文字必须逐字读出，看不清就说看不清。',
      ].join('\n')
      : '',
    '**【最重要】网络热梗识别**：绝大多数表情包都来自网络热梗/名场面，只描述画面是**不合格**的。',
    '你必须尽力识别它出自什么梗，例如：',
    '  - 画面文字（"逊"、"就这"、"你礼貌吗"、"绷不住"、"yyds"、"666"、"破防"、"典"、"cpu"）+ 配图 → 判断梗义',
    '  - 经典影视/动漫/游戏截图（如星爷、猫和老鼠、奥特曼、表情包三巨头熊猫头）',
    '  - 夸张表情 + 特定文字组合（如"绷不住了"= 忍笑失败）',
    '  如果你认识这个梗，请在 meme 字段写出**梗名与含义**；实在不认识就写【未识别出梗】。',
    '  **绝对不要编造出处**：如果你不能确信具体出自哪部作品/哪个人/哪个事件，就只说明"这是一类什么梗"，',
    '  不要写具体作品名。例如只写"谐音/嘲讽类梗，配图是真人爆笑场景"，**不要**写"出自《某某》第几集"。',
    '**网络表情包常识（重要）**：表情包的"梗义"常与画面表面不符，需要结合流行语判断：',
    '  - 猫/狗**斜眼上瞟、面无表情**：通常表示"无语"或"你在说什么傻话"，但如果是被突然吓到定格的构图，也可能是**震惊**。',
    '  - 猫**瞳孔放大、耳朵竖起、身体僵直**：震惊/吓到。',
    '  - 猫**歪头、张大嘴**：震惊/难以置信。',
    '  - 熊猫头、模糊抖动的人脸：多为震惊/破防。',
    '  判断时要同时考虑：画面动作 + 是否有定格感 + 常见梗语境。',
    '',
    '**判断步骤（务必按顺序）**：',
    '1. 先仔细观察**眼睛**是睁圆还是眯起——这是区分"震惊"和"无语"的关键：',
    '   眼睛睁大、瞳孔明显 = 震惊/惊讶；眼睛眯成缝、半眯 = 无语/不屑/嫌弃。',
    '2. 再看**嘴巴**：张开常表示惊讶/大笑；闭合下撇常表示无语/不满。',
    '3. 结合整张图的氛围，给出 3 个候选情绪，再说最终结论。',
    '',
    `分类可以从这些里选：${categoriesText}。`,
    '如果都不合适，**可以自己起一个新分类**（两个字左右，比如「敷衍」「上头」「破防」），我会自动扩充类目。',
    animeHint(animated),
    // [2026-11-12] 梗库命中的已知梗：作为**事实**给模型，避免它自己编
    knownMemes
      ? knownMemes + '\n以上是**已知事实**，如果画面与某个梗匹配，请优先采用它的含义与分类。'
      : '',
    extraHint ? `补充信息：${extraHint}` : '',
  ].filter(Boolean).join('\n');

  const payload = {
    model: opts.model ?? 'deepseek-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    max_tokens: 400,
    temperature: 0.3,
  };

  const baseURL = opts.baseURL ?? 'https://ai-api.crec.cn/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let text = '';
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`视觉接口 HTTP ${res.status}`);
    const data = await res.json() as any;
    text = data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }

  // 解析 JSON（模型可能包了代码块）
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  let parsed: Partial<StickerAnalysis> = {};
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = {}; } }

  const cands = Array.isArray((parsed as any).candidates)
    ? ((parsed as any).candidates as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : [];
  const eyes = String((parsed as any).eyes ?? '');
  const mouth = String((parsed as any).mouth ?? '');

  // [2026-11-12] 规则兜底：眼睛睁大但被判成无语时，纠正为震惊
  let category = String(parsed.category ?? '').trim();
  const wideEyes = /睁大|圆睁|睁圆|瞪大|瞳孔放大|瞪/.test(eyes);
  const narrowEyes = /眯|半睁|半眯|斜视|闭眼/.test(eyes);
  if (!category) category = cands[0] ?? '欢乐';
  if (wideEyes && !narrowEyes && /无语|不屑|嫌弃|冷漠/.test(category)) {
    category = '惊讶';
  }
  const objects = String((parsed as any).objects ?? '').trim();
  const srcRaw = String((parsed as any).source ?? '').trim();
  const conf = String((parsed as any).sourceConfidence ?? '').toLowerCase();
  const srcOk = /^(high|medium)$/.test(conf) && srcRaw && !/不确定|未识别|不知道/.test(srcRaw);
  const memepartRaw = String((parsed as any).meme ?? '').trim();
  // 出处不可信时，从梗描述里剔除具体作品名（防止编造）
  const memepart = srcOk
    ? memepartRaw
    : memepartRaw
      .replace(/出自[《"“]([^》"”]+)[》"”][^；;，,。]*/g, '')
      .replace(/《[^》]+》/g, '')
      .replace(/^[，；,;\s]+/, '')
      .trim();
  const desc = String(parsed.description ?? cleaned.slice(0, 120) ?? '');
  const extras: string[] = [];
  if (objects) extras.push(`关键物品：${objects}`);
  if (memepart && !/未识别/.test(memepart)) extras.push(`梗：${memepart}`);
  return {
    description: extras.length > 0 ? `${desc}【${extras.join('；')}】` : desc,
    meme: memepart,
    emotion: String(parsed.emotion ?? cands[0] ?? ''),
    category,
    occasion: String(parsed.occasion ?? ''),
    animated,
    format,
    // 额外保留诊断信息，便于日后排查
    eyes,
    mouth,
    candidates: cands,
  };
}

/** 下载 + 分析一个表情包 */
export async function fetchAndAnalyzeSticker(
  url: string,
  opts: VisionConfig,
  extraHint = '',
  knownMemes = '',
): Promise<StickerAnalysis & { bytes: Uint8Array }> {
  const bytes = await downloadBytes(url, opts.proxy, 8 * 1024 * 1024);
  const analysis = await analyzeSticker(bytes, opts, extraHint, knownMemes);
  return { ...analysis, bytes };
}

// [2026-11-13] AI 驱动的表情包准入判定（收集闸门）
//
// 背景：旧逻辑在 chat-store.ts 的 looksLikeSticker() 里判断，规则是
//   「URL 含 qq_expression」或「消息正文为空 / 只有 [image] 占位」→ 当成表情包。
// 后果：群里有人单发一张新闻截图、公告长图、聊天记录截图（正文都是空），
// 全都被收进表情包库（实测混入过 AMD 招聘公告截图、QQ 聊天界面截图）。
//
// 现在改为：真正入库/送去分析之前，先让视觉模型回答"这到底是不是表情包"。
// 判定失败（接口报错/超时/返回不可解析）一律按「不是表情包」处理（宁缺勿滥，用户已确认）。

export interface StickerVerdict {
  /** 是否表情包 */
  isSticker: boolean;
  /** 置信度 0~1 */
  confidence: number;
  /** 判定理由（一句话，便于 /s audit 复核与排查误判） */
  reason: string;
  /** 模型识别出的图片类型，如「表情包」「新闻截图」「聊天截图」「公告长图」 */
  kind: string;
  /** 判定是否走了模型（false=预筛直接否决，或调用失败） */
  byModel: boolean;
}

/**
 * 低成本预筛：明显不可能是表情包的图直接否决，不浪费一次视觉请求。
 * 返回 null 表示"无法预判，交给模型"。
 *
 * 依据：QQ 表情包几乎都是小图或近方形；新闻/公告截图多为宽幅大图。
 */
export function prefilterByShape(width: number, height: number): StickerVerdict | null {
  if (!width || !height) return null;
  const ratio = width / height;
  // 横图且很宽（>2.2:1）同时像素很大：典型的长图新闻/公告/网页截图
  if (ratio > 2.2 && width >= 800) {
    return {
      isSticker: false, confidence: 0.95, byModel: false,
      kind: '宽幅大图',
      reason: `尺寸 ${width}x${height}，宽高比 ${ratio.toFixed(1)}:1，属于图片/网页截图典型比例`,
    };
  }
  return null;
}

/**
 * 调视觉模型判定「这张图是不是表情包」。
 *
 * 与 analyzeSticker 的区别：这里**不下情绪/分类结论**，只回答二元问题 + 置信度，
 * 所以 prompt 更短、要求更硬，避免模型为了"配合"而把新闻图也说成表情包。
 */
export async function classifySticker(
  imageBytes: Uint8Array,
  opts: VisionConfig,
  extraHint = '',
): Promise<StickerVerdict> {
  const { mime } = detectFormat(imageBytes);
  const bounded = await downscaleIfHuge(imageBytes);
  const upscaled = await upscaleForVision(bounded);
  const srcW = await imageWidth(imageBytes);

  // 预筛：尺寸层面就能排掉的，不花 token
  const probe = prefilterByShape(srcW, await imageHeight(imageBytes));
  if (probe) return probe;

  const b64 = Buffer.from(upscaled).toString('base64');
  const prompt = [
    '你的任务：判断这张图**是不是一张 QQ 表情包**，只回答这一个问题。',
    '',
    '判定为「是表情包」的情况：',
    '  - 人物/动物/卡通角色的夸张表情配文字，用来表达情绪或接梗',
    '  - 纯文字梗图、谐音梗图、熊猫头、蘑菇头、二次元表情、动图表情',
    '  - 由聊天记录/影视截图**二次加工而成**的梗图（加了粗体大字、白边、夸张裁剪，明显是为了当表情发）',
    '',
    '判定为「不是表情包」的情况：',
    '  - 新闻截图、公告、通知、招聘信息、产品发布页、公众号文章截图',
    '  - 原始的聊天记录截图（没有加工成梗图，纯粹是在分享对话）',
    '  - 照片、风景、自拍、商品图、表格、数据图表、代码截图',
    '  - 长图、海报、二维码、文件预览',
    '',
    '注意：不要因为"图里有文字"或"图比较糊"就判成表情包；关键是**它是不是被做成用来发的梗图**。',
    '拿不准时，confidence 给 0.4~0.6 之间，不要硬给高分。',
    '',
    '严格按下面 JSON 输出（不要加代码块标记，不要多余文字）：',
    '{"isSticker":true或false,'
    + '"confidence":0到1之间的小数（你对这个判断的确信程度）,'
    + '"kind":"这张图实际上是什么：表情包/新闻截图/聊天截图/公告长图/照片/图表/其它",'
    + '"reason":"一句话说明依据"}',
    extraHint ? `补充信息：${extraHint}` : '',
  ].filter(Boolean).join('\n');

  const payload = {
    model: opts.model ?? 'deepseek-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    // [2026-11-13] 判定只需要很短的回答；超时压到 25 秒，避免收集队列被单张图拖死
    max_tokens: 160,
    temperature: 0,
  };

  const baseURL = opts.baseURL ?? 'https://ai-api.crec.cn/v1';
  const ctrl = new AbortController();
  // [2026-11-16] 超时从 25s 提到 45s：实测正常 1~4s，但接口偶有长尾（>25s 被误判超时）。
  // 判定一次的成本远低于"图被判失败后重试整批"，放宽更划算。
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let text = '';
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`判定接口 HTTP ${res.status}`);
    const data = await res.json() as any;
    text = data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }

  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('判定返回不可解析');
  const parsed = JSON.parse(m[0]) as Partial<StickerVerdict> & { isSticker?: unknown };

  // 代码级闸门：只有明确的 true 才算表情包；其余一律 false（防止模型输出 "是"/1/字符串等变体被当成真）
  const rawFlag = (parsed as any).isSticker;
  const isSticker = rawFlag === true;
  const confNum = Number((parsed as any).confidence);
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(1, confNum)) : 0;
  return {
    isSticker,
    confidence,
    kind: String((parsed as any).kind ?? '').trim() || '未知',
    reason: String((parsed as any).reason ?? '').trim(),
    byModel: true,
  };
}

/**
 * [2026-11-13] 闸门最终裁决：既是表情包、且置信度达到门槛，才放行。
 * 收集链路和 /s audit 复检共用这一处判断，避免两处阈值逻辑日后漂移。
 */
export function passesStickerGate(verdict: StickerVerdict, minConfidence: number): boolean {
  const min = Number.isFinite(minConfidence) ? minConfidence : 0.6;
  return verdict.isSticker === true && Number(verdict.confidence) >= min;
}

/**
 * 打包：下载 + 判定，一步拿到结论 + 字节（后续分析与保存复用，避免重复下载）。
 * 任何异常都向上抛，由调用方按"不收"处理。
 */
export async function fetchAndClassify(
  url: string,
  opts: VisionConfig,
  extraHint = '',
): Promise<{ verdict: StickerVerdict; bytes: Uint8Array }> {
  const bytes = await downloadBytes(url, opts.proxy, 8 * 1024 * 1024);
  const verdict = await classifySticker(bytes, opts, extraHint);
  return { verdict, bytes };
}


/**
 * [2026-11-12] 小图放大预处理。
 *
 * 为什么需要：QQ 表情包常只有 100x100 左右、几 KB，模型容易把"睁圆的眼睛"看成"眯眼"、
 * 把"震惊"判成"无语"。放大到至少 384px 再交给视觉模型，识别准确率明显提升。
 *
 * 只用 macOS 自带 sips，不引入额外依赖；失败则原样返回。
 */
export async function upscaleForVision(bytes: Uint8Array, minSide = 384): Promise<Uint8Array> {
  try {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { format } = detectFormat(bytes);
    if (!['jpeg', 'png', 'gif', 'webp'].includes(format)) return bytes;

    // 已经是够大的图就不处理
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-up-'));
    const ext = format === 'jpeg' ? 'jpg' : format;
    const src = path.join(tmpDir, `in.${ext}`);
    fs.writeFileSync(src, bytes);
    const w = Number(execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', src], { encoding: 'utf8' })
      .match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
    if (w >= minSide) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return bytes;
    }
    // 用 -Z 等比缩放到长边 512
    const out = path.join(tmpDir, 'out.png');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '512', src, '--out', out], { stdio: 'ignore' });
    const up = fs.readFileSync(out);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return new Uint8Array(up);
  } catch {
    return bytes; // 放大失败不影响分析
  }
}

/** 保存表情包到本地（按分类分目录） */
export function saveSticker(dir: string, url: string, bytes: Uint8Array, category: string): string {
  const safeCat = category.replace(/[^\u4e00-\u9fa5\w-]/g, '') || '未分类';
  const target = path.join(dir, safeCat);
  fs.mkdirSync(target, { recursive: true });
  // [2026-11-13 修复] 原来用 Buffer.from(url).toString('hex').slice(0,16) 当文件名，
  // 但那是 URL **前 16 个字节**的 hex：QQ 图床的 URL 都以 "https://multimed" 开头，
  // 前 16 字节 hex 全是 68747470733a2f2f6d756c74696d6564 → 同分类的图全部撞名互相覆盖。
  // 后果：本地文件与数据库记录错位（/s audit 读本地文件复检时会拿错图）。
  // 改为对完整 URL 取 sha256 前 16 位。
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const { format } = detectFormat(bytes);
  const ext = format === 'unknown' ? 'bin' : format === 'jpeg' ? 'jpg' : format;
  const file = path.join(target, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return file;
}
