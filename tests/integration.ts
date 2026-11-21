// [2026-11-12] 协议层集成测试：本机起一个假的 OneBot11 服务端（WS + HTTP），
// 驱动真实 gateway 处理事件并断言：收到私聊→回复、群未@→忽略、群@→回复(带CQ at)、
// 限流生效、探活在线。用于在没有 QQ 登录之前先把协议闭环验证干净。
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const WS_PORT = 39001;
const HTTP_PORT = 39000;
const selfUin = '10001';
const outbox = path.join(tmpdir(), `qqbot-it-${Date.now()}`);
fs.mkdirSync(outbox, { recursive: true });

// ---- 假 OneBot 服务端 ----
const sends: Array<{ action: string; params: any }> = [];
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const action = (req.url ?? '/').slice(1);
    const params = body ? JSON.parse(body) : {};
    sends.push({ action, params });
    let data: unknown = { message_id: 999 };
    if (action === 'get_login_info') data = { user_id: Number(selfUin), nickname: 'test-bot' };
    if (action === 'get_status') data = { online: true, good: true };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});
await new Promise<void>(r => httpServer.listen(HTTP_PORT, '127.0.0.1', () => r()));

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
let sock: import('ws').WebSocket | null = null;
await new Promise<void>(r => {
  wss.once('listening', () => r());
  wss.once('error', (e) => { console.error('[it] wss error', e); process.exit(2); });
});
wss.on('connection', (s) => { sock = s; });

