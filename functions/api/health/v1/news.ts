/**
 * Health news endpoint — Cloudflare Pages Function.
 * Single source: D1 outbreak_items table (populated by Mac Mini pipeline).
 * RSS fallback removed — pipeline already crawls VN news sources directly.
 */
import { jsonResponse, errorResponse } from '../../../_shared/cors';
import { getCached, setCached } from '../../../_shared/cache';

const CACHE_KEY = 'news';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const NEWS_LIMIT = 50;
const NEWS_SCAN_LIMIT = 150;

interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  summary?: string;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

/** Fetch news items from D1 outbreak_items table.
 *  Only whitelisted source types (web news) + VN-only title guard. */
async function fetchNewsFromD1(db: D1Database): Promise<NewsItem[]> {
  const result = await db.prepare(`
    SELECT id, title,
      CASE WHEN instr(source, ':') > 0 THEN substr(source, instr(source, ':') + 1) ELSE source END AS source,
      url, COALESCE(published_at, ingested_at) AS published_at, summary
    FROM outbreak_items
    WHERE url IS NOT NULL AND title IS NOT NULL
      AND source_type = 'web'
      AND (LOWER(COALESCE(country, '')) IN ('vietnam', 'viet nam', 'việt nam', 'vn') OR province IS NOT NULL)
      AND LOWER(title) NOT GLOB '*bangladesh*'
      AND LOWER(title) NOT GLOB '*pakistan*'
      AND LOWER(title) NOT GLOB '*argentina*'
      AND LOWER(title) NOT GLOB '*florida*'
      AND LOWER(title) NOT GLOB '*texas*'
      AND LOWER(title) NOT GLOB '*nigeria*'
      AND LOWER(title) NOT GLOB '*philippines*'
      AND LOWER(title) NOT GLOB '*indonesia*'
      AND LOWER(title) NOT GLOB '*thái lan*'
      AND LOWER(title) NOT GLOB '*singapore*'
      AND LOWER(title) NOT GLOB '*malaysia*'
      AND LOWER(title) NOT GLOB '*cambodia*'
      AND LOWER(title) NOT GLOB '*trung quốc*'
      AND LOWER(title) NOT GLOB '*china*'
      AND LOWER(title) NOT GLOB '*châu phi*'
      AND LOWER(title) NOT GLOB '*africa*'
    ORDER BY COALESCE(published_at, ingested_at) DESC
    LIMIT ?
  `).bind(NEWS_SCAN_LIMIT).all<{ id: string; title: string; source: string; url: string; published_at: string; summary: string | null }>();

  return (result.results ?? []).map(row => ({
    id: String(row.id),
    title: String(row.title),
    source: String(row.source ?? ''),
    url: String(row.url),
    publishedAt: row.published_at ? new Date(row.published_at).getTime() : Date.now(),
    summary: row.summary ?? undefined,
  }));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const cached = getCached<{ items: unknown[]; fetchedAt: number; source: string }>(CACHE_KEY);
  if (cached) return jsonResponse(cached, 200, 900);

  try {
    const items = await fetchNewsFromD1(context.env.DB);

    // Deduplicate by canonical URL. Recrawls can create new IDs for the same article.
    const seen = new Set<string>();
    const deduped = items
      .filter(item => {
        const key = canonicalUrl(item.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, NEWS_LIMIT);

    const payload = { items: deduped, fetchedAt: Date.now(), source: 'pipeline' };
    setCached(CACHE_KEY, payload, CACHE_TTL);
    return jsonResponse(payload, 200, 900);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to fetch news');
  }
};
