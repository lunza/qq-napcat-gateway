// [2026-11-12] 探活判定回归：离线时绝不能被判成在线
import { OneBotClient } from '../gateway/src/onebot.ts';
const mk = (online: boolean | undefined, loginOk = true) => new OneBotClient({
  wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://x', token: '', timeoutMs: 1000, logDir: '/tmp',
  onEvent: () => {}, onConnection: () => {},
}) as unknown as { call: (a: string) => Promise<unknown>; probe: () => Promise<{ online: boolean }> };
// 直接替换 call 模拟 NapCat 响应
function patched(online: boolean | undefined, loginOk = true) {
  const c = new OneBotClient({ wsUrl: 'ws://x', httpUrl: 'http://x', token: '', timeoutMs: 1000, logDir: '/tmp', onEvent: () => {}, onConnection: () => {} });
  (c as unknown as Record<string, unknown>).call = async (a: string) => a === 'get_login_info'
    ? { status: loginOk ? 'ok' : 'failed', retcode: 0, data: { user_id: 1000000001 } }
    : { status: 'ok', retcode: 0, data: { online } };
  return c;
}
const cases: Array<[string, boolean | undefined, boolean, boolean]> = [
  ['在线: online=true', true, true, true],
  ['离线: online=false（关键回归）', false, true, false],
  ['未给出 online 字段', undefined, true, false],
  ['login 失败 + online=true', true, false, true],
];
let pass = 0;
for (const [name, online, loginOk, want] of cases) {
  const r = await patched(online, loginOk).probe();
  const ok = r.online === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: want online=${want} got=${r.online}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
