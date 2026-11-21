// [2026-11-12] 学习范围硬性验证：机器人自己的消息、#/命令 必须完全不参与学习
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { analyze, toToneSample } from '../gateway/src/learn.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const SELF = '1000000001';
const OTHER = '1000000002';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
const st = openChatStore(path.join(dir, 'c.db'));

const add = (userId: string, text: string, isCommand = false) =>
  st.addMessage({ ts: new Date().toISOString(), peerKey: 'private:1', kind: 'private',
    userId, nickname: userId === SELF ? '机器人' : '别人', text, images: [], isSticker: false, isCommand });

// 1) 机器人自己的话（带明显语气，若被学习会污染口头禅）
add(SELF, '机器人自己哈哈哈');
add(SELF, '机器人自己好家伙');
add(SELF, '机器人自己绝了');

// 2) 别人的命令
add(OTHER, '#来点色图', true);
add(OTHER, '/reset', true);
add(OTHER, '/sticker list', true);
add(OTHER, '＃全角命令', true);   // 全角
add(OTHER, '／全角斜杠', true);

// 3) 别人正常聊天
add(OTHER, '这个真的太离谱了哈哈哈');
add(OTHER, '好家伙，你怎么回事');
add(OTHER, '确实有点那个吧？？');
add(OTHER, '笑死我了😹');

const before = st.counts();
console.log(`数据库共 ${before.messages} 条消息（自身3 + 命令5 + 正常4）`);

const profile = analyze(st, path.join(dir, 'learned'), SELF);

// 样本只应包含 4 条正常聊天
check('样本数只含正常聊天(4条)', profile.sampleSize === 4, `实际 ${profile.sampleSize}`);

// 口头禅不能来自机器人
const cp = profile.catchphrases.join(',');
check('口头禅不含机器人内容', cp.length === 0 || !cp.includes('机器人自己'), cp);

// 示例不能含命令
const exText = profile.examples.map((e) => e.text).join(' | ');
check('示例不含 # 命令', !exText.includes('#'), exText.slice(0, 100));
check('示例不含 / 命令', !exText.includes('/'), exText.slice(0, 100));
check('示例不含全角命令', !exText.includes('全角'), exText.slice(0, 100));

// 示例文件也不能含
const md = fs.readFileSync(path.join(dir, 'learned', 'examples.md'), 'utf8');
check('示例文件不含命令', !md.includes('#来点色图') && !md.includes('/reset'));
check('示例文件不含机器人内容', !md.includes('机器人自己'));

// 直接验证 toToneSample 对命令返回空
check('toToneSample(#命令) 为空', toToneSample('#来点色图') === '');
check('toToneSample(/命令) 为空', toToneSample('/reset') === '');
check('toToneSample(全角＃) 为空', toToneSample('＃命令') === '');
check('toToneSample(全角／) 为空', toToneSample('／命令') === '');

// unlearnedMessages 不应返回命令
const un = st.unlearnedMessages(100);
check('待学习队列不含命令', un.every((m) => !m.isCommand), `数量 ${un.length}`);

st.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
