// [2026-11-12] 学习只学语气 + 只学他人消息 测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { toToneSample, extractCatchphrases, analyze } from '../gateway/src/learn.ts';
import { openChatStore } from '../gateway/src/chat-store.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// 语气提取：保留语气特征，绝不泄漏内容
const t1 = toToneSample('我今天去吃了火锅哈哈哈');
check('1 保留语气"哈哈"', t1.includes('哈哈'), t1);
check('1 不泄漏"火锅"', !t1.includes('火锅'), t1);
check('1 不泄漏"今天"', !t1.includes('今天'), t1);

const t2 = toToneSample('这游戏也太难了吧？？');
check('2 标出叠问号', t2.includes('叠问号') || t2.includes('问号'), t2);
check('2 不泄漏"游戏"', !t2.includes('游戏'), t2);

const t3 = toToneSample('好家伙，原来是这么回事');
check('3 标出开头语气词', t3.includes('好家伙'), t3);
check('3 不泄漏"回事"', !t3.includes('回事'), t3);

const t4 = toToneSample('笑死我了😹');
check('4 保留 emoji', t4.includes('😹'), t4);
check('4 不泄漏"我了"', !t4.includes('我了'), t4);

check('5 命令不参与学习', toToneSample('#来点色图') === '');
check('6 斜杠命令不参与', toToneSample('/reset') === '');
check('7 空文本返回空', toToneSample('') === '');
check('8 无语气特征的普通陈述被忽略或极简', toToneSample('请帮我看一下这个文件').length < 40);

// 口头禅只统计语气词
// [2026-11-17] 数据更新：口癖门槛已改为「≥5 次 且 占比 ≥3%」，样本需满足该统计条件
const msgs = [
  ...Array.from({ length: 8 }, (_, i) => ({ ts: 'x', peerKey: 'g:1', kind: 'group' as const, userId: '1', nickname: 'A', text: `哈哈哈消息${i}`, images: [], isSticker: false })),
  { ts: 'x', peerKey: 'g:1', kind: 'group' as const, userId: '1', nickname: 'A', text: '火锅真好吃', images: [], isSticker: false },
  { ts: 'x', peerKey: 'g:1', kind: 'group' as const, userId: '1', nickname: 'A', text: '火锅again', images: [], isSticker: false },
  ...Array.from({ length: 200 }, (_, i) => ({ ts: 'x', peerKey: 'g:1', kind: 'group' as const, userId: '1', nickname: 'A', text: `普通消息${i}`, images: [], isSticker: false })),
];
const cps = extractCatchphrases(msgs as any);
check('提取到语气词"哈哈"', cps.some(c => c.includes('哈')), JSON.stringify(cps));
check('不提取实词"火锅"', !cps.includes('火锅'), JSON.stringify(cps));

// 只学他人消息
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-'));
const st = openChatStore(path.join(dir, 'c.db'));
const SELF = '9999';
for (let i = 0; i < 5; i++) {
  st.addMessage({ ts: `2026-11-12T10:0${i}:00Z`, peerKey: 'p:1', kind: 'private', userId: '111', nickname: '别人', text: `别人的话${i}哈哈哈`, images: [], isSticker: false });
  st.addMessage({ ts: `2026-11-12T10:1${i}:00Z`, peerKey: 'p:1', kind: 'private', userId: SELF, nickname: '机器人', text: `机器人自己的回复${i}`, images: [], isSticker: false });
}
const profile = analyze(st, path.join(dir, 'learned'), SELF);
// 消息共 10 条，排除自身后样本应为 5（real 中非空文本也是 5）
check('样本排除自身消息', profile.sampleSize === 5, String(profile.sampleSize));
check('示例中不含机器人内容', !profile.examples.some(e => e.text.includes('机器人自己的回复')), JSON.stringify(profile.examples.map(e=>e.text)));
// [2026-11-17] 行为变更：示例现在必须包含真实文本（否则学不到语气），同时确保媒体标记被剥离
check('示例包含真实文本', profile.examples.some(e => e.text.includes('别人的话')), JSON.stringify(profile.examples.map(e=>e.text).slice(0,3)));

const md = fs.readFileSync(path.join(dir, 'learned', 'examples.md'), 'utf8');
check('示例文件包含真实文本', md.includes('别人的话'), md.slice(0, 200));

st.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
