import { jsonResponse, errorResponse } from '../../../_shared/cors';
import { getCached, setCached } from '../../../_shared/cache';
import { canonicalProvinceName } from '../../../_shared/vietnam-provinces';

const CACHE_TTL = 15 * 60 * 1000;

interface TimeSeriesRow {
  day: string;
  disease: string;
  province: string;
  peak_alert: string;
  article_count: number;
  peak_cases: number | null;
  source_count: number;
}

function clampDays(value: string | null): number {
  const parsed = Number(value ?? '90');
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(7, Math.min(365, Math.round(parsed)));
}

function cacheKey(url: URL): string {
  return `timeseries:${url.searchParams.toString()}`;
}

async function fetchTimeSeries(db: D1Database, url: URL) {
  const days = clampDays(url.searchParams.get('days'));
  const province = url.searchParams.get('province')?.trim() ?? '';
  const disease = url.searchParams.get('disease')?.trim() ?? '';

  const provinceFilter = province.toLowerCase();
  const diseaseFilter = disease.toLowerCase();

  const result = await db.prepare(`
    SELECT
      strftime('%Y-%m-%d', published_at/1000 + 25200, 'unixepoch') AS day,
      disease,
      province,
      CASE MAX(CASE alert_level WHEN 'alert' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
        WHEN 3 THEN 'alert' WHEN 2 THEN 'warning' ELSE 'watch'
      END AS peak_alert,
      COUNT(DISTINCT LOWER(CASE WHEN instr(url, '?') > 0 THEN substr(url, 1, instr(url, '?') - 1) ELSE url END)) AS article_count,
      MAX(cases) AS peak_cases,
      COUNT(DISTINCT source) AS source_count
    FROM outbreak_items
    WHERE source_type = 'web'
      AND published_at > (strftime('%s','now') - ? * 86400) * 1000
      AND disease IS NOT NULL AND TRIM(disease) != ''
      AND province IS NOT NULL AND TRIM(province) != ''
      AND (LOWER(COALESCE(country, '')) IN ('vietnam', 'viet nam', 'viá»‡t nam', 'vn') OR province IS NOT NULL)
      AND (? = '' OR LOWER(province) = ?)
      AND (? = '' OR LOWER(disease) = ?)
    GROUP BY day, disease, province
    ORDER BY day ASC, article_count DESC
    LIMIT 3000
  `).bind(days, provinceFilter, provinceFilter, diseaseFilter, diseaseFilter).all<TimeSeriesRow>();

  const points = (result.results ?? []).map((row) => ({
    day: String(row.day),
    disease: String(row.disease),
    province: String(row.province),
    adminProvince: canonicalProvinceName(String(row.province)),
    alertLevel: row.peak_alert === 'alert' || row.peak_alert === 'warning' ? row.peak_alert : 'watch',
    articleCount: Number(row.article_count ?? 0),
    cases: row.peak_cases == null ? undefined : Number(row.peak_cases),
    sourceCount: Number(row.source_count ?? 0),
  }));

  return {
    points,
    fetchedAt: Date.now(),
    days,
    filters: {
      province: province || undefined,
      disease: disease || undefined,
    },
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const key = cacheKey(url);
  const cached = getCached<unknown>(key);
  if (cached) return jsonResponse(cached, 200, 900);

  try {
    const payload = await fetchTimeSeries(context.env.DB, url);
    setCached(key, payload, CACHE_TTL);
    return jsonResponse(payload, 200, 900);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to fetch time series');
  }
};
