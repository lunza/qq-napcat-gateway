import path from 'node:path';
// 用假 OneBot 服务端 + 真实 gateway 配置，验证 #help 与 # 技能触发
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WS = 39301, HTTP = 39300, self = '10001';
const sends = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c));
  req.on('end', () => {
    const a = req.url.slice(1); const p = b ? JSON.parse(b) : {};
    sends.push({ a, p });
    let d = { message_id: 1 };
    if (a === 'get_login_info') d = { user_id: Number(self), nickname: 'bot' };
    if (a === 'get_status') d = { online: true, good: true };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: d }));
  });
});
await new Promise(r => srv.listen(HTTP, '127.0.0.1', r));
const wss = new WebSocketServer({ port: WS, host: '127.0.0.1' });
let sock = null;
await new Promise(r => { wss.once('listening', r); wss.once('error', () => process.exit(2)); });
wss.on('connection', s => { sock = s; });

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(repo + '/config/qq.json', 'utf8'));
cfg.onebot.wsUrl = `ws://127.0.0.1:${WS}`;
cfg.onebot.httpUrl = `http://127.0.0.1:${HTTP}`;
cfg.autoReply.mode = 'off'; // 避免触发真实模型，只看路由与 #help
fs.writeFileSync('/tmp/e2e-qq.json', JSON.stringify(cfg, null, 2));

const gw = spawn(process.execPath, ['--experimental-strip-types', 'gateway/src/main.ts'], {
  cwd: repo, env: { ...process.env, QQBOT_CONFIG: '/tmp/e2e-qq.json' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; gw.stdout.on('data', d => (out += d)); gw.stderr.on('data', d => (out += d));
for (let i = 0; i < 80 && !sock; i++) await new Promise(r => setTimeout(r, 100));

const send = (text, id) => sock.send(JSON.stringify({
  post_type: 'message', message_type: 'private', self_id: Number(self), time: Math.floor(Date.now()/1000),
  user_id: 20001, message_id: id, message: [{ type: 'text', data: { text } }], raw_message: text,
  sender: { user_id: 20001, nickname: '测试者' },
}));

send('#help', 9001);
await new Promise(r => setTimeout(r, 2500));
send('今日运势', 9002);   // 无 # 应不触发技能
await new Promise(r => setTimeout(r, 2500));
gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 500));
srv.close(); wss.close();

const replied = sends.filter(s => s.a === 'send_private_msg').map(s => String(s.p.message));
console.log('=== 实际发给用户的消息 ===');
for (const m of replied) console.log(m + '\n---');
console.log('#help 返回技能列表:', replied.some(m => m.includes('可用技能') && m.includes('#今日运势')));
// autoReply=off 时普通消息本就不回复，只需确认没有误把普通消息当 #help
console.log('普通消息未触发 #help:', !replied.some(m => m.includes('可用技能') && m.length > 200));
process.exit(0);
