// [2026-11-12] harness 模式真实推理验证：假 OneBot 服务端 + 真实 gateway + 真实 dsh-bridge
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const WS_PORT = 39101, HTTP_PORT = 39100, selfUin = '10001';
const out = path.join(tmpdir(), `qqbot-live-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const sends: any[] = [];
const httpServer = http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c));
  req.on('end', () => {
    const action = (req.url ?? '/').slice(1);
    const params = body ? JSON.parse(body) : {};
    sends.push({ action, params });
    let data: any = { message_id: 1 };
    if (action === 'get_login_info') data = { user_id: Number(selfUin), nickname: 'bot' };
    if (action === 'get_status') data = { online: true, good: true };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});
await new Promise<void>(r => httpServer.listen(HTTP_PORT, '127.0.0.1', () => r()));
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
let sock: any = null;
await new Promise<void>(r => { wss.once('listening', () => r()); wss.once('error', () => process.exit(2)); });
wss.on('connection', s => { sock = s; });

const repo = path.resolve(import.meta.dirname, '..');
const cfg = path.join(out, 'qq.json');
fs.writeFileSync(cfg, JSON.stringify({
  onebot: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}`, token: '', timeoutMs: 5000 },
  behavior: { selfUin, privateReply: true, groupRequireMention: true, triggers: [], ignoreSelfMessages: true, replyPrefix: '', maxReplyChars: 500, rateLimitPerPeerPerMin: 10 },
  admin: { allowPeers: [] },
  monitor: { heartbeatMs: 5000, probeEveryN: 1, probeTimeoutMs: 3000, offlineAlertMin: 5 },
  autoReply: { mode: 'harness', httpUrl: '', command: path.join(repo, 'dsh-bridge.sh'), cwd: repo, timeoutMs: 240000 },
}, null, 2));

const gw = spawn(process.execPath, ['--experimental-strip-types', 'gateway/src/main.ts'], {
  cwd: repo, env: { ...process.env, QQBOT_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
});
let gwOut = ''; gw.stdout.on('data', d => (gwOut += d)); gw.stderr.on('data', d => (gwOut += d));
for (let i = 0; i < 60 && !sock; i++) await new Promise(r => setTimeout(r, 100));

const cases = ['测试', '你是谁', '今天天气怎么样'];
for (let i = 0; i < cases.length; i++) {
  sock.send(JSON.stringify({ post_type: 'message', self_id: Number(selfUin), time: Math.floor(Date.now()/1000),
    message_type: 'private', user_id: 20001 + i, message_id: 5000 + i,
    message: [{ type: 'text', data: { text: cases[i] } }], raw_message: cases[i],
    sender: { user_id: 20001 + i, nickname: `测试者${i}` } }));
  console.log(`>> 发送: ${cases[i]}`);
  await new Promise(r => setTimeout(r, 25000)); // 每条给足模型思考时间
}
gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 800));
httpServer.close(); wss.close();

console.log('\n=== 回复结果 ===');
let ok = 0;
for (let i = 0; i < cases.length; i++) {
  const r = sends.filter(s => s.action === 'send_private_msg' && s.params.user_id === 20001 + i);
  const txt = r.length ? String(r[0].params.message) : '(无回复)';
  const pass = r.length > 0 && !txt.includes('harness 运行失败');
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  "${cases[i]}" -> "${txt}"`);
}
if (ok < cases.length) console.log('[debug]', gwOut.slice(-1200));
console.log(`\n${ok}/${cases.length} 成功`);
process.exit(ok === cases.length ? 0 : 1);
