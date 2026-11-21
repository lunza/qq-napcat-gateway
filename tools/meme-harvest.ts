// [2026-11-16] 梗指南频道采集管道（正式存档，取代 2026-11-13 的临时脚本）
//
// 流程：抓频道视频列表（翻页）→ diff 已入库 _bvid → 逐个发豆包解析 → 噪音过滤 → upsert memes.json
//
// 用法：
//   node --experimental-strip-types tools/meme-harvest.ts list [--max-pn 15]
//   node --experimental-strip-types tools/meme-harvest.ts pending
//   node --experimental-strip-types tools/meme-harvest.ts ask [BV...] [--limit N]
//
// 依赖：无头 Chrome + 豆包登录态 profile（<workspace>/.dsh/doubao-profile，过期需重新扫码）。
// 2026-11-13 踩坑记录：豆包回答最短等 80s 再判稳；回答混界面文字要按行过滤；
//   CDP 注入 JS 里的正则 \/ 会被转义吃掉，一律用 indexOf/includes 判断。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname ?? '.', '..');
const MEMES_FILE = path.join(REPO, 'state', 'memes.json');
const HARVEST_DIR = path.join(REPO, 'state', 'meme-harvest');
const DOUBAO_PROFILE = path.resolve(REPO, '..', '.dsh', 'doubao-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHANNEL_ID = '94510621'; // B站「梗指南」

// ── CDP 精简客户端（复刻 e621.ts 验证过的实现） ──

async function connect(wsUrl: string): Promise<any> {
  const WS: any = (globalThis as any).WebSocket;
  const ws = new WS(wsUrl);
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (raw: any) => {
    const data = raw?.data ?? raw;
    try { const m = JSON.parse(String(data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch { /* */ }
  });
  await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', (e: any) => rej(new Error(String(e)))); });
  return {
    send: (method: string, params: any = {}, sessionId?: string) =>
      new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }),
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

async function evaluate(cdp: any, sessionId: string, expression: string): Promise<any> {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r?.result?.result?.value;
}

// ── Chrome 生命周期 ──

function cleanStaleLock(profile: string): void {
  const lock = path.join(profile, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lock);
    const pid = Number(target.split('-').pop());
    if (pid) { try { process.kill(pid, 0); return; } catch { /* 已死 */ } }
    fs.rmSync(lock, { force: true });
    console.log(`[chrome] 清理残留锁（持有者 pid=${pid || '?'} 已死）`);
  } catch { /* 无锁 */ }
}

class Browser {
  private child: any = null;
  private profile = '';
  /** [2026-11-16] attach 模式（附着到用户登录用的实例）：kill() 必须是空操作。
   *  血泪教训：SIGKILL 同 profile 的有头实例会丢 session cookie → from_logout 循环。 */
  attached = false;

  async launch(profile: string): Promise<any> {
    cleanStaleLock(profile);
    // 锁被存活进程持有（如用户登录用的有头实例）→ 明确报错，让调用方走 attach，
    // 绝不再 launch 一个同 profile 实例（SingletonLock 冲突 + kill 时误杀）。
    try {
      const target = fs.readlinkSync(path.join(profile, 'SingletonLock'));
      const pid = Number(target.split('-').pop());
      if (pid) { try { process.kill(pid, 0); throw new Error(`profile 被占用（pid=${pid}，可能是登录用实例）。请设 DOUBAO_ATTACH_PORT 附着到它，或先关闭该实例`); } catch (e) { if ((e as Error).message.includes('profile 被占用')) throw e; /* 已死 */ } }
    } catch (e) {
      if ((e as Error).message.includes('profile 被占用')) throw e;
      /* 无锁或链接读取失败：继续 */
    }
    this.profile = profile;
    if (!profile.startsWith(os.tmpdir())) fs.mkdirSync(profile, { recursive: true });
    const port = 43000 + Math.floor(Math.random() * 5000);
    this.child = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
    ], { stdio: 'ignore' });
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); wsUrl = ((await r.json()) as any).webSocketDebuggerUrl ?? ''; } catch { /* */ }
      if (!wsUrl) await new Promise((r) => setTimeout(r, 250));
    }
    if (!wsUrl) { this.kill(); throw new Error('Chrome CDP 未就绪'); }
    return connect(wsUrl);
  }

  kill(): void {
    if (this.attached) { console.log('[chrome] attach 模式：不杀用户实例'); return; }
    try { this.child?.kill('SIGKILL'); } catch { /* */ }
    // 只清自己 profile 的进程；profile 为空（attach 模式）时绝不能执行 pkill
    if (this.profile) {
      try { execSync(`pkill -9 -f "user-data-dir=${this.profile}"`, { stdio: 'ignore' }); } catch { /* */ }
    }
    if (this.profile && this.profile.startsWith(os.tmpdir())) {
      try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

async function openPage(cdp: any, url: string): Promise<string> {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  return sessionId;
}

// ── 频道列表抓取（翻页） ──

export interface ChannelVideo { bvid: string; title: string; }

export async function fetchChannelVideos(cdp: any, maxPn = 15): Promise<ChannelVideo[]> {
  const all = new Map<string, string>();
  for (let pn = 1; pn <= maxPn; pn++) {
    const sessionId = await openPage(cdp, `https://space.bilibili.com/${CHANNEL_ID}/videos?pn=${pn}`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const n = await evaluate(cdp, sessionId, `document.querySelectorAll('a[href*="/video/BV"]').length`);
      if (Number(n) >= 5) break;
    }
    const items: ChannelVideo[] = await evaluate(cdp, sessionId, `(() => {
      const out = new Map();
      for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/BV[0-9A-Za-z]+/);
        if (!m) continue;
        const card = a.closest('.bili-video-card') || a.closest('.small-item') || a;
        const title = (card.querySelector('.bili-video-card__title, .title') || a).textContent || '';
        if (!title.trim()) continue;
        if (!out.has(m[0])) out.set(m[0], title.trim());
      }
      return [...out.entries()].map(([bvid, title]) => ({ bvid, title }));
    })()`) ?? [];
    let fresh = 0;
    for (const it of items) if (!all.has(it.bvid)) { all.set(it.bvid, it.title); fresh++; }
    console.log(`[list] pn=${pn}: 本页 ${items.length} 条，新增 ${fresh} 条，累计 ${all.size}`);
    if (items.length === 0 || fresh === 0) break;
  }
  return [...all.entries()].map(([bvid, title]) => ({ bvid, title }));
}

// ── 已入库 diff ──

export function loadMemes(): Record<string, any> {
  return JSON.parse(fs.readFileSync(MEMES_FILE, 'utf8'));
}

export function saveMemes(memes: Record<string, any>): void {
  const tmp = `${MEMES_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(memes, null, 2), 'utf8');
  fs.renameSync(tmp, MEMES_FILE);
}

export function knownBvids(memes: Record<string, any>): Set<string> {
  return new Set(Object.values(memes).map((m: any) => m._bvid).filter(Boolean));
}

// ── 豆包问答 ──

const NOISE_PREFIXES = ['我先查看', '云电脑', '免费', '付费', '下载电脑客户端', '立即下载', '自动完成复杂工作任务', '下载电脑版', '关于豆包', '登录', '有什么我能帮你的吗', '新工作任务', '新对话', '云盘', '项目', '技能', '工作台', '最近', '对话', '工作', '更多', '用户'];

/**
 * [2026-11-16] 从"页面新增行"里截取回答正文。
 * 2026-11-13 验证过的策略：不依赖回答容器 DOM（新版豆包页面不暴露 testid），
 * 按「XX是什么梗」标题行截取（跳过含 https:// 的问题回现行），截到界面噪音行为止。
 */
function extractAnswerLines(newLines: string[]): string {
  // 跳过问题回显与空行
  const body = newLines.map((l) => l.trim()).filter((l) => l && !l.includes('https://') && !l.includes('请分别说明'));
  // 起点：回答标题行（短行且含"是什么梗"），兜底"指什么"行
  let start = body.findIndex((l) => l.length < 60 && l.includes('是什么梗'));
  if (start < 0) start = body.findIndex((l) => l.startsWith('指什么'));
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start; i < body.length; i++) {
    const l = body[i]!;
    if (NOISE_PREFIXES.some((p) => l.startsWith(p))) break;
    if (/^(今天|昨天|前天)?\s*\d{1,2}[-/:]\d{1,2}\s*\d{1,2}:\d{2}$/.test(l)) continue;
    out.push(l);
  }
  // 掐尾部平台词串（微博/哔哩哔哩等采集来源残留）
  const tailWords = ['哔哩哔哩', '微博', '抖音', 'B站', 'b站', '小红书', '知乎'];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const stripped = tailWords.reduce((acc, w) => acc.endsWith(w) ? acc.slice(0, -w.length).trim() : acc, last);
    if (stripped === last) break;
    if (stripped) out[out.length - 1] = stripped; else out.pop();
  }
  return out.join('\n').trim();
}

function extractName(answer: string, videoTitle: string): string {
  const m = answer.match(/[「《]([^」》]{1,20})[」》][^\n]{0,6}是什么梗/);
  if (m?.[1]) return m[1];
  // 标题行本身（"「笑拥了」是什么梗"）→ 直接取引号内；无引号则用视频标题拆段
  const m2 = answer.match(/^([^「》\n]{1,20}?)是什么梗/m);
  if (m2?.[1] && !m2[1].includes('http') && m2[1].trim().length >= 2) return m2[1].trim().replace(/^[「《]/, '');
  const base = videoTitle.replace(/是什么梗【梗指南】?$/, '').replace(/是什么梗$/, '');
  const parts = base.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? base;
}

export interface AskResult { bvid: string; videoTitle: string; ok: boolean; name?: string; answer?: string; error?: string; }

export async function askDoubao(cdp: any, bvid: string, videoTitle: string): Promise<AskResult> {
  const sessionId = await openPage(cdp, 'https://www.doubao.com/chat/');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ready = Boolean(await evaluate(cdp, sessionId, `Boolean(document.querySelector('[data-testid="chat_input_input"]'))`));
    if (ready) break;
  }
  if (!ready) return { bvid, videoTitle, ok: false, error: '输入框未就绪' };

  // 发送前记录页面已有行（新对话页几乎全为界面文字）——回答 = diff 新增行
  const beforeLines = new Set(String(await evaluate(cdp, sessionId, `document.body.innerText`) ?? '')
    .split('\n').map((l) => l.trim()));

  const question = `https://www.bilibili.com/video/${bvid} 这是什么梗？请分别说明：指什么、出处、适用场合。`;
  // [2026-11-16] 输入与发送改用 CDP 真实输入层事件：页面内 execCommand + 合成
  // KeyboardEvent 时好时坏（合成事件不是可信事件）。且 JS focus() 不可靠——
  // 先用 CDP 真实鼠标点击输入框拿到焦点，再 insertText + Enter。
  const box = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="chat_input_input"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 40)), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!box) return { bvid, videoTitle, ok: false, error: '找不到输入框' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  await cdp.send('Input.insertText', { text: question }, sessionId);
  await new Promise((r) => setTimeout(r, 800));
  // 校验文本已进输入框（insertText 偶发丢失时能看到）
  const inBox = String(await evaluate(cdp, sessionId, `document.querySelector('[data-testid="chat_input_input"]')?.textContent ?? ''`) ?? '');
  if (!inBox.includes('请分别说明')) {
    // 兜底：再 insert 一次
    await cdp.send('Input.insertText', { text: question }, sessionId);
    await new Promise((r) => setTimeout(r, 800));
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);

  // [2026-11-16] 发送确认：问题文本出现在 body = 已发出。
  // 注意发送后路由 /chat/ → /chat/<id> 重挂载，气泡渲染延迟可达 10s（实测 4s 时 diff 仍为 0），
  // 确认窗口放宽到 18s，失败才用 CDP 再发一次并重等。
  let sent = false;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await evaluate(cdp, sessionId, `document.body.innerText.includes('请分别说明')`)) { sent = true; break; }
  }
  if (!sent) {
    // 重试：重新 focus 后用 CDP 再发一次 Enter，再等 12s
    await evaluate(cdp, sessionId, `document.querySelector('[data-testid="chat_input_input"]')?.focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await evaluate(cdp, sessionId, `document.body.innerText.includes('请分别说明')`)) { sent = true; break; }
    }
    if (!sent) {
      // 失败诊断：输入框残留内容 / 当前 URL / body 尾部
      const diag = await evaluate(cdp, sessionId, `(() => ({
        input: (document.querySelector('[data-testid="chat_input_input"]')?.textContent ?? '').slice(0, 80),
        url: location.href,
        tail: document.body.innerText.slice(-300),
      }))()`);
      try { fs.writeFileSync(path.join(HARVEST_DIR, 'send-fail-diag.json'), JSON.stringify(diag, null, 1)); } catch { /* */ }
      return { bvid, videoTitle, ok: false, error: `消息未发出（CDP 点击+Enter 两次，诊断见 send-fail-diag.json）` };
    }
  }

  // 判稳：最短 80s（豆包解析视频+搜索），之后每 5s 取"新增行拼合文本"，连续 4 次无变化 → 完成
  await new Promise((r) => setTimeout(r, 80000));
  let lastDiff = '';
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = String(await evaluate(cdp, sessionId, `document.body.innerText`) ?? '');
    const newLines = cur.split('\n').map((l) => l.trim()).filter((l) => l && !beforeLines.has(l));
    const diff = newLines.join('\n');
    // 消息发出后 body 必然出现新增行（至少有用户消息回显）；120s 仍空 = 发送失败/页面异常，早退
    if (diff === '' && i >= 8) return { bvid, videoTitle, ok: false, error: '页面无新增内容（发送疑似失败）' };
    if (diff === lastDiff && diff.length > 100) { stable++; if (stable >= 4) break; }
    else { stable = 0; lastDiff = diff; }
  }
  const answer = extractAnswerLines(lastDiff.split('\n'));
  if (answer.length < 80) {
    // 失败时落盘 diff 原文，供调试选择器/结构
    try { fs.writeFileSync(path.join(HARVEST_DIR, 'last-diff.txt'), lastDiff || '(空)'); } catch { /* */ }
    return { bvid, videoTitle, ok: false, error: `回答过短(${answer.length}字符)——未截取到回答结构` };
  }
  return { bvid, videoTitle, ok: true, name: extractName(answer, videoTitle), answer };
}

// ── 入库 ──

export function upsertMeme(memes: Record<string, any>, r: { name: string; bvid: string; videoTitle: string; answer: string }): string {
  if (memes[r.name]) return `跳过（同名已存在）: ${r.name}`;
  const meaning = r.answer.split('\n').filter((l) => !/^(出处|使用场合|适用场合|来源)/.test(l)).join('\n').slice(0, 1200);
  const source = r.answer.match(/出处[：:]\s*([^\n]+)/)?.[1]?.trim() ?? '';
  const base = r.videoTitle.replace(/是什么梗【梗指南】?$/, '').replace(/是什么梗$/, '');
  const keywords = [...new Set([r.name, ...base.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)])].filter((k) => k && k !== '是什么梗');
  memes[r.name] = {
    keywords, name: r.name, meaning,
    source: source || `B站「梗指南」频道`,
    category: '热梗', _bvid: r.bvid, _fullAnswer: r.answer,
  };
  return `入库: ${r.name}（keywords: ${keywords.join('/')}）`;
}

// ── 主流程 ──

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  fs.mkdirSync(HARVEST_DIR, { recursive: true });

  const browser = new Browser();
  let exitCode = 0;
  try {
    // [2026-11-16] 支持附着到已运行的有头 Chrome（登录用）：DOUBAO_ATTACH_PORT=45678
    // 采集时绝不杀用户登录用的浏览器进程（SIGKILL 会丢 session，导致 from_logout 循环）。
    const attachPort = Number(process.env.DOUBAO_ATTACH_PORT ?? 0);
    let cdp: any;
    if (attachPort > 0) {
      const r = await fetch(`http://127.0.0.1:${attachPort}/json/version`);
      const j = await r.json() as any;
      cdp = await connect(j.webSocketDebuggerUrl);
      browser.attached = true;   // attach 模式：finally 不杀用户实例
      console.log(`[chrome] 附着到已运行实例（端口 ${attachPort}）`);
    } else {
      cdp = await browser.launch(DOUBAO_PROFILE);
    }
    if (cmd === 'list') {
      const maxPn = Number(argv[argv.indexOf('--max-pn') + 1] ?? 15) || 15;
      const videos = await fetchChannelVideos(cdp, maxPn);
      const file = path.join(HARVEST_DIR, 'channel-videos.json');
      fs.writeFileSync(file, JSON.stringify(videos, null, 1));
      console.log(`已写入 ${file}（共 ${videos.length} 条，「是什么梗」${videos.filter((v) => /是什么梗/.test(v.title)).length} 条）`);
    } else if (cmd === 'pending') {
      const videos: ChannelVideo[] = JSON.parse(fs.readFileSync(path.join(HARVEST_DIR, 'channel-videos.json'), 'utf8'));
      const known = knownBvids(loadMemes());
      const pending = videos.filter((v) => !known.has(v.bvid) && /是什么梗/.test(v.title));
      console.log(`频道 ${videos.length} 条，未入库「是什么梗」视频 ${pending.length} 条：`);
      for (const v of pending) console.log(`  ${v.bvid}  ${v.title}`);
    } else if (cmd === 'ask') {
      const idx = argv.indexOf('--limit');
      const limit = idx >= 0 ? Number(argv[idx + 1]) || 0 : 0;
      let bvids = argv.slice(1).filter((a) => /^BV/.test(a));
      const videos: ChannelVideo[] = fs.existsSync(path.join(HARVEST_DIR, 'channel-videos.json'))
        ? JSON.parse(fs.readFileSync(path.join(HARVEST_DIR, 'channel-videos.json'), 'utf8')) : [];
      const titleOf = (b: string) => videos.find((v) => v.bvid === b)?.title ?? '(无标题)';
      if (bvids.length === 0) {
        const known = knownBvids(loadMemes());
        bvids = videos.filter((v) => !known.has(v.bvid) && /是什么梗/.test(v.title)).map((v) => v.bvid);
        console.log(`[ask] 未指定 bvid，自动取未入库清单 ${bvids.length} 条`);
      }
      if (limit > 0) bvids = bvids.slice(0, limit);
      cdp = cdp ?? await browser.launch(DOUBAO_PROFILE);
      const memes = loadMemes();
      const results: AskResult[] = [];
      for (let i = 0; i < bvids.length; i++) {
        const bvid = bvids[i]!;
        console.log(`[ask ${i + 1}/${bvids.length}] ${bvid} ${titleOf(bvid)}`);
        let r: AskResult;
        try { r = await askDoubao(cdp, bvid, titleOf(bvid)); }
        catch (e) { r = { bvid, videoTitle: titleOf(bvid), ok: false, error: (e as Error).message }; }
        if (r.ok && r.name && r.answer) {
          const log = upsertMeme(memes, { name: r.name, bvid, videoTitle: r.videoTitle, answer: r.answer });
          saveMemes(memes);
          console.log(`  → ${log}`);
        }
        results.push({ ...r, answer: r.answer ? `${r.answer.length} 字符` : undefined });
        // 进度落盘（§十一：随时可看）
        fs.writeFileSync(path.join(HARVEST_DIR, 'ask-log.json'), JSON.stringify(results, null, 1));
        if (!r.ok) console.log(`  → 失败: ${r.error}`);
      }
      const okN = results.filter((x) => x.ok).length;
      console.log(`\n完成：${okN}/${results.length} 成功入库`);
    } else {
      console.log('用法: list [--max-pn N] | pending | ask [BV...] [--limit N]');
      exitCode = 2;
    }
  } catch (e) {
    console.error('ERROR:', (e as Error).message);
    exitCode = 1;
  } finally {
    browser.kill();
  }
  process.exit(exitCode);
}
void main();
