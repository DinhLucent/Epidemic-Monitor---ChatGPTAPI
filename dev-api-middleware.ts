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

const CHATGPT_REFRESH_SNAPSHOT_PATH = resolve(
  process.cwd(),
  process.env.CHATGPT_REFRESH_SNAPSHOT_PATH ?? '.chatgpt-refresh/latest-snapshot.json',
);

// In-memory cache for dev mode
const cache = new Map<string, { data: unknown; expiry: number }>();
const SEEN_ARTICLE_TTL_MS = 24 * 60 * 60_000;
const SEEN_ARTICLE_MAX = 500;
const EXTRACTION_POLICY_VERSION = '2026-04-28-disease-context-guard-v1';
const RSS_BACKOFF_BASE_MS = 60_000;
const RSS_BACKOFF_MAX_MS = 30 * 60_000;
const NEWS_CACHE_TTL_MS = positiveInt(process.env.HEALTH_NEWS_CACHE_TTL_MS, 10 * 60_000);
const OUTBREAK_REFRESH_INTERVAL_MS = positiveInt(process.env.OUTBREAK_REFRESH_INTERVAL_MS, 10 * 60_000);
const OUTBREAK_REFRESH_RETRY_MS = positiveInt(process.env.OUTBREAK_REFRESH_RETRY_MS, 2 * 60_000);
const OUTBREAK_REFRESH_MIN_GAP_MS = positiveInt(process.env.OUTBREAK_REFRESH_MIN_GAP_MS, 60_000);
const OUTBREAK_STALE_TTL_MS = positiveInt(process.env.OUTBREAK_STALE_TTL_MS, 6 * 60 * 60_000);
const WORKER_SNAPSHOT_MAX_AGE_MS = positiveInt(process.env.CHATGPT_REFRESH_SNAPSHOT_MAX_AGE_MS, OUTBREAK_STALE_TTL_MS);
const OUTBREAK_INITIAL_WAIT_MS = positiveInt(process.env.OUTBREAK_INITIAL_WAIT_MS, 3_000);
const MAX_RSS_ITEMS_PER_SOURCE = positiveInt(process.env.RSS_ITEMS_PER_SOURCE, 8);
const MAX_RSS_ITEMS_FOR_AI = positiveInt(process.env.CHATGPT2API_MAX_RSS_ITEMS, 50);
const MAX_STAGE2_EXTRACTIONS = positiveInt(process.env.CHATGPT2API_MAX_STAGE2_ITEMS, 4);
const AI_CLASSIFY_BATCH_SIZE = positiveInt(process.env.CHATGPT2API_CLASSIFY_BATCH_SIZE, 25);
const AI_CLASSIFY_CONCURRENCY = positiveInt(
  process.env.CHATGPT2API_CLASSIFY_CONCURRENCY,
  Math.max(1, Math.min(4, configuredKeys().length || 1)),
);
const AI_CLASSIFY_TIMEOUT_MS = positiveInt(process.env.CHATGPT2API_CLASSIFY_TIMEOUT_MS, 110_000);
const AI_EXTRACT_TIMEOUT_MS = positiveInt(process.env.CHATGPT2API_EXTRACT_TIMEOUT_MS, 65_000);
const OUTBREAK_REFRESH_HARD_TIMEOUT_MS = positiveInt(process.env.OUTBREAK_REFRESH_HARD_TIMEOUT_MS, 8 * 60_000);

interface RssSource {
  name: string;
  url: string;
  maxItems?: number;
}

interface SourceRunMetric {
  name: string;
  url: string;
  ok: boolean;
  durationMs: number;
  itemCount: number;
  usedItemCount: number;
  error?: string;
}

interface ClassificationBatchMetric {
  batch: number;
  lane: string;
  offset: number;
  itemCount: number;
  ok: boolean;
  durationMs: number;
  returnedCount: number;
  outbreakCount: number;
  error?: string;
}

interface ClassificationRunResult {
  classified: ClassifiedArticle[];
  processedItems: RssItem[];
  metrics: ClassificationBatchMetric[];
}

const RSS_SOURCES: RssSource[] = [
  { name: 'VnExpress', url: 'https://vnexpress.net/rss/suc-khoe.rss' },
  { name: 'VietnamNet', url: 'https://vietnamnet.vn/suc-khoe.rss' },
  { name: 'Tuoi Tre', url: 'https://tuoitre.vn/rss/suc-khoe.rss' },
  { name: 'Thanh Nien', url: 'https://thanhnien.vn/rss/suc-khoe.rss' },
  { name: 'Dan Tri', url: 'https://dantri.com.vn/rss/suc-khoe.rss' },
  { name: 'Suc Khoe Doi Song', url: 'https://suckhoedoisong.vn/rss/y-te.rss' },
  { name: 'VOV', url: 'https://vov.vn/rss/suc-khoe.rss' },
  { name: 'VietnamPlus', url: 'https://www.vietnamplus.vn/rss/y-te.rss' },
  { name: 'Nhan Dan', url: 'https://nhandan.vn/rss/y-te-11.rss' },
  { name: 'PLO', url: 'https://plo.vn/rss/suc-khoe-21.rss' },
  { name: 'Tien Phong', url: 'https://tienphong.vn/rss/suc-khoe-210.rss' },
  { name: 'Nguoi Lao Dong', url: 'https://nld.com.vn/rss/suc-khoe.rss' },
];

interface SourceBackoffEntry {
  failures: number;
  retryAfter: number;
  lastError: string;
}

