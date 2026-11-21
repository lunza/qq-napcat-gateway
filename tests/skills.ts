// [2026-11-12] 技能引擎测试：以 # 触发、#help 列表、冷却、优先级
import {
  matchSkill, skillPromptSection, resetSkillCooldown,
  extractTags, isHelpRequest, renderSkillHelp, activeSkills,
} from '../gateway/src/skills.ts';
import type { QqConfig } from '../gateway/src/config.ts';

const base = {
  skills: {
    enabled: true,
    items: [
      { id: 'fortune', name: '今日运势', triggers: ['今日运势', '运势', '算一卦'], prompt: '测运势指令', enabled: true, cooldownSec: 60 },
      { id: 'pic', name: '今日美图', triggers: ['来张图', '今日美图'], prompt: '去图库取一张图', enabled: true, cooldownSec: 0 },
      { id: 'off', name: '已禁用', triggers: ['禁用词'], prompt: '不应触发', enabled: false, cooldownSec: 0 },
    ],
  },
} as unknown as QqConfig;

let pass = 0, total = 0;
const check = (name: string, cond: boolean, extra = '') => {
  total++; if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// --- 提取 # 片段 ---
check('提取单个 #', JSON.stringify(extractTags('#今日运势')) === '["今日运势"]');
check('提取多个 #', JSON.stringify(extractTags('#今日运势 #来张图')) === '["今日运势","来张图"]');
check('全角 ＃ 也认', JSON.stringify(extractTags('＃今日运势')) === '["今日运势"]');
check('句中出现也算', JSON.stringify(extractTags('帮我 #今日运势 看看')) === '["今日运势"]');
check('无 # 返回空', extractTags('今日运势').length === 0);

// --- # 触发规则 ---
resetSkillCooldown();
check('不带 # 不触发', matchSkill('今日运势', base, 'p1') === null);
resetSkillCooldown();
check('不带 # 普通聊天不触发', matchSkill('帮我看看运势如何', base, 'p2') === null);
resetSkillCooldown();
const h1 = matchSkill('#今日运势', base, 'p3');
check('# 触发命中', h1?.skill.id === 'fortune', JSON.stringify(h1?.trigger));
resetSkillCooldown();
const h2 = matchSkill('#算一卦', base, 'p4');
check('# 短触发词命中', h2?.skill.id === 'fortune');
resetSkillCooldown();
const h3 = matchSkill('帮我 #来张图', base, 'p5');
check('句中 # 触发', h3?.skill.id === 'pic');
resetSkillCooldown();
check('禁用技能 # 也不触发', matchSkill('#禁用词', base, 'p6') === null);
resetSkillCooldown();
const h4 = matchSkill('#今日美图', base, 'p7');
check('可用技能名当触发词', h4?.skill.id === 'pic', JSON.stringify(h4?.trigger));
resetSkillCooldown();
check('未知 # 不触发', matchSkill('#不存在的技能', base, 'p8') === null);

// --- #help ---
check('#help 被识别', isHelpRequest('#help') === true);
check('#帮助 被识别', isHelpRequest('#帮助') === true);
check('全角 ＃help', isHelpRequest('＃help') === true);
check('#HELP 大小写', isHelpRequest('#HELP') === true);
check('普通消息非 help', isHelpRequest('今天吃什么') === false);
const help = renderSkillHelp(base);
check('#help 列出启用技能', help.includes('今日运势') && help.includes('今日美图'));
check('#help 不含禁用技能', !help.includes('已禁用'));
check('#help 带 # 前缀', help.includes('#今日运势'));
check('#help 带用法提示', help.includes('发送 #技能名'));
const emptyHelp = renderSkillHelp({ skills: { enabled: true, items: [] } } as QqConfig);
check('无技能时提示明确', emptyHelp.includes('没有可用的技能'));

// --- 冷却 ---
resetSkillCooldown();
matchSkill('#今日运势', base, 'c1');
check('冷却生效', matchSkill('#今日运势', base, 'c1') === null);
resetSkillCooldown();
matchSkill('#今日运势', base, 'c2');
check('冷却按会话隔离', matchSkill('#今日运势', base, 'c3') !== null);
resetSkillCooldown();
const a = matchSkill('#来张图', base, 'c4');
const b = matchSkill('#来张图', base, 'c4');
check('cooldownSec=0 不冷却', a !== null && b !== null);

// --- 总开关 / 注入 ---
resetSkillCooldown();
check('总开关关闭时 #help 无内容', activeSkills({ skills: { ...base.skills, enabled: false } } as QqConfig).length === 0);
resetSkillCooldown();
const hit = matchSkill('#今日运势', base, 'inj');
check('注入含技能名', skillPromptSection(hit)?.includes('今日运势') === true);
check('无命中注入为空', skillPromptSection(null) === '');

// --- 长词优先 ---
resetSkillCooldown();
const tie = matchSkill('#今日运势', { skills: { enabled: true, items: [
  { id: 'a', name: 'A', triggers: ['运势'], prompt: 'a', enabled: true, cooldownSec: 0 },
  { id: 'b', name: 'B', triggers: ['今日运势'], prompt: 'b', enabled: true, cooldownSec: 0 },
] } } as QqConfig, 'tie');
check('长触发词优先', tie?.skill.id === 'b', JSON.stringify(tie?.skill.id));

console.log('\n--- #help 输出预览 ---');
console.log(help);
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
