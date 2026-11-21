// [2026-11-12] 群聊触发规则测试
import { route } from '../gateway/src/router.ts';
import type { QqConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const SELF = '1000000001';
const base = {
  behavior: { selfUin: SELF, privateReply: true, groupRequireMention: true, triggers: [], ignoreSelfMessages: true },
  admin: { allowPeers: [] },
} as unknown as QqConfig;

let seq = 0;
const grp = (text: string, atSelf = false) => ({
  post_type: 'message', message_type: 'group', self_id: Number(SELF), time: Date.now(),
  group_id: 2000000001, user_id: 1000000002, message_id: ++seq,
  message: atSelf ? [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text } }] : [{ type: 'text', data: { text } }],
  raw_message: atSelf ? `[CQ:at,qq=${SELF}] ${text}` : text,
  sender: { user_id: 1000000002, nickname: '群友' },
});

// 仅 @ 回复模式
check('群聊 @ 机器人 → 回复', route(grp('你好', true), base, SELF) !== null);
check('群聊普通聊天 → 不回复', route(grp('今天天气不错'), base, SELF) === null);
check('群聊 #help → 回复（免 @）', route(grp('#help'), base, SELF) !== null, '');
check('群聊 #来点色图 → 回复（免 @）', route(grp('#来点色图'), base, SELF) !== null);
check('群聊全角＃help → 回复', route(grp('＃help'), base, SELF) !== null);
check('群聊 @ 别人 → 不回复', route({ ...grp('哈哈'), message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '哈哈' } }], raw_message: '[CQ:at,qq=999999] 哈哈' }, base, SELF) === null);

// 白名单限制
const restricted = { ...base, admin: { allowPeers: ['group:123'] } } as unknown as QqConfig;
check('白名单不含该群 → 不回复', route(grp('你好', true), restricted, SELF) === null);
const allowed = { ...base, admin: { allowPeers: ['group:2000000001'] } } as unknown as QqConfig;
check('白名单含该群 → 回复', route(grp('你好', true), allowed, SELF) !== null);

// 私聊不受影响
const pri = (text: string) => ({ post_type: 'message', message_type: 'private', self_id: Number(SELF), time: Date.now(), user_id: 1000000002, message_id: ++seq, message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: 1000000002, nickname: 'A' } });
check('私聊正常回复', route(pri('你好'), base, SELF) !== null);
check('私聊 #help 也能用', route(pri('#help'), base, SELF) !== null);

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
