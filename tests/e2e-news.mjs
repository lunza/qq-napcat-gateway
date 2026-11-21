import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WS=40501,HTTP=40500,self='10001';
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
fs.writeFileSync('/tmp/e2e-news.json',JSON.stringify(cfg,null,2));
const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo,env:{...process.env,QQBOT_CONFIG:'/tmp/e2e-news.json'},stdio:['ignore','pipe','pipe']});
let out='';gw.stdout.on('data',d=>out+=d);gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++)await new Promise(r=>setTimeout(r,100));
let seq=0;
const send=(text,kind='group',at=false)=>sock.send(JSON.stringify({
  post_type:'message',message_type:kind,self_id:Number(self),time:Math.floor(Date.now()/1000),
  ...(kind==='group'?{group_id:2000000001}:{}),user_id:1000000002,message_id:++seq,
  message:at&&kind==='group'?[{type:'at',data:{qq:self}},{type:'text',data:{text}}]:[{type:'text',data:{text}}],
  raw_message:at&&kind==='group'?`[CQ:at,qq=${self}] ${text}`:text,
  sender:{user_id:1000000002,nickname:'OwnerDemo'}}));

send('#新鲜事','group'); await new Promise(r=>setTimeout(r,15000));
send('#新闻','private'); await new Promise(r=>setTimeout(r,15000));
gw.kill('SIGTERM');await new Promise(r=>setTimeout(r,800));srv.close();wss.close();

const fwd=sends.filter(s=>s.a==='send_forward_msg');
const pri=sends.filter(s=>s.a==='send_private_msg');
const grp=sends.filter(s=>s.a==='send_group_msg');
console.log('\n=== 结果 ===');
console.log('群转发:',fwd.length,'| 群消息:',grp.length,'| 私聊:',pri.length);
if(fwd.length>0){
  const nodes=fwd[0].p.messages;
  const content=nodes[0]?.data?.content||[];
  console.log('转发节点内容段:',content.map(c=>c.type).join(', '));
  const txt=content.find(c=>c.type==='text');
  if(txt) console.log('文字预览:\n'+String(txt.data.text).slice(0,200));
  const img=content.find(c=>c.type==='image');
  console.log('图片:',img?String(img.data.file).slice(0,70):'(无)');
}
if(pri.length>0){
  const m=pri[0].p.message;
  const segs=Array.isArray(m)?m:[{type:'text',data:{text:m}}];
  console.log('\n私聊段:',segs.map(s=>s.type).join(', '));
}
