/**
 * Vite dev middleware — proxies /api/health/v1/* routes by fetching real RSS feeds.
 * Only active in dev mode. In production, Vercel Edge Functions handle these routes.
 */
import type { Plugin } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { diseaseLabel } from './src/components/case-report-panel-data';
import { createSdkOutbreakExtractor, type BatchClassifyItem, type BatchClassifyResult } from './src/services/local-ai/sdk-model-driver';
import {
  type GeoPrecision,
  scoreOutbreakEvidence,
  summarizeSources,
} from './functions/_shared/source-registry';
import { canonicalProvinceName, VIETNAM_PROVINCES_2025 } from './functions/_shared/vietnam-provinces';

// Load .env.local into process.env for dev API middleware
const ENV_LOCAL_PATH = resolve(process.cwd(), '.env.local');

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

try {
  const envLocal = readFileSync(ENV_LOCAL_PATH, 'utf-8');
  for (const line of envLocal.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && !(key.trim() in process.env)) process.env[key.trim()] = parseEnvValue(rest.join('='));
  }
} catch { /* .env.local optional */ }

// In-memory cache for dev mode
const cache = new Map<string, { data: unknown; expiry: number }>();

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiry) { cache.delete(key); return undefined; }
  return entry.data as T;
}
function setCached(key: string, data: unknown, ttlMs: number): void {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

function splitKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((k) => k.trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[\r\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function configuredKeys(): string[] {
  const keys = splitKeys(process.env.CHATGPT2API_AUTH_KEYS);
  if (keys.length > 0) return keys;
  return splitKeys(process.env.CHATGPT2API_AUTH_KEY);
}

function configuredBaseUrl(): string {
  return process.env.CHATGPT2API_BASE_URL?.trim() ?? '';
}

function configuredModel(): string {
  return process.env.CHATGPT2API_MODEL ?? 'auto';
}

// ---------------------------------------------------------------------------
// RSS parsing (same regex approach as Edge functions)
// ---------------------------------------------------------------------------
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractLink(block: string): string {
  // Handle both plain text and CDATA-wrapped links
  const lm = block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/s);
  if (lm && lm[1].trim()) return lm[1].trim();
  const gm = block.match(/<guid[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/guid>/s);
  return gm ? gm[1].trim() : '';
}

function stripHtml(s: string): string { return s.replace(/<[^>]+>/g, '').trim(); }

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
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

interface RssItem { title: string; link: string; pubDate: string; description: string; }

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    items.push({
      title: stripHtml(extractTag(b, 'title')),
      link: extractLink(b),
      pubDate: extractTag(b, 'pubDate') || extractTag(b, 'dc:date'),
      description: stripHtml(extractTag(b, 'description') || extractTag(b, 'summary')).slice(0, 300),
    });
  }
  return items;
}

async function fetchRss(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EpidemicMonitor/1.0-dev', Accept: 'application/rss+xml, text/xml, application/xml' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RSS ${res.status}: ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Disease keyword matching for Vietnamese news
// ---------------------------------------------------------------------------
const VN_DISEASE_KW = [
  { p: /sốt xuất huyết|dengue|sxh/i, d: 'Sốt xuất huyết (Dengue)', a: 'warning' as const },
  { p: /tay chân miệng|hand.?foot|hfmd/i, d: 'Tay chân miệng (HFMD)', a: 'warning' as const },
  { p: /covid|sars.?cov|corona/i, d: 'COVID-19', a: 'watch' as const },
  { p: /cúm\s*a|influenza\s*a|h[0-9]n[0-9]/i, d: 'Cúm A (Influenza A)', a: 'watch' as const },
  { p: /cúm gia cầm|avian|bird flu|h5n1/i, d: 'Cúm gia cầm (Avian Influenza)', a: 'alert' as const },
  { p: /sởi|measles/i, d: 'Sởi (Measles)', a: 'warning' as const },
  { p: /bạch hầu|diphtheria/i, d: 'Bạch hầu (Diphtheria)', a: 'alert' as const },
  { p: /tả|cholera/i, d: 'Tả (Cholera)', a: 'alert' as const },
  { p: /ho gà|pertussis/i, d: 'Ho gà (Pertussis)', a: 'warning' as const },
  { p: /dại|rabies/i, d: 'Dại (Rabies)', a: 'warning' as const },
  { p: /viêm não|encephalitis/i, d: 'Viêm não Nhật Bản (JE)', a: 'warning' as const },
  { p: /ebola/i, d: 'Ebola', a: 'alert' as const },
  { p: /mpox|đậu mùa khỉ/i, d: 'Mpox', a: 'warning' as const },
  { p: /lao|tuberculosis|tb\b/i, d: 'Lao (Tuberculosis)', a: 'watch' as const },
  { p: /sốt rét|malaria/i, d: 'Sốt rét (Malaria)', a: 'warning' as const },
  { p: /viêm gan|hepatitis/i, d: 'Viêm gan (Hepatitis)', a: 'watch' as const },
  { p: /thủy đậu|chickenpox|varicella/i, d: 'Thủy đậu (Chickenpox)', a: 'watch' as const },
  { p: /bệnh dại|whitmore|melioidosis/i, d: 'Whitmore (Melioidosis)', a: 'warning' as const },
];

/** All 63 provinces + 5 municipalities with diacritic + non-diacritic variants */
const VN_PROVINCES: Record<string, [number, number]> = {
  // 5 municipalities
  'Hà Nội': [21.03, 105.85], 'Ha Noi': [21.03, 105.85],
  'Hồ Chí Minh': [10.82, 106.63], 'Ho Chi Minh': [10.82, 106.63], 'TPHCM': [10.82, 106.63], 'TP.HCM': [10.82, 106.63], 'Sài Gòn': [10.82, 106.63],
  'Đà Nẵng': [16.05, 108.22], 'Da Nang': [16.05, 108.22],
  'Hải Phòng': [20.86, 106.68], 'Hai Phong': [20.86, 106.68],
  'Cần Thơ': [10.04, 105.79], 'Can Tho': [10.04, 105.79],
  // Northern provinces
  'Hà Giang': [22.83, 104.98], 'Cao Bằng': [22.67, 106.26], 'Bắc Kạn': [22.15, 105.83],
  'Tuyên Quang': [21.78, 105.21], 'Lào Cai': [22.49, 103.97], 'Yên Bái': [21.72, 104.87],
  'Thái Nguyên': [21.59, 105.85], 'Lạng Sơn': [21.85, 106.76], 'Quảng Ninh': [21.01, 107.29],
  'Bắc Giang': [21.27, 106.19], 'Phú Thọ': [21.42, 105.23], 'Vĩnh Phúc': [21.31, 105.60],
  'Bắc Ninh': [21.19, 106.07], 'Hải Dương': [20.94, 106.31], 'Hưng Yên': [20.65, 106.06],
  'Thái Bình': [20.45, 106.34], 'Hà Nam': [20.58, 105.92], 'Nam Định': [20.43, 106.16],
  'Ninh Bình': [20.25, 105.97], 'Hòa Bình': [20.81, 105.34],
  'Sơn La': [21.33, 103.91], 'Lai Châu': [22.39, 103.46], 'Điện Biên': [21.39, 103.02],
  // Central provinces
  'Thanh Hóa': [19.81, 105.78], 'Nghệ An': [18.97, 105.17], 'Hà Tĩnh': [18.34, 105.91],
  'Quảng Bình': [17.47, 106.60], 'Quảng Trị': [16.75, 107.19],
  'Thừa Thiên Huế': [16.47, 107.60], 'Huế': [16.47, 107.60],
  'Quảng Nam': [15.57, 108.47], 'Quảng Ngãi': [15.12, 108.80],
  'Bình Định': [13.78, 109.22], 'Phú Yên': [13.09, 109.09], 'Khánh Hòa': [12.25, 109.05],
  'Ninh Thuận': [11.58, 108.99], 'Bình Thuận': [11.09, 108.07],
  // Highlands
  'Kon Tum': [14.35, 108.00], 'Gia Lai': [13.98, 108.00],
  'Đắk Lắk': [12.71, 108.24], 'Đắk Nông': [12.00, 107.69], 'Lâm Đồng': [11.94, 108.44],
  // Southern provinces
  'Bình Phước': [11.75, 106.72], 'Tây Ninh': [11.31, 106.10],
  'Bình Dương': [11.17, 106.65], 'Đồng Nai': [10.95, 106.82],
  'Bà Rịa Vũng Tàu': [10.50, 107.17], 'Vũng Tàu': [10.35, 107.08],
  // Mekong Delta
  'Long An': [10.54, 106.41], 'Tiền Giang': [10.35, 106.36], 'Bến Tre': [10.24, 106.38],
  'Trà Vinh': [9.95, 106.34], 'Vĩnh Long': [10.25, 105.97], 'Đồng Tháp': [10.45, 105.63],
  'An Giang': [10.52, 105.13], 'Kiên Giang': [10.01, 105.08],
  'Hậu Giang': [9.78, 105.47], 'Sóc Trăng': [9.60, 105.98],
  'Bạc Liêu': [9.29, 105.72], 'Cà Mau': [9.18, 105.15],
};


/** Remove Vietnamese diacritics for fuzzy province matching in article text */
function removeDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

function matchDisease(text: string) {
  for (const kw of VN_DISEASE_KW) {
    if (kw.p.test(text)) return { disease: kw.d, alert: kw.a };
  }
  return null;
}

function refineAlert(text: string, base: string) {
  const l = text.toLowerCase();
  if (/bùng phát|tử vong|chết|khẩn cấp|outbreak|emergency/.test(l)) return 'alert';
  if (/tăng mạnh|tăng cao|lan rộng|cảnh báo/.test(l)) return 'warning';
  return base;
}

function findProvince(text: string) {
  // Try exact match first (with diacritics)
  for (const [name, coords] of Object.entries(VN_PROVINCES)) {
    if (text.includes(name)) return { name, coords };
  }
  // Fallback: normalized match (remove diacritics from both)
  const normText = removeDiacritics(text);
  for (const [name, coords] of Object.entries(VN_PROVINCES)) {
    if (normText.includes(removeDiacritics(name))) return { name, coords };
  }
  return null;
}

function isVietnamRelated(text: string): boolean {
  const norm = removeDiacritics(text);
  return Boolean(findProvince(text))
    || /\b(viet nam|vietnam|vn|toan quoc|trong nuoc|bo y te|so y te|cdc)\b/i.test(norm);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleNews(): Promise<unknown> {
  const cached = getCached<unknown>('news');
  if (cached) return cached;

  const sources = [
    { name: 'VnExpress', url: 'https://vnexpress.net/rss/suc-khoe.rss' },
    { name: 'VietnamNet', url: 'https://vietnamnet.vn/suc-khoe.rss' },
    { name: 'Tuổi Trẻ', url: 'https://tuoitre.vn/rss/suc-khoe.rss' },
    { name: 'Thanh Niên', url: 'https://thanhnien.vn/rss/suc-khoe.rss' },
    { name: 'Dân Trí', url: 'https://dantri.com.vn/rss/suc-khoe.rss' },
  ];

  const results = await Promise.allSettled(sources.map(async (s) => {
    const xml = await fetchRss(s.url);
    return parseRssItems(xml).map(item => ({
      id: hashStr(`${s.name}:${item.link || item.title}`),
      title: item.title,
      source: s.name,
      url: item.link,
      publishedAt: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
      summary: item.description,
    }));
  }));

  const items: unknown[] = [];
  const okSources: string[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      items.push(...(results[i] as PromiseFulfilledResult<unknown[]>).value);
      okSources.push(sources[i].name);
    }
  }

  const seen = new Set<string>();
  const deduped = (items as Array<{ id: string; title?: string; url?: string; publishedAt: number }>)
    .filter(it => {
      const key = it.url ? canonicalUrl(it.url) : `${it.id}:${String(it.title ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 50);

  const payload = { items: deduped, fetchedAt: Date.now(), sources: okSources };
  setCached('news', payload, 10 * 60_000);
  return payload;
}

// ---------------------------------------------------------------------------
// Server-side LLM enrichment — crawl article + extract cases/district/ward
// ---------------------------------------------------------------------------
interface OutbreakItem {
  id: string; disease: string; country: string; countryCode: string;
  alertLevel: string; title: string; summary: string; url: string;
  publishedAt: number; lat?: number; lng?: number; province?: string;
  district?: string; cases?: number; deaths?: number; source: string;
  isOutbreakNews?: boolean;
  sourceCount?: number; sourceLabels?: string[]; officialConfirmed?: boolean;
  riskScore?: number; confidence?: number; riskFactors?: string[];
  extractionWarnings?: string[]; geoPrecision?: GeoPrecision;
  latestArticlePublishedAt?: number; pipelineUpdatedAt?: number;
}

function normalizedAlert(level: string): 'alert' | 'warning' | 'watch' {
  return level === 'alert' || level === 'warning' ? level : 'watch';
}

function withEvidenceMeta(
  item: OutbreakItem,
  sourceUrls = item.url,
  sourceNames = item.source,
  articleCount = 1,
): OutbreakItem {
  const sources = summarizeSources(sourceUrls, sourceNames);
  const geoPrecision: GeoPrecision = item.district ? 'district' : item.province ? 'province' : 'unknown';
  const score = scoreOutbreakEvidence({
    articleCount,
    casesPerMillion: 0,
    daysOld: Math.max(0, (Date.now() - item.publishedAt) / 86_400_000),
    alertLevel: normalizedAlert(item.alertLevel),
    geoPrecision,
    sources,
  });
  return {
    ...item,
    sourceCount: sources.sourceCount,
    sourceLabels: sources.labels.slice(0, 4),
    officialConfirmed: sources.officialConfirmed,
    riskScore: score.riskScore,
    confidence: score.confidence,
    riskFactors: score.riskFactors,
    extractionWarnings: score.extractionWarnings,
    geoPrecision,
    latestArticlePublishedAt: item.publishedAt,
    pipelineUpdatedAt: Date.now(),
  };
}

function maxTimestamp(values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

function buildFreshness(outbreaks: OutbreakItem[], newsItems: Array<{ source?: string; publishedAt?: number }>) {
  const sources = new Set<string>();
  for (const outbreak of outbreaks) {
    for (const label of outbreak.sourceLabels ?? []) sources.add(label);
    if (outbreak.source) sources.add(outbreak.source);
  }
  for (const item of newsItems) {
    if (item.source) sources.add(item.source);
  }
  return {
    apiFetchedAt: Date.now(),
    pipelineUpdatedAt: maxTimestamp(outbreaks.map((outbreak) => outbreak.pipelineUpdatedAt)),
    latestArticlePublishedAt: maxTimestamp([
      ...outbreaks.map((outbreak) => outbreak.latestArticlePublishedAt ?? outbreak.publishedAt),
      ...newsItems.map((item) => item.publishedAt),
    ]),
    sourceCount: sources.size,
  };
}

// Secrets MUST come from .env.local or the dev settings endpoint. If missing,
// SDK extraction is skipped and the middleware returns articles without enrichment.
const sdkOutbreakExtractors = new Map<string, ReturnType<typeof createSdkOutbreakExtractor>>();

function getSdkOutbreakExtractor(apiKey?: string): ReturnType<typeof createSdkOutbreakExtractor> | null {
  if (!configuredBaseUrl()) return null;

  const extractorKey = `${configuredBaseUrl()}|${configuredModel()}|${apiKey ?? 'no-token'}`;
  let extractor = sdkOutbreakExtractors.get(extractorKey);
  if (!extractor) {
    extractor = createSdkOutbreakExtractor({
      baseUrl: configuredBaseUrl(),
      apiKey,
      model: configuredModel(),
      stateRoot: '.chatgpt-to-sdk/dev-api',
      includeExamples: false,
      experimental: true,
    });
    sdkOutbreakExtractors.set(extractorKey, extractor);
  }
  return extractor;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
/** Fetch pipeline hotspots from Cloudflare Worker + D1 (same logic as Edge function). */
async function fetchPipelineHotspots(): Promise<unknown[]> {
  const apiUrl = process.env.EPIDEMIC_API_URL;
  const apiKey = process.env.EPIDEMIC_API_KEY;
  if (!apiUrl || !apiKey) return [];

  // Fetch last 7 days in parallel (same as Edge function outbreaks.ts)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().split('T')[0];
  });

  const results = await Promise.allSettled(days.map(async (day) => {
    const res = await fetch(`${apiUrl}/hotspots?day=${day}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { hotspots: Record<string, unknown>[] };
    return (data.hotspots ?? []).map((h) => {
      const districtIdSuf = h.district ? `:${h.district}` : '';
      const item = {
        id: `pipeline:${h.disease}:${h.province}${districtIdSuf}:${h.day}`,
        disease: String(h.disease ?? ''),
        country: 'Vietnam',
        countryCode: 'VN',
        alertLevel: String(h.peak_alert ?? 'watch'),
        title: `${diseaseLabel(String(h.disease ?? ''))} tại ${h.district ? h.district + ', ' : ''}${h.province}`,
        summary: `${h.article_count} nguồn (${h.source_types}). Số ca: ${h.peak_cases ?? 'N/A'}`,
        url: String((h.source_urls as string)?.split('|')[0] ?? ''),
        publishedAt: new Date(String(h.day)).getTime(),
        province: String(h.province ?? ''),
        district: h.district ? String(h.district) : undefined,
        source: `pipeline:${String(h.source_types ?? '')}`,
        cases: h.peak_cases ? Number(h.peak_cases) : undefined,
      };
      return withEvidenceMeta(
        item,
        String(h.source_urls ?? ''),
        String(h.source_types ?? ''),
        Number(h.article_count ?? 1),
      );
    });
  }));

  const all: unknown[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  return all.sort((a: any, b: any) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

/** Stage 1: Use ChatGPT to classify all RSS articles in batch */
async function batchClassifyArticles(
  items: Array<{ title: string; description: string; link: string; pubDate: string; sourceName: string }>,
): Promise<Array<{ item: typeof items[0]; disease: string; alert: string }>> {
  const extractor = getSdkOutbreakExtractor();
  if (!extractor) {
    console.warn('[classify] SDK unavailable, using conservative VN-only keyword fallback');
    return items.flatMap((item) => {
      const text = `${item.title} ${item.description}`;
      const disease = matchDisease(text);
      if (!disease || !isVietnamRelated(text)) return [];
      return [{
        item,
        disease: disease.disease,
        alert: refineAlert(text, disease.alert),
      }];
    });
  }

  const batchInput: BatchClassifyItem[] = items.map((item, i) => ({
    index: i,
    title: item.title,
    summary: item.description.slice(0, 150),
  }));

  console.info(`[classify] Sending ${batchInput.length} articles to ChatGPT Stage 1...`);
  const classified = await extractor.classifyBatch(batchInput);
  console.info(`[classify] ChatGPT returned ${classified.length} classifications`);

  const outbreaks: Array<{ item: typeof items[0]; disease: string; alert: string }> = [];
  for (const c of classified) {
    if (c.classification !== 'OUTBREAK') continue;
    if (c.index < 0 || c.index >= items.length) continue;
    outbreaks.push({
      item: items[c.index],
      disease: c.disease_vn ?? 'Unknown',
      alert: c.confidence >= 0.8 ? 'warning' : 'watch',
    });
  }
  console.info(`[classify] ${outbreaks.length} OUTBREAK articles after Stage 1 filter`);
  return outbreaks;
}

/** Stage 2: Use ChatGPT to extract detailed data from filtered articles */
async function batchExtractArticleDetails(
  classifiedItems: Array<{ item: { title: string; description: string; link: string; pubDate: string; sourceName: string }; disease: string; alert: string }>,
): Promise<OutbreakItem[]> {
  const extractor = getSdkOutbreakExtractor();
  const results: OutbreakItem[] = [];

  for (const { item, alert } of classifiedItems) {
    let disease = '';
    // disease comes from classification, may be overridden by LLM extraction
    const classifiedItem = classifiedItems.find(c => c.item === item);
    disease = classifiedItem?.disease ?? 'Unknown';
    let extractedProvince: string | undefined;
    let extractedDistrict: string | undefined;
    let extractedCases: number | undefined;
    let extractedDeaths: number | undefined;
    let extractedSeverity = alert;
    let extractedSummary = item.description;

    if (extractor && item.link) {
      try {
        const articleBody = await fetchArticleBody(item.link);
        if (articleBody) {
          const extracted = await extractor.extract(articleBody, { sourceUrl: item.link });
          if (extracted) {
            if (extracted.province) extractedProvince = String(extracted.province);
            if (extracted.district) extractedDistrict = String(extracted.district);
            if (extracted.cases != null) extractedCases = Number(extracted.cases) || undefined;
            if (extracted.deaths != null) extractedDeaths = Number(extracted.deaths) || undefined;
            if (extracted.severity) extractedSeverity = String(extracted.severity);
            if (extracted.summary_vi) extractedSummary = String(extracted.summary_vi);
            if (extracted.disease_vn) disease = String(extracted.disease_vn);
          }
        }
      } catch { /* extraction failed, use Stage 1 data */ }
    }

    const text = item.title + ' ' + item.description;
    const prov = extractedProvince
      ? findProvince(extractedProvince) ?? findProvince(text)
      : findProvince(text);

    results.push(withEvidenceMeta({
      id: hashStr(`${item.sourceName}:${item.link}`),
      disease,
      country: 'Vietnam',
      countryCode: 'VN',
      alertLevel: extractedSeverity as 'alert' | 'warning' | 'watch',
      title: item.title,
      summary: extractedSummary,
      url: item.link,
      publishedAt: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
      lat: prov?.coords[0] ?? 16.05,
      lng: prov?.coords[1] ?? 108.22,
      province: prov?.name ?? extractedProvince,
      district: extractedDistrict,
      cases: extractedCases,
      deaths: extractedDeaths,
      source: item.sourceName,
    }));
  }

  return results;
}

/** Fetch article body text from URL (lightweight, no browser) */
async function fetchArticleBody(url: string): Promise<string | null> {
  const cacheKey = `body:${url}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EpidemicMonitor/1.0)' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const bodyPatterns = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*(?:fck_detail|article-body|content-detail|singular-content|detail-content|the-article-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    let body = '';
    for (const p of bodyPatterns) {
      const m = html.match(p);
      if (m) { body = m[1] || m[0]; if (body.length > 200) break; }
    }
    if (body.length < 100) body = html;
    body = body.replace(/<[^>]+>/g, '').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
    if (body.length >= 100) setCached(cacheKey, body, 6 * 60 * 60_000);
    return body.length >= 100 ? body : null;
  } catch {
    return null;
  }
}

async function handleOutbreaks(): Promise<unknown> {
  const cached = getCached<unknown>('outbreaks');
  if (cached) return cached;

  const sources = [
    { name: 'VnExpress', url: 'https://vnexpress.net/rss/suc-khoe.rss' },
    { name: 'VietnamNet', url: 'https://vietnamnet.vn/suc-khoe.rss' },
    { name: 'Tuổi Trẻ', url: 'https://tuoitre.vn/rss/suc-khoe.rss' },
    { name: 'Thanh Niên', url: 'https://thanhnien.vn/rss/suc-khoe.rss' },
    { name: 'Dân Trí', url: 'https://dantri.com.vn/rss/suc-khoe.rss' },
  ];

  const rssResults = await Promise.allSettled(sources.map(async (s) => {
    const xml = await fetchRss(s.url);
    return parseRssItems(xml).map(item => ({ ...item, sourceName: s.name }));
  }));

  const allRssItems: Array<{ title: string; description: string; link: string; pubDate: string; sourceName: string }> = [];
  const okSources: string[] = [];
  for (let i = 0; i < rssResults.length; i++) {
    if (rssResults[i].status === 'fulfilled') {
      allRssItems.push(...(rssResults[i] as PromiseFulfilledResult<typeof allRssItems>).value);
      okSources.push(sources[i].name);
    }
  }

  const classified = await batchClassifyArticles(allRssItems);
  const outbreakItems = await batchExtractArticleDetails(classified);

  const whoDonResult = await Promise.allSettled([fetchPipelineHotspots()]);
  const all: unknown[] = [...outbreakItems];

  if (whoDonResult[0].status === 'fulfilled') {
    all.push(...(whoDonResult[0] as PromiseFulfilledResult<unknown[]>).value);
    okSources.push('pipeline');
  }

  const seen = new Set<string>();
  const deduped = (all as Array<{ id: string; title?: string; url?: string; disease?: string; province?: string; publishedAt: number }>)
    .filter(it => {
      const key = it.url
        ? canonicalUrl(it.url)
        : `${it.disease ?? ''}|${it.province ?? ''}|${String(it.title ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const payload = {
    outbreaks: deduped,
    fetchedAt: Date.now(),
    freshness: buildFreshness(deduped as OutbreakItem[], []),
    sources: okSources,
  };
  setCached('outbreaks', payload, 10 * 60_000);
  return payload;
}

// ---------------------------------------------------------------------------
// Stats handler — derives from outbreaks (same logic as Edge function)
// ---------------------------------------------------------------------------
async function handleStats(): Promise<unknown> {
  const cached = getCached<unknown>('stats');
  if (cached) return cached;

  const outbreaksPayload = await handleOutbreaks() as { outbreaks: Array<{ disease: string; countryCode: string; alertLevel: string }> };
  const outbreaks = outbreaksPayload.outbreaks;

  const diseaseCount = new Map<string, number>();
  const countries = new Set<string>();
  let activeAlerts = 0;

  for (const o of outbreaks) {
    diseaseCount.set(o.disease, (diseaseCount.get(o.disease) ?? 0) + 1);
    if (o.countryCode) countries.add(o.countryCode);
    if (o.alertLevel === 'alert') activeAlerts++;
  }

  const topDiseases = Array.from(diseaseCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([disease, count]) => ({ disease, count }));

  const stats = {
    totalOutbreaks: outbreaks.length,
    activeAlerts,
    countriesAffected: countries.size,
    topDiseases,
    lastUpdated: Date.now(),
  };

  const payload = { stats, fetchedAt: Date.now() };
  setCached('stats', payload, 30 * 60_000);
  return payload;
}

// ---------------------------------------------------------------------------
// Climate handler — fetches real Open-Meteo weather data for VN provinces
// ---------------------------------------------------------------------------
async function handleSourceHealth(): Promise<unknown> {
  const cached = getCached<unknown>('source-health');
  if (cached) return cached;

  const outbreaksPayload = await handleOutbreaks() as { outbreaks: OutbreakItem[] };
  const bySource = new Map<string, { source: string; sourceType: string; itemCount: number; outbreakCount: number; latestPublishedAt?: number }>();
  for (const item of outbreaksPayload.outbreaks) {
    const source = item.sourceLabels?.[0] ?? item.source ?? 'unknown';
    const current = bySource.get(source) ?? { source, sourceType: item.source?.split(':')[0] ?? 'web', itemCount: 0, outbreakCount: 0 };
    current.itemCount += 1;
    current.outbreakCount += item.disease ? 1 : 0;
    current.latestPublishedAt = Math.max(current.latestPublishedAt ?? 0, item.publishedAt ?? 0);
    bySource.set(source, current);
  }

  const sources = Array.from(bySource.values())
    .sort((a, b) => b.itemCount - a.itemCount)
    .map((source) => ({
      ...source,
      freshnessHours: source.latestPublishedAt
        ? Math.round(Math.max(0, Date.now() - source.latestPublishedAt) / 36_000) / 100
        : undefined,
    }));
  const payload = { sources, fetchedAt: Date.now(), windowDays: 14, totalSources: sources.length };
  setCached('source-health', payload, 10 * 60_000);
  return payload;
}

async function handleTimeSeries(url: URL): Promise<unknown> {
  const outbreaksPayload = await handleOutbreaks() as { outbreaks: OutbreakItem[] };
  const days = Math.max(7, Math.min(365, Math.round(Number(url.searchParams.get('days') ?? 90) || 90)));
  const province = url.searchParams.get('province')?.trim() ?? '';
  const disease = url.searchParams.get('disease')?.trim() ?? '';
  const from = Date.now() - days * 86_400_000;
  const buckets = new Map<string, { day: string; disease: string; province: string; alertLevel: string; articleCount: number; cases: number; sourceCount: number }>();

  for (const item of outbreaksPayload.outbreaks) {
    if ((item.publishedAt ?? 0) < from) continue;
    if (province && canonicalProvinceName(item.province ?? '') !== canonicalProvinceName(province)) continue;
    if (disease && item.disease.toLowerCase() !== disease.toLowerCase()) continue;
    const day = new Date(item.publishedAt).toISOString().slice(0, 10);
    const key = `${day}|${item.disease}|${item.province ?? ''}`;
    const current = buckets.get(key) ?? {
      day,
      disease: item.disease,
      province: item.province ?? '',
      alertLevel: item.alertLevel,
      articleCount: 0,
      cases: 0,
      sourceCount: 0,
    };
    current.articleCount += item.sourceCount ?? 1;
    current.cases = Math.max(current.cases, item.cases ?? 0);
    current.sourceCount = Math.max(current.sourceCount, item.sourceCount ?? 1);
    if (item.alertLevel === 'alert' || (item.alertLevel === 'warning' && current.alertLevel === 'watch')) {
      current.alertLevel = item.alertLevel;
    }
    buckets.set(key, current);
  }

  const points = Array.from(buckets.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((point) => ({ ...point, adminProvince: canonicalProvinceName(point.province) }));
  return { points, fetchedAt: Date.now(), days, filters: { province: province || undefined, disease: disease || undefined } };
}

const CLIMATE_PROVINCES = VIETNAM_PROVINCES_2025;

function dengueScore(tMax: number, rain: number, hum: number): number {
  const t = tMax >= 25 && tMax <= 35 ? 1 : tMax > 35 ? 0.7 : tMax >= 20 ? 0.3 : 0.1;
  const r = rain > 20 ? 1 : rain > 5 ? 0.7 : rain > 0 ? 0.3 : 0.05;
  const h = hum > 80 ? 1 : hum > 70 ? 0.7 : hum > 60 ? 0.4 : 0.1;
  return Math.min(1, t * 0.4 + r * 0.35 + h * 0.25);
}

function hfmdScore(tMax: number, hum: number): number {
  const t = tMax > 28 ? 1 : tMax > 24 ? 0.5 : 0.2;
  const h = hum > 80 ? 1 : hum > 70 ? 0.6 : hum > 60 ? 0.3 : 0.1;
  return Math.min(1, t * 0.5 + h * 0.5);
}

function riskLevel(score: number): string {
  if (score >= 0.6) return 'HIGH';
  if (score >= 0.3) return 'MODERATE';
  return 'LOW';
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function handleClimate(): Promise<unknown> {
  const cached = getCached<unknown>('climate');
  if (cached) return cached;

  const results = await mapLimit(CLIMATE_PROVINCES, 4, async (p) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean&forecast_days=14&timezone=Asia%2FBangkok`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json() as { daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[]; relative_humidity_2m_mean: number[] } };
    const d = data.daily;
    const avg = (arr: number[]) => arr.reduce((s, v) => s + (v ?? 0), 0) / arr.length;
    const tMax = +avg(d.temperature_2m_max).toFixed(1);
    const tMin = +avg(d.temperature_2m_min).toFixed(1);
    const rain = +avg(d.precipitation_sum).toFixed(1);
    const hum = +avg(d.relative_humidity_2m_mean).toFixed(1);
    const dr = +dengueScore(tMax, rain, hum).toFixed(2);
    const hr = +hfmdScore(tMax, hum).toFixed(2);
    const airQualityRisk = 0;
    const respiratoryRisk = +(Math.min(1, (hum >= 85 ? 0.16 : hum >= 75 ? 0.11 : 0.05) + (tMax >= 35 ? 0.08 : tMax >= 30 ? 0.05 : 0.02))).toFixed(2);

    let peakScore = -1, peakDay = d.time[0] ?? '';
    for (let i = 0; i < d.time.length; i++) {
      const s = dengueScore(d.temperature_2m_max[i] ?? 0, d.precipitation_sum[i] ?? 0, d.relative_humidity_2m_mean[i] ?? 0);
      if (s > peakScore) { peakScore = s; peakDay = d.time[i] ?? ''; }
    }

    return {
      province: p.name, lat: p.lat, lng: p.lng,
      dengueRisk: dr, hfmdRisk: hr,
      dengueLevel: riskLevel(dr), hfmdLevel: riskLevel(hr),
      airQualityRisk, airQualityLevel: riskLevel(airQualityRisk),
      respiratoryRisk, respiratoryLevel: riskLevel(respiratoryRisk),
      tempMax: tMax, tempMin: tMin, rainfall: rain, humidity: hum,
      pm25: undefined, pm10: undefined, ozone: undefined, nitrogenDioxide: undefined,
      forecastDays: d.time.length, peakRiskDay: peakDay,
    };
  });

  const forecasts = results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<unknown>).value);

  const payload = { forecasts, fetchedAt: Date.now() };
  setCached('climate', payload, 6 * 60 * 60_000);
  return payload;
}

// ---------------------------------------------------------------------------
// Vite plugin
// ---------------------------------------------------------------------------
export function devApiMiddleware(): Plugin {
  return {
    name: 'dev-api-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/health/v1/')) return next();

        const urlObj = new URL(req.url, 'http://localhost');
        const route = urlObj.pathname.replace('/api/health/v1/', '');
        try {
          let data: unknown;
          if (route === 'all') {
            // Bulk endpoint: outbreaks + stats + news in one call
            const [outbreaksPayload, newsPayload] = await Promise.all([handleOutbreaks(), handleNews()]);
            const ob = (outbreaksPayload as { outbreaks: OutbreakItem[] }).outbreaks;
            const newsItems = (newsPayload as { items?: Array<{ source?: string; publishedAt?: number }> }).items ?? [];
            const diseaseCount = new Map<string, number>();
            const countries = new Set<string>();
            let activeAlerts = 0;
            for (const o of ob) {
              diseaseCount.set(o.disease, (diseaseCount.get(o.disease) ?? 0) + 1);
              if (o.countryCode) countries.add(o.countryCode);
              if (o.alertLevel === 'alert') activeAlerts++;
            }
            data = {
              ...(outbreaksPayload as object),
              stats: {
                totalOutbreaks: ob.length, activeAlerts, countriesAffected: countries.size,
                topDiseases: Array.from(diseaseCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([disease, count]) => ({ disease, count })),
                lastUpdated: Date.now()
              },
              news: newsPayload,
              freshness: buildFreshness(ob, newsItems),
            };
          }
          else if (route === 'news') data = await handleNews();
          else if (route === 'outbreaks') data = await handleOutbreaks();
          else if (route === 'stats') data = await handleStats();
          else if (route === 'source-health') data = await handleSourceHealth();
          else if (route === 'timeseries') data = await handleTimeSeries(urlObj);
          else if (route === 'climate') data = await handleClimate();
          else return next();

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(data));
        } catch (err) {
          console.error(`[dev-api] ${route} error:`, err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
