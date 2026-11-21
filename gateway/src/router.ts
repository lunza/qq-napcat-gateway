// [2026-11-12] qq-gateway 消息路由：过滤 → 去重 → 触发判定 → 限流 → 排队（离线积压）
// 触发规则（按 AGENTS.md §十：逐条写死，不列举可选集合）：
//   私聊：behavior.privateReply=true 且对端非机器人自己 → 回复
//   群聊：behavior.groupRequireMention=true 时，仅当消息包含 @机器人 或 @全体且机器人被动触发 → 回复
//         鼠标触发词模式（groupRequireMention=false）时，消息文本包含 triggers 中任一词 → 回复
//   自己发的消息：behavior.ignoreSelfMessages=true 时丢弃（防回环）
//   白名单：admin.allowPeers 非空时，仅允许列表内会话
import type { OneBotEvent } from './onebot.ts';
import type { QqConfig } from './config.ts';

export interface InboundMessage {
  id: string;
  peerKey: string;          // private:<uin> / group:<gid>
  kind: 'private' | 'group';
  userId: string;
  groupId?: string;
  nickname: string;
  text: string;             // 纯文本（去掉 CQ 码/消息段中的非文本部分）
  atSelf: boolean;
  atAll: boolean;
  isSelf: boolean;
  isAdmin: boolean;
  raw: OneBotEvent;
}

const seen = new Set<string>();
const SEEN_MAX = 2000;

function remember(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_MAX) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  return true;
}

function segmentsToText(msg: OneBotEvent['message'], selfUin: string): { text: string; atSelf: boolean; atAll: boolean } {
  if (typeof msg === 'string') {
    // 字符串格式：直接返回，@ 判断交给 raw_message
    return { text: msg, atSelf: false, atAll: false };
  }
  if (!Array.isArray(msg)) return { text: '', atSelf: false, atAll: false };
  let text = '';
  let atSelf = false;
  let atAll = false;
  for (const seg of msg) {
    if (seg.type === 'text') text += String(seg.data.text ?? '');
    else if (seg.type === 'at') {
      const qq = String(seg.data.qq ?? '');
      // [2026-11-12 修复] 原逻辑把"任意 @"都当成 @机器人，导致群里 @别人也会触发回复。
      // 现在必须与 behavior.selfUin 精确比对才算 @机器人。
      if (qq === 'all') atAll = true;
      else if (qq) {
        if (selfUin && qq === selfUin) atSelf = true;
        text += `@${qq} `;
      }
    } else if (seg.type === 'face' || seg.type === 'image' || seg.type === 'record' || seg.type === 'video' || seg.type === 'file') {
      text += `[${seg.type}]`;
    }
  }
  return { text: text.trim(), atSelf, atAll };
}

/** 判断这条事件是否应该触发机器人回复；返回 null 表示丢弃 */
export function route(ev: OneBotEvent, config: QqConfig, selfUin: string): InboundMessage | null {
  if (ev.post_type !== 'message') return null;
  // OneBot 标准事件：post_type=message 时有 message_type
  const kind = ev.message_type === 'group' ? 'group' : (ev.message_type === 'private' ? 'private' : null);
  if (!kind) return null;

  const userId = String(ev.user_id ?? '');
  const groupId = ev.group_id ? String(ev.group_id) : undefined;
  const id = `${kind}:${groupId ?? ''}:${ev.message_id ?? ev.time}`;
  if (!remember(id)) return null;

  const isSelf = config.behavior.ignoreSelfMessages && !!selfUin && userId === selfUin;
  if (isSelf) return null;

  const { text, atSelf, atAll } = segmentsToText(ev.message, selfUin);
  const rawText = ev.raw_message ?? (typeof ev.message === 'string' ? ev.message : '');
  const mentionSelfBySegment = atSelf;
  const mentionSelfByRaw = !!selfUin && rawText.includes(`[CQ:at,qq=${selfUin}]`);
  const mentionSelf = mentionSelfBySegment || mentionSelfByRaw;

  const peerKey = kind === 'group' ? `group:${groupId}` : `private:${userId}`;
  const allowList = config.admin.allowPeers;
  const isAdmin = allowList.length === 0 ? true : allowList.includes(peerKey) || allowList.includes(`private:${userId}`);
  if (!isAdmin) return null;

  // [2026-11-12] 群里以 # 开头的（#help / #技能）视为显式调用，不需要 @
  // 依据：用户在群里主动打 # 一般就是想让机器人干活，再强制 @ 很反直觉
  const isExplicitHash = /^[/／#＃]/.test(text.trim());

  if (kind === 'group' && config.behavior.groupRequireMention) {
    const hitTrigger = config.behavior.triggers.some(t => t && text.includes(t));
    if (!mentionSelf && !hitTrigger && !isExplicitHash) return null;
  }
  if (kind === 'group' && !config.behavior.groupRequireMention && config.behavior.triggers.length > 0) {
    const hitTrigger = config.behavior.triggers.some(t => t && text.includes(t));
    if (!hitTrigger && !mentionSelf) return null;
  }
  if (kind === 'private' && !config.behavior.privateReply) return null;
  if (!text.trim()) return null;

  return {
    id, peerKey, kind,
    userId,
    groupId,
    nickname: ev.sender?.card || ev.sender?.nickname || userId,
    text,
    atSelf: mentionSelf,
    atAll,
    isSelf,
    isAdmin,
    raw: ev,
  };
}

/** 处理 @机器人 后残留的前缀（如 "@123 你好" 中去掉 @123） */
export function stripMention(text: string, selfUin: string): string {
  if (!selfUin) return text.trim();
  return text.replace(new RegExp(`@${selfUin}\\s*`, 'g'), '').trim();
}
