// [2026-11-12] 主管命令系统测试
// 覆盖：解析、主管鉴权、非主管不能执行、各命令输出、配置写回（写临时仓库，不碰真实 config）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCommand, handleCommand, isOwner, COMMANDS, type CommandContext } from '../gateway/src/commands.ts';
import { loadConfig, type QqConfig } from '../gateway/src/config.ts';
import type { InboundMessage } from '../gateway/src/router.ts';

const OWNER = '1000000002';
const STRANGER = '1000000001';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqcmd-'));
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config', 'qq.json'), JSON.stringify({ admin: { owners: [OWNER] } }, null, 2));
fs.writeFileSync(path.join(tmp, 'state', 'health.json'), JSON.stringify({ online: true, detail: 'login=ok' }));
fs.writeFileSync(path.join(tmp, 'state', 'inbox.jsonl'), JSON.stringify({ ts: 'x', peerKey: 'private:1', text: '你好' }) + '\n');
fs.writeFileSync(path.join(tmp, 'state', 'outbox.jsonl'), JSON.stringify({ ts: 'x', peerKey: 'private:1', text: '在呢' }) + '\n');

const { config } = loadConfig();
config.admin.owners = [OWNER];
config.behavior.silenceUntil = 0;

const mkMsg = (userId: string): InboundMessage => ({
  id: 'x', peerKey: `private:${userId}`, kind: 'private', userId, nickname: 'n',
  text: '', atSelf: false, atAll: false, isSelf: false, isAdmin: true, raw: {} as never,
});

const ctx: CommandContext = {
  config, repoRoot: tmp, configPath: path.join(tmp, 'config', 'qq.json'),
  stateDir: path.join(tmp, 'state'), logDir: path.join(tmp, 'state'),
  startedAt: Date.now() - 65000,
  send: async () => true,
  clearHistory: () => {},
  setAutoReplyMode: (m: string) => {
    config.autoReply.mode = m as QqConfig['autoReply']['mode'];
    // 模拟 main.ts 的 setAutoReplyMode：写回 ctx.configPath
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'qq.json'), 'utf8'));
    raw.autoReply = { ...(raw.autoReply ?? {}), mode: m };
    fs.writeFileSync(path.join(tmp, 'config', 'qq.json'), JSON.stringify(raw, null, 2) + '\n');
  },
  report: () => ({ window: { from: 'a', to: 'b' }, uptimeRatio: '99.5%', offlineDrops: 1, offlineMinutesTotal: 2, outages: [{ start: '2026-11-12T00:00:00Z', minutes: 2 }] }),
};

let pass = 0, total = 0;
const check = (name: string, cond: boolean, extra = '') => {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// 1) 解析
check('解析 /help', parseCommand('/help')?.name === 'help');
check('解析全角斜杠 /help', parseCommand('／help')?.name === 'help');
check('解析带参数', JSON.stringify(parseCommand('/mode echo')) === JSON.stringify({ name: 'mode', args: ['echo'] }));
check('普通文本不是命令', parseCommand('你好 /help') === null);
check('空串不是命令', parseCommand('') === null);

// 2) 鉴权
check('主管识别', isOwner(config, OWNER) === true);
check('非主管识别', isOwner(config, STRANGER) === false);

// 3) 主管 /help 有输出且包含命令
const helpOut = await handleCommand('/help', ctx, mkMsg(OWNER));
check('/help 主管可用', Array.isArray(helpOut) && helpOut.length > 3, `行数=${helpOut?.length}`);
check('/help 含 /status', (helpOut ?? []).some(l => l.includes('/status')));
check('/help 列出主管专属命令', (helpOut ?? []).some(l => l.includes('/owner')));

// 4) 非主管发 /help：不暴露命令体系，返回 null（当普通聊天）
const strangerHelp = await handleCommand('/help', ctx, mkMsg(STRANGER));
check('非主管 /help 不暴露命令', strangerHelp !== null && strangerHelp.join('').includes('/status') === false, JSON.stringify(strangerHelp).slice(0, 60));

// 5) 非主管发主管命令：明确拒绝
const strangerOwner = await handleCommand('/owner list', ctx, mkMsg(STRANGER));
check('非主管 /owner 被拒绝', (strangerOwner ?? []).join('').includes('需要主管权限'));

// 6) /status
const st = (await handleCommand('/status', ctx, mkMsg(OWNER)))?.join('\n') ?? '';
check('/status 含在线', st.includes('在线：是'));
check('/status 含运行时长', st.includes('已运行'));
check('/status 含掉线次数', st.includes('掉线次数：1'));

// 7) /whoami
const who = (await handleCommand('/whoami', ctx, mkMsg(OWNER)))?.join('') ?? '';
check('/whoami 标记主管', who.includes(OWNER) && who.includes('主管：是'));

// 8) /mode 切换并写回配置
await handleCommand('/mode echo', ctx, mkMsg(OWNER));
check('/mode 运行时生效', config.autoReply.mode === 'echo');
const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'qq.json'), 'utf8'));
check('/mode 已写回配置文件', persisted.autoReply?.mode === 'echo', JSON.stringify(persisted.autoReply));
await handleCommand('/mode harness', ctx, mkMsg(OWNER));

