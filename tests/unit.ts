import { route } from '../gateway/src/router.ts';
import { createReplyEngine } from '../gateway/src/reply.ts';
import { computeUptime } from '../gateway/src/store.ts';
import { loadConfig } from '../gateway/src/config.ts';

const { config } = loadConfig();
const self = '123456';
const mk = (o: any) => ({ post_type: 'message', time: Date.now(), self_id: 1, ...o });
const cases: Array<[string, any, boolean]> = [
  ['私聊文本', mk({ message_type: 'private', user_id: '888', message_id: 1, message: [{ type: 'text', data: { text: '你好' } }] }), true],
  ['群聊未@', mk({ message_type: 'group', group_id: 9, user_id: '888', message_id: 2, message: [{ type: 'text', data: { text: '随便聊聊' } }] }), false],
  ['群聊@机器人', mk({ message_type: 'group', group_id: 9, user_id: '888', message_id: 3, message: [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: '在吗' } }] }), true],
  ['自己发的', mk({ message_type: 'private', user_id: self, message_id: 4, message: [{ type: 'text', data: { text: '我' } }] }), false],
  ['重复消息', mk({ message_type: 'private', user_id: '888', message_id: 1, message: [{ type: 'text', data: { text: '你好' } }] }), false],
  ['空消息', mk({ message_type: 'private', user_id: '888', message_id: 5, message: [] }), false],
];
let pass = 0;
for (const [name, ev, want] of cases) {
  const got = route(ev, config, self) !== null;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name}: want=${want} got=${got}`);
  if (got === want) pass++;
}
// ---- 拟真 QQ 事件形态：测试路由是否真的认得 NapCat 推来的事件 ----
// 形态来源：NapCat OneBot11 message_post_format=array 的 private / group / message_sent / friend_recall 等
const napcatSamples: Array<[string, any, boolean]> = [
  ['NapCat私聊(数组)', { post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1700000001, self_id: 10001, user_id: 20002, message_id: 77001, message: [{ type: 'text', data: { text: '晚上好' } }], raw_message: '晚上好', sender: { user_id: 20002, nickname: '小明' }, font: 14 }, true],
  ['NapCat群聊(数组,未@)', { post_type: 'message', message_type: 'group', sub_type: 'normal', time: 1700000002, self_id: 10001, group_id: 55555, user_id: 20002, message_id: 77002, message: [{ type: 'text', data: { text: '今天吃啥' } }, { type: 'image', data: { file: 'x.jpg' } }], raw_message: '今天吃啥[CQ:image,file=x.jpg]', sender: { user_id: 20002, nickname: '小明', card: '小明' } }, false],
  ['NapCat群聊(@机器人+文本)', { post_type: 'message', message_type: 'group', sub_type: 'normal', time: 1700000003, self_id: 10001, group_id: 55555, user_id: 20002, message_id: 77003, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看下' } }], raw_message: '[CQ:at,qq=10001] 帮我看下', sender: { user_id: 20002, nickname: '小明' } }, true],
  ['NapCat字符串格式私聊', { post_type: 'message', message_type: 'private', time: 1700000004, self_id: 10001, user_id: 20003, message_id: 77004, message: '在吗', raw_message: '在吗', sender: { user_id: 20003, nickname: '小红' } }, true],
  ['NapCat自身消息(防回环)', { post_type: 'message_sent', message_type: 'private', time: 1700000005, self_id: 10001, user_id: 20002, message_id: 77005, message: [{ type: 'text', data: { text: '我发的' } }], raw_message: '我发的', sender: { user_id: 20002 } }, false],
];


for (const [name, ev, want] of napcatSamples) {
  const got = route(ev, config, '10001') !== null;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  [拟真] ${name}: want=${want} got=${got}`);
  if (got === want) pass++;
}
// [2026-11-12 回归] 群里 @ 别人（非机器人）不应触发回复
const atOther = { post_type: 'message', message_type: 'group', sub_type: 'normal', time: 1700000010, self_id: 10001, group_id: 55555, user_id: 20002, message_id: 77999,
  message: [{ type: 'at', data: { qq: '3079388626' } }, { type: 'text', data: { text: ' 身高差美味w' } }],
  raw_message: '[CQ:at,qq=3079388626] 身高差美味w', sender: { user_id: 20002, nickname: '路人' } };
const gotAtOther = route(atOther, config, '10001') !== null;
console.log(`${gotAtOther === false ? 'PASS' : 'FAIL'}  [回归] 群里@别人不触发: want=false got=${gotAtOther}`);
if (gotAtOther === false) pass++;
const totalChecks = cases.length + napcatSamples.length + 1;

const echo = createReplyEngine({ ...config, autoReply: { mode: 'echo', httpUrl: '' } });
const msg: any = { text: '@123456 你好呀', peerKey: 'group:9', userId: '888', nickname: 'x', kind: 'group', atSelf: true };
const r = await echo.reply(msg, []);
console.log('echo reply:', r);

// uptime 计算：0-100s 在线，100-200s 离线，200-300s 在线 → 200s/300s ≈ 66.67%
const u = computeUptime([{ t: 0, online: true }, { t: 100000, online: false }, { t: 200000, online: true }], 0, 300000);
console.log('uptime:', u.uptimeRatio.toFixed(4), 'drops:', u.offlineDrops);
console.log(pass === totalChecks && r === '收到：你好呀' && Math.abs(u.uptimeRatio - 200 / 300) < 1e-6 ? 'ALL PASS' : 'SOME FAIL');