// ---- 启动真实 gateway ----
const cfg = path.join(outbox, 'qq.json');
fs.writeFileSync(cfg, JSON.stringify({
  onebot: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}`, token: '', timeoutMs: 3000 },
  behavior: { selfUin, privateReply: true, groupRequireMention: true, triggers: [], ignoreSelfMessages: true, replyPrefix: '', maxReplyChars: 50, rateLimitPerPeerPerMin: 2 },
  admin: { allowPeers: [] },
  monitor: { heartbeatMs: 500, probeEveryN: 1, probeTimeoutMs: 2000, offlineAlertMin: 2 },
  autoReply: { mode: 'echo', httpUrl: '' },
}, null, 2));
const repo = path.resolve(import.meta.dirname, '..');
const gw = spawn(process.execPath, ['--experimental-strip-types', 'gateway/src/main.ts'], {
  cwd: repo, env: { ...process.env, QQBOT_CONFIG: cfg, QQBOT_STATE_DIR: outbox }, stdio: ['ignore', 'pipe', 'pipe'],
});
let gwOut = '';
gw.stdout.on('data', d => (gwOut += d.toString()));
gw.stderr.on('data', d => (gwOut += d.toString()));
console.log("[it] gateway started, waiting ws...");
const t0=Date.now(); while(!sock && Date.now()-t0<5000) await new Promise(r => setTimeout(r, 100));
console.log("[it] ws connected:", !!sock);
await new Promise(r => setTimeout(r, 800));

const send = (ev: unknown) => sock!.send(JSON.stringify(ev));
const base = { post_type: 'message', self_id: Number(selfUin), time: Math.floor(Date.now() / 1000) };

// 1) 私聊 → 应回复
send({ ...base, message_type: 'private', user_id: 20001, message_id: 1001, message: [{ type: 'text', data: { text: '你好' } }], raw_message: '你好' });
// 2) 群聊未 @ → 不应回复
send({ ...base, message_type: 'group', group_id: 30001, user_id: 20001, message_id: 1002, message: [{ type: 'text', data: { text: '闲聊' } }], raw_message: '闲聊' });
// 3) 群聊 @ → 应回复且带 CQ at
send({ ...base, message_type: 'group', group_id: 30001, user_id: 20001, message_id: 1003, message: [{ type: 'at', data: { qq: selfUin } }, { type: 'text', data: { text: '在吗' } }], raw_message: `[CQ:at,qq=${selfUin}] 在吗` });
// 4) 私聊高频 → 触发限流（每分钟 2 条，第 3 条应被限流）
send({ ...base, message_type: 'private', user_id: 20002, message_id: 1004, message: [{ type: 'text', data: { text: 'a' } }], raw_message: 'a' });
send({ ...base, message_type: 'private', user_id: 20002, message_id: 1005, message: [{ type: 'text', data: { text: 'b' } }], raw_message: 'b' });
send({ ...base, message_type: 'private', user_id: 20002, message_id: 1006, message: [{ type: 'text', data: { text: 'c' } }], raw_message: 'c' });

await new Promise(r => setTimeout(r, 2500));
gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 500));
httpServer.close(); wss.close();
// 本测试占用了 OneBot 端口，结束前必须把端口还给 NapCat 的真实服务
await new Promise<void>((resolve) => {
  const done = () => resolve();
  if (wss.clients.size === 0) return done();
  let n = wss.clients.size;
  for (const c of wss.clients) c.once('close', () => { if (--n === 0) done(); });
  setTimeout(done, 5000);
});
console.log('[it] round1 服务端已关闭连接，clients=', wss.clients.size);

const sendsOf = (a: string) => sends.filter(s => s.action === a);
const privateSends = sendsOf('send_private_msg');
const groupSends = sendsOf('send_group_msg');
const results: Array<[string, boolean, string]> = [
  ['私聊收到回复', privateSends.some(s => s.params.user_id === 20001 && String(s.params.message).includes('你好')), JSON.stringify(privateSends.map(s => s.params))],
  ['群聊未@被忽略', !groupSends.some(s => s.params.message && String(s.params.message).includes('闲聊')), ''],
  ['群聊@有回复且带at', groupSends.some(s => String(s.params.message).includes(`[CQ:at,qq=20001]`)), JSON.stringify(groupSends.map(s => s.params))],
  ['限流生效(20002只回2条)', privateSends.filter(s => s.params.user_id === 20002).length === 2, `count=${privateSends.filter(s => s.params.user_id === 20002).length}`],
  ['gateway 日志含限流提示', gwOut.includes('触发限流'), ''],
  ['探活写入 health.json', fs.existsSync(path.join(repo, 'state', 'health.json')), ''],
];
let ok = 0;
for (const [name, pass, extra] of results) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (pass) ok++; }
console.log(ok === results.length ? 'ROUND1 ALL PASS' : `ROUND1 SOME FAIL (${ok}/${results.length})`);
if (ok !== results.length) process.exit(1);

// ---- 第二轮：harness 模式（桥接脚本）链路 ----
import { spawn as spawn2 } from 'node:child_process';
import os from 'node:os';
// 第二轮使用全新的 HTTP/WS 服务端（新端口），不复用第一轮已关闭的 server
const WS_PORT2 = 39011, HTTP_PORT2 = 39010;
const http2 = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const action = (req.url ?? '/').slice(1);
    const params = body ? JSON.parse(body) : {};
    sends.push({ action, params });
    let data: unknown = { message_id: 999 };
    if (action === 'get_login_info') data = { user_id: Number(selfUin), nickname: 'test-bot' };
    if (action === 'get_status') data = { online: true, good: true };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});
await new Promise<void>(r => http2.listen(HTTP_PORT2, '127.0.0.1', () => r()));
const wss2 = new WebSocketServer({ port: WS_PORT2, host: '127.0.0.1' });
let sock2: import('ws').WebSocket | null = null;
await new Promise<void>(r => { wss2.once('listening', () => r()); wss2.once('error', () => process.exit(2)); });
wss2.on('connection', (s2) => { sock2 = s2; });
const send2 = (ev: unknown) => sock2?.send(JSON.stringify(ev));

const cfg2 = path.join(outbox, 'qq2.json');
fs.writeFileSync(cfg2, JSON.stringify({
  onebot: { wsUrl: `ws://127.0.0.1:${WS_PORT2}`, httpUrl: `http://127.0.0.1:${HTTP_PORT2}`, token: '', timeoutMs: 3000 },
  behavior: { selfUin, privateReply: true, groupRequireMention: true, triggers: [], ignoreSelfMessages: true, replyPrefix: '', maxReplyChars: 200, rateLimitPerPeerPerMin: 10 },
  admin: { allowPeers: [] },
  monitor: { heartbeatMs: 2000, probeEveryN: 1, probeTimeoutMs: 2000, offlineAlertMin: 2 },
  autoReply: { mode: 'harness', httpUrl: '', command: path.join(repo, 'tests', 'bridge-mock.sh'), cwd: repo, timeoutMs: 20000 },
}, null, 2));
// 重建一个干净的服务端：第一轮的 server 已 close，新连接需要新的 listener
await new Promise<void>((resolve) => {
  const deadline = Date.now() + 5000;
  const tryClose = () => {
    httpServer.close(() => resolve());
    if (Date.now() > deadline) resolve();
  };
  tryClose();
});
wss.removeAllListeners('connection');
wss.on('connection', (s) => { sock = s; });
console.log('[it] round2 服务端就绪, clients=', wss.clients.size);
const gw2 = spawn2(process.execPath, ['--experimental-strip-types', 'gateway/src/main.ts'], {
  cwd: repo, env: { ...process.env, QQBOT_CONFIG: cfg2 }, stdio: ['ignore', 'pipe', 'pipe'],
});
let gw2Out = ''; gw2.stdout.on('data', d => (gw2Out += d.toString())); gw2.stderr.on('data', d => (gw2Out += d.toString()));
await new Promise(r => setTimeout(r, 2500));
const before = sends.length;
for (let i = 0; i < 60 && !sock2; i++) await new Promise(r => setTimeout(r, 100));
send2({ ...base, message_type: 'private', user_id: 20009, message_id: 2001, message: [{ type: 'text', data: { text: '今晚吃什么' } }], raw_message: '今晚吃什么' });
await new Promise(r => setTimeout(r, 4000));
gw2.kill('SIGTERM');
await new Promise(r => setTimeout(r, 500));
http2.close(); wss2.close();
const harnessSends = sends.slice(before).filter(s => s.action === 'send_private_msg' && s.params.user_id === 20009);
if (harnessSends.length === 0) console.log('[debug] gw2 输出：', gw2Out.slice(-1500));
console.log(`${harnessSends.length > 0 ? 'PASS' : 'FAIL'}  harness 模式经桥接脚本回复  ${JSON.stringify(harnessSends.map(s => s.params.message))}`);
console.log(`${gw2Out.includes('已回复') ? 'PASS' : 'FAIL'}  harness 模式写回日志`);
gw.kill('SIGKILL');
process.exit(harnessSends.length > 0 ? 0 : 1);
