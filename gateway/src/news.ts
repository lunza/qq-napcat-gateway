// [2026-11-13] 新闻抓取
//
// 从多个 RSS 源抓最近新闻，优先选带图的，返回：标题 / 摘要 / 图片 / 链接 / 来源 / 时间。
//
// 源选择依据（实测可达）：
//   IT之家 www.ithome.com/rss/           60 条，中文科技
//   36氪 www.36kr.com/feed              30 条，含图
//   爱范儿 www.ifanr.com/feed           20 条，含图多
//   少数派 sspai.com/feed               10 条，无图
//   Solidot www.solidot.org/index.rss   20 条，无图
//   小众软件 www.appinn.com/feed/        软件资讯
//
// 不依赖第三方 RSS 代理；只用 Node 内置 fetch。

export interface NewsItem {
  title: string;
  link: string;
  summary: string;
  /** 图片地址（可能为空） */
  imageUrl: string;
  /** 来源名 */
  source: string;
  /** 发布时间（ISO） */
  publishedAt: string;
  /** 距现在多少小时 */
  ageHours: number;
}

export interface NewsSource {
  name: string;
  url: string;
  /** 优先级（越大越优先） */
  weight: number;
}

/** 可用的新闻源（按图片可得性排优先级） */
export const NEWS_SOURCES: NewsSource[] = [
  { name: '爱范儿', url: 'https://www.ifanr.com/feed', weight: 5 },
  { name: '36氪', url: 'https://www.36kr.com/feed', weight: 4 },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', weight: 3 },
  { name: '小众软件', url: 'https://www.appinn.com/feed/', weight: 2 },
  { name: '少数派', url: 'https://sspai.com/feed', weight: 1 },
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss', weight: 1 },
];

/** 去掉 HTML 标签，解实体，压缩空白 */
export function stripHtml(html: string): string {
  // [2026-11-13] 关键顺序：**先解转义，再剥标签**。
  // 之前顺序反了，导致 &lt;p data-vmark="x"&gt; 解出来的标签残留成文本。
  let t = String(html ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  // 解两轮，处理二次转义
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return t
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从原始条目里提取第一个 <img> 的 src */
export function extractFirstImage(raw: string): string {
  const decoded = String(raw ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const m = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];
  const enc = raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i)
    ?? raw.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  return enc?.[1] ?? '';
}

/** 解析 RSS（兼容 CDATA 与普通标签） */
export function parseRss(xml: string, sourceName: string, now = Date.now()): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const pick = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m?.[1]) return '';
      return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
    };
    const title = stripHtml(pick('title'));
    const link = pick('link') || (block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? '').trim();
    if (!title || !link) continue;
    const descRaw = pick('description') || pick('content:encoded');
    const summary = stripHtml(descRaw).slice(0, 220);
    const imageUrl = extractFirstImage(descRaw) || pick('content:encoded').match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
    const pubRaw = pick('pubDate') || pick('dc:date');
    const t = pubRaw ? Date.parse(pubRaw) : NaN;
    const publishedAt = Number.isFinite(t) ? new Date(t).toISOString() : new Date(now).toISOString();
    const ageHours = Number.isFinite(t) ? Math.max(0, (now - t) / 3600000) : 0;
    items.push({ title, link, summary, imageUrl, source: sourceName, publishedAt, ageHours });
  }
  return items;
}

/** 拉一个源 */
async function fetchSource(src: NewsSource, timeoutMs: number): Promise<NewsItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, src.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchNewsOptions {
  /** 只取最近多少小时内的（默认 48 小时） */
  maxAgeHours?: number;
  /** 是否必须带图 */
  requireImage?: boolean;
  /** 每个源最多取几条 */
  perSource?: number;
}

/**
 * 并发拉取所有源，合并后按"新鲜度 + 是否带图 + 源权重"排序。
 */
export async function fetchLatestNews(opts: FetchNewsOptions = {}): Promise<NewsItem[]> {
  const maxAgeHours = opts.maxAgeHours ?? 48;
  const requireImage = opts.requireImage ?? false;
  const perSource = opts.perSource ?? 10;

  const results = await Promise.all(
    NEWS_SOURCES.map(async (src) => {
      const items = await fetchSource(src, 10000);
      return items
        .slice(0, perSource)
        .map((it) => ({ it, weight: src.weight }));
    }),
  );

  const merged: Array<{ item: NewsItem; score: number }> = [];
  for (const group of results) {
    for (const { it, weight } of group) {
      if (requireImage && !it.imageUrl) continue;
      if (it.ageHours > maxAgeHours) continue;
      // 评分：越新越高；带图加分；源权重加分
      const freshness = Math.max(0, 72 - it.ageHours) / 72;   // 0~1
      const imgBonus = it.imageUrl ? 0.6 : 0;
      const wBonus = weight * 0.08;
      merged.push({ item: it, score: freshness + imgBonus + wBonus });
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.map((m) => m.item);
}
