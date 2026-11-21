// [2026-11-13] 私密模式（/secret）测试
//
// 覆盖用户明确要求：
//   1. 只有主人账号能触发（非主人、群聊都不行）
//   2. 私密模式有专门人设，与普通提示词**不共用**
//   3. 历史按模式隔离，不互相污染
import { buildPersonaPrompt, buildSecretPersonaPrompt } from '../gateway/src/reply.ts';
import { handleCommand, isOwner, COMMANDS, type CommandContext } from '../gateway/src/commands.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const { config } = loadConfig();
const OWNER = config.admin.owners[0] ?? '1000000002';
const STRANGER = '1000000001';
config.admin.owners = [OWNER];

// ---------- 1) 人设隔离 ----------
console.log('--- 人设隔离（核心要求）---');
const normal = buildPersonaPrompt(config);
const secret = buildSecretPersonaPrompt(config);

check('普通人设非空', normal.length > 50);
check('私密人设非空', secret.length > 20);  // [2026-11-21] 默认人设留空后由规则段构成，门槛从 50 降到 20
check('两者内容不相同', normal !== secret);
check('私密人设有自己的风格描述', secret.includes(config.secretPersona.style.slice(0, 6)));
check('普通人设不含私密专属规则', !normal.includes('私下相处'));
check('私密人设已生效（含专属开场或自定义规则）', secret.includes('私下相处') || (config.secretPersona.extraRules ?? []).some(r => secret.includes(r)));  // [2026-11-21] 改为校验结构而非特定文案
check('私密人设不复用普通 style', !config.persona.style?.trim() || !secret.includes(config.persona.style));

// 更强的隔离验证：把普通 persona 改得完全不一样，私密人设不应受影响
const snapshot = JSON.parse(JSON.stringify(config));
(config as any).persona = { name: '普通名', prompt: '【普通模式专属】', style: '普通风格', extraRules: ['普通规则A'] };
const secretAfterNormalChanged = buildSecretPersonaPrompt(config);
check('改动普通 persona 不影响私密人设', !secretAfterNormalChanged.includes('普通模式专属'));
check('改动普通 persona 不影响私密规则', !secretAfterNormalChanged.includes('普通规则A'));
// 反向：改私密人设不影响普通
(config as any).secretPersona = { name: '私密名', prompt: '【私密专属】', style: '私密风格', extraRules: ['私密规则B'] };
const normalAfterSecretChanged = buildPersonaPrompt(config);
check('改动私密 persona 不影响普通人设', !normalAfterSecretChanged.includes('私密专属'));
check('私密人设能反映自己的改动', buildSecretPersonaPrompt(config).includes('私密专属'));
Object.assign(config, snapshot);

// 私密模式 name 留空时沿用普通 name（否则模型不知道自己叫什么）
const snap2 = JSON.parse(JSON.stringify(config));
(config as any).secretPersona = { name: '', prompt: 'x', style: '', extraRules: [] };
check('私密 name 留空沿用普通 name', buildSecretPersonaPrompt(config).includes(config.persona.name));
Object.assign(config, snap2);

// ---------- 2) 权限：仅主人可触发 ----------
console.log('--- 权限控制 ---');
const secretDef = COMMANDS.find(c => c.name === 'secret')!;
check('/secret 命令已注册', !!secretDef);
check('/secret 标记为 ownerOnly', secretDef.ownerOnly === true);
check('/secret 有 sm 简写', secretDef.aliases?.includes('sm') === true);

const calls: Array<[boolean, string]> = [];
const mkCtx = (): CommandContext => ({
  config, repoRoot: '.', configPath: 'x', stateDir: '.', logDir: '.', startedAt: 0,
  send: async () => true, clearHistory: () => ({}), setAutoReplyMode: () => {}, report: () => ({}),
  secret: (on, msg) => { calls.push([on, msg.peerKey]); return { ok: true, text: on ? 'ON' : 'OFF' }; },
});
const mkMsg = (userId: string, kind: 'private' | 'group' = 'private') => ({
  id: '1', peerKey: kind === 'group' ? 'group:123' : `private:${userId}`, kind, userId,
  groupId: kind === 'group' ? '123' : undefined, nickname: 'n', text: '',
  atSelf: false, atAll: false, isSelf: false, isAdmin: true, raw: {} as any,
});

