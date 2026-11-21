// [2026-11-16] CQ 码转消息段测试：OneBot11 数组格式 text 段不解析 CQ 码，
// 带图回复 caption 里的 [CQ:at] 必须转成 at 段（否则字面文本显示给用户）。
import { buildTextSegments, buildImageMessage } from '../gateway/src/onebot.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// ── buildTextSegments ──
{
  const s = buildTextSegments('[CQ:at,qq=123] 你好') as Array<{ type: string; data: any }>;
  check('at码转at段', s.length === 2 && s[0]!.type === 'at' && s[0]!.data.qq === '123', JSON.stringify(s));
  check('at码后的文本保留', s[1]!.type === 'text' && s[1]!.data.text === ' 你好');
}
{
  const s = buildTextSegments('普通文本没有CQ码') as Array<{ type: string; data: any }>;
  check('无CQ码=单text段', s.length === 1 && s[0]!.type === 'text', JSON.stringify(s));
}
{
  const s = buildTextSegments('[CQ:at,qq=1] a [CQ:at,qq=2] b') as Array<{ type: string; data: any }>;
  check('多个at码各转一段', s.filter((x) => x.type === 'at').length === 2, JSON.stringify(s));
  check('段顺序保持原文语序', s[0]!.type === 'at' && s[2]!.type === 'at' && s[3]!.data.text === ' b');
}
{
  const s = buildTextSegments('前缀[CQ:at,qq=9]') as Array<{ type: string; data: any }>;
  check('结尾at码+前缀文本', s.length === 2 && s[0]!.data.text === '前缀' && s[1]!.type === 'at');
}
{
  // 未识别的 CQ 码按原文保留（宁可原样也不丢内容）
  const s = buildTextSegments('看看[CQ:face,id=1]这个') as Array<{ type: string; data: any }>;
  check('未识别CQ码原样保留', s.length === 1 && s[0]!.data.text.includes('[CQ:face,id=1]'));
}
{
  const s = buildTextSegments('') as Array<{ type: string; data: any }>;
  check('空文本给空text段', s.length === 1 && s[0]!.type === 'text');
}

// ── buildImageMessage ──
{
  const s = buildImageMessage('base64://xxx', '[CQ:at,qq=123] 图来了') as Array<{ type: string; data: any }>;
  check('带图:at段+text段+image段', s.length === 3 && s[0]!.type === 'at' && s[1]!.type === 'text' && s[2]!.type === 'image', JSON.stringify(s.map((x) => x.type)));
}
{
  const s = buildImageMessage('base64://xxx') as Array<{ type: string; data: any }>;
  check('带图:无caption只有image段', s.length === 1 && s[0]!.type === 'image');
}
{
  const s = buildImageMessage('base64://xxx', '纯文字说明') as Array<{ type: string; data: any }>;
  check('带图:纯文字caption', s.length === 2 && s[0]!.type === 'text' && s[0]!.data.text === '纯文字说明' && s[1]!.type === 'image');
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
