// [2026-11-13] 随机日期选择测试（months/week/year 窗口内真随机）
import { buildPopularUrl, randomDateForScale, formatTime } from '../gateway/src/e621.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const DAY = 24 * 60 * 60 * 1000;

// 格式正确
const d1 = randomDateForScale('day');
check('时间格式正确', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(d1), d1);

// 落在合理区间
for (const [scale, days] of [['day', 1], ['week', 7], ['month', 30], ['year', 365]] as const) {
  const dates = Array.from({ length: 20 }, () => randomDateForScale(scale)).map(s => new Date(s.replace(' ', 'T').replace(' ', '')).getTime());
  const now = Date.now();
  const allInRange = dates.every(t => t <= now + 60000 && t >= now - (days + 1) * DAY);
  check(`${scale} 窗口落在 ${days} 天内`, allInRange);
  const uniqueRatio = new Set(dates).size / dates.length;
  check(`${scale} 有随机性（20 次至少 15 个不同）`, uniqueRatio >= 0.75, `${new Set(dates).size}/20`);
}

// URL 构造
const u = buildPopularUrl({ scale: 'month' });
check('URL 含 scale=month', u.includes('scale=month'), u.slice(0, 90));
check('URL 含 date 参数', u.includes('date='));
const u2 = buildPopularUrl({ scale: 'month', date: '2026-11-01 10:00:00 +0800' });
check('指定 date 时不随机', u2.includes(encodeURIComponent('2026-11-01 10:00:00 +0800').replace(/%20/g,'%20')) || u2.includes('2026-11-01'), u2.slice(0, 100));

// 两次构造的 URL 应不同（除非恰好同时）
const a = buildPopularUrl({ scale: 'month' });
const b = buildPopularUrl({ scale: 'month' });
check('两次构造 URL 不同', a !== b, '');

// formatTime
const t = formatTime(new Date('2026-11-13T10:00:00+08:00'));
check('formatTime 输出格式', /^2026-11-13 \d{2}:00:00 \+0800$/.test(t) || /^2026-11-13 \d{2}:00:00/.test(t), t);

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