const rssBackoff = new Map<string, SourceBackoffEntry>();

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiry) { cache.delete(key); return undefined; }
  return entry.data as T;
}
function setCached(key: string, data: unknown, ttlMs: number): void {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

type RssItem = { title: string; description: string; link: string; pubDate: string; sourceName: string };
type ArticleClassification = {
  disease: string;
  alert: string;
  province?: string;
  country?: string;
  diseaseIntl?: string;
  diseaseCategory?: string;
  confidence?: number;
};
type ClassifiedArticle = { item: RssItem } & ArticleClassification;

interface SeenArticleEntry {
  fingerprint: string;
  classification: ArticleClassification | null;
  outbreak: OutbreakItem | null;
  expiresAt: number;
  lastSeenAt: number;
}

const seenArticleCache = new Map<string, SeenArticleEntry>();

function articleCacheKey(item: Pick<RssItem, 'link' | 'title' | 'sourceName'>): string {
  return item.link
    ? canonicalUrl(item.link)
    : `${item.sourceName}:${item.title}`.trim().toLowerCase();
}

function articleFingerprint(item: Pick<RssItem, 'title' | 'description'>): string {
  return hashStr(`${EXTRACTION_POLICY_VERSION}\n${normalizeSearchText(`${item.title}\n${item.description}`)}`);
}

function articleContentKey(item: Pick<RssItem, 'title' | 'description'>): string {
  const normalized = normalizeSearchText(`${item.title} ${item.description}`);
  return normalized ? `content:${hashStr(normalized)}` : '';
}

function getSeenArticleEntry(item: RssItem): SeenArticleEntry | undefined {
  const key = articleCacheKey(item);
  const entry = seenArticleCache.get(key);
  const now = Date.now();
  if (!entry || entry.expiresAt <= now || entry.fingerprint !== articleFingerprint(item)) {
    if (entry) seenArticleCache.delete(key);
    return undefined;
  }
  entry.lastSeenAt = now;
  return entry;
}

function rememberSeenArticle(
  item: RssItem,
  patch: Pick<SeenArticleEntry, 'classification'> | Pick<SeenArticleEntry, 'outbreak'>,
): void {
  const key = articleCacheKey(item);
  const now = Date.now();
  const current = seenArticleCache.get(key);
  seenArticleCache.set(key, {
    fingerprint: articleFingerprint(item),
    classification: current?.classification ?? null,
    outbreak: current?.outbreak ?? null,
    expiresAt: now + SEEN_ARTICLE_TTL_MS,
    lastSeenAt: now,
    ...patch,
  });

  if (seenArticleCache.size > SEEN_ARTICLE_MAX) {
    const stale = Array.from(seenArticleCache.entries())
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
      .slice(0, seenArticleCache.size - SEEN_ARTICLE_MAX);
    for (const [staleKey] of stale) seenArticleCache.delete(staleKey);
  }
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

function configuredStateNamespace(): string {
  return safeStatePart(process.env.CHATGPT2API_STATE_NAMESPACE ?? 'dev-api-2');
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

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', egrave: 'è', ecirc: 'ê',
  iacute: 'í', igrave: 'ì', oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ',
  uacute: 'ú', ugrave: 'ù', yacute: 'ý', Aacute: 'Á', Agrave: 'À', Acirc: 'Â',
  Atilde: 'Ã', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Yacute: 'Ý',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return HTML_ENTITY_MAP[entity] ?? match;
  });
}

function stripHtml(s: string): string { return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).trim(); }

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