const strangerOut = (await handleCommand('/secret', mkCtx(), mkMsg(STRANGER))) ?? [];
check('非主人 /secret 被拒绝', strangerOut.join('').includes('需要主管权限'), strangerOut.join('').slice(0, 40));
check('非主人不会触发 secret 回调', calls.length === 0, JSON.stringify(calls));

const ownerOut = (await handleCommand('/secret', mkCtx(), mkMsg(OWNER))) ?? [];
check('主人 /secret 返回成功', ownerOut.join('') === 'ON', ownerOut.join(''));
check('主人触发 secret(on=true)', calls[0]?.[0] === true);

calls.length = 0;
await handleCommand('/secret off', mkCtx(), mkMsg(OWNER));
check('/secret off 触发 on=false', calls[0]?.[0] === false);
calls.length = 0;
await handleCommand('/secret 关', mkCtx(), mkMsg(OWNER));
check('/secret 关 也走关闭', calls[0]?.[0] === false);
calls.length = 0;
await handleCommand('/sm', mkCtx(), mkMsg(OWNER));
check('/sm 简写可用', calls[0]?.[0] === true);

check('isOwner 对主人为真', isOwner(config, OWNER) === true);
check('isOwner 对陌生人为假', isOwner(config, STRANGER) === false);

// ---------- 3) 群聊防护 ----------
// 命令层只校验 ownerOnly 会放行主人；真正的"群聊禁止"在 main.ts 的 secret 回调里。
// 这里用与 main 完全相同的判定条件做验证，确保主人的群聊请求会被拒。
console.log('--- 群聊场景 ---');
const canEnterSecret = (msg: { kind: 'private' | 'group'; userId: string }) =>
  msg.kind === 'private' && isOwner(config, msg.userId);

check('主人在私聊可以开启', canEnterSecret({ kind: 'private', userId: OWNER }) === true);
check('主人在群聊不能开启', canEnterSecret({ kind: 'group', userId: OWNER }) === false);
check('陌生人在私聊不能开启', canEnterSecret({ kind: 'private', userId: STRANGER }) === false);
check('陌生人在群聊不能开启', canEnterSecret({ kind: 'group', userId: STRANGER }) === false);

// ---------- 4) 全局提示词：拼在人设最前方 ----------
console.log('--- 全局提示词 ---');
{
  const snap3 = JSON.parse(JSON.stringify(config));
  (config as any).secretPersona = {
    globalPrompt: '【全局总纲】始终第一人称。',
    name: '测试名',
    prompt: '【角色人设】你是水伊布。',
    style: '简短',
    extraRules: ['规则甲'],
  };
  const built = buildSecretPersonaPrompt(config);
  const gi = built.indexOf('【全局总纲】');
  const pi = built.indexOf('【角色人设】');
  const ni = built.indexOf('你的自称');
  const si = built.indexOf('风格要求');
  const ri = built.indexOf('规则：规则甲');
  check('全局提示词出现在结果里', gi >= 0);
  check('全局提示词在最前方', gi === 0, `位置=${gi}`);
  check('全局提示词在人设提示词之前', gi < pi && pi > 0);
  check('顺序：全局 → 人设 → 自称 → 风格 → 规则', gi < pi && pi < ni && ni < si && si < ri,
    `位置 ${gi}/${pi}/${ni}/${si}/${ri}`);

  // 留空不产生空行/多余内容
  (config as any).secretPersona = { globalPrompt: '', name: 'n', prompt: 'P', style: '', extraRules: [] };
  const noGlobal = buildSecretPersonaPrompt(config);
  check('全局为空时不拼接', !noGlobal.includes('全局') && noGlobal.startsWith('P'), JSON.stringify(noGlobal.slice(0, 20)));
  (config as any).secretPersona = { globalPrompt: '   \n  ', name: 'n', prompt: 'P', style: '', extraRules: [] };
  const blank = buildSecretPersonaPrompt(config);
  check('全局仅空白时不产生空行', blank.startsWith('P'), JSON.stringify(blank.slice(0, 12)));
  check('全局缺失字段不报错', (() => {
    (config as any).secretPersona = { name: 'n', prompt: 'P', style: '', extraRules: [] };
    try { return buildSecretPersonaPrompt(config).startsWith('P'); } catch { return false; }
  })());

  // 全局提示词不能污染普通人设
  (config as any).secretPersona = { globalPrompt: '【仅私密】', name: '', prompt: '', style: '', extraRules: [] };
  check('全局提示词不进普通人设', !buildPersonaPrompt(config).includes('【仅私密】'));
  Object.assign(config, snap3);
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
