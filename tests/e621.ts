// [2026-11-12] e621 媒体类型过滤测试（纯函数，不联网）
import { isSendableExt, buildPopularUrl, ALLOWED_EXTS, VIDEO_EXTS } from '../gateway/src/e621.ts';

let pass = 0, total = 0;
const check = (name: string, cond: boolean, extra = '') => {
  total++; if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// 允许：静态图 + gif
for (const e of ['jpg', 'jpeg', 'png', 'gif', 'webp']) {
  check(`允许 .${e}`, isSendableExt(e) === true);
}
// 禁止：视频
for (const e of ['webm', 'mp4', 'mov', 'avi', 'mkv', 'swf', 'flv']) {
  check(`禁止视频 .${e}`, isSendableExt(e) === false);
}
// 大小写、带点、空白
check('大写 .JPG', isSendableExt('JPG') === true);
check('带点 .gif', isSendableExt('.gif') === true);
check('大写 .WEBM', isSendableExt('WEBM') === false);
check('空值不允许', isSendableExt('') === false);

// URL 公式
const u1 = buildPopularUrl({ scale: 'day', date: '2026-11-11 04:43:30 -0500' });
check('URL 含 scale=day', u1.includes('scale=day'), u1);
check('URL 编码 date', u1.includes('date=2026-11-11') && u1.includes('%20'), u1);
const u2 = buildPopularUrl({ scale: 'week' });
check('可切换 scale', u2.includes('scale=week'));

// 集合一致性
check('允许集合不含视频', [...VIDEO_EXTS].every(v => !ALLOWED_EXTS.has(v)));

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
