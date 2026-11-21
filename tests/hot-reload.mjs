import path from 'node:path';
// 模拟：改配置后不重启 gateway，发一条消息看是否用了新配置
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WS=39901, HTTP=39900, self='10001';
const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  const a=req.url.slice(1);let d={message_id:1};
  if(a==='get_login_info')d={user_id:Number(self),nickname:'bot'};
  if(a==='get_status')d={online:true,good:true};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:d}));});});
await new Promise(r=>srv.listen(HTTP,'127.0.0.1',r));
const wss=new WebSocketServer({port:WS,host:'127.0.0.1'});
let sock=null;
await new Promise(r=>{wss.once('listening',r);wss.once('error',()=>process.exit(2));});
wss.on('connection',s=>{sock=s;});
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg=JSON.parse(fs.readFileSync(repo+'/config/qq.json','utf8'));
cfg.onebot.wsUrl=`ws://127.0.0.1:${WS}`; cfg.onebot.httpUrl=`http://127.0.0.1:${HTTP}`; cfg.autoReply.mode='echo';
fs.writeFileSync('/tmp/hot-qq.json',JSON.stringify(cfg,null,2));
const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo,env:{...process.env,QQBOT_CONFIG:'/tmp/hot-qq.json'},stdio:['ignore','pipe','pipe']});
let out='';gw.stdout.on('data',d=>out+=d);gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++)await new Promise(r=>setTimeout(r,100));
// 启动后改配置文件
await new Promise(r=>setTimeout(r,1500));
const c2=JSON.parse(fs.readFileSync('/tmp/hot-qq.json','utf8'));
c2.persona.style='【热重载生效了】';
fs.writeFileSync('/tmp/hot-qq.json',JSON.stringify(c2,null,2));
await new Promise(r=>setTimeout(r,500));
// 发消息触发 reload
sock.send(JSON.stringify({post_type:'message',message_type:'private',self_id:Number(self),time:Math.floor(Date.now()/1000),user_id:20001,message_id:1,message:[{type:'text',data:{text:'/status'}}],raw_message:'/status',sender:{user_id:20001,nickname:'测试'}}));
await new Promise(r=>setTimeout(r,3000));
gw.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));srv.close();wss.close();
console.log('=== 热重载日志 ===');
const lines=out.split('\n').filter(l=>l.includes('热重载'));
console.log(lines.join('\n')||'(无热重载记录)');
process.exit(0);
