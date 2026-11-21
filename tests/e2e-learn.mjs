import path from 'node:path';
// [2026-11-12] 端到端：真实 gateway 收集文字+表情包，然后跑分析
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WS = 39701, HTTP = 39700, self = '10001';
const srv = http.createServer((req, res) => {
  let b=''; req.on('data', c=>b+=c);
  req.on('end', () => {
    const a = req.url.slice(1); let d = { message_id: 1 };
    if (a==='get_login_info') d={user_id:Number(self),nickname:'bot'};
    if (a==='get_status') d={online:true,good:true};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',retcode:0,data:d}));
  });
});
await new Promise(r=>srv.listen(HTTP,'127.0.0.1',r));
const wss = new WebSocketServer({ port: WS, host: '127.0.0.1' });
let sock=null;
await new Promise(r=>{wss.once('listening',r);wss.once('error',()=>process.exit(2));});
wss.on('connection',s=>{sock=s;});

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg=JSON.parse(fs.readFileSync(repo+'/config/qq.json','utf8'));
cfg.onebot.wsUrl=`ws://127.0.0.1:${WS}`; cfg.onebot.httpUrl=`http://127.0.0.1:${HTTP}`;
cfg.autoReply.mode='off';              // 只测收集，不调模型
fs.writeFileSync('/tmp/e2e-learn-qq.json', JSON.stringify(cfg,null,2));
// 用独立 state 目录避免污染真实库
cfg.stateDir='/tmp/e2e-learn-state';
fs.mkdirSync('/tmp/e2e-learn-state',{recursive:true});

const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo, env:{...process.env, QQBOT_CONFIG:'/tmp/e2e-learn-qq.json'}, stdio:['ignore','pipe','pipe']});
let out=''; gw.stdout.on('data',d=>out+=d); gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++) await new Promise(r=>setTimeout(r,100));

const send=(text,id,extras={})=>sock.send(JSON.stringify({
  post_type:'message', message_type:'group', self_id:Number(self), time:Math.floor(Date.now()/1000),
  group_id:2000000001, user_id:20001, message_id:id,
  message: extras.message ?? [{type:'text',data:{text}}],
  raw_message: text, sender:{user_id:20001,nickname:'测试者'},
}));

send('哈哈哈笑死我了', 1);
await new Promise(r=>setTimeout(r,600));
// 表情包消息（image 段带 url）
send('[image]', 2, { message:[{type:'image',data:{url:'https://p.qpic.cn/qq_expression/123/abc'}}] });
await new Promise(r=>setTimeout(r,600));
send('确实离谱', 3);
await new Promise(r=>setTimeout(r,600));
send('好家伙', 4);
await new Promise(r=>setTimeout(r,600));
send('', 5, { message:[{type:'mface',data:{url:'https://p.qpic.cn/qq_expression/456/xyz',summary:'[表情]'}}] });
await new Promise(r=>setTimeout(r,1500));
gw.kill('SIGTERM');
await new Promise(r=>setTimeout(r,800));
srv.close(); wss.close();
console.log('gateway 退出');
process.exit(0);
