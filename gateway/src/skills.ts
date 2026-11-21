// [2026-11-12] qq-gateway 技能引擎
//
// 触发规则（2026-11-12 修订：改用 # 前缀，避免普通聊天误触发）：
//   - 技能用 `#名称` 触发，如 `#今日运势`
//   - `#help`（或 `#帮助`）列出所有已启用技能
//   - 只有以 # 开头的片段才被识别，普通聊天里出现"运势"两个字不会触发
//
// 设计：
//  - 纯函数匹配（matchSkill / parseSkillCommand / renderSkillHelp），无副作用，便于单测
//  - 每个技能独立冷却（cooldownSec），避免同一个人刷屏反复触发
//
// 支持全角 #（＃），中文输入法下很常见。
import type { QqConfig } from './config.ts';

export interface SkillDef {
  id: string;
  name: string;
  triggers: string[];
  prompt: string;
  enabled: boolean;
  cooldownSec: number;
  /** [2026-11-13] 技能类型：prompt=注入提示词；e621=抓图发送；news=抓新闻发送 */
  type?: 'prompt' | 'e621' | 'news';
  e621?: { scale?: string; date?: string; preference?: string };
}

export interface SkillHit {
  skill: SkillDef;
  /** 命中的具体触发词 */
  trigger: string;
}

/** #help 的别名集合（小写比对） */
const HELP_ALIASES = new Set(['help', '帮助', '？', '?', '列表', '技能']);

const lastFired = new Map<string, number>();

/** 归一化：全角 # → 半角 #，去掉首尾空白 */
function normalize(text: string): string {
  return String(text ?? '').replace(/＃/g, '#').trim();
}

/** 从文本里提取所有 #xxx 片段（不含 #），保持出现顺序 */
export function extractTags(text: string): string[] {
  const t = normalize(text);
  const out: string[] = [];
  const re = /#([^\s#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const tag = (m[1] ?? '').trim();
    if (tag !== '') out.push(tag);
  }
  return out;
}

/** 是否为 #help 请求 */
export function isHelpRequest(text: string): boolean {
  return extractTags(text).some((tag) => HELP_ALIASES.has(tag.toLowerCase()));
}

/** 当前已启用的技能（总开关打开 + 单个技能启用） */
export function activeSkills(config: QqConfig): SkillDef[] {
  const cfg = config.skills;
  if (!cfg?.enabled) return [];
  return (cfg.items ?? []).filter(
    (s) => s && s.enabled !== false && Array.isArray(s.triggers) && s.triggers.length > 0,
  );
}

/**
 * 匹配技能。
 * 只有在文本中出现了 `#触发词` 才命中；触发词本身可以不带 #。
 * 命中多个时取"最具体的"（触发词最长）。
 */
export function matchSkill(text: string, config: QqConfig, peerKey: string): SkillHit | null {
  const skills = activeSkills(config);
  if (skills.length === 0) return null;

  const tags = extractTags(text).map((t) => t.toLowerCase());
  if (tags.length === 0) return null;

  const hits: SkillHit[] = [];
  for (const skill of skills) {
    for (const raw of skill.triggers) {
      const trigger = String(raw ?? '').trim().replace(/^#+/, '');
      if (trigger === '') continue;
      if (tags.includes(trigger.toLowerCase())) hits.push({ skill, trigger });
    }
    // 也允许用技能名作为触发词（如 #今日运势 而 triggers 里没写）
    if (skill.name && tags.includes(skill.name.toLowerCase())) {
      hits.push({ skill, trigger: skill.name });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.trigger.length - a.trigger.length);
  const best = hits[0]!;

  // 冷却：同一会话同一技能在冷却期内不重复触发
  const key = `${peerKey}::${best.skill.id}`;
  const now = Date.now();
  const cooldownMs = Math.max(0, Number(best.skill.cooldownSec ?? 0)) * 1000;
  const last = lastFired.get(key) ?? 0;
  if (cooldownMs > 0 && now - last < cooldownMs) return null;
  lastFired.set(key, now);
  return best;
}

/** 把技能提示词拼进任务描述 */
export function skillPromptSection(hit: SkillHit | null): string {
  if (!hit) return '';
  const p = String(hit.skill.prompt ?? '').trim();
  if (p === '') return '';
  return `【本次触发的技能：${hit.skill.name}】\n${p}`;
}

/** 生成 #help 的技能列表文本 */
export function renderSkillHelp(config: QqConfig): string {
  const skills = activeSkills(config);
  if (skills.length === 0) return '当前没有可用的技能。';
  const lines = ['【可用技能】'];
  for (const s of skills) {
    // 优先展示触发词；没有触发词时退回技能名
    const triggers = (s.triggers ?? [])
      .map((t) => String(t).trim().replace(/^#+/, ''))
      .filter((t) => t !== '');
    const shown = triggers.length > 0 ? triggers : [s.name];
    lines.push(`#${shown[0]}  —  ${s.name}`);
    if (shown.length > 1) lines.push(`    其他写法：${shown.slice(1).map((t) => `#${t}`).join('、')}`);
  }
  lines.push('', '发送 #技能名 即可触发，例如 #今日运势');
  return lines.join('\n');
}

/** 清空冷却记录（测试与 /new 命令使用） */
export function resetSkillCooldown(): void {
  lastFired.clear();
}
