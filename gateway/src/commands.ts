// [2026-11-12] 主管账号命令系统（斜杠命令）
//
// 设计原则：
//   1. 只有 admin.owners 里的 QQ 号能用命令；其他任何人发 /help 都只会被当普通聊天
//   2. 命令不进模型、不进对话历史，避免污染上下文
//   3. 每条命令都能在没有 QQ 的情况下单测（execute 是纯函数，依赖通过 ctx 注入）
//   4. 命令在私聊和群聊（@机器人）都可用；群里的输出会 @ 回操作者
//
// 命令清单见 COMMANDS 表；新增命令只需往表里加一项。
import fs from 'node:fs';
import path from 'node:path';
import type { QqConfig } from './config.ts';
import type { InboundMessage } from './router.ts';

export interface CommandContext {
  config: QqConfig;
  repoRoot: string;
  /** [2026-11-12] 实际加载的配置文件路径（/mode 等命令要写回这里，而不是硬编码 repoRoot/config） */
  configPath: string;
  stateDir: string;
  logDir: string;
  startedAt: number;
  /** 发送一条消息（私聊或群聊），由 main.ts 注入 */
  send: (msg: InboundMessage, text: string) => Promise<boolean>;
  /**
   * [2026-11-12] 彻底重置一个会话：内存历史 + 数据库消息 + 图片记录 + 学习画像
   * 返回各项清理的数量，供命令回复展示。
   */
  clearHistory: (peerKey: string) => { memory: boolean; messages: number; images: number; profile: boolean };
  /** 当前自动回复模式切换（运行时生效，写回配置文件） */
  setAutoReplyMode: (mode: string) => void;
  /** 读取在线报告 */
  report: () => Record<string, unknown>;
  /** [2026-11-12] 立即跑一次自我升级分析 */
  learn?: () => string;
  /** 收集统计 */
  stats?: () => string;
  /**
   * [2026-11-12] 表情包管理：查看/纠正分类
   * [2026-11-13] 改为可返回 Promise：/s audit 需要调 AI 复检存量，是异步的
   */
  sticker?: (args: string[]) => string | Promise<string>;
  /** [2026-11-12] 梗库维护 */
  meme?: (args: string[]) => string;
  /** [2026-11-16] 媒体收集/整理进度查看 */
  media?: (args: string[]) => string;
  /**
   * [2026-11-13] 私密模式开关。仅主人 + 私聊可用。
   * on=true 进入，false 退出；返回是否成功，以及当前状态说明。
   */
  secret?: (on: boolean, msg: InboundMessage) => { ok: boolean; text: string };
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  ownerOnly?: boolean;
  run: (args: string[], ctx: CommandContext, msg: InboundMessage) => Promise<string | string[] | null> | string | string[] | null;
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tailJsonl(file: string, n: number): unknown[] {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${s % 60}秒`;
}

// 非主管可见的命令（其余视为运维命令，仅主管可见）
const PUBLIC_COMMANDS = new Set(['help', 'whoami']);

export const COMMANDS: CommandDef[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    usage: '/help',
    summary: '显示所有可用命令',
    run: (_args, ctx, msg) => {
      const owner = isOwner(ctx.config, msg.userId);
      // [2026-11-12] 非主管只看到公开命令，不暴露 /mode /log /owner 等运维命令
      const lines = ['【机器人命令】'];
      for (const c of COMMANDS) {
        if (c.ownerOnly && !owner) continue;
        if (!owner && !PUBLIC_COMMANDS.has(c.name)) continue;
        lines.push(`${c.usage}  —  ${c.summary}`);
      }
      if (owner) lines.push('', `当前模型：${ctx.config.autoReply.mode}`);
      return lines;
    },
  },
  {
    name: 'status',
    usage: '/status',
    summary: '查看运行状态（在线、运行时长、掉线、回复模式）',
    run: (_a, ctx) => {
      const health = readJson(path.join(ctx.stateDir, 'health.json')) as Record<string, unknown> | null;
      const rep = ctx.report();
      return [
        `在线：${health?.online ? '是' : '否'}（${health?.detail ?? 'unknown'}）`,
        `已运行：${fmtDuration(Date.now() - ctx.startedAt)}`,
        `回复模式：${ctx.config.autoReply.mode}`,
        `在线率：${rep.uptimeRatio}  掉线次数：${rep.offlineDrops}`,
        `群聊需@：${ctx.config.behavior.groupRequireMention ? '是' : '否'}`,
      ];
    },
  },
  {
    name: 'mode',
    usage: '/mode <harness|echo|off>',
    summary: '切换回复模式：harness=模型对话, echo=回显, off=只记录不回复',
    run: (args, ctx) => {
      const m = (args[0] ?? '').trim();
      if (!['harness', 'echo', 'off'].includes(m)) return '用法：/mode harness|echo|off';
      ctx.setAutoReplyMode(m);
      return `回复模式已切换为 ${m}`;
    },
  },
  {
    name: 'new',
    aliases: ['reset'],
    usage: '/new',
    summary: '彻底重置当前会话：内存上下文 + 收集的聊天记录 + 图片记录 + 学习画像',
    run: (_a, ctx, msg) => {
      const r = ctx.clearHistory(msg.peerKey);
      const lines = ['已重置本会话：'];
      lines.push(`  对话上下文：${r.memory ? '已清空' : '本来就是空的'}`);
      lines.push(`  聊天记录：清除 ${r.messages} 条`);
      lines.push(`  图片记录：清除 ${r.images} 条`);
      lines.push(`  学习画像：${r.profile ? '已重建' : '未受影响'}`);
      return lines.join('\n');
    },
  },
  {
    name: 'log',
    aliases: ['logs'],
    usage: '/log [n]',
    summary: '查看最近 n 条收发记录（默认 10）',
    run: (args, ctx) => {
      const n = Math.min(Math.max(parseInt(args[0] ?? '10', 10) || 10, 1), 50);
      const inb = tailJsonl(path.join(ctx.stateDir, 'inbox.jsonl'), n) as Array<Record<string, unknown>>;
      const out = tailJsonl(path.join(ctx.stateDir, 'outbox.jsonl'), n) as Array<Record<string, unknown>>;
      const rows: string[] = ['【最近消息】'];
      for (const r of inb) rows.push(`← ${String(r.peerKey)} ${String(r.text).slice(0, 40)}`);
      rows.push('【最近回复】');
      for (const r of out) rows.push(`→ ${String(r.peerKey)} ${String(r.text).slice(0, 40)}`);
      return rows;
    },
  },
  {
    name: 'report',
    usage: '/report',
    summary: '查看在线率与掉线明细',
    run: (_a, ctx) => {
      const r = ctx.report() as Record<string, unknown> & { outages?: Array<{ start: string; minutes: number }> };
      const lines = [
        `统计窗口：${JSON.stringify(r.window)}`,
        `在线率 ${r.uptimeRatio}，掉线 ${r.offlineDrops} 次，累计离线 ${r.offlineMinutesTotal} 分钟`,
      ];
      for (const o of (r.outages ?? []).slice(-5)) lines.push(`  掉线 ${o.start} 持续 ${o.minutes} 分钟`);
      return lines;
    },
  },
  {
    name: 'learn',
    usage: '/learn',
    summary: '立即整理分析聊天记录，更新"学到的聊天习惯"（主管可用）',
    ownerOnly: true,
    run: (_a, ctx) => {
      if (!ctx.learn) return '当前环境不支持教学分析';
      return ctx.learn();
    },
  },
  {
    name: 'stats',
    usage: '/stats',
    summary: '查看消息与表情包收集情况（主管可用）',
    ownerOnly: true,
    run: (_a, ctx) => {
      if (!ctx.stats) return '当前环境不支持统计';
      return ctx.stats();
    },
  },
  {
    name: 'sticker',
    // [2026-11-13] 手机端输入 /sticker 太费事，兼容 /s 作为同义简写（用户要求）
    aliases: ['s'],
    usage: '/s | /s stats | /s fix <序号> <分类> | /s audit',
    summary: '表情包库：查看/纠错/统计/AI 复检清理（主管可用，/s 是 /sticker 的简写）',
    ownerOnly: true,
    run: async (args, ctx) => {
      if (!ctx.sticker) return '当前环境不支持表情包管理';
      return await ctx.sticker(args);
    },
  },
  {
    // [2026-11-13] 私密模式：只有主人能在私聊里开；用的是 secretPersona 独立人设
    name: 'secret',
    aliases: ['sm'],
    usage: '/secret | /secret off',
    summary: '进入/退出私密模式（仅主人私聊可用）。私密模式使用独立人设，与普通模式不共用',
    ownerOnly: true,
    run: (args, ctx, msg) => {
      if (!ctx.secret) return '当前环境不支持私密模式';
      const sub = (args[0] ?? '').toLowerCase();
      // 支持 /secret、/secret on、/secret 开 进入；/secret off、/secret 关 退出
      const offWords = ['off', 'exit', 'quit', 'stop', '关', '关闭', '退出'];
      const on = sub ? !offWords.includes(sub) : true;
      const r = ctx.secret(on, msg);
      return r.text;
    },
  },
  {
    // [2026-11-16] 媒体流水线进度：先收集原件，再由定时任务整理成表情包
    name: 'media',
    aliases: ['m'],
    usage: '/media',
    summary: '查看媒体收集与整理进度（原件已落盘数、待整理数、已整理出多少表情包）',
    ownerOnly: true,
    run: (args, ctx) => {
      if (!ctx.media) return '当前环境不支持媒体统计';
      return ctx.media(args);
    },
  },
  {
    name: 'meme',
    usage: '/meme list | /meme add <梗名> | <关键词,逗号分隔> | <含义> | <出处>',
    summary: '查看和维护网络梗库（主管可用）。梗库优先于模型猜测，避免编造出处',
    ownerOnly: true,
    run: (args, ctx) => {
      if (!ctx.meme) return '当前环境不支持梗库管理';
      return ctx.meme(args);
    },
  },
  {
    name: 'whoami',
    usage: '/whoami',
    summary: '显示你的 QQ 号与是否为机器人主管',
    run: (_a, ctx, msg) => `QQ：${msg.userId}  昵称：${msg.nickname}  主管：${isOwner(ctx.config, msg.userId) ? '是' : '否'}`,
  },
  {
    name: 'owner',
    usage: '/owner add <QQ号> | /owner remove <QQ号> | /owner list',
    summary: '管理主管账号（仅主管可用）',
    ownerOnly: true,
    run: (args, ctx) => {
      const sub = (args[0] ?? 'list').toLowerCase();
      const ownerList = ctx.config.admin.owners;
      if (sub === 'list') return `主管账号：${ownerList.join(', ') || '（无）'}`;
      const qq = (args[1] ?? '').trim();
      if (!/^\d{5,12}$/.test(qq)) return '用法：/owner add|remove <QQ号>';
      if (sub === 'add') {
        if (!ownerList.includes(qq)) ownerList.push(qq);
        persistConfig(ctx, ctx.config);
        return `已添加主管：${qq}`;
      }
      if (sub === 'remove') {
        const i = ownerList.indexOf(qq);
        if (i >= 0) ownerList.splice(i, 1);
        persistConfig(ctx, ctx.config);
        return `已移除主管：${qq}`;
      }
      return '用法：/owner add|remove|list';
    },
  },
  {
    name: 'allow',
    usage: '/allow list | /allow add <private:QQ|group:群号> | /allow remove <...>',
    summary: '管理允许对话的白名单（仅主管可用，空=全部允许）',
    ownerOnly: true,
    run: (args, ctx) => {
      const sub = (args[0] ?? 'list').toLowerCase();
      const list = ctx.config.admin.allowPeers;
      if (sub === 'list') return `白名单：${list.length ? list.join(', ') : '（空，全部允许）'}`;
      const target = (args[1] ?? '').trim();
      if (!/^(private:\d{5,12}|group:\d{5,14})$/.test(target)) return '用法：/allow add|remove private:123456|group:987654';
      if (sub === 'add') {
        if (!list.includes(target)) list.push(target);
        persistConfig(ctx, ctx.config);
        return `已加入白名单：${target}`;
      }
      if (sub === 'remove') {
        const i = list.indexOf(target);
        if (i >= 0) list.splice(i, 1);
        persistConfig(ctx, ctx.config);
        return `已移出白名单：${target}`;
      }
      return '用法：/allow list|add|remove';
    },
  },
  {
    name: 'silence',
    usage: '/silence <分钟>',
    summary: '静默 N 分钟不回复（0 表示立即恢复）',
    run: (args, ctx) => {
      const min = parseFloat(args[0] ?? '');
      if (!Number.isFinite(min) || min < 0) return '用法：/silence <分钟>';
      ctx.config.behavior.silenceUntil = min > 0 ? Date.now() + min * 60000 : 0;
      persistConfig(ctx, ctx.config);
      return min > 0 ? `已静默 ${min} 分钟` : '已取消静默';
    },
  },
];

/** 允许 QQ 号是否是主管 */
export function isOwner(config: QqConfig, userId: string): boolean {
  return config.admin.owners.includes(String(userId));
}

function persistConfig(ctx: CommandContext, config: QqConfig): void {
  const p = ctx.configPath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export interface ParsedCommand { name: string; args: string[] }

/** 解析 "/help"、"／help"（全角斜杠）、"/help arg1 arg2" */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  const m = t.match(/^[/／]([a-zA-Z][\w-]*)\s*(.*)$/s);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() ? m[2].trim().split(/\s+/) : [] };
}

/**
 * 执行命令。返回 null 表示"不是命令，交给正常聊天处理"。
 * 返回字符串/数组表示命令输出。
 */
export async function handleCommand(
  text: string, ctx: CommandContext, msg: InboundMessage,
): Promise<string[] | null> {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const cmd = COMMANDS.find(c => c.name === parsed.name || c.aliases?.includes(parsed.name));
  if (!cmd) {
    // 主管发了未知命令：给出提示；非主管：不暴露命令体系，交回正常聊天处理
    if (!isOwner(ctx.config, msg.userId)) return null;
    return [`未知命令 /${parsed.name}，发送 /help 查看可用命令`];
  }
  if (cmd.ownerOnly && !isOwner(ctx.config, msg.userId)) {
    // [2026-11-13] 用用户实际输入的那个名字回话（如 /s），不要回显成长名 /sticker
    return [`/${parsed.name} 需要主管权限`];
  }
  const out = await cmd.run(parsed.args, ctx, msg);
  if (out === null) return null;
  return Array.isArray(out) ? out : [out];
}

/** 供 /help 等展示的命令摘要（不含实现） */
export function commandCatalog(): Array<{ usage: string; summary: string; ownerOnly: boolean }> {
  return COMMANDS.map(c => ({ usage: c.usage, summary: c.summary, ownerOnly: !!c.ownerOnly }));
}

// [2026-11-12] #help：列出所有可用技能。
// 与 /help（运维命令）分开：/help 面向主管，列出机器人管理命令；
// #help 面向所有人，列出 QQ 里能用的技能。
// 由 main.ts 在普通消息处理前拦截，返回技能列表文本。
export { renderSkillHelp, isHelpRequest } from './skills.ts';
