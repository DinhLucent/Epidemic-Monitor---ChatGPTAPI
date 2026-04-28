import { jsonResponse, errorResponse } from '../../../_shared/cors';
import { getCached, setCached } from '../../../_shared/cache';
import { OUTBREAK_FALSE_POSITIVE_SQL } from '../../../_shared/outbreak-false-positive-sql';

const CACHE_KEY = 'source-health';
const CACHE_TTL = 15 * 60 * 1000;

interface SourceHealthRow {
  source: string;
  source_type: string;
  item_count: number;
  outbreak_count: number;
  latest_published_at: number | null;
  latest_ingested_at: number | null;
}

interface SourceHealthItem {
  source: string;
  sourceType: string;
  itemCount: number;
  outbreakCount: number;
  latestPublishedAt?: number;
  latestIngestedAt?: number;
  freshnessHours?: number;
}

function asTimestamp(value: number | string | null | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function freshnessHours(ts: number | undefined): number | undefined {
  if (!ts) return undefined;
  return Math.round(Math.max(0, Date.now() - ts) / 36_000) / 100;
}

async function fetchSourceHealth(db: D1Database): Promise<SourceHealthItem[]> {
  const result = await db.prepare(`
    SELECT
      CASE WHEN instr(source, ':') > 0 THEN substr(source, instr(source, ':') + 1) ELSE source END AS source,
      source_type,
      COUNT(DISTINCT LOWER(CASE WHEN instr(url, '?') > 0 THEN substr(url, 1, instr(url, '?') - 1) ELSE url END)) AS item_count,
      COUNT(DISTINCT CASE
        WHEN disease IS NOT NULL AND TRIM(disease) != ''
        THEN LOWER(CASE WHEN instr(url, '?') > 0 THEN substr(url, 1, instr(url, '?') - 1) ELSE url END)
        ELSE NULL
      END) AS outbreak_count,
      MAX(published_at) AS latest_published_at,
      MAX(ingested_at) AS latest_ingested_at
    FROM outbreak_items
    WHERE COALESCE(ingested_at, published_at) > (strftime('%s','now') - 14 * 86400) * 1000
      AND (LOWER(COALESCE(country, '')) IN ('vietnam', 'viet nam', 'viá»‡t nam', 'vn') OR province IS NOT NULL)
      ${OUTBREAK_FALSE_POSITIVE_SQL}
    GROUP BY source, source_type
    ORDER BY item_count DESC
    LIMIT 80
  `).all<SourceHealthRow>();

  return (result.results ?? []).map((row) => {
    const latestPublishedAt = asTimestamp(row.latest_published_at);
    const latestIngestedAt = asTimestamp(row.latest_ingested_at);
    return {
      source: String(row.source ?? 'unknown'),
      sourceType: String(row.source_type ?? 'unknown'),
      itemCount: Number(row.item_count ?? 0),
      outbreakCount: Number(row.outbreak_count ?? 0),
      latestPublishedAt,
      latestIngestedAt,
      freshnessHours: freshnessHours(latestIngestedAt ?? latestPublishedAt),
    };
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const cached = getCached<unknown>(CACHE_KEY);
  if (cached) return jsonResponse(cached, 200, 900);

  try {
    const sources = await fetchSourceHealth(context.env.DB);
    const payload = {
      sources,
      fetchedAt: Date.now(),
      windowDays: 14,
      totalSources: sources.length,
    };
    setCached(CACHE_KEY, payload, CACHE_TTL);
    return jsonResponse(payload, 200, 900);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to fetch source health');
  }
};
