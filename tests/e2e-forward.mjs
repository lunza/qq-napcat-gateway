import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WS=40301,HTTP=40300,self='10001';
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
// 用 echo 避免调模型，但 e621 技能是独立分支不受影响
fs.writeFileSync('/tmp/e2e-fwd.json',JSON.stringify(cfg,null,2));
const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo,env:{...process.env,QQBOT_CONFIG:'/tmp/e2e-fwd.json'},stdio:['ignore','pipe','pipe']});
let out='';gw.stdout.on('data',d=>out+=d);gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++)await new Promise(r=>setTimeout(r,100));
sock.send(JSON.stringify({post_type:'message',message_type:'group',self_id:Number(self),time:Math.floor(Date.now()/1000),
  group_id:2000000001,user_id:1000000002,message_id:9001,
  message:[{type:'text',data:{text:'#来点色图'}}],raw_message:'#来点色图',sender:{user_id:1000000002,nickname:'OwnerDemo'}}));
console.log('已发 #来点色图，等待取图（最多 60s）...');
await new Promise(r=>setTimeout(r,60000));
gw.kill('SIGTERM');await new Promise(r=>setTimeout(r,800));srv.close();wss.close();
const fwd=sends.filter(s=>s.a==='send_forward_msg');
const grp=sends.filter(s=>s.a==='send_group_msg');
console.log('\n=== 发送结果 ===');
console.log('send_forward_msg 调用次数:', fwd.length);
console.log('send_group_msg 调用次数:', grp.length);
if(fwd.length>0){
  const nodes=fwd[0].p.messages;
  console.log('转发节点数:', nodes.length);
  const content=nodes[0]?.data?.content || [];
  console.log('节点内容段:', content.map((c)=>c.type).join(', '));
  const img=content.find((c)=>c.type==='image');
  if(img) console.log('图片形式:', String(img.data.file).slice(0,30));
}
