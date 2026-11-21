// [2026-11-12] WS 连通性探针：在"不依赖登录"的前提下，验证 NapCat 的 OneBot 正向 WS 是否可连。
// 用法：node --experimental-strip-types tests/ws-probe.ts <wsUrl> [token]
import WebSocket from 'ws';
const url = process.argv[2] || 'ws://127.0.0.1:3001';
const token = process.argv[3] || '';
const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
const t0 = Date.now();
WS: {
  ws.on('open', () => { console.log(`OPEN  ${url}  (${Date.now() - t0}ms)`); console.log('与 NapCat 的 OneBot WS 链路已通（握手成功即说明协议端在监听并接受连接）'); });
  ws.on('message', (b) => { console.log('EVENT', String(b).slice(0, 300)); });
  ws.on('error', (e) => { console.log(`ERROR ${url}: ${(e as Error).message}`); });
  ws.on('close', (c) => { console.log('CLOSE', c); process.exit(0); });
}
setTimeout(() => { console.log('TIMEOUT 未连上（可能 NapCat 未启动或 WS 未开启）'); ws.close(); process.exit(1); }, 3000);
