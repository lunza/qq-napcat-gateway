import path from 'node:path';
// [2026-11-12] 端到端：真实抓 e621 图 -> 走真实 gateway -> 检查发出的图片消息段
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WS = 39501, HTTP = 39500, self = '10001';
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
fs.writeFileSync('/tmp/e2e-img-qq.json', JSON.stringify(cfg, null, 2));

const gw = spawn(process.execPath, ['--experimental-strip-types', 'gateway/src/main.ts'], {
  cwd: repo, env: { ...process.env, QQBOT_CONFIG: '/tmp/e2e-img-qq.json' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; gw.stdout.on('data', d => (out += d)); gw.stderr.on('data', d => (out += d));
for (let i = 0; i < 80 && !sock; i++) await new Promise(r => setTimeout(r, 100));

sock.send(JSON.stringify({
  post_type: 'message', message_type: 'private', self_id: Number(self),
  time: Math.floor(Date.now()/1000), user_id: 20001, message_id: 99001,
  message: [{ type: 'text', data: { text: '#来点色图' } }], raw_message: '#来点色图',
  sender: { user_id: 20001, nickname: '测试者' },
}));
console.log('已发送 #来点色图，等待抓图（约 20-40 秒）...');
await new Promise(r => setTimeout(r, 55000));
gw.kill('SIGTERM');
await new Promise(r => setTimeout(r, 800));
srv.close(); wss.close();

const imgSends = sends.filter(s => s.a === 'send_private_msg');
console.log('\n=== 发送结果 ===');
for (const s of imgSends) {
  const msg = s.p.message;
  const segs = Array.isArray(msg) ? msg : [];
  console.log('user:', s.p.user_id);
  for (const seg of segs) {
    if (seg.type === 'image') console.log('  [图片段] file=', String(seg.data.file).slice(0, 110));
    else console.log(`  [${seg.type}]`, JSON.stringify(seg.data).slice(0, 100));
  }
}
const hasImage = imgSends.some(s => Array.isArray(s.p.message) && s.p.message.some(x => x.type === 'image'));
const file = imgSends.flatMap(s => (Array.isArray(s.p.message) ? s.p.message : []))
  .filter(x => x.type === 'image').map(x => String(x.data.file))[0] || '';
const isVideo = /\.(webm|mp4|mov|swf)(\?|$)/i.test(file);
console.log('\n发出图片消息段:', hasImage);
console.log('是图片/GIF 而非视频:', hasImage && !isVideo, file ? `(.${(file.match(/\.([a-z0-9]+)(\?|$)/i)||[])[1]})` : '');
if (!hasImage) console.log('[调试]', out.slice(-800));
process.exit(hasImage && !isVideo ? 0 : 1);