// 9) /mode 非法参数
const badMode = (await handleCommand('/mode 乱写', ctx, mkMsg(OWNER)))?.join('') ?? '';
check('/mode 非法参数给用法', badMode.includes('用法'));

// 10) /log
const logOut = (await handleCommand('/log 5', ctx, mkMsg(OWNER)))?.join('\n') ?? '';
check('/log 读到收发记录', logOut.includes('你好') && logOut.includes('在呢'));

// 11) /report
const rep = (await handleCommand('/report', ctx, mkMsg(OWNER)))?.join('\n') ?? '';
check('/report 含在线率', rep.includes('99.5%'));
check('/report 含掉线明细', rep.includes('掉线'));

// 12) /silence
await handleCommand('/silence 5', ctx, mkMsg(OWNER));
check('/silence 设置静默窗口', (config.behavior.silenceUntil ?? 0) > Date.now());
await handleCommand('/silence 0', ctx, mkMsg(OWNER));
check('/silence 0 取消', (config.behavior.silenceUntil ?? 0) === 0);

// 13) /allow
await handleCommand('/allow add private:123456', ctx, mkMsg(OWNER));
check('/allow add 生效', config.admin.allowPeers.includes('private:123456'));
await handleCommand('/allow remove private:123456', ctx, mkMsg(OWNER));
check('/allow remove 生效', !config.admin.allowPeers.includes('private:123456'));
const badAllow = (await handleCommand('/allow add 乱写', ctx, mkMsg(OWNER)))?.join('') ?? '';
check('/allow 非法格式给用法', badAllow.includes('用法'));

// 14) /owner 增删
await handleCommand('/owner add 2000000002', ctx, mkMsg(OWNER));
check('/owner add 生效', config.admin.owners.includes('2000000002'));
await handleCommand('/owner remove 2000000002', ctx, mkMsg(OWNER));
check('/owner remove 生效', !config.admin.owners.includes('2000000002'));

// 15) 未知命令：主管得提示，非主管当普通聊天
const unknownOwner = await handleCommand('/nonexistentcmd', ctx, mkMsg(OWNER));
check('未知命令给主管提示', (unknownOwner ?? []).join('').includes('未知命令'));
const unknownStranger = await handleCommand('/xyz', ctx, mkMsg(STRANGER));
check('未知命令对非主管静默', unknownStranger === null, `got=${JSON.stringify(unknownStranger)}`);

// 16) 命令目录完整性
check('命令数 >= 9', COMMANDS.length >= 9, `实际 ${COMMANDS.length}`);

// 17) [2026-11-13] /s 是 /sticker 的简写（手机端输入方便）
check('解析 /s', JSON.stringify(parseCommand('/s')) === JSON.stringify({ name: 's', args: [] }));
check('解析 /s fix 2 震惊', JSON.stringify(parseCommand('/s fix 2 震惊')) === JSON.stringify({ name: 's', args: ['fix', '2', '震惊'] }));
check('解析全角 /s', parseCommand('／s')?.name === 's');
const stickerCmd = COMMANDS.find(c => c.name === 'sticker');
check('/sticker 声明了 s 别名', !!stickerCmd?.aliases?.includes('s'), JSON.stringify(stickerCmd?.aliases));

// /s 与 /sticker 必须完全等价：用桩函数记录收到的参数
const seen: string[][] = [];
const ctxWithSticker: CommandContext = { ...ctx, sticker: (a: string[]) => { seen.push(a); return 'STUB'; } };
const viaShort = await handleCommand('/s fix 2 震惊', ctxWithSticker, mkMsg(OWNER));
const viaLong = await handleCommand('/sticker fix 2 震惊', ctxWithSticker, mkMsg(OWNER));
check('/s fix 执行了 sticker 并原样透传参数', JSON.stringify(seen[0]) === JSON.stringify(['fix', '2', '震惊']), JSON.stringify(seen[0]));
check('/s 与 /sticker 输出一致', JSON.stringify(viaShort) === JSON.stringify(viaLong), `${JSON.stringify(viaShort)} vs ${JSON.stringify(viaLong)}`);
const viaShortList = await handleCommand('/s', ctxWithSticker, mkMsg(OWNER));
check('/s 无参数等价 /sticker（默认 list）', JSON.stringify(seen[2]) === JSON.stringify([]) && viaShortList?.[0] === 'STUB', JSON.stringify(seen[2]));

// 别名不应破坏鉴权：非主管 /s 仍被拒绝
const shortStranger = (await handleCommand('/s', ctxWithSticker, mkMsg(STRANGER)))?.join('') ?? '';
check('非主管 /s 被拒绝且回显 /s', shortStranger.includes('/s 需要主管权限'), shortStranger);

// /help 里展示短命令（手机端更容易照抄）
const helpAfter = (await handleCommand('/help', ctx, mkMsg(OWNER))) ?? [];
check('/help 用 /s 展示表情包命令', helpAfter.some(l => l.includes('/s ')), helpAfter.find(l => l.includes('表情包')) ?? '');

console.log(`\n${pass}/${total} 通过`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(pass === total ? 0 : 1);
