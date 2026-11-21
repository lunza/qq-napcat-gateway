import path from 'node:path';
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const WS=40001, HTTP=40000, self='10001';
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
// 用独立的 state 目录避免污染真实库
const testState='/tmp/e2e-reset-state';
fs.rmSync(testState,{recursive:true,force:true});fs.mkdirSync(testState,{recursive:true});
// 预置一条历史，模拟"之前聊过"
const prep=JSON.parse(fs.readFileSync(repo+'/config/qq.json','utf8'));
prep.onebot.wsUrl=`ws://127.0.0.1:${WS}`;prep.onebot.httpUrl=`http://127.0.0.1:${HTTP}`;prep.autoReply.mode='echo';
fs.writeFileSync('/tmp/e2e-reset-qq.json',JSON.stringify(prep,null,2));

const gw=spawn(process.execPath,['--experimental-strip-types','gateway/src/main.ts'],{
  cwd:repo,env:{...process.env,QQBOT_CONFIG:'/tmp/e2e-reset-qq.json',QQBOT_STATE_DIR:testState},stdio:['ignore','pipe','pipe']});
let out='';gw.stdout.on('data',d=>out+=d);gw.stderr.on('data',d=>out+=d);
for(let i=0;i<80&&!sock;i++)await new Promise(r=>setTimeout(r,100));
const send=(text,id)=>sock.send(JSON.stringify({post_type:'message',message_type:'private',self_id:Number(self),
  time:Math.floor(Date.now()/1000),user_id:20001,message_id:id,message:[{type:'text',data:{text}}],
  raw_message:text,sender:{user_id:20001,nickname:'测试者'}}));

send('聊点别的',1); await new Promise(r=>setTimeout(r,800));
send('再多说几句',2); await new Promise(r=>setTimeout(r,800));
send('/reset',3); await new Promise(r=>setTimeout(r,2000));
gw.kill('SIGTERM'); await new Promise(r=>setTimeout(r,800));
srv.close();wss.close();

const replies=sends.filter(s=>s.a==='send_private_msg').map(s=>String(s.p.message));
console.log('=== /reset 回复 ===');
console.log(replies.find(r=>r.includes('已重置'))||'(无)');
// 检查数据库
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(repo+'/state/chat.db');
const cnt=d.prepare("SELECT COUNT(*) c FROM messages WHERE peerKey='private:20001'").get().c;
d.close();
console.log('\n该会话剩余消息:', cnt);
process.exit(cnt===0?0:1);