function rssPublishedAt(item: Pick<RssItem, 'pubDate'>): number {
  const time = item.pubDate ? new Date(item.pubDate).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

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
      sourceName: ''
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

async function fetchRssWithBackoff(source: { name: string; url: string }): Promise<string> {
  const now = Date.now();
  const backoff = rssBackoff.get(source.url);
  if (backoff && now < backoff.retryAfter) {
    throw new Error(`RSS backoff active for ${source.name}: ${backoff.lastError}`);
  }

  try {
    const xml = await fetchRss(source.url);
    rssBackoff.delete(source.url);
    return xml;
  } catch (error) {
    const previous = rssBackoff.get(source.url);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = Math.min(RSS_BACKOFF_MAX_MS, RSS_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 8));
    rssBackoff.set(source.url, {
      failures,
      retryAfter: now + delay,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function getActiveRssSources(): RssSource[] {
  const envSources = process.env.HEALTH_RSS_SOURCES?.trim();
  if (!envSources) return RSS_SOURCES;
  const parsed = envSources
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, url] = line.split('|').map((part) => part?.trim());
      return name && url ? { name, url } : null;
    })
    .filter((source): source is RssSource => Boolean(source));
  return parsed.length > 0 ? parsed : RSS_SOURCES;
}

async function fetchSourceItems(source: RssSource): Promise<{ items: RssItem[]; metric: SourceRunMetric }> {
  const started = Date.now();
  try {
    const xml = await fetchRssWithBackoff(source);
    const parsed = parseRssItems(xml).map((item) => ({ ...item, sourceName: source.name }));
    const used = parsed.slice(0, source.maxItems ?? MAX_RSS_ITEMS_PER_SOURCE);
    return {
      items: used,
      metric: {
        name: source.name,
        url: source.url,
        ok: true,
        durationMs: Date.now() - started,
        itemCount: parsed.length,
        usedItemCount: used.length,
      },
    };
  } catch (error) {
    return {
      items: [],
      metric: {
        name: source.name,
        url: source.url,
        ok: false,
        durationMs: Date.now() - started,
        itemCount: 0,
        usedItemCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

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
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
}

function normalizeSearchText(value: string): string {
  return removeDiacritics(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const TB_POSITIVE_CONTEXT = [
  /\bbenh lao\b/,
  /\bmac lao\b/,
  /\bnghi mac lao\b/,
  /\bca lao\b/,
  /\blao phoi\b/,
  /\blao khang thuoc\b/,
  /\bsang loc lao\b/,
  /\bphat hien\b.*\blao\b/,
  /\btuberculosis\b/,
  /\btb\b/,
];

const TB_NOISE_CONTEXT = [
  /\blao xuong\b/,
  /\blao vao\b/,
  /\blao ra\b/,
  /\blao dong\b/,
  /\bnguoi lao dong\b/,
  /\bhuan chuong lao\b/,
  /\blon lao\b/,
  /\blao cong\b/,
];

const RABIES_POSITIVE_CONTEXT = [
  /\bbenh dai\b/,
  /\bcho can\b/,
  /\bmeo can\b/,
  /\bcho dai\b/,
  /\bvirus dai\b/,
  /\bphong dai\b/,
  /\btiem phong dai\b/,
  /\bvac xin dai\b/,
  /\bvaccine dai\b/,
  /\bphoi nhiem\b.*\bdai\b/,
  /\brabies\b/,
];

const RABIES_NOISE_CONTEXT = [
  /\bco dai\b/,
  /\bmoc dai\b/,
  /\bcay\b.*\bdai\b/,
  /\bthuoc dai\b/,
  /\bdai hoc\b/,
  /\bdai bieu\b/,
  /\bdai dich\b/,
  /\bdai thao duong\b/,
];

const OUTBREAK_EVENT_CONTEXT = [
  /\b\d+\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b.{0,80}\b(mac|nghi mac|ngo doc|nhap vien|tu vong|duong tinh|lay nhiem)\b/,
  /\b(mac|nghi mac|ngo doc|nhap vien|tu vong|duong tinh|lay nhiem)\b.{0,80}\b\d+\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b/,
  /\b(ghi nhan|phat hien|xuat hien|truy vet|o dich|bung phat|dich benh|ca mac|nghi mac|tu vong|nhap vien)\b/,
  /\b(cdc|so y te|bo y te|trung tam kiem soat benh tat|khan truong|canh bao|lay lan|cach ly|giam sat)\b/,
];

const NON_EVENT_HEALTH_CONTEXT = [
  /\b(tu van|khuyen cao chung|dau hieu|trieu chung|cach phong|nen an|nen tranh|thoi quen|dinh duong)\b/,
  /\b(ung thu|tieu duong|dai thao duong|suy than|ton thuong than|di ung|noi man)\b/,
];

function isTuberculosisLabel(disease: string): boolean {
  const normalized = normalizeSearchText(disease);
  return /\blao\b/.test(normalized) || /\btuberculosis\b/.test(normalized);
}

function isRabiesLabel(disease: string): boolean {
  const normalized = normalizeSearchText(disease);
  return /\brabies\b/.test(normalized) || normalized === 'dai' || /\bbenh dai\b/.test(normalized);
}

function isDiseaseEvidenceValid(disease: string, text: string): boolean {
  const normalizedDisease = normalizeSearchText(disease);
  const normalizedText = normalizeSearchText(text);
  if (!normalizedDisease || normalizedDisease === 'unknown') return false;

  if (isTuberculosisLabel(disease)) {
    return !hasPattern(normalizedText, TB_NOISE_CONTEXT)
      && hasPattern(normalizedText, TB_POSITIVE_CONTEXT);
  }

  if (isRabiesLabel(disease)) {
    return !hasPattern(normalizedText, RABIES_NOISE_CONTEXT)
      && hasPattern(normalizedText, RABIES_POSITIVE_CONTEXT);
  }

  return true;
}

function hasOutbreakEventEvidence(text: string): boolean {
  const normalizedText = normalizeSearchText(text);
  return Boolean(normalizedText) && hasPattern(normalizedText, OUTBREAK_EVENT_CONTEXT);
}

function isLikelyGeneralHealthAdvice(text: string): boolean {
  const normalizedText = normalizeSearchText(text);
  return hasPattern(normalizedText, NON_EVENT_HEALTH_CONTEXT)
    && !hasPattern(normalizedText, OUTBREAK_EVENT_CONTEXT);
}

function cleanProvince(value: string | null | undefined): string | undefined {
  const normalized = normalizeSearchText(value ?? '');
  if (!normalized) return undefined;
  if (/\b(khong xac dinh|khong ro|khong cu the|chua ro|toan quoc)\b/.test(normalized)) return undefined;
  return value?.trim() || undefined;
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

  {
    const results = await Promise.all(getActiveRssSources().map(fetchSourceItems));
    const items: unknown[] = [];
    const okSources: string[] = [];
    for (const result of results) {
      if (result.metric.ok) okSources.push(result.metric.name);
      items.push(...result.items.map(item => ({
        id: hashStr(`${item.sourceName}:${item.link || item.title}`),
        title: item.title,
        source: item.sourceName,
        url: item.link,
        publishedAt: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
        summary: item.description,
      })));
    }

    const seen = new Set<string>();
    const deduped = (items as Array<{ id: string; title?: string; summary?: string; url?: string; publishedAt: number }>)
      .filter(it => {
        const key = it.url ? canonicalUrl(it.url) : `${it.id}:${String(it.title ?? '').toLowerCase()}`;
        const contentKey = articleContentKey({ title: it.title ?? '', description: it.summary ?? '' });
        if (seen.has(key) || (contentKey && seen.has(contentKey))) return false;
        seen.add(key);
        if (contentKey) seen.add(contentKey);
        return true;
      })
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 50);

    const payload = { items: deduped, fetchedAt: Date.now(), sources: okSources };
    setCached('news', payload, NEWS_CACHE_TTL_MS);
    return payload;
  }

  const sources = [
    { name: 'VnExpress', url: 'https://vnexpress.net/rss/suc-khoe.rss' },
    { name: 'VietnamNet', url: 'https://vietnamnet.vn/suc-khoe.rss' },
    { name: 'Tuổi Trẻ', url: 'https://tuoitre.vn/rss/suc-khoe.rss' },
    { name: 'Thanh Niên', url: 'https://thanhnien.vn/rss/suc-khoe.rss' },
    { name: 'Dân Trí', url: 'https://dantri.com.vn/rss/suc-khoe.rss' },
  ];

  const results = await Promise.allSettled(sources.map(async (s) => {
    const xml = await fetchRssWithBackoff(s);
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
  const deduped = (items as Array<{ id: string; title?: string; summary?: string; url?: string; publishedAt: number }>)
    .filter(it => {
      const key = it.url ? canonicalUrl(it.url) : `${it.id}:${String(it.title ?? '').toLowerCase()}`;
      const contentKey = articleContentKey({ title: it.title ?? '', description: it.summary ?? '' });
      if (seen.has(key) || (contentKey && seen.has(contentKey))) return false;
      seen.add(key);
      if (contentKey) seen.add(contentKey);
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

type RefreshStatus = 'idle' | 'running' | 'succeeded' | 'failed';

interface BackgroundRefreshPublicStatus {
  status: RefreshStatus;
  reason?: string;
  currentStage?: string;
  startedAt?: number;
  completedAt?: number;
  lastSuccessAt?: number;
  nextRunAt?: number;
  durationMs?: number;
  runCount: number;
  error?: string;
  sourceMetrics?: SourceRunMetric[];
  classifyMetrics?: ClassificationBatchMetric[];
}

interface OutbreaksPayload {
  outbreaks: OutbreakItem[];
  fetchedAt: number;
  freshness: {
    apiFetchedAt: number;
    pipelineUpdatedAt?: number;
    latestArticlePublishedAt?: number;
    sourceCount: number;
    backgroundStatus?: RefreshStatus;
    refreshStartedAt?: number;
    lastSuccessfulRefreshAt?: number;
    nextRefreshAt?: number;
    lastRefreshDurationMs?: number;
  };
  sources: string[];
  backgroundRefresh?: BackgroundRefreshPublicStatus;
  diagnostics?: {
    sourceMetrics: SourceRunMetric[];
    scannedArticleCount: number;
    aiCandidateCount: number;
    outbreakCount: number;
    maxItemsPerSource: number;
    maxAiItems: number;
    classifyBatchSize: number;
    classifyConcurrency: number;
    maxStage2Items: number;
    rssFetchMs: number;
    classifyMs: number;
    extractMs: number;
    pipelineMs: number;
    classifyMetrics: ClassificationBatchMetric[];
  };
}

function normalizedAlert(level: string): 'alert' | 'warning' | 'watch' {
  if (level === 'outbreak' || level === 'critical' || level === 'high') return 'alert';
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
  const alertLevel = normalizedAlert(item.alertLevel);
  const score = scoreOutbreakEvidence({
    articleCount,
    casesPerMillion: 0,
    daysOld: Math.max(0, (Date.now() - item.publishedAt) / 86_400_000),
    alertLevel,
    geoPrecision,
    sources,
  });
  return {
    ...item,
    alertLevel,
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

function alertRank(level: string): number {
  return level === 'alert' ? 3 : level === 'warning' ? 2 : 1;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function outbreakGroupKey(item: Pick<OutbreakItem, 'disease' | 'province' | 'publishedAt'>): string {
  const day = item.publishedAt ? new Date(item.publishedAt).toISOString().slice(0, 10) : 'unknown-day';
  const disease = normalizeSearchText(item.disease);
  const province = normalizeSearchText(canonicalProvinceName(item.province ?? '') || item.province || '');
  return `${disease}|${province}|${day}`;
}

function mergeOutbreakSignals(items: OutbreakItem[]): OutbreakItem[] {
  const groups = new Map<string, OutbreakItem[]>();
  for (const item of items) {
    const key = item.disease && item.province
      ? outbreakGroupKey(item)
      : `single:${item.url || item.id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0]!;

    const sorted = [...group].sort((a, b) =>
      alertRank(b.alertLevel) - alertRank(a.alertLevel)
      || (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
      || (b.confidence ?? 0) - (a.confidence ?? 0),
    );
    const primary = sorted[0]!;
    const sourceUrls = uniqueStrings(group.map((item) => item.url)).join('|');
    const sourceNames = uniqueStrings(group.flatMap((item) => [item.source, ...(item.sourceLabels ?? [])])).join(',');
    const bestAlert = sorted.reduce((best, item) => alertRank(item.alertLevel) > alertRank(best) ? item.alertLevel : best, primary.alertLevel);
    const latestArticlePublishedAt = Math.max(...group.map((item) => item.latestArticlePublishedAt ?? item.publishedAt ?? 0));
    const cases = Math.max(0, ...group.map((item) => item.cases ?? 0)) || undefined;
    const deaths = Math.max(0, ...group.map((item) => item.deaths ?? 0)) || undefined;

    return withEvidenceMeta(
      {
        ...primary,
        id: hashStr(`${normalizeSearchText(primary.disease)}:${normalizeSearchText(primary.province ?? '')}:${new Date(primary.publishedAt).toISOString().slice(0, 10)}`),
        alertLevel: bestAlert,
        summary: `${group.length} nguồn cùng ghi nhận. ${primary.summary}`,
        source: primary.source,
        cases,
        deaths,
        latestArticlePublishedAt,
        pipelineUpdatedAt: Date.now(),
      },
      sourceUrls,
      sourceNames,
      group.length,
    );
  });
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

const outbreakRefreshState: BackgroundRefreshPublicStatus = {
  status: 'idle',
  runCount: 0,
};
let latestOutbreakPayload: OutbreaksPayload | null = null;
let outbreakRefreshPromise: Promise<OutbreaksPayload | null> | null = null;
let outbreakSchedulerTimer: ReturnType<typeof setTimeout> | null = null;
let outbreakSchedulerStarted = false;

function cloneRefreshState(): BackgroundRefreshPublicStatus {
  return {
    ...outbreakRefreshState,
    sourceMetrics: outbreakRefreshState.sourceMetrics
      ? outbreakRefreshState.sourceMetrics.map((metric) => ({ ...metric }))
      : undefined,
    classifyMetrics: outbreakRefreshState.classifyMetrics
      ? outbreakRefreshState.classifyMetrics.map((metric) => ({ ...metric }))
      : undefined,
  };
}

function attachRefreshMeta(payload: OutbreaksPayload): OutbreaksPayload {
  const status = cloneRefreshState();
  return {
    ...payload,
    freshness: {
      ...payload.freshness,
      backgroundStatus: status.status,
      refreshStartedAt: status.startedAt,
      lastSuccessfulRefreshAt: status.lastSuccessAt,
      nextRefreshAt: status.nextRunAt,
      lastRefreshDurationMs: status.durationMs,
    },
    backgroundRefresh: status,
  };
}

function emptyOutbreaksPayload(): OutbreaksPayload {
  const fetchedAt = Date.now();
  return {
    outbreaks: [],
    fetchedAt,
    freshness: {
      apiFetchedAt: fetchedAt,
      sourceCount: 0,
    },
    sources: [],
  };
}

function loadWorkerSnapshot(): OutbreaksPayload | null {
  try {
    const payload = JSON.parse(readFileSync(CHATGPT_REFRESH_SNAPSHOT_PATH, 'utf-8')) as OutbreaksPayload;
    if (!payload || !Array.isArray(payload.outbreaks) || !Number.isFinite(payload.fetchedAt)) return null;
    if (Date.now() - payload.fetchedAt > WORKER_SNAPSHOT_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function scheduleOutbreakRefresh(delayMs: number, reason = 'scheduled'): void {
  if (outbreakSchedulerTimer) clearTimeout(outbreakSchedulerTimer);
  outbreakRefreshState.nextRunAt = Date.now() + delayMs;
  outbreakSchedulerTimer = setTimeout(() => {
    outbreakSchedulerTimer = null;
    void queueOutbreakRefresh(reason);
  }, delayMs);
  outbreakSchedulerTimer.unref?.();
}

function startOutbreakScheduler(): void {
  if (outbreakSchedulerStarted || process.env.OUTBREAK_BACKGROUND_REFRESH === '0') return;
  outbreakSchedulerStarted = true;
  const workerSnapshot = loadWorkerSnapshot();
  if (workerSnapshot) {
    latestOutbreakPayload = workerSnapshot;
    outbreakRefreshState.status = 'succeeded';
    outbreakRefreshState.lastSuccessAt = workerSnapshot.fetchedAt;
    outbreakRefreshState.completedAt = workerSnapshot.fetchedAt;
    if (process.env.OUTBREAK_PREFER_WORKER_SNAPSHOT === '1') return;
  }
  scheduleOutbreakRefresh(500, 'startup');
}

function stopOutbreakScheduler(): void {
  if (outbreakSchedulerTimer) clearTimeout(outbreakSchedulerTimer);
  outbreakSchedulerTimer = null;
  outbreakSchedulerStarted = false;
}

async function waitForRefresh(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise((resolveWait) => setTimeout(resolveWait, timeoutMs)),
  ]);
}

// Secrets MUST come from .env.local or the dev settings endpoint. If missing,
// SDK extraction is skipped and the middleware returns articles without enrichment.
const sdkOutbreakExtractors = new Map<string, ReturnType<typeof createSdkOutbreakExtractor>>();
let sdkKeyCursor = 0;

function nextConfiguredKey(): string | undefined {
  const keys = configuredKeys();
  if (keys.length === 0) return undefined;
  const key = keys[sdkKeyCursor % keys.length];
  sdkKeyCursor += 1;
  return key;
}

function safeStatePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'default';
}

function getSdkOutbreakExtractor(
  apiKey = nextConfiguredKey(),
  lane = 'default',
): ReturnType<typeof createSdkOutbreakExtractor> | null {
  if (!configuredBaseUrl()) return null;

  const laneId = safeStatePart(lane);
  const extractorKey = `${configuredBaseUrl()}|${configuredModel()}|${apiKey ?? 'no-token'}|${laneId}`;
  let extractor = sdkOutbreakExtractors.get(extractorKey);
  if (!extractor) {
    extractor = createSdkOutbreakExtractor({
      baseUrl: configuredBaseUrl(),
      apiKey,
      model: configuredModel(),
      timeoutMs: positiveInt(process.env.CHATGPT2API_TIMEOUT_MS, 90_000),
      providerId: `chatgpt2api-local-${laneId}`,
      stateRoot: `.chatgpt-to-sdk/${configuredStateNamespace()}/${laneId}`,
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
  items: RssItem[],
): Promise<ClassificationRunResult> {
  if (!configuredBaseUrl()) {
    console.warn('[classify] SDK unavailable; skipping keyword fallback to avoid false disease labels');
    return { classified: [], processedItems: [], metrics: [] };
  }

  const outbreaks: ClassifiedArticle[] = [];
  const processedItems: RssItem[] = [];
  const metrics: ClassificationBatchMetric[] = [];
  const chunks = Array.from({ length: Math.ceil(items.length / AI_CLASSIFY_BATCH_SIZE) }, (_, batch) => {
    const offset = batch * AI_CLASSIFY_BATCH_SIZE;
    return {
      batch: batch + 1,
      offset,
      lane: `classify-${(batch % AI_CLASSIFY_CONCURRENCY) + 1}`,
      items: items.slice(offset, offset + AI_CLASSIFY_BATCH_SIZE),
    };
  });

  const batchResults = await mapLimit(chunks, AI_CLASSIFY_CONCURRENCY, async (chunkInfo) => {
    const { batch, lane, offset, items: chunk } = chunkInfo;
    const started = Date.now();
    const extractor = getSdkOutbreakExtractor(nextConfiguredKey(), lane);
    const batchInput: BatchClassifyItem[] = chunk.map((item, i) => ({
      index: i,
      title: item.title,
      summary: item.description.slice(0, 150),
    }));

    console.info(`[classify] Sending ${batchInput.length} articles to ChatGPT Stage 1 (${offset + 1}-${offset + chunk.length}/${items.length})...`);
    if (!extractor) {
      return {
        classified: [],
        processedItems: [],
        metric: {
          batch,
          lane,
          offset,
          itemCount: chunk.length,
          ok: false,
          durationMs: Date.now() - started,
          returnedCount: 0,
          outbreakCount: 0,
          error: 'SDK unavailable',
        } satisfies ClassificationBatchMetric,
      };
    }

    let classified: BatchClassifyResult[] = [];
    try {
      classified = await withTimeout(
        extractor.classifyBatch(batchInput),
        AI_CLASSIFY_TIMEOUT_MS,
        'ChatGPT Stage 1 classify',
      );
    } catch (error) {
      console.error('[classify] ChatGPT Stage 1 batch failed:', error instanceof Error ? error.message : String(error));
      return {
        classified: [],
        processedItems: [],
        metric: {
          batch,
          lane,
          offset,
          itemCount: chunk.length,
          ok: false,
          durationMs: Date.now() - started,
          returnedCount: 0,
          outbreakCount: 0,
          error: error instanceof Error ? error.message : String(error),
        } satisfies ClassificationBatchMetric,
      };
    }

    console.info(`[classify] ChatGPT returned ${classified.length} classifications for batch ${offset + 1}-${offset + chunk.length}`);

    const batchOutbreaks: ClassifiedArticle[] = [];
    for (const c of classified) {
      if (c.classification !== 'OUTBREAK') continue;
      if (c.index < 0 || c.index >= chunk.length) continue;
      const item = chunk[c.index];
      const disease = c.disease_vn ?? 'Unknown';
      const text = `${item?.title ?? ''} ${item?.description ?? ''}`;
      const country = normalizeSearchText(c.country ?? '');
      const province = cleanProvince(c.province);
      const normalizedText = normalizeSearchText(text);
      if (!item) continue;
      if (country && !['vietnam', 'viet nam', 'vn'].includes(country) && !isVietnamRelated(text)) continue;
      if (!country && !isVietnamRelated(text)) continue;
      if (!province && !findProvince(text) && !/\b(toan quoc|ca nuoc|tren ca nuoc|bo y te|cdc|so y te)\b/.test(normalizedText)) continue;
      if (!hasOutbreakEventEvidence(text) || isLikelyGeneralHealthAdvice(text)) continue;
      if (!isDiseaseEvidenceValid(disease, `${item.title} ${item.description}`)) continue;
      batchOutbreaks.push({
        item,
        disease,
        alert: normalizedAlert(c.alert_level ?? (c.confidence >= 0.8 ? 'warning' : 'watch')),
        province,
        country: c.country ?? undefined,
        diseaseIntl: c.disease_intl ?? undefined,
        diseaseCategory: c.disease_category ?? undefined,
        confidence: c.confidence,
      });
    }

    return {
      classified: batchOutbreaks,
      processedItems: chunk,
      metric: {
        batch,
        lane,
        offset,
        itemCount: chunk.length,
        ok: true,
        durationMs: Date.now() - started,
        returnedCount: classified.length,
        outbreakCount: batchOutbreaks.length,
      } satisfies ClassificationBatchMetric,
    };
  });

  for (const result of batchResults) {
    if (result.status !== 'fulfilled') continue;
    outbreaks.push(...result.value.classified);
    processedItems.push(...result.value.processedItems);
    metrics.push(result.value.metric);
  }
  metrics.sort((a, b) => a.batch - b.batch);

  console.info(`[classify] ${outbreaks.length} OUTBREAK articles after Stage 1 filter; processed ${processedItems.length}/${items.length}`);
  return { classified: outbreaks, processedItems, metrics };
}

async function classifyArticlesWithSeenCache(items: RssItem[]): Promise<ClassificationRunResult & { cacheHits: number; uncachedCount: number }> {
  const cached: ClassifiedArticle[] = [];
  const uncached: RssItem[] = [];
  let cacheHits = 0;

  for (const item of items) {
    const entry = getSeenArticleEntry(item);
    if (!entry) {
      uncached.push(item);
      continue;
    }
    cacheHits++;
    if (entry.classification) {
      cached.push({ item, ...entry.classification });
    }
  }

  const classifyResult = await batchClassifyArticles(uncached);
  const classified = classifyResult.classified;
  const positiveKeys = new Set<string>();
  for (const result of classified) {
    positiveKeys.add(articleCacheKey(result.item));
    rememberSeenArticle(result.item, {
      classification: {
        disease: result.disease,
        alert: result.alert,
        province: result.province,
        country: result.country,
        diseaseIntl: result.diseaseIntl,
        diseaseCategory: result.diseaseCategory,
        confidence: result.confidence,
      },
    });
  }
  for (const item of classifyResult.processedItems) {
    if (!positiveKeys.has(articleCacheKey(item))) {
      rememberSeenArticle(item, { classification: null });
    }
  }

  console.info(`[classify] seen-cache hit ${cacheHits}/${items.length} (${cached.length} outbreak); sent ${uncached.length} new/changed article(s), processed ${classifyResult.processedItems.length}`);
  return {
    classified: [...cached, ...classified],
    processedItems: classifyResult.processedItems,
    metrics: classifyResult.metrics,
    cacheHits,
    uncachedCount: uncached.length,
  };
}

/** Stage 2: Use ChatGPT to extract detailed data from filtered articles */
async function batchExtractArticleDetails(
  classifiedItems: ClassifiedArticle[],
): Promise<Array<OutbreakItem | null>> {
  const extractor = getSdkOutbreakExtractor();
  const results: Array<OutbreakItem | null> = [];
  let stage2Count = 0;

  for (const classifiedItem of classifiedItems) {
    const { item, alert } = classifiedItem;
    let disease = classifiedItem.disease ?? 'Unknown';
    let extractedProvince: string | undefined = cleanProvince(classifiedItem.province);
    let extractedDistrict: string | undefined;
    let extractedCases: number | undefined;
    let extractedDeaths: number | undefined;
    let extractedSeverity = alert;
    let extractedSummary = item.description;

    if (extractor && item.link && stage2Count < MAX_STAGE2_EXTRACTIONS) {
      stage2Count += 1;
      try {
        const articleBody = await fetchArticleBody(item.link, articleFingerprint(item));
        if (articleBody) {
          const extracted = await withTimeout(
            extractor.extract(articleBody, { sourceUrl: item.link }),
            AI_EXTRACT_TIMEOUT_MS,
            'ChatGPT Stage 2 extract',
          );
          if (extracted) {
            if (extracted.province) extractedProvince = cleanProvince(String(extracted.province));
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
    const combinedText = `${text} ${extractedSummary}`;
    if (!hasOutbreakEventEvidence(combinedText) || isLikelyGeneralHealthAdvice(combinedText)) {
      results.push(null);
      continue;
    }
    if (!isDiseaseEvidenceValid(disease, `${text} ${extractedSummary}`)) {
      results.push(null);
      continue;
    }
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
async function fetchArticleBody(url: string, fingerprint = 'unknown'): Promise<string | null> {
  const cacheKey = `body:${canonicalUrl(url)}:${fingerprint}`;
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

async function buildOutbreaksPayload(): Promise<OutbreaksPayload> {
  const pipelineStarted = Date.now();
  outbreakRefreshState.currentStage = 'rss';
  const rssStarted = Date.now();
  const sourceResults = await Promise.all(getActiveRssSources().map(fetchSourceItems));
  const rssFetchMs = Date.now() - rssStarted;
  const sourceMetrics = sourceResults.map((result) => result.metric);
  const allRssItems = sourceResults.flatMap((result) => result.items);
  const okSources = sourceMetrics.filter((metric) => metric.ok).map((metric) => metric.name);

  const uniqueRssItems = Array.from(
    new Map(allRssItems.map((item) => [articleContentKey(item) || articleCacheKey(item), item])).values(),
  )
    .sort((a, b) => rssPublishedAt(b) - rssPublishedAt(a))
    .slice(0, MAX_RSS_ITEMS_FOR_AI);

  outbreakRefreshState.currentStage = 'classify';
  const classifyStarted = Date.now();
  const classifyRun = await classifyArticlesWithSeenCache(uniqueRssItems);
  const classifyMs = Date.now() - classifyStarted;
  outbreakRefreshState.classifyMetrics = classifyRun.metrics;

  outbreakRefreshState.currentStage = 'extract';
  const extractStarted = Date.now();
  const outbreakItems = await extractArticleDetailsWithSeenCache(classifyRun.classified);
  const extractMs = Date.now() - extractStarted;

  outbreakRefreshState.currentStage = 'pipeline';
  const whoDonResult = await Promise.allSettled([fetchPipelineHotspots()]);
  const all: unknown[] = [...outbreakItems];

  if (whoDonResult[0].status === 'fulfilled') {
    all.push(...(whoDonResult[0] as PromiseFulfilledResult<unknown[]>).value);
    okSources.push('pipeline');
  }

  const seen = new Set<string>();
  const deduped = (all as Array<{ id: string; title?: string; summary?: string; url?: string; disease?: string; province?: string; publishedAt: number }>)
    .filter(it => {
      const key = it.url
        ? canonicalUrl(it.url)
        : `${it.disease ?? ''}|${it.province ?? ''}|${String(it.title ?? '').toLowerCase()}`;
      const contentKey = articleContentKey({ title: it.title ?? '', description: it.summary ?? '' });
      if (seen.has(key) || (contentKey && seen.has(contentKey))) return false;
      seen.add(key);
      if (contentKey) seen.add(contentKey);
      return true;
    })
    .sort((a, b) => b.publishedAt - a.publishedAt);
  const merged = mergeOutbreakSignals(deduped as OutbreakItem[])
    .sort((a, b) => b.publishedAt - a.publishedAt);

  return {
    outbreaks: merged,
    fetchedAt: Date.now(),
    freshness: buildFreshness(merged, []),
    sources: okSources,
    diagnostics: {
      sourceMetrics,
      scannedArticleCount: allRssItems.length,
      aiCandidateCount: uniqueRssItems.length,
      outbreakCount: merged.length,
      maxItemsPerSource: MAX_RSS_ITEMS_PER_SOURCE,
      maxAiItems: MAX_RSS_ITEMS_FOR_AI,
      classifyBatchSize: AI_CLASSIFY_BATCH_SIZE,
      classifyConcurrency: AI_CLASSIFY_CONCURRENCY,
      maxStage2Items: MAX_STAGE2_EXTRACTIONS,
      rssFetchMs,
      classifyMs,
      extractMs,
      pipelineMs: Date.now() - pipelineStarted,
      classifyMetrics: classifyRun.metrics,
    },
  };
}

async function queueOutbreakRefresh(reason = 'scheduled', force = false): Promise<OutbreaksPayload | null> {
  if (outbreakRefreshPromise) return outbreakRefreshPromise;

  const now = Date.now();
  if (
    !force
    && latestOutbreakPayload
    && outbreakRefreshState.lastSuccessAt
    && now - outbreakRefreshState.lastSuccessAt < OUTBREAK_REFRESH_MIN_GAP_MS
  ) {
    return latestOutbreakPayload;
  }

  if (outbreakSchedulerTimer) {
    clearTimeout(outbreakSchedulerTimer);
    outbreakSchedulerTimer = null;
  }

  outbreakRefreshState.status = 'running';
  outbreakRefreshState.reason = reason;
  outbreakRefreshState.currentStage = 'queued';
  outbreakRefreshState.startedAt = now;
  outbreakRefreshState.completedAt = undefined;
  outbreakRefreshState.durationMs = undefined;
  outbreakRefreshState.error = undefined;
  outbreakRefreshState.nextRunAt = undefined;
  outbreakRefreshState.sourceMetrics = undefined;
  outbreakRefreshState.classifyMetrics = undefined;
  outbreakRefreshState.runCount += 1;

  outbreakRefreshPromise = (async () => {
    try {
      const payload = await withTimeout(
        buildOutbreaksPayload(),
        OUTBREAK_REFRESH_HARD_TIMEOUT_MS,
        'Outbreak background refresh',
      );
      latestOutbreakPayload = payload;
      setCached('outbreaks', payload, OUTBREAK_STALE_TTL_MS);
      const completedAt = Date.now();
      outbreakRefreshState.status = 'succeeded';
      outbreakRefreshState.currentStage = 'idle';
      outbreakRefreshState.completedAt = completedAt;
      outbreakRefreshState.lastSuccessAt = completedAt;
      outbreakRefreshState.durationMs = completedAt - now;
      outbreakRefreshState.sourceMetrics = payload.diagnostics?.sourceMetrics;
      outbreakRefreshState.classifyMetrics = payload.diagnostics?.classifyMetrics;
      return payload;
    } catch (error) {
      outbreakRefreshState.status = 'failed';
      outbreakRefreshState.currentStage = 'failed';
      outbreakRefreshState.completedAt = Date.now();
      outbreakRefreshState.durationMs = outbreakRefreshState.completedAt - now;
      outbreakRefreshState.error = error instanceof Error ? error.message : String(error);
      return latestOutbreakPayload;
    } finally {
      outbreakRefreshPromise = null;
      scheduleOutbreakRefresh(
        outbreakRefreshState.status === 'succeeded' ? OUTBREAK_REFRESH_INTERVAL_MS : OUTBREAK_REFRESH_RETRY_MS,
        outbreakRefreshState.status === 'succeeded' ? 'scheduled' : 'retry-after-failure',
      );
    }
  })();

  return outbreakRefreshPromise;
}

async function handleOutbreaks(options: { force?: boolean; waitForRefreshMs?: number; reason?: string } = {}): Promise<OutbreaksPayload> {
  const { force = false, waitForRefreshMs = OUTBREAK_INITIAL_WAIT_MS, reason = force ? 'manual' : 'request' } = options;
  const snapshot = latestOutbreakPayload ?? getCached<OutbreaksPayload>('outbreaks') ?? loadWorkerSnapshot();
  if (snapshot && !latestOutbreakPayload) latestOutbreakPayload = snapshot;

  if (force) {
    const refresh = queueOutbreakRefresh(reason, true);
    await waitForRefresh(refresh, waitForRefreshMs);
    return attachRefreshMeta(latestOutbreakPayload ?? emptyOutbreaksPayload());
  }

  if (latestOutbreakPayload) {
    const lastSuccessAt = outbreakRefreshState.lastSuccessAt ?? latestOutbreakPayload.fetchedAt;
    if (!outbreakRefreshPromise && Date.now() - lastSuccessAt >= OUTBREAK_REFRESH_INTERVAL_MS) {
      void queueOutbreakRefresh('stale-snapshot');
    }
    return attachRefreshMeta(latestOutbreakPayload);
  }

  const refresh = queueOutbreakRefresh(reason);
  await waitForRefresh(refresh, waitForRefreshMs);
  return attachRefreshMeta(latestOutbreakPayload ?? emptyOutbreaksPayload());

  /*
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
    const xml = await fetchRssWithBackoff(s);
    return parseRssItems(xml).map(item => ({ ...item, sourceName: s.name }));
  }));

  const allRssItems: RssItem[] = [];
  const okSources: string[] = [];
  for (let i = 0; i < rssResults.length; i++) {
    if (rssResults[i].status === 'fulfilled') {
      allRssItems.push(...(rssResults[i] as PromiseFulfilledResult<typeof allRssItems>).value);
      okSources.push(sources[i].name);
    }
  }

  const uniqueRssItems = Array.from(
    new Map(allRssItems.map((item) => [articleContentKey(item) || articleCacheKey(item), item])).values(),
  )
    .sort((a, b) => rssPublishedAt(b) - rssPublishedAt(a))
    .slice(0, MAX_RSS_ITEMS_FOR_AI);

  const classified = await classifyArticlesWithSeenCache(uniqueRssItems);
  const outbreakItems = await extractArticleDetailsWithSeenCache(classified);

  const whoDonResult = await Promise.allSettled([fetchPipelineHotspots()]);
  const all: unknown[] = [...outbreakItems];

  if (whoDonResult[0].status === 'fulfilled') {
    all.push(...(whoDonResult[0] as PromiseFulfilledResult<unknown[]>).value);
    okSources.push('pipeline');
  }

  const seen = new Set<string>();
  const deduped = (all as Array<{ id: string; title?: string; summary?: string; url?: string; disease?: string; province?: string; publishedAt: number }>)
    .filter(it => {
      const key = it.url
        ? canonicalUrl(it.url)
        : `${it.disease ?? ''}|${it.province ?? ''}|${String(it.title ?? '').toLowerCase()}`;
      const contentKey = articleContentKey({ title: it.title ?? '', description: it.summary ?? '' });
      if (seen.has(key) || (contentKey && seen.has(contentKey))) return false;
      seen.add(key);
      if (contentKey) seen.add(contentKey);
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
  */
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

async function extractArticleDetailsWithSeenCache(classifiedItems: ClassifiedArticle[]): Promise<OutbreakItem[]> {
  const cached: OutbreakItem[] = [];
  const uncached: ClassifiedArticle[] = [];

  for (const classified of classifiedItems) {
    const entry = getSeenArticleEntry(classified.item);
    if (entry?.outbreak) {
      cached.push(entry.outbreak);
    } else {
      uncached.push(classified);
    }
  }

  const extracted = await batchExtractArticleDetails(uncached);
  for (let index = 0; index < uncached.length; index++) {
    const classified = uncached[index];
    rememberSeenArticle(classified.item, {
      outbreak: extracted[index] ?? null,
    });
  }

  console.info(`[extract] seen-cache hit ${cached.length}/${classifiedItems.length}; extracted ${uncached.length} new/changed article(s)`);
  return [...cached, ...extracted.filter((item): item is OutbreakItem => Boolean(item))];
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
      startOutbreakScheduler();
      server.httpServer?.once('close', stopOutbreakScheduler);

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/health/v1/')) return next();

        const urlObj = new URL(req.url, 'http://localhost');
        const route = urlObj.pathname.replace('/api/health/v1/', '');
        try {
          let data: unknown;
          if (route === 'all') {
            // Bulk endpoint: outbreaks + stats + news in one call
            const forceRefresh = ['1', 'true', 'yes'].includes((urlObj.searchParams.get('refresh') ?? '').toLowerCase());
            const waitForRefreshMs = Math.min(
              positiveInt(urlObj.searchParams.get('waitMs'), forceRefresh ? 1_000 : OUTBREAK_INITIAL_WAIT_MS),
              30_000,
            );
            const [outbreaksPayload, newsPayload] = await Promise.all([
              handleOutbreaks({
                force: forceRefresh,
                waitForRefreshMs,
                reason: forceRefresh ? 'manual-all-endpoint' : 'all-endpoint',
              }),
              handleNews(),
            ]);
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
              freshness: {
                ...buildFreshness(ob, newsItems),
                backgroundStatus: (outbreaksPayload as OutbreaksPayload).freshness.backgroundStatus,
                refreshStartedAt: (outbreaksPayload as OutbreaksPayload).freshness.refreshStartedAt,
                lastSuccessfulRefreshAt: (outbreaksPayload as OutbreaksPayload).freshness.lastSuccessfulRefreshAt,
                nextRefreshAt: (outbreaksPayload as OutbreaksPayload).freshness.nextRefreshAt,
                lastRefreshDurationMs: (outbreaksPayload as OutbreaksPayload).freshness.lastRefreshDurationMs,
              },
              backgroundRefresh: (outbreaksPayload as OutbreaksPayload).backgroundRefresh,
              diagnostics: (outbreaksPayload as OutbreaksPayload).diagnostics,
            };
          }
          else if (route === 'news') data = await handleNews();
          else if (route === 'outbreaks') data = await handleOutbreaks();
          else if (route === 'refresh') {
            const waitForRefreshMs = Math.min(positiveInt(urlObj.searchParams.get('waitMs'), 1_000), 30_000);
            data = await handleOutbreaks({
              force: true,
              waitForRefreshMs,
              reason: 'manual-refresh-endpoint',
            });
          }
          else if (route === 'pipeline-status') {
            data = {
              backgroundRefresh: cloneRefreshState(),
              hasSnapshot: Boolean(latestOutbreakPayload),
              scheduler: {
                enabled: process.env.OUTBREAK_BACKGROUND_REFRESH !== '0',
                intervalMs: OUTBREAK_REFRESH_INTERVAL_MS,
                retryMs: OUTBREAK_REFRESH_RETRY_MS,
                maxItemsPerSource: MAX_RSS_ITEMS_PER_SOURCE,
                maxAiItems: MAX_RSS_ITEMS_FOR_AI,
                classifyBatchSize: AI_CLASSIFY_BATCH_SIZE,
                classifyConcurrency: AI_CLASSIFY_CONCURRENCY,
                maxStage2Items: MAX_STAGE2_EXTRACTIONS,
                hardTimeoutMs: OUTBREAK_REFRESH_HARD_TIMEOUT_MS,
              },
            };
          }
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
