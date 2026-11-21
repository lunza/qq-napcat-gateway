import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WS=40101,HTTP=40100,self='10001';
const sends=[];
const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  const a=req.url.slice(1);const p=b?JSON.parse(b):{};sends.push({a,p});
  let d={message_id:1};
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
cfg.onebot.wsUrl=`ws://127.0.0.1:${WS}`;cfg.onebot.httpUrl=`http://127.0.0.1:${HTTP}`;
cfg.autoReply.mode='off';   // 只测路由，#help 走命令不走模型
fs.writeFileSync('/tmp/e2e-grp.json',JSON.stringify(cfg,null,2));
const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo,env:{...process.env,QQBOT_CONFIG:'/tmp/e2e-grp.json'},stdio:['ignore','pipe','pipe']});
let out='';gw.stdout.on('data',d=>out+=d);gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++)await new Promise(r=>setTimeout(r,100));
let seq=0;
const grp=(text,at=false)=>sock.send(JSON.stringify({post_type:'message',message_type:'group',self_id:Number(self),time:Math.floor(Date.now()/1000),group_id:2000000001,user_id:1000000002,message_id:++seq,
  message:at?[{type:'at',data:{qq:self}},{type:'text',data:{text}}]:[{type:'text',data:{text}}],
  raw_message:at?`[CQ:at,qq=${self}] ${text}`:text,sender:{user_id:1000000002,nickname:'群友'}}));
grp('#help',false); await new Promise(r=>setTimeout(r,1500));   // 免@应回复
grp('今天天气不错',false); await new Promise(r=>setTimeout(r,1200)); // 普通聊天不应回复
gw.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));srv.close();wss.close();
const grpReplies=sends.filter(s=>s.a==='send_group_msg').map(s=>String(s.p.message));
console.log('群消息回复数:', grpReplies.length);
for(const r of grpReplies) console.log('  ', r.slice(0,80).replace(/\n/g,' | '));
process.exit(grpReplies.length===1?0:1);
