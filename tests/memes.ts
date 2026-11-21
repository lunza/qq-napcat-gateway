// [2026-11-12] 梗库测试
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openMemeLibrary, memesPromptSection } from '../gateway/src/memes.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memes-'));
const f = path.join(dir, 'memes.json');
const lib = openMemeLibrary(f);
check('默认梗库非空', lib.all().length >= 5, String(lib.all().length));
check('含杰哥不要', lib.all().some(m => m.name === '杰哥不要'));

// [2026-11-16] matchesKeyword 已改为"单字关键词不参与匹配"（防"猫"/"典"误命中），
// 测试用例同步改用 2 字以上关键词验证命中。
const h1 = lib.match('画面有个阿伟，两个人在笑');
check('关键词命中杰哥不要', h1.some(m => m.name === '杰哥不要'), h1.map(m=>m.name).join(','));
check('单字关键词不匹配（防误命中）', !lib.match('画面有个逊字').some(m => m.name === '杰哥不要'));
const h2 = lib.match('完全无关的画面描述');
check('无关文本不命中', h2.length === 0);
check('空文本不命中', lib.match('').length === 0);

const sec = memesPromptSection(h1);
check('提示段含梗名', sec.includes('杰哥不要'));
check('提示段含出处', sec.includes('台湾'));
check('提示段含分类建议', sec.includes('嘲讽'));
check('空条目返回空串', memesPromptSection([]) === '');

// 新增与删除
lib.upsert({ keywords: ['测试梗'], name: '新梗', meaning: '测试含义', source: '测试出处', category: '欢乐' });
check('新增后能匹配', lib.match('这里有个测试梗').some(m => m.name === '新梗'));
lib.save();
const lib2 = openMemeLibrary(f);
check('持久化生效', lib2.all().some(m => m.name === '新梗'));
check('删除生效', lib2.remove('新梗') === true);
check('删除后不匹配', !lib2.match('测试梗').some(m => m.name === '新梗'));

// 边界
lib2.upsert({ keywords: [], name: '无关键词', meaning: 'x', source: '' });
check('无关键词不误匹配', !lib2.match('随便什么文本').some(m => m.name === '无关键词'));

lib2.save();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
