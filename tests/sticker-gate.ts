// [2026-11-13] 表情包 AI 收藏闸门测试
//
// 覆盖：
//   1. 预筛（宽幅大图直接否决，不花 token）
//   2. 阈值裁决 passesStickerGate（0.6 门槛、边界值、非法置信度）
//   3. 存储层：verdict 写入/读取、rejected 列表、删除记录
//   4. 配置默认值：stickerFilter 默认启用、阈值 0.6、失败不收（用户已确认）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prefilterByShape, passesStickerGate, type StickerVerdict } from '../gateway/src/sticker.ts';
import { openChatStore } from '../gateway/src/chat-store.ts';
import { loadConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };
const v = (isSticker: boolean, confidence: number): StickerVerdict =>
  ({ isSticker, confidence, reason: 'test', kind: '测试', byModel: true });

// 1) 预筛：宽幅大图（典型新闻/公告长截图）不需要模型就能否决
console.log('--- 预筛 ---');
const wide = prefilterByShape(1920, 500);
check('宽幅大图被预筛否决', wide !== null && wide.isSticker === false, JSON.stringify(wide && { r: wide.confidence, k: wide.kind }));
check('预筛否决不标记为走了模型', wide?.byModel === false);
check('方形表情包不被预筛否决', prefilterByShape(200, 200) === null);
check('略宽的小图不被预筛否决', prefilterByShape(400, 150) === null);
check('极高比例但小尺寸不预筛否决', prefilterByShape(600, 200) === null);
check('尺寸未知交给模型', prefilterByShape(0, 0) === null);

// 2) 阈值裁决
console.log('--- 阈值裁决 ---');
check('是表情包且 0.6 → 放行', passesStickerGate(v(true, 0.6), 0.6) === true);
check('是表情包且 0.59 → 拒绝', passesStickerGate(v(true, 0.59), 0.6) === false);
check('是表情包且 1.0 → 放行', passesStickerGate(v(true, 1), 0.6) === true);
check('不是表情包但置信度 0.99 → 拒绝', passesStickerGate(v(false, 0.99), 0.6) === false);
check('置信度 0 → 拒绝', passesStickerGate(v(true, 0), 0.6) === false);
check('minConfidence 非法时退回 0.6', passesStickerGate(v(true, 0.5), NaN) === false);
check('minConfidence 为 0 时任何表情包都放行', passesStickerGate(v(true, 0), 0) === true);

// 3) 存储层：verdict 读写 + rejected 列表 + 删除
console.log('--- 存储层 ---');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
const st = openChatStore(path.join(dir, 'c.db'));
st.addSticker('https://x/sticker.png', 'group:1', '1001');
st.addSticker('https://x/news.png', 'group:1', '1002');
st.addSticker('https://x/legacy.png', 'group:1', '1003');

const byUrl = new Map(st.allStickers(10).map((x) => [x.url, x]));
check('allStickers 取到全部记录', byUrl.size === 3, String(byUrl.size));
check('新记录默认 verdict=unknown', byUrl.get('https://x/legacy.png')?.verdict === 'unknown', String(byUrl.get('https://x/legacy.png')?.verdict));

st.setVerdict('https://x/sticker.png', 'sticker', '表情包/0.92 夸张表情配文字');
st.setVerdict('https://x/news.png', 'rejected', '新闻截图/0.95 AMD 官方招聘公告');
const after = new Map(st.allStickers(10).map((x) => [x.url, x]));
check('verdict 写入生效', after.get('https://x/sticker.png')?.verdict === 'sticker');
check('verdictReason 写入生效', (after.get('https://x/news.png')?.verdictReason ?? '').includes('招聘公告'), String(after.get('https://x/news.png')?.verdictReason));

const rejected = st.rejectedStickers(10);
check('rejectedStickers 只返回被否决的', rejected.length === 1 && rejected[0]!.url === 'https://x/news.png', JSON.stringify(rejected.map((r) => r.url)));

check('删除存在的记录返回 true', st.deleteSticker('https://x/news.png') === true);
check('删除后记录数减少', st.allStickers(10).length === 2, String(st.allStickers(10).length));
check('删除后不再出现在 rejected 列表', st.rejectedStickers(10).length === 0);
check('删除不存在的记录返回 false', st.deleteSticker('https://x/nonexistent.png') === false);
check('删除一条不影响其它记录', st.allStickers(10).some((x) => x.url === 'https://x/sticker.png'));

st.close();
fs.rmSync(dir, { recursive: true, force: true });

// 4) 配置默认值（用户已确认：默认启用、阈值 0.6、失败不收）
console.log('--- 配置默认值 ---');
const { config } = loadConfig();
check('stickerFilter 默认存在', !!config.stickerFilter);
check('默认启用闸门', config.stickerFilter.enabled === true);
check('默认阈值 0.6', config.stickerFilter.minConfidence === 0.6, String(config.stickerFilter.minConfidence));
check('默认失败不收集（宁缺勿滥）', config.stickerFilter.collectOnError === false);

// 5) /s 支持异步 handler（/s audit 需要调 AI），且未知子命令不再静默当 list
console.log('--- 命令层 ---');
{
  const cmds = await import('../gateway/src/commands.ts');
  const stickerDef = cmds.COMMANDS.find((c: any) => c.name === 'sticker')!;
  check('用法文案含 audit', stickerDef.usage.includes('audit'), stickerDef.usage);
  // 异步 handler：返回 Promise 也要能被 await 出结果
  const fakeCtx: any = {
    config, repoRoot: '.', configPath: 'x', stateDir: '.', logDir: '.', startedAt: 0,
    send: async () => true, clearHistory: () => ({}), setAutoReplyMode: () => {}, report: () => ({}),
    sticker: async (args: string[]) => `HANDLED:${args.join(',')}`,
  };
  const fakeMsg: any = { id: '1', peerKey: 'private:1', kind: 'private', userId: config.admin.owners[0] ?? '1',
    nickname: 'n', text: '', atSelf: false, atAll: false, isSelf: false, isAdmin: true, raw: {} };
  const out = await cmds.handleCommand('/s audit', fakeCtx, fakeMsg);
  check('异步 sticker handler 结果能正确返回', JSON.stringify(out) === JSON.stringify(['HANDLED:audit']), JSON.stringify(out));
  const outDel = await cmds.handleCommand('/s audit del 2', fakeCtx, fakeMsg);
  check('audit del 参数透传', JSON.stringify(outDel) === JSON.stringify(['HANDLED:audit,del,2']), JSON.stringify(outDel));
}

// 6) [2026-11-13 回归] 同一分类下不同 URL 的图不能撞名互相覆盖
console.log('--- 文件名唯一性 ---');
{
  const { saveSticker } = await import('../gateway/src/sticker.ts');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'save-'));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  // QQ 图床真实特征：不同图片的 URL 前 16 字节完全相同（都是 https://multimed...）
  const u1 = 'https://multimedia.nt.qq.com.cn/download?fileid=AAAA';
  const u2 = 'https://multimedia.nt.qq.com.cn/download?fileid=BBBB';
  const f1 = saveSticker(d, u1, png, '嘲讽');
  const f2 = saveSticker(d, u2, png, '嘲讽');
  check('同分类不同图产生不同文件名', f1 !== f2, `${path.basename(f1)} vs ${path.basename(f2)}`);
  check('两张图都落盘', fs.existsSync(f1) && fs.existsSync(f2));
  const same = saveSticker(d, u1, png, '嘲讽');
  check('同一 URL 重复保存幂等', same === f1);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
