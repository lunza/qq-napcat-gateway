// [2026-11-13] 新闻抓取测试
import { stripHtml, extractFirstImage, parseRss, NEWS_SOURCES, fetchLatestNews } from '../gateway/src/news.ts';
import { matchSkill, resetSkillCooldown } from '../gateway/src/skills.ts';
import type { QqConfig } from '../gateway/src/config.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

// HTML 处理
check('去标签', stripHtml('<p>你好<b>世界</b></p>') === '你好世界');
// 解实体后再剥标签：&lt;c&gt; 会被当成标签去掉，这是期望行为（摘要来自 HTML）
check('解实体后再剥标签', stripHtml('a &amp; b &lt;c&gt;') === 'a & b', stripHtml('a &amp; b &lt;c&gt;'));
check('纯文本实体保留', stripHtml('a &amp; b') === 'a & b');
check('去 script', !stripHtml('<script>alert(1)</script>正文').includes('alert'));
check('压缩空白', stripHtml('a   \n  b') === 'a b');

// 图片提取
check('提取 img', extractFirstImage('<p><img src="https://x/1.jpg"></p>') === 'https://x/1.jpg');
check('提取转义 img', extractFirstImage('&lt;img src=&quot;https://x/2.png&quot;&gt;') === 'https://x/2.png');
check('无图返回空', extractFirstImage('<p>纯文字</p>') === '');
check('enclosure 提取', extractFirstImage('<enclosure url="https://x/3.jpg" type="image/jpeg"/>') === 'https://x/3.jpg');

// RSS 解析
const sampleRss = `<?xml version="1.0"?><rss><channel>
<item>
  <title><![CDATA[测试新闻标题]]></title>
  <link>https://example.com/1</link>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <description><![CDATA[<p>这是摘要</p><img src="https://x/a.jpg">]]></description>
</item>
<item>
  <title>无图新闻</title>
  <link>https://example.com/2</link>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <description>纯文字</description>
</item>
</channel></rss>`;
const items = parseRss(sampleRss, '测试源');
check('解析出 2 条', items.length === 2);
check('标题正确', items[0]!.title === '测试新闻标题', items[0]!.title);
check('链接正确', items[0]!.link === 'https://example.com/1');
check('摘要去标签', !items[0]!.summary.includes('<p>'), items[0]!.summary);
check('第一条有图', items[0]!.imageUrl === 'https://x/a.jpg');
check('第二条无图', items[1]!.imageUrl === '');
check('来源标记', items[0]!.source === '测试源');
check('时间已解析', items[0]!.ageHours < 0.1);

// 源配置
check('新闻源数量 >= 5', NEWS_SOURCES.length >= 5, String(NEWS_SOURCES.length));
check('含爱范儿', NEWS_SOURCES.some(s => s.name === '爱范儿'));
check('含 IT之家', NEWS_SOURCES.some(s => s.name === 'IT之家'));
check('源都有权重', NEWS_SOURCES.every(s => typeof s.weight === 'number'));

// 技能匹配
const base = { skills: { enabled: true, items: [
  { id: 'news', name: '新鲜事', triggers: ['新鲜事', '新闻'], prompt: '', enabled: true, cooldownSec: 0, type: 'news' },
] } } as unknown as QqConfig;
resetSkillCooldown();
check('#新鲜事 命中', matchSkill('#新鲜事', base, 'p1')?.skill.id === 'news');
resetSkillCooldown();
check('#新闻 命中', matchSkill('#新闻', base, 'p2')?.skill.id === 'news');
resetSkillCooldown();
check('普通聊天不触发', matchSkill('今天有新闻吗', base, 'p3') === null);

// 真实网络（可能跳过）
console.log('  （下面测试真实网络）');
try {
  const real = await fetchLatestNews({ requireImage: true, maxAgeHours: 72 });
  check('真实抓取有结果', real.length > 0, `${real.length} 条`);
  check('全部带图', real.every(n => n.imageUrl), '');
  check('按评分排序（首条带图）', Boolean(real[0]?.imageUrl));
  check('有来源信息', real.every(n => n.source));
} catch (e) {
  console.log(`  SKIP 真实网络：${(e as Error).message.slice(0, 50)}`);
}

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
