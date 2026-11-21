// [2026-11-12] qq-gateway 配置加载器
// 配置文件位置（按优先级）：$QQBOT_CONFIG > <repo>/config/qq.json
// 字段说明见 config/qq.example.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export interface QqConfig {
  onebot: {
    wsUrl: string;          // 正向 WS 地址，如 ws://127.0.0.1:3001
    httpUrl: string;        // HTTP API 地址，如 http://127.0.0.1:3000
    token: string;          // OneBot access_token（可为空，但建议设置）
    timeoutMs: number;
  };
  /**
   * [2026-11-12] 下载图片用的 HTTP 代理。
   * e621 的图片 CDN 在部分网络下不可达，gateway 需要走代理下载后再以 base64 发送。
   * 留空表示直连。
   */
  proxy: {
    url: string;            // 如 http://127.0.0.1:7897
  };
  behavior: {
    selfUin: string;                 // 机器人自身 QQ 号（用于 @ 判断与防回环）
    privateReply: boolean;           // 是否回复私聊
    groupRequireMention: boolean;    // 群聊是否必须 @ 才回复
    triggers: string[];              // 群聊触发词（当 groupRequireMention 为 false 时生效）
    ignoreSelfMessages: boolean;     // 忽略自己发出的消息（防回环）
    replyPrefix: string;             // 每条回复加的前缀（可为空）
    maxReplyChars: number;           // 单条回复最大字符数，超出截断
    rateLimitPerPeerPerMin: number;  // 每个会话每分钟最多回复数
    silenceUntil?: number;           // [2026-11-12] 时间戳；在此之前不回复任何消息
  };
  /**
   * [2026-11-12] 人设配置：由 dsh-qq-ops 插件管理，gateway 在拼提示词时读取。
   * prompt 为空时使用内置默认人设。
   */
  persona: {
    name: string;              // 机器人自称（空=不自我介绍）
    prompt: string;            // 完整人设/system prompt；为空则用内置默认
    style: string;             // 风格提示，附加在 prompt 之后
    extraRules: string[];      // 额外硬性规则，逐条追加
  };
  /**
   * [2026-11-16] 梗库世界书（SillyTavern World Info 风格）：
   * 每轮回复前扫描会话文本，关键词/向量命中梗库条目则注入提示词。
   * 可选字段——旧配置缺省时用 worldbook.ts 的 DEFAULT_WORLDBOOK。
   */
  worldbook?: {
    enabled: boolean;
    /** 扫描最近 N 条同会话消息（含当前消息） */
    scanDepth: number;
    /** 同会话同梗冷却秒数 */
    cooldownSec: number;
    /** 单轮注入条目上限 */
    maxInject: number;
    vector: {
      enabled: boolean;
      /** 余弦相似度阈值 */
      threshold: number;
      /** 单次语义召回上限 */
      topK: number;
      /** embedding 模型 */
      model: string;
    };
  };
  /**
   * [2026-11-12] 技能配置：QQ 消息命中触发词时，把该技能的提示词注入本轮对话。
   * 由 dsh-qq-ops 设置页维护。
   */
  skills: {
    enabled: boolean;
    items: Array<{
      id: string;
      name: string;
      triggers: string[];
      prompt: string;
      enabled: boolean;
      cooldownSec: number;
      /** prompt=注入提示词；e621=抓图发送；news=抓新闻发送 */
      type?: 'prompt' | 'e621' | 'news';
      news?: { maxAgeHours?: number; requireImage?: boolean };
      e621?: { scale?: string; date?: string; preference?: string };
    }>;
  };
  /**
   * [2026-11-12] 群聊随机表情包机制：
   * 当没人主动和机器人说话时，以极低概率在别人发消息后跟一个表情包（不发文字）。
   */
  groupSticker: {
    enabled: boolean;
    /** 跟随概率（0~1）；[2026-11-16] 按用户要求从 0.01 提升到 0.1 = 10% */
    probability: number;
    /** 仅在"没人 @ 机器人"时触发（不打断正常对话） */
    onlyWhenIgnored: boolean;
    /** 每个群冷却秒数，防止连续刷 */
    cooldownSecPerGroup: number;
    /** 优先使用的分类（空=任意） */
    categories: string[];
    /**
     * [2026-11-17] "凑热闹"的文字分支概率（0~1），默认 0.1 = 10%。
     *
     * 判定顺序是**串行**的：先掷 probability 决定发不发图，没发图才掷 textProbability 决定说不说话。
     * 所以实际触发率：
     *   表情包 = probability（默认 20%）
     *   文字   = (1 - probability) × textProbability（默认 0.8 × 0.1 = 8%）
     *   合计   = 28%，其余 72% 不动
     * 这个"10% 实为 8%"是 2026-11-17 与用户确认过的口径（一次事件最多触发一个分支，
     * 不会既发图又说话）。若要文字真的达到 10%，把 textProbability 调到 0.125。
     */
    textProbability: number;
    /** 文字分支的冷却秒数；不填则沿用冷却策略（见 main.ts） */
    textCooldownSecPerGroup?: number;
    /**
     * [2026-11-17] "跟图 +1"：群里有人发某张表情包，如果短时间内别人也发了同一张，
     * 机器人就跟着发一张一样的（类似群友接龙 +1）。
     *
     * 与 probability / textProbability 无关——这是触发确定的行为，不走概率。
     * 只发一次：同一张图在 followWindowSec 内只跟一次，且每群有 followCooldownSec 冷却。
     */
    followSameSticker: {
      enabled: boolean;
      /** 多久内出现的重复视为"接龙"，默认 120 秒 */
      followWindowSec: number;
      /** 每群跟图冷却秒数，默认 600 秒，避免刷屏 */
      followCooldownSecPerGroup: number;
    };
    /**
     * [2026-11-18] 频率权重：群友高频发的表情包，在"挑哪张图"时更容易被选中。
     *
     * 注意分寸（用户原话"稍微调高"）：权重封顶 2.5 倍，且用对数曲线压缩，
     * 不会让高频图垄断。只影响"选中某张图"的概率，不影响"发不发图"的频率。
     */
    frequencyWeight: {
      enabled: boolean;
      /** 统计窗口（天），默认 30 */
      windowDays: number;
      /** 权重上限倍数，默认 2.5 */
      maxWeight: number;
    };
  };
  /**
   * [2026-11-16] 回复时配表情包。
   *
   * 与 groupSticker 的区别：
   *   groupSticker = 没人 @ 机器人时"自己凑热闹"跟一张图；
   *   replySticker = 机器人**正常回复**时，把文字和一张表情包放在同一条消息里发出。
   *
   * 用户要求：回复里不许出现 emoji，用表情包代替表情。
   */
  replySticker: {
    enabled: boolean;
    /** 回复时配图概率（0~1），默认 0.1 = 10% */
    probability: number;
    /** 按回复情绪选同类表情包；选不到再全库随机 */
    byCategory: boolean;
    /** 发送前剔除回复文字里的 emoji（用表情包代替表情） */
    stripEmoji: boolean;
  };
  /**
   * [2026-11-13] 表情包收集闸门（AI 驱动）。
   *
   * 背景：旧规则只看「消息正文是否为空」来判断表情包，导致群里单发的新闻截图、
   * 公告长图、聊天记录截图全部被当成表情包收进库。现在改为入库前先让视觉模型判定。
   *
   * enabled=false 时退回旧行为（按 looksLikeSticker 规则直接收），排查问题时可用。
   */
  stickerFilter: {
    enabled: boolean;
    /** 判定为表情包所需的最低置信度（0~1）；低于它按"不是表情包"处理 */
    minConfidence: number;
    /** 判定接口报错/超时时是否仍然收集。默认 false = 宁缺勿滥（用户已确认） */
    collectOnError: boolean;
  };
  /**
   * [2026-11-13] 私密模式（/secret）专用人设。
   *
   * 与上面的 persona **完全独立**：进入私密模式后只用这一段拼提示词，
   * 不会混入 persona.prompt / style / extraRules 的任何内容。
   * 触发权限：仅 admin.owners，且仅限私聊（群聊里发 /secret 无效，避免内容发到群里）。
   */
  secretPersona: {
    /**
     * [2026-11-13] 全局提示词（系统提示词）。
     * 拼在私密人设提示词**最前方**，用于放跨角色都适用的总纲约束。
     * 留空则跳过，不影响其它字段。
     */
    globalPrompt: string;
    /** 私密模式下的自称（留空则沿用 persona.name） */
    name: string;
    /** 私密模式的完整人设；为空则用 builtin 默认 */
    prompt: string;
    style: string;
    extraRules: string[];
    /**
     * [2026-11-13] 私密模式单条回复字数上限。
     * 0 或不设 = 不做代码截断，长度完全由提示词里的字数要求决定（用户明确要求"以设定为准"）。
     * 这是为了让 RP 能写完整段落，不被 behavior.maxReplyChars 硬切。
     */
    maxReplyChars?: number;
  };
  admin: {
    allowPeers: string[];            // 允许的会话：private:<uin> / group:<group_id>；空数组=全部允许
    owners: string[];                // [2026-11-12] 主管账号 QQ 号，可使用 /命令
  };
  monitor: {
    heartbeatMs: number;             // 心跳间隔（写 heartbeat.jsonl）
    probeEveryN: number;             // 每 N 次心跳做一次 get_status 探活
    probeTimeoutMs: number;
    offlineAlertMin: number;         // 连续离线超过 N 分钟记为一次告警（写入 alerts.jsonl）
  };
  autoReply: {
    mode: 'off' | 'echo' | 'http' | 'harness';
    httpUrl: string;                 // mode=http 时的推理服务地址，POST {text,peer} -> {reply}
    command?: string;                // mode=harness 时调用的桥接可执行文件
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  };
}

const DEFAULTS: QqConfig = {
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', token: '', timeoutMs: 8000 },
  proxy: { url: '' },
  behavior: {
    selfUin: '',
    privateReply: true,
    groupRequireMention: true,
    triggers: [],
    ignoreSelfMessages: true,
    replyPrefix: '',
    maxReplyChars: 500,
    rateLimitPerPeerPerMin: 6,
  },
  persona: { name: '', prompt: '', style: '', extraRules: [] },
  secretPersona: { globalPrompt: '', name: '', prompt: '', style: '', extraRules: [] },
  groupSticker: {
    enabled: true, probability: 0.2, textProbability: 0.1, onlyWhenIgnored: true,
    cooldownSecPerGroup: 600, categories: [],
    followSameSticker: { enabled: true, followWindowSec: 120, followCooldownSecPerGroup: 600 },
    frequencyWeight: { enabled: true, windowDays: 30, maxWeight: 2.5 },
  },
  replySticker: { enabled: true, probability: 0.1, byCategory: true, stripEmoji: true },
  // [2026-11-13] 阈值 0.6：宽松档，基本不漏真表情包，少量边界图仍可能混入（用户已确认）
  stickerFilter: { enabled: true, minConfidence: 0.6, collectOnError: false },
  skills: { enabled: true, items: [] },
  admin: { allowPeers: [], owners: [] },
  monitor: { heartbeatMs: 30000, probeEveryN: 2, probeTimeoutMs: 6000, offlineAlertMin: 2 },
  autoReply: { mode: 'echo', httpUrl: 'http://127.0.0.1:8787/reply', timeoutMs: 180000 },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object' || typeof base !== 'object' || base === null) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function loadConfig(): { config: QqConfig; configPath: string } {
  const configPath = process.env.QQBOT_CONFIG || path.join(REPO_ROOT, 'config', 'qq.json');
  const example = path.join(REPO_ROOT, 'config', 'qq.example.json');
  let raw: unknown = {};
  const source = fs.existsSync(configPath) ? configPath : (fs.existsSync(example) ? example : undefined);
  if (source) {
    raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  }
  const config = deepMerge(DEFAULTS, raw);
  // token 支持从环境变量覆盖，避免写进配置文件
  if (process.env.QQBOT_ONEBOT_TOKEN) config.onebot.token = process.env.QQBOT_ONEBOT_TOKEN;
  if (process.env.QQBOT_SELF_UIN) config.behavior.selfUin = process.env.QQBOT_SELF_UIN;
  return { config, configPath: source ?? configPath };
}
