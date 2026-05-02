import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createChatGPTtoSDK, fileArtifactStore } from '@chatgpt-to-sdk/sdk-ts';
import { sqliteStore } from '@chatgpt-to-sdk/session-sqlite';
import { openAICompatibleProvider } from '@chatgpt-to-sdk/provider-openai-compatible';
import { syncPipelineTelemetryToD1, syncQueueToD1 } from './sync-chatgpt-queue-to-d1.mjs';

const POLICY_VERSION = '2026-04-28-chatgpt-refresh-v1';
const DEFAULT_SNAPSHOT_PATH = '.chatgpt-refresh/latest-snapshot.json';
const DEFAULT_SEEN_CACHE_PATH = '.chatgpt-refresh/seen-cache.json';
const DEFAULT_LOCK_PATH = '.chatgpt-refresh/refresh.lock';
const DEFAULT_QUEUE_DB_PATH = '.chatgpt-refresh/queue.db';

const RSS_SOURCES = [
  ['VnExpress', 'https://vnexpress.net/rss/suc-khoe.rss'],
  ['VietnamNet', 'https://vietnamnet.vn/suc-khoe.rss'],
  ['Tuoi Tre', 'https://tuoitre.vn/rss/suc-khoe.rss'],
  ['Thanh Nien', 'https://thanhnien.vn/rss/suc-khoe.rss'],
  ['Dan Tri', 'https://dantri.com.vn/rss/suc-khoe.rss'],
  ['Suc Khoe Doi Song', 'https://suckhoedoisong.vn/rss/y-te.rss'],
  ['VOV', 'https://vov.vn/rss/suc-khoe.rss'],
  ['VietnamPlus', 'https://www.vietnamplus.vn/rss/y-te.rss'],
  ['Nhan Dan', 'https://nhandan.vn/rss/y-te-11.rss'],
  ['PLO', 'https://plo.vn/rss/suc-khoe-21.rss'],
  ['Tien Phong', 'https://tienphong.vn/rss/suc-khoe-210.rss'],
  ['Nguoi Lao Dong', 'https://nld.com.vn/rss/suc-khoe.rss'],
];

const PROVINCE_COORDS = new Map([
  ['ha noi', [21.03, 105.85]],
  ['ho chi minh', [10.82, 106.63]],
  ['tphcm', [10.82, 106.63]],
  ['tp hcm', [10.82, 106.63]],
  ['dak lak', [12.67, 108.05]],
  ['binh duong', [11.17, 106.67]],
  ['dong nai', [11.07, 107.17]],
  ['da nang', [16.05, 108.22]],
  ['hai phong', [20.86, 106.68]],
  ['can tho', [10.04, 105.79]],
]);

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  atilde: 'ã',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  iacute: 'í',
  igrave: 'ì',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  otilde: 'õ',
  uacute: 'ú',
  ugrave: 'ù',
  yacute: 'ý',
  Aacute: 'Á',
  Agrave: 'À',
  Acirc: 'Â',
  Atilde: 'Ã',
  Eacute: 'É',
  Egrave: 'È',
  Ecirc: 'Ê',
  Iacute: 'Í',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Uacute: 'Ú',
  Yacute: 'Ý',
};

const CLASSIFY_ARTICLE_SCHEMA = {
  type: 'object',
  required: ['index', 'classification', 'confidence', 'reasoning'],
  additionalProperties: false,
  properties: {
    index: { type: 'number' },
    classification: { type: 'string', enum: ['OUTBREAK', 'HEALTH_NEWS', 'IRRELEVANT'] },
    disease_vn: { type: ['string', 'null'] },
    disease_intl: { type: ['string', 'null'] },
    disease_category: { type: ['string', 'null'] },
    alert_level: { type: ['string', 'null'] },
    province: { type: ['string', 'null'] },
    country: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
};

const CLASSIFY_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['articles'],
      additionalProperties: false,
      properties: {
        articles: {
          type: 'array',
          items: CLASSIFY_ARTICLE_SCHEMA,
        },
      },
    },
    {
      type: 'array',
      items: CLASSIFY_ARTICLE_SCHEMA,
    },
  ],
};

/*
 * Kept for prompt clarity even though CLASSIFY_SCHEMA accepts a top-level
 * array. Some ChatGPT2API sessions ignore object wrappers; the normalizer
 * below handles both valid shapes.
 */
const CLASSIFY_OBJECT_SHAPE = {
  type: 'object',
  required: ['articles'],
  additionalProperties: false,
  properties: {
    articles: {
      type: 'array',
      items: CLASSIFY_ARTICLE_SCHEMA,
    },
  },
};

const EXTRACT_SCHEMA = {
  type: 'object',
  required: [
    'disease_vn',
    'province',
    'district',
    'ward',
    'cases',
    'deaths',
    'severity',
    'date',
    'is_outbreak_news',
    'summary_vi',
  ],
  additionalProperties: false,
  properties: {
    disease_vn: { type: ['string', 'null'] },
    province: { type: ['string', 'null'] },
    district: { type: ['string', 'null'] },
    ward: { type: ['string', 'null'] },
    cases: { type: ['number', 'null'] },
    deaths: { type: ['number', 'null'] },
    severity: { type: 'string', enum: ['outbreak', 'warning', 'watch'] },
    date: { type: ['string', 'null'] },
    is_outbreak_news: { type: 'boolean' },
    summary_vi: { type: 'string' },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function flag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function splitKeys(value) {
  if (!value) return [];
  return String(value).split(/[\r\n,]+/).map((key) => key.trim()).filter(Boolean);
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(value ?? '').trim().toLowerCase();
  }
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => HTML_ENTITIES[name] ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtml(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractTag(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function extractLink(block) {
  const link = String(block).match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
  if (link?.[1]?.trim()) return link[1].trim();
  const guid = String(block).match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i);
  return guid?.[1]?.trim() ?? '';
}

function parseRssItems(xml, sourceName) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      sourceName,
      title: stripHtml(extractTag(block, 'title')),
      description: stripHtml(extractTag(block, 'description') || extractTag(block, 'summary')).slice(0, 400),
      link: extractLink(block),
      pubDate: extractTag(block, 'pubDate') || extractTag(block, 'dc:date'),
    });
  }
  return items;
}

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function baseUrlProbeUrl(baseUrl) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/v1') ? `${basePath}/models` : `${basePath}/v1/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function retryDelayMs(attempt, options) {
  const base = options.baseUrlRetryDelayMs;
  return Math.min(base * Math.max(1, attempt), options.baseUrlMaxRetryDelayMs);
}

function probeErrorMessage(error, timeoutMs) {
  if (error?.name === 'AbortError') return `probe timeout after ${timeoutMs}ms`;
  return error instanceof Error ? error.message : String(error);
}

async function probeBaseUrl(options, attempt) {
  const startedAt = Date.now();
  const url = baseUrlProbeUrl(options.baseUrl);
  try {
    const headers = {
      accept: 'application/json,*/*',
      'user-agent': 'EpidemicMonitorChatGPTRefresh/1.0',
    };
    if (options.authKey) headers.authorization = `Bearer ${options.authKey}`;
    const res = await fetchWithTimeout(url, options.baseUrlProbeTimeoutMs, { headers });
    try {
      if (res.body) await res.body.cancel();
    } catch {
      // Probe only needs the status code.
    }
    return {
      ready: res.status < 500,
      attempt,
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ready: false,
      attempt,
      url,
      error: probeErrorMessage(error, options.baseUrlProbeTimeoutMs),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function waitForBaseUrlReady(options, onProbe) {
  const startedAt = Date.now();
  const deadline = startedAt + options.baseUrlWaitMs;
  let attempt = 0;
  let lastProbe = null;
  do {
    attempt += 1;
    lastProbe = await probeBaseUrl(options, attempt);
    await onProbe?.(lastProbe);
    if (lastProbe.ready) {
      return {
        ready: true,
        attempts: attempt,
        waitedMs: Date.now() - startedAt,
        lastProbe,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(retryDelayMs(attempt, options), remainingMs));
  } while (Date.now() < deadline);

  return {
    ready: false,
    attempts: attempt,
    waitedMs: Date.now() - startedAt,
    lastProbe,
  };
}

async function fetchSource([name, url], itemsPerSource) {
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(url, 12_000, {
      headers: {
        accept: 'application/rss+xml,text/xml,application/xml,*/*',
        'user-agent': 'EpidemicMonitorChatGPTRefresh/1.0',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseRssItems(await res.text(), name);
    const used = itemsPerSource > 0 ? parsed.slice(0, itemsPerSource) : parsed;
    return {
      items: used,
      metric: {
        name,
        url,
        ok: true,
        durationMs: Date.now() - startedAt,
        itemCount: parsed.length,
        usedItemCount: used.length,
      },
    };
  } catch (error) {
    return {
      items: [],
      metric: {
        name,
        url,
        ok: false,
        durationMs: Date.now() - startedAt,
        itemCount: 0,
        usedItemCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function buildClassifySystemPrompt() {
  return `You are a Vietnamese public-health surveillance analyst.
Classify each article.

OUTBREAK: concrete Vietnam-related outbreak/signal with disease + place + event evidence.
HEALTH_NEWS: general health news, prevention, policy, research, chronic disease, symptoms, advice.
IRRELEVANT: unrelated, ads, beauty, farming-only, foreign outbreak unrelated to Vietnam.

Strict rules:
- Vietnam-only. Foreign outbreaks not related to Vietnam are IRRELEVANT.
- Do not use a fixed disease list. Infer disease dynamically.
- OUTBREAK must have event evidence: case/death/hospitalization count, cluster/outbreak, recorded/detected/emerged signal, tracing, or CDC/So Y te/Bo Y te warning.
- General advice, allergy, cancer, diabetes, kidney injury, chronic disease, nutrition, symptoms without a concrete case cluster/hotspot are not OUTBREAK.
- "co dai" is not rabies. "xe lao", "lao dong", "huan chuong lao dong", "lon lao" are not tuberculosis.

Prefer this exact top-level object shape:
${JSON.stringify(CLASSIFY_OBJECT_SHAPE)}

Return only JSON.`;
}

function buildClassifyUserPrompt(items) {
  return items.map((item, index) => `[${index}] ${String(item.title ?? '')}\n${String(item.summary ?? item.description ?? '').slice(0, 180)}`).join('\n---\n');
}

function buildExtractSystemPrompt() {
  return `You extract structured outbreak fields from Vietnamese public-health news.
Return only JSON. No markdown.

Only mark is_outbreak_news=true when the article has concrete Vietnam outbreak/event evidence:
case/death/hospitalization count, cluster/outbreak, recorded/detected/emerged signal, tracing, or CDC/So Y te/Bo Y te warning.
Reject general health advice, chronic disease, allergy, cancer, diabetes, kidney injury, symptoms, nutrition, and product content.
Do not confuse "co dai" with rabies or "xe lao/lao dong" with tuberculosis.`;
}

function buildExtractUserPrompt(article) {
  return `<article>\n${article.slice(0, 6000)}\n</article>\n\nExtract the JSON object now.`;
}

function buildVerifySystemPrompt() {
  return `You are a conservative Vietnam public-health verification analyst.
Verify whether this extracted event should be published as a disease outbreak/signal.
Return only JSON: {"publish":true|false,"alert_level":"alert|warning|watch","reason":"short Vietnamese reason"}.

Publish only Vietnam-related concrete epidemiologic events. Reject general health advice, chronic disease education,
foreign-only outbreaks, animal-only disease without human cases, and lexical false positives like "xe lao" or "co dai".`;
}

function buildVerifyUserPrompt(outbreak) {
  return JSON.stringify({
    disease: outbreak.disease,
    province: outbreak.province,
    title: outbreak.title,
    summary: outbreak.summary,
    cases: outbreak.cases ?? null,
    deaths: outbreak.deaths ?? null,
    source: outbreak.source,
  });
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['publish', 'alert_level', 'reason'],
  additionalProperties: false,
  properties: {
    publish: { type: 'boolean' },
    alert_level: { type: 'string', enum: ['alert', 'warning', 'watch'] },
    reason: { type: 'string' },
  },
};

function createRunner({ lane, baseUrl, apiKey, model, stateRoot }) {
  const providerId = `chatgpt2api-refresh-${lane}`;
  const store = sqliteStore({ path: `${stateRoot}/${lane}/state.db` });
  const sdk = createChatGPTtoSDK({
    store,
    artifactStore: fileArtifactStore({ root: `${stateRoot}/${lane}/artifacts` }),
    providers: [
      openAICompatibleProvider({
        id: providerId,
        baseUrl,
        apiKey,
        defaultModel: model,
        experimental: true,
        productionReady: false,
      }),
    ],
    defaultProviderId: providerId,
  });
  return {
    async runJson({ sessionKey, timeoutMs, schema, messages, input, metadata }) {
      return sdk.runJson({
        sessionKey,
        model,
        timeoutMs,
        provider: {
          strategy: 'fixed',
          preferredProviderId: providerId,
          allow: [providerId],
          profile: 'research',
        },
        input,
        schema,
        messages,
        metadata,
      });
    },
    close() {
      store.close();
    },
  };
}

function articleKey(item) {
  return item.link ? canonicalUrl(item.link) : `${item.sourceName}:${normalizeText(item.title)}`;
}

function articleFingerprint(item) {
  return hashText(`${POLICY_VERSION}|${normalizeText(`${item.title}\n${item.description}`)}`);
}

function contentKey(item) {
  return `content:${hashText(normalizeText(`${item.title} ${item.description}`))}`;
}

function articlePublishedMs(item) {
  const parsed = new Date(item.pubDate ?? '').getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function outbreakSignalScore(item) {
  const value = normalizeText(`${item.title ?? ''} ${item.description ?? ''}`);
  let score = 0;
  const strongPatterns = [
    /\b(ngo doc|nghi ngo doc|sot xuat huyet|tay chan mieng|viem nao mo cau|bach hau|ho ga|soi|covid|cum [a-z0-9]*)\b/,
    /\b(o dich|dich benh|bung phat|ca benh|ca mac|nghi mac|tu vong|nhap vien|duong tinh|lay nhiem)\b/,
    /\b(truy vet|cach ly|giam sat|cdc|so y te|bo y te|trung tam kiem soat benh tat)\b/,
  ];
  for (const pattern of strongPatterns) {
    if (pattern.test(value)) score += 25;
  }
  if (/\b\d+\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b/.test(value)) score += 20;
  if (/\b(tho may|co giat|soc|cap cuu|khan truong|canh bao|dien bien phuc tap)\b/.test(value)) score += 10;
  if (/\b(vnexpress|tuoi tre|suc khoe doi song|bo y te|so y te|cdc)\b/.test(normalizeText(item.sourceName ?? ''))) score += 5;
  if (/\b(an gi|nen an|tap gym|giam can|tham my|nha khoa|ung thu|tieu duong|dai thao duong)\b/.test(value)) score -= 10;
  return Math.max(0, score);
}

function estimateCaseCountFromText(text) {
  const value = normalizeText(text);
  const matches = Array.from(value.matchAll(/\b(\d{1,5})\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b/g));
  const values = matches
    .map((match) => Number(match[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

export function isPublishablePublicHealthSignal(disease, text, cases) {
  const diseaseText = normalizeText(disease);
  const value = normalizeText(text);
  const n = cases ?? estimateCaseCountFromText(value) ?? 0;
  const foodborneDisease = /\b(ngo doc thuc pham|food poisoning|salmonella|e coli|ecoli|botulinum|botulism|staphylococcus)\b/.test(diseaseText);
  const foodborneText = /\b(ngo doc|nghi ngo doc)\b/.test(value)
    && /\b(thuc pham|banh mi|com|suat an|bep an|an banh|an com|thuc an|salmonella|e coli|ecoli|vi khuan|nhiem khuan)\b/.test(value);

  if (/\b(xuat huyet tieu hoa|ung thu|u thu|dot quy|suy than|ha kali|bong|chan thuong|tai nan)\b/.test(diseaseText)) {
    return false;
  }

  if (/\b(ngo doc thuoc|ngo doc thuc vat|ngo doc hoa chat)\b/.test(diseaseText)) {
    return n >= 5 && /\b(tap the|hang loat|truong hoc|hoc sinh|bep an|cong ty|cong nhan|dieu tra|so y te)\b/.test(value);
  }

  if (foodborneDisease || foodborneText || /\bngo doc thuc pham\b/.test(value)) {
    return n >= 2 || /\b(tap the|hang loat|truong hoc|hoc sinh|bep an|cong ty|cong nhan|dieu tra|so y te)\b/.test(value);
  }

  if (/\b(lao|tuberculosis)\b/.test(diseaseText)) {
    return /\b(benh lao|mac lao|nghi mac lao|ca lao|lao phoi|sang loc|phat hien.*nghi mac|nhieu nguoi)\b/.test(value);
  }

  if (/\b(sot xuat huyet|tay chan mieng|viem (mang )?nao (do )?mo cau|nao mo cau|bach hau|ho ga|soi|covid|cum|dai|rabies|meningococcal|dengue)\b/.test(diseaseText)) {
    return hasOutbreakEventEvidence(value);
  }

  return /\b(o dich|dich benh|bung phat|lay lan|truy vet|cach ly|cdc|so y te|bo y te)\b/.test(value)
    && hasOutbreakEventEvidence(value);
}

export function compareAiCandidate(a, b) {
  return outbreakSignalScore(b) - outbreakSignalScore(a)
    || articlePublishedMs(b) - articlePublishedMs(a);
}

export function hasOutbreakEventEvidence(text) {
  const value = normalizeText(text);
  return /\b\d+\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b.{0,80}\b(mac|nghi mac|ngo doc|nhap vien|tu vong|duong tinh|lay nhiem)\b/.test(value)
    || /\b(mac|nghi mac|ngo doc|nhap vien|tu vong|duong tinh|lay nhiem)\b.{0,80}\b\d+\s*(ca|nguoi|benh nhan|hoc sinh|tre|truong hop)\b/.test(value)
    || /\b(ghi nhan|phat hien|xuat hien|truy vet|o dich|bung phat|dich benh|ca mac|nghi mac|tu vong|nhap vien)\b/.test(value)
    || /\b(cdc|so y te|bo y te|trung tam kiem soat benh tat|khan truong|canh bao|lay lan|cach ly|giam sat)\b/.test(value);
}

export function isGeneralAdvice(text) {
  const value = normalizeText(text);
  const advice = /\b(tu van|khuyen cao chung|dau hieu|trieu chung|cach phong|nen an|nen tranh|thoi quen|dinh duong)\b/.test(value)
    || /\b(ung thu|tieu duong|dai thao duong|suy than|ton thuong than|di ung|noi man)\b/.test(value);
  return advice && !hasOutbreakEventEvidence(value);
}

export function isBadDiseaseContext(disease, text) {
  const diseaseText = normalizeText(disease);
  const value = normalizeText(text);
  if (/\blao\b|\btuberculosis\b/.test(diseaseText)) {
    if (/\b(lao xuong|lao vao|lao ra|lao dong|nguoi lao dong|huan chuong lao|lon lao|lao cong)\b/.test(value)) return true;
    return !/\b(benh lao|mac lao|nghi mac lao|ca lao|lao phoi|lao khang thuoc|sang loc lao|tuberculosis|tb)\b/.test(value);
  }
  if (/\brabies\b/.test(diseaseText) || diseaseText === 'dai' || /\bbenh dai\b/.test(diseaseText)) {
    if (/\b(co dai|moc dai|thuoc dai|dai hoc|dai bieu|dai dich|dai thao duong)\b/.test(value)) return true;
    return !/\b(benh dai|cho can|meo can|cho dai|virus dai|phong dai|tiem phong dai|vac xin dai|vaccine dai|phoi nhiem.*dai|rabies)\b/.test(value);
  }
  return false;
}

export function cleanProvince(value) {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (/\b(khong xac dinh|khong ro|khong cu the|chua ro|toan quoc|unknown|unspecified|n\/a)\b/.test(normalized)) return undefined;
  if (/\b(tphcm|tp hcm|ho chi minh|thanh pho ho chi minh|sai gon)\b/.test(normalized)) return 'TPHCM';
  return String(value).trim();
}

export function inferProvinceFromText(text) {
  const value = normalizeText(text);
  if (/\b(tphcm|tp hcm|tp\.hcm|ho chi minh|thanh pho ho chi minh|sai gon)\b/.test(value)) return 'TPHCM';
  if (/\bdak lak\b/.test(value)) return 'Dak Lak';
  if (/\bda nang\b/.test(value)) return 'Da Nang';
  if (/\bha noi\b/.test(value)) return 'Ha Noi';
  if (/\bcan tho\b/.test(value)) return 'Can Tho';
  if (/\bdong nai\b/.test(value)) return 'Dong Nai';
  if (/\bbinh duong\b/.test(value)) return 'Binh Duong';
  if (/\bhai phong\b/.test(value)) return 'Hai Phong';
  return undefined;
}

function provinceKey(value) {
  const normalized = normalizeText(value);
  if (/\b(tphcm|tp hcm|ho chi minh|thanh pho ho chi minh|sai gon)\b/.test(normalized)) return 'ho chi minh';
  return normalized;
}

function resolveCoords(province) {
  const normalized = normalizeText(province);
  for (const [key, coords] of PROVINCE_COORDS.entries()) {
    if (normalized.includes(key) || key.includes(normalized)) return coords;
  }
  return [16.05, 108.22];
}

export function normalizeAlert(value, confidence = 0.5) {
  const level = normalizeText(value);
  if (/\b(outbreak|critical|high|alert|khan cap|nguy kich|cap cuu|cao)\b/.test(level)) return 'alert';
  if (/\b(warning|medium|moderate|canh bao|trung binh)\b/.test(level)) return 'warning';
  return confidence >= 0.8 ? 'warning' : 'watch';
}

async function loadSeenCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export function normalizeClassifyRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.articles)) return data.articles;
  return [];
}

function firstNonEmptyString(...values) {
  const value = values.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return value ? value.trim() : undefined;
}

function classificationDisease(row) {
  return firstNonEmptyString(row?.disease_vn, row?.disease, row?.disease_name, row?.pathogen, row?.disease_intl) ?? 'Unknown';
}

function classificationAlert(row) {
  return firstNonEmptyString(row?.alert_level, row?.alert, row?.severity, row?.risk_level);
}

function classificationProvince(row, text) {
  return cleanProvince(firstNonEmptyString(row?.province, row?.province_vn, row?.location, row?.locality)) ?? inferProvinceFromText(text);
}

function classificationCountry(row) {
  return firstNonEmptyString(row?.country, row?.country_vn) ?? 'Vietnam';
}

function classificationConfidence(row) {
  const confidence = Number(row?.confidence);
  return Number.isFinite(confidence) ? confidence : 0.5;
}

export function acceptedClassifiedOutbreak(row, item) {
  if (row?.classification !== 'OUTBREAK') return null;
  const text = `${item.title} ${item.description}`;
  const disease = classificationDisease(row);
  const province = classificationProvince(row, text);
  const confidence = classificationConfidence(row);
  if (!province && !/\b(toan quoc|ca nuoc|bo y te|cdc|so y te)\b/.test(normalizeText(text))) return null;
  if (!hasOutbreakEventEvidence(text) || isGeneralAdvice(text)) return null;
  if (isBadDiseaseContext(disease, text)) return null;
  if (!isPublishablePublicHealthSignal(disease, text)) return null;
  return {
    item,
    disease,
    alert: normalizeAlert(classificationAlert(row), confidence),
    province,
    country: classificationCountry(row),
    confidence,
  };
}

export function articleStatusFromClassification(decision, accepted) {
  if (accepted) return 'CLASSIFIED';
  return decision?.classification === 'HEALTH_NEWS' ? 'NEWS_ONLY' : 'REJECTED';
}

async function acquireLock(path, ttlMs) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs > ttlMs) await rm(path, { force: true });
  }
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
    return async () => rm(path, { force: true });
  } catch {
    throw new Error(`Refresh lock is active: ${path}`);
  }
}

async function classifyArticles({ items, seen, runners, options }) {
  const cached = [];
  const uncached = [];
  for (const item of items) {
    const key = articleKey(item);
    const entry = seen[key];
    if (entry?.fingerprint === articleFingerprint(item)) {
      if (entry.classification) cached.push({ item, ...entry.classification });
    } else {
      uncached.push(item);
    }
  }

  const chunks = [];
  for (let offset = 0; offset < uncached.length; offset += options.classifyBatchSize) {
    chunks.push({ offset, items: uncached.slice(offset, offset + options.classifyBatchSize) });
  }

  const metrics = [];
  const classified = [];
  const processed = [];
  const decisions = [];
  const batchResults = await mapLimit(chunks, options.classifyConcurrency, async (chunk, batchIndex) => {
    const lane = `classify-${(batchIndex % runners.classify.length) + 1}`;
    const runner = runners.classify[batchIndex % runners.classify.length];
    const startedAt = Date.now();
    const inputItems = chunk.items.map((item, index) => ({
      index,
      title: String(item.title ?? ''),
      summary: String(item.description ?? '').slice(0, 200),
    }));
    const result = await runner.runJson({
      sessionKey: `refresh:classify:${POLICY_VERSION}:${hashText(inputItems.map((item) => item.title).join('|'))}`,
      timeoutMs: options.classifyTimeoutMs,
      schema: CLASSIFY_SCHEMA,
      input: { articles: inputItems },
      messages: [
        { role: 'system', content: buildClassifySystemPrompt() },
        { role: 'user', content: buildClassifyUserPrompt(inputItems) },
      ],
      metadata: { caller: 'epidemic-monitor-refresh', stage: 'classify' },
    });
    if (!result.ok) {
      throw new Error(`${result.error?.code ?? 'SDK_ERROR'}: ${result.error?.message ?? 'classification failed'}`);
    }

    const rows = normalizeClassifyRows(result.data);
    const positives = [];
    const decisions = [];
    const decidedItems = [];
    let aiOutbreakCount = 0;
    let guardrailRejectedCount = 0;
    for (const row of rows) {
      const item = chunk.items[row.index];
      if (!item) continue;
      decisions.push({ item, decision: row });
      decidedItems.push(item);
      const accepted = acceptedClassifiedOutbreak(row, item);
      if (row?.classification === 'OUTBREAK') aiOutbreakCount += 1;
      if (accepted) positives.push(accepted);
      else if (row?.classification === 'OUTBREAK') guardrailRejectedCount += 1;
    }

    return {
      positives,
      processed: decidedItems,
      decisions,
      metric: {
        batch: batchIndex + 1,
        lane,
        offset: chunk.offset,
        itemCount: chunk.items.length,
        ok: true,
        durationMs: Date.now() - startedAt,
        returnedCount: rows.length,
        aiOutbreakCount,
        outbreakCount: positives.length,
        guardrailRejectedCount,
      },
    };
  });

  for (const result of batchResults) {
    if (result.status !== 'fulfilled') {
      metrics.push({ ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      continue;
    }
    classified.push(...result.value.positives);
    processed.push(...result.value.processed);
    decisions.push(...result.value.decisions);
    metrics.push(result.value.metric);
  }

  const positiveKeys = new Set(classified.map((row) => articleKey(row.item)));
  for (const row of classified) {
    seen[articleKey(row.item)] = {
      fingerprint: articleFingerprint(row.item),
      classification: {
        disease: row.disease,
        alert: row.alert,
        province: row.province,
        country: row.country,
        confidence: row.confidence,
      },
      updatedAt: Date.now(),
    };
  }
  for (const item of processed) {
    if (!positiveKeys.has(articleKey(item))) {
      seen[articleKey(item)] = {
        fingerprint: articleFingerprint(item),
        classification: null,
        updatedAt: Date.now(),
      };
    }
  }

  return {
    classified: [...cached, ...classified],
    metrics,
    cacheHits: cached.length,
    uncachedCount: uncached.length,
    processedCount: processed.length,
    processedItems: processed,
    decisions,
    aiOutbreaks: metrics.reduce((total, metric) => total + (Number(metric.aiOutbreakCount) || 0), 0),
    guardrailRejected: metrics.reduce((total, metric) => total + (Number(metric.guardrailRejectedCount) || 0), 0),
  };
}

async function fetchArticleBody(url) {
  try {
    const res = await fetchWithTimeout(url, 10_000, {
      headers: {
        accept: 'text/html,*/*',
        'user-agent': 'Mozilla/5.0 EpidemicMonitorChatGPTRefresh/1.0',
      },
    });
    if (!res.ok) return null;
    return stripHtml(await res.text()).slice(0, 6000);
  } catch {
    return null;
  }
}

async function extractDetails({ classified, seen, runner, options }) {
  const out = [];
  const metrics = [];
  let used = 0;
  for (const row of classified) {
    const item = row.item;
    const key = articleKey(item);
    const cached = seen[key];
    if (
      cached
      && cached.fingerprint === articleFingerprint(item)
      && Object.prototype.hasOwnProperty.call(cached, 'outbreak')
    ) {
      if (cached.outbreak) out.push(cached.outbreak);
      continue;
    }

    let disease = row.disease;
    let province = row.province;
    let district;
    let cases;
    let deaths;
    let summary = item.description;
    let alertLevel = row.alert;
    const startedAt = Date.now();

    if (used < options.stage2Items && item.link) {
      used += 1;
      const article = await fetchArticleBody(item.link);
      if (article) {
        try {
          const result = await runner.runJson({
            sessionKey: `refresh:extract:${POLICY_VERSION}:${hashText(canonicalUrl(item.link))}`,
            timeoutMs: options.extractTimeoutMs,
            schema: EXTRACT_SCHEMA,
            input: { article, sourceUrl: item.link },
            messages: [
              { role: 'system', content: buildExtractSystemPrompt() },
              { role: 'user', content: buildExtractUserPrompt(article) },
            ],
            metadata: { caller: 'epidemic-monitor-refresh', stage: 'extract', sourceUrl: item.link },
          });
          if (result.ok && result.data?.is_outbreak_news) {
            disease = result.data.disease_vn || disease;
            province = cleanProvince(result.data.province) || province;
            district = result.data.district || undefined;
            cases = result.data.cases ?? undefined;
            deaths = result.data.deaths ?? undefined;
            summary = result.data.summary_vi || summary;
            alertLevel = normalizeAlert(result.data.severity, row.confidence);
          }
        } catch {
          // Keep Stage 1 data.
        }
      }
    }

    const text = `${item.title} ${item.description} ${summary}`;
    if (!hasOutbreakEventEvidence(text) || isGeneralAdvice(text) || isBadDiseaseContext(disease, text)) {
      seen[key] = {
        ...(seen[key] ?? {}),
        fingerprint: articleFingerprint(item),
        outbreak: null,
        updatedAt: Date.now(),
      };
      continue;
    }
    const publishedAt = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
    const coords = resolveCoords(province);
    const outbreak = {
      id: hashText(`${item.sourceName}:${item.link || item.title}`),
      disease,
      country: 'Vietnam',
      countryCode: 'VN',
      alertLevel,
      title: item.title,
      summary,
      url: item.link,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      lat: coords[0],
      lng: coords[1],
      province,
      district,
      cases,
      deaths,
      source: item.sourceName,
      sourceCount: 1,
      sourceLabels: [item.sourceName],
      officialConfirmed: /suc khoe doi song|bo y te|so y te|cdc/i.test(item.sourceName),
      confidence: row.confidence,
      latestArticlePublishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      pipelineUpdatedAt: Date.now(),
    };
    out.push(outbreak);
    seen[key] = {
      ...(seen[key] ?? {}),
      fingerprint: articleFingerprint(item),
      outbreak,
      updatedAt: Date.now(),
    };
    metrics.push({ url: item.link, durationMs: Date.now() - startedAt });
  }
  return { outbreaks: mergeEvents(out), metrics };
}

function eventKey(item) {
  const day = new Date(item.publishedAt || Date.now()).toISOString().slice(0, 10);
  return `${normalizeText(item.disease)}|${provinceKey(item.province)}|${day}`;
}

function alertRank(level) {
  return level === 'alert' ? 3 : level === 'warning' ? 2 : 1;
}

function mergeEvents(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.disease && item.province ? eventKey(item) : `single:${item.url || item.id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    const sorted = [...group].sort((a, b) => alertRank(b.alertLevel) - alertRank(a.alertLevel) || b.publishedAt - a.publishedAt);
    const primary = sorted[0];
    const labels = Array.from(new Set(group.flatMap((item) => item.sourceLabels ?? [item.source]).filter(Boolean)));
    return {
      ...primary,
      id: hashText(eventKey(primary)),
      alertLevel: sorted.reduce((best, item) => (alertRank(item.alertLevel) > alertRank(best) ? item.alertLevel : best), primary.alertLevel),
      summary: `${group.length} nguon cung ghi nhan. ${primary.summary}`,
      sourceCount: labels.length,
      sourceLabels: labels.slice(0, 4),
      latestArticlePublishedAt: Math.max(...group.map((item) => item.latestArticlePublishedAt ?? item.publishedAt ?? 0)),
      pipelineUpdatedAt: Date.now(),
      cases: Math.max(0, ...group.map((item) => item.cases ?? 0)) || undefined,
      deaths: Math.max(0, ...group.map((item) => item.deaths ?? 0)) || undefined,
    };
  }).sort((a, b) => b.publishedAt - a.publishedAt);
}

function buildFreshness(outbreaks, newsItems, sourceNames) {
  return {
    apiFetchedAt: Date.now(),
    pipelineUpdatedAt: Date.now(),
    latestArticlePublishedAt: Math.max(0, ...outbreaks.map((item) => item.latestArticlePublishedAt ?? item.publishedAt), ...newsItems.map((item) => item.publishedAt)),
    sourceCount: sourceNames.length,
    backgroundStatus: 'succeeded',
    lastSuccessfulRefreshAt: Date.now(),
  };
}

function openQueueDb(dbPath) {
  mkdirSyncForFile(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scan_at INTEGER,
      last_ok_at INTEGER,
      last_error TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      used_item_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      article_key TEXT NOT NULL UNIQUE,
      content_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      url TEXT NOT NULL,
      pub_date TEXT,
      published_at INTEGER,
      status TEXT NOT NULL DEFAULT 'NEW',
      classification_json TEXT,
      extraction_json TEXT,
      outbreak_json TEXT,
      verify_json TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_articles_content ON articles(content_key);
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      article_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      locked_at INTEGER,
      locked_by TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(type, article_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(type, status, available_at, priority);

    CREATE TABLE IF NOT EXISTS events (
      event_key TEXT PRIMARY KEY,
      outbreak_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      article_ids TEXT NOT NULL,
      latest_published_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      mode TEXT NOT NULL,
      metrics_json TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_run_id
      ON pipeline_run_events(run_id, created_at);
  `);
  ensureColumn(db, 'worker_runs', 'current_stage', 'current_stage TEXT');
  ensureColumn(db, 'worker_runs', 'heartbeat_at', 'heartbeat_at INTEGER');
  ensureColumn(db, 'worker_runs', 'worker_id', 'worker_id TEXT');
  return db;
}

function ensureColumn(db, tableName, columnName, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
  if (!exists) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

function mkdirSyncForFile(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function buildNewsItems(items) {
  const seen = new Set();
  return items
    .filter((item) => {
      const key = articleKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (new Date(b.pubDate).getTime() || 0) - (new Date(a.pubDate).getTime() || 0))
    .slice(0, 50)
    .map((item) => ({
      id: hashText(`${item.sourceName}:${item.link || item.title}`),
      title: item.title,
      source: item.sourceName,
      url: item.link,
      publishedAt: Number.isFinite(new Date(item.pubDate).getTime()) ? new Date(item.pubDate).getTime() : Date.now(),
      summary: item.description,
    }));
}

function asArticleRowItem(row) {
  return {
    dbId: row.id,
    sourceName: row.source_name,
    title: row.title,
    description: row.description,
    link: row.url,
    pubDate: row.pub_date,
  };
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readJsonSync(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function syncD1IfRequested(options) {
  if (!options.syncD1) return null;
  return syncQueueToD1({
    queueDbPath: options.queueDbPath,
    snapshotPath: options.snapshotPath,
    database: options.d1Database,
    remote: options.d1Remote,
    local: options.d1Local,
    persistTo: options.d1PersistTo,
    dryRun: options.d1DryRun,
    limit: options.d1SyncLimit,
  });
}

async function syncTelemetryIfRequested(options) {
  if (!options.syncD1 || !options.d1Telemetry) return null;
  try {
    return await syncPipelineTelemetryToD1({
      queueDbPath: options.queueDbPath,
      database: options.d1Database,
      remote: options.d1Remote,
      local: options.d1Local,
      persistTo: options.d1PersistTo,
      dryRun: options.d1DryRun,
      runLimit: 10,
      eventLimit: 120,
    });
  } catch (error) {
    console.warn('[chatgpt-refresh-worker] telemetry sync failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function eventMetaJson(meta) {
  if (!meta) return null;
  try {
    return JSON.stringify(meta).slice(0, 8000);
  } catch {
    return null;
  }
}

function recordRunEvent(db, runId, stage, status, message = '', meta = null) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO pipeline_run_events(run_id, created_at, stage, status, message, meta_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, now, stage, status, String(message ?? '').slice(0, 500), eventMetaJson(meta));
  db.prepare('UPDATE worker_runs SET current_stage = ?, heartbeat_at = ? WHERE id = ?')
    .run(stage, now, runId);
}

async function markRunStage(db, runId, options, stage, status, message = '', meta = null, publishTelemetry = false) {
  recordRunEvent(db, runId, stage, status, message, meta);
  if (publishTelemetry) await syncTelemetryIfRequested(options);
}

function enqueueJob(db, type, articleId, priority = 0) {
  const now = Date.now();
  const existing = db.prepare('SELECT id, status FROM jobs WHERE type = ? AND article_id = ?').get(type, articleId);
  if (!existing) {
    db.prepare(`
      INSERT INTO jobs(type, article_id, status, priority, available_at, created_at, updated_at)
      VALUES (?, ?, 'PENDING', ?, ?, ?, ?)
    `).run(type, articleId, priority, now, now, now);
    return;
  }
  if (existing.status !== 'RUNNING') {
    db.prepare(`
      UPDATE jobs
      SET status = 'PENDING', priority = MAX(priority, ?), available_at = ?,
          locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(priority, now, now, existing.id);
  }
}

function completeJob(db, type, articleId) {
  db.prepare(`
    UPDATE jobs SET status = 'DONE', updated_at = ?, locked_at = NULL, locked_by = NULL
    WHERE type = ? AND article_id = ?
  `).run(Date.now(), type, articleId);
}

function failJob(db, type, articleId, error, retryDelayMs = 5 * 60_000) {
  const now = Date.now();
  const job = db.prepare('SELECT id, attempts FROM jobs WHERE type = ? AND article_id = ?').get(type, articleId);
  if (!job) return;
  const attempts = Number(job?.attempts ?? 0) + 1;
  const status = attempts >= 3 ? 'DEAD_LETTER' : 'PENDING';
  db.prepare(`
    UPDATE jobs
    SET status = ?, attempts = ?, available_at = ?, last_error = ?, updated_at = ?,
        locked_at = NULL, locked_by = NULL
    WHERE type = ? AND article_id = ?
  `).run(status, attempts, now + retryDelayMs * attempts, String(error).slice(0, 500), now, type, articleId);
}

function claimJobs(db, type, limit, workerId, lockTtlMs) {
  if (limit <= 0) return [];
  const now = Date.now();
  db.prepare(`
    UPDATE jobs
    SET status = 'PENDING', available_at = ?, locked_at = NULL, locked_by = NULL,
        last_error = COALESCE(last_error, 'stale running job recovered'), updated_at = ?
    WHERE type = ? AND status = 'RUNNING' AND locked_at IS NOT NULL AND locked_at < ?
  `).run(now, now, type, now - lockTtlMs);
  const rows = db.prepare(`
    SELECT j.id AS job_id, j.type, j.article_id, j.attempts AS job_attempts, a.*
    FROM jobs j
    JOIN articles a ON a.id = j.article_id
    WHERE j.type = ? AND j.status = 'PENDING' AND j.available_at <= ?
    ORDER BY j.priority DESC, COALESCE(a.published_at, a.last_seen_at, j.created_at) DESC, j.created_at DESC
    LIMIT ?
  `).all(type, now, limit);
  const update = db.prepare(`
    UPDATE jobs SET status = 'RUNNING', locked_at = ?, locked_by = ?, updated_at = ?
    WHERE id = ? AND status = 'PENDING'
  `);
  return rows.filter((row) => update.run(now, workerId, now, row.job_id).changes > 0);
}

async function scanSourcesToQueue(db, options) {
  const started = Date.now();
  const sourceResults = await Promise.all(RSS_SOURCES.map((source) => fetchSource(source, options.itemsPerSource)));
  const now = Date.now();
  const upsertSource = db.prepare(`
    INSERT INTO sources(name, url, enabled, last_scan_at, last_ok_at, last_error, item_count, used_item_count)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      last_scan_at = excluded.last_scan_at,
      last_ok_at = excluded.last_ok_at,
      last_error = excluded.last_error,
      item_count = excluded.item_count,
      used_item_count = excluded.used_item_count
  `);
  const insertArticle = db.prepare(`
    INSERT INTO articles(
      id, article_key, content_key, fingerprint, source_name, title, description, url, pub_date, published_at,
      status, first_seen_at, last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?)
    ON CONFLICT(article_key) DO UPDATE SET
      content_key = excluded.content_key,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at,
      source_name = excluded.source_name,
      title = excluded.title,
      description = excluded.description,
      pub_date = excluded.pub_date,
      published_at = excluded.published_at
  `);
  const getArticle = db.prepare('SELECT id, fingerprint FROM articles WHERE article_key = ?');
  const resetChanged = db.prepare(`
    UPDATE articles
    SET fingerprint = ?, status = 'NEW', classification_json = NULL, extraction_json = NULL,
        outbreak_json = NULL, verify_json = NULL, last_error = NULL, updated_at = ?
    WHERE id = ?
  `);

  let seenArticles = 0;
  let newArticles = 0;
  let changedArticles = 0;
  for (const result of sourceResults) {
    const metric = result.metric;
    upsertSource.run(
      metric.name,
      metric.url,
      now,
      metric.ok ? now : null,
      metric.ok ? null : metric.error,
      metric.itemCount,
      metric.usedItemCount,
    );
    for (const item of result.items) {
      if (!item.title && !item.link) continue;
      seenArticles += 1;
      const key = articleKey(item);
      const id = hashText(key);
      const fingerprint = articleFingerprint(item);
      const previous = getArticle.get(key);
      const publishedAt = Number.isFinite(new Date(item.pubDate).getTime()) ? new Date(item.pubDate).getTime() : now;
      insertArticle.run(
        id,
        key,
        contentKey(item),
        previous?.fingerprint ?? fingerprint,
        item.sourceName,
        item.title ?? '',
        item.description ?? '',
        item.link ?? '',
        item.pubDate ?? null,
        publishedAt,
        now,
        now,
        now,
      );
      if (!previous) {
        newArticles += 1;
        enqueueJob(db, 'classify', id, 10 + outbreakSignalScore(item));
      } else if (previous.fingerprint !== fingerprint) {
        changedArticles += 1;
        resetChanged.run(fingerprint, now, previous.id);
        enqueueJob(db, 'classify', previous.id, 20 + outbreakSignalScore(item));
      }
    }
  }

  return {
    durationMs: Date.now() - started,
    sourceMetrics: sourceResults.map((result) => result.metric),
    seenArticles,
    newArticles,
    changedArticles,
  };
}

async function processClassifyQueue(db, runners, options, workerId) {
  const rows = claimJobs(db, 'classify', options.classifyJobLimit, workerId, options.jobLockTtlMs);
  if (rows.length === 0) return { claimed: 0, processed: 0, positives: 0, aiOutbreaks: 0, guardrailRejected: 0, metrics: [] };
  const items = rows.map(asArticleRowItem);
  const seen = {};
  const result = await classifyArticles({ items, seen, runners, options });
  const positiveByArticleId = new Map(result.classified.map((row) => [row.item.dbId, row]));
  const processedIds = new Set(result.processedItems.map((item) => item.dbId));
  const decisionByArticleId = new Map(result.decisions.map(({ item, decision }) => [item.dbId, decision]));
  const updatePositive = db.prepare(`
    UPDATE articles
    SET status = 'CLASSIFIED', classification_json = ?, updated_at = ?, last_error = NULL
    WHERE id = ?
  `);
  const updateNegative = db.prepare(`
    UPDATE articles
    SET status = ?, classification_json = ?, updated_at = ?, last_error = NULL
    WHERE id = ?
  `);
  const now = Date.now();

  for (const row of rows) {
    const positive = positiveByArticleId.get(row.id);
    if (positive) {
      updatePositive.run(JSON.stringify({
        classification: 'OUTBREAK',
        disease: positive.disease,
        alert: positive.alert,
        province: positive.province,
        country: positive.country,
        confidence: positive.confidence,
      }), now, row.id);
      completeJob(db, 'classify', row.id);
      enqueueJob(db, 'extract', row.id, positive.alert === 'alert' ? 20 : 10);
    } else if (processedIds.has(row.id)) {
      const decision = decisionByArticleId.get(row.id) ?? { classification: 'IRRELEVANT' };
      updateNegative.run(
        articleStatusFromClassification(decision, false),
        JSON.stringify(decision),
        now,
        row.id,
      );
      completeJob(db, 'classify', row.id);
    } else {
      failJob(db, 'classify', row.id, 'classification batch did not complete');
    }
  }

  return {
    claimed: rows.length,
    processed: processedIds.size,
    positives: positiveByArticleId.size,
    aiOutbreaks: result.aiOutbreaks,
    guardrailRejected: result.guardrailRejected,
    metrics: result.metrics,
  };
}

async function extractOneQueuedArticle(row, runner, options) {
  const item = asArticleRowItem(row);
  const classification = parseJson(row.classification_json, {});
  let disease = classification.disease || 'Unknown';
  let province = classification.province;
  let district;
  let cases;
  let deaths;
  let summary = item.description;
  let alertLevel = classification.alert || 'watch';
  let extraction = null;
  const article = item.link ? await fetchArticleBody(item.link) : null;

  if (article) {
    const result = await runner.runJson({
      sessionKey: `queue:extract:${POLICY_VERSION}:${hashText(canonicalUrl(item.link))}`,
      timeoutMs: options.extractTimeoutMs,
      schema: EXTRACT_SCHEMA,
      input: { article, sourceUrl: item.link },
      messages: [
        { role: 'system', content: buildExtractSystemPrompt() },
        { role: 'user', content: buildExtractUserPrompt(article) },
      ],
      metadata: { caller: 'epidemic-monitor-refresh-queue', stage: 'extract', sourceUrl: item.link },
    });
    if (!result.ok) {
      throw new Error(`${result.error?.code ?? 'SDK_ERROR'}: ${result.error?.message ?? 'extraction failed'}`);
    }
    extraction = result.data;
  }

  if (extraction && !extraction.is_outbreak_news) {
    return { publish: false, extraction };
  }

  if (extraction?.is_outbreak_news) {
    disease = extraction.disease_vn || disease;
    province = cleanProvince(extraction.province) || province;
    district = extraction.district || undefined;
    cases = extraction.cases ?? undefined;
    deaths = extraction.deaths ?? undefined;
    summary = extraction.summary_vi || summary;
    alertLevel = normalizeAlert(extraction.severity, classification.confidence);
  }

  const text = `${item.title} ${item.description} ${summary}`;
  if (!hasOutbreakEventEvidence(text) || isGeneralAdvice(text) || isBadDiseaseContext(disease, text)) {
    return { publish: false, extraction };
  }
  if (!isPublishablePublicHealthSignal(disease, text, cases)) {
    return { publish: false, extraction };
  }

  const publishedAt = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
  const coords = resolveCoords(province);
  return {
    publish: true,
    extraction,
    outbreak: {
      id: hashText(`${item.sourceName}:${item.link || item.title}`),
      articleId: row.id,
      disease,
      country: 'Vietnam',
      countryCode: 'VN',
      alertLevel,
      title: item.title,
      summary,
      url: item.link,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      lat: coords[0],
      lng: coords[1],
      province,
      district,
      cases,
      deaths,
      source: item.sourceName,
      sourceCount: 1,
      sourceLabels: [item.sourceName],
      officialConfirmed: /suc khoe doi song|bo y te|so y te|cdc/i.test(item.sourceName),
      confidence: classification.confidence,
      latestArticlePublishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      pipelineUpdatedAt: Date.now(),
    },
  };
}

async function processExtractQueue(db, runner, options, workerId) {
  const rows = claimJobs(db, 'extract', options.extractJobLimit, workerId, options.jobLockTtlMs);
  if (rows.length === 0) return { claimed: 0, published: 0, rejected: 0, metrics: [] };
  const updatePublished = db.prepare(`
    UPDATE articles
    SET status = ?, extraction_json = ?, outbreak_json = ?, updated_at = ?, last_error = NULL
    WHERE id = ?
  `);
  const updateRejected = db.prepare(`
    UPDATE articles
    SET status = 'REJECTED', extraction_json = ?, outbreak_json = NULL, updated_at = ?, last_error = NULL
    WHERE id = ?
  `);
  let published = 0;
  let rejected = 0;
  const metrics = [];
  for (const row of rows) {
    const started = Date.now();
    try {
      const result = await extractOneQueuedArticle(row, runner, options);
      if (result.publish) {
        const needsVerify = result.outbreak.alertLevel === 'alert'
          || (result.outbreak.confidence ?? 0) < 0.85
          || !result.outbreak.cases;
        const verifyEnabled = options.verifyJobLimit > 0;
        updatePublished.run(
          needsVerify && verifyEnabled ? 'EXTRACTED' : 'PUBLISHED',
          JSON.stringify(result.extraction ?? {}),
          JSON.stringify(result.outbreak),
          Date.now(),
          row.id,
        );
        completeJob(db, 'extract', row.id);
        if (needsVerify && verifyEnabled) enqueueJob(db, 'verify', row.id, result.outbreak.alertLevel === 'alert' ? 30 : 10);
        published += 1;
      } else {
        updateRejected.run(JSON.stringify(result.extraction ?? {}), Date.now(), row.id);
        completeJob(db, 'extract', row.id);
        rejected += 1;
      }
      metrics.push({ articleId: row.id, ok: true, durationMs: Date.now() - started });
    } catch (error) {
      failJob(db, 'extract', row.id, error instanceof Error ? error.message : String(error));
      metrics.push({ articleId: row.id, ok: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { claimed: rows.length, published, rejected, metrics };
}

async function processVerifyQueue(db, runner, options, workerId) {
  const rows = claimJobs(db, 'verify', options.verifyJobLimit, workerId, options.jobLockTtlMs);
  if (rows.length === 0) return { claimed: 0, published: 0, rejected: 0, metrics: [] };
  const update = db.prepare(`
    UPDATE articles SET status = ?, verify_json = ?, outbreak_json = ?, updated_at = ?, last_error = NULL
    WHERE id = ?
  `);
  let published = 0;
  let rejected = 0;
  const metrics = [];
  for (const row of rows) {
    const started = Date.now();
    try {
      const outbreak = parseJson(row.outbreak_json);
      if (!outbreak) {
        update.run('REJECTED', JSON.stringify({ publish: false, reason: 'missing outbreak payload' }), null, Date.now(), row.id);
        completeJob(db, 'verify', row.id);
        rejected += 1;
        continue;
      }
      const result = await runner.runJson({
        sessionKey: `queue:verify:${POLICY_VERSION}:${row.id}:${hashText(row.outbreak_json ?? '')}`,
        timeoutMs: options.extractTimeoutMs,
        schema: VERIFY_SCHEMA,
        input: { outbreak },
        messages: [
          { role: 'system', content: buildVerifySystemPrompt() },
          { role: 'user', content: buildVerifyUserPrompt(outbreak) },
        ],
        metadata: { caller: 'epidemic-monitor-refresh-queue', stage: 'verify', sourceUrl: outbreak?.url },
      });
      if (!result.ok) throw new Error(`${result.error?.code ?? 'SDK_ERROR'}: ${result.error?.message ?? 'verify failed'}`);
      if (result.data.publish) {
        outbreak.alertLevel = normalizeAlert(result.data.alert_level, outbreak.confidence);
        outbreak.pipelineUpdatedAt = Date.now();
        update.run('PUBLISHED', JSON.stringify(result.data), JSON.stringify(outbreak), Date.now(), row.id);
        published += 1;
      } else {
        update.run('REJECTED', JSON.stringify(result.data), row.outbreak_json, Date.now(), row.id);
        rejected += 1;
      }
      completeJob(db, 'verify', row.id);
      metrics.push({ articleId: row.id, ok: true, durationMs: Date.now() - started });
    } catch (error) {
      failJob(db, 'verify', row.id, error instanceof Error ? error.message : String(error));
      metrics.push({ articleId: row.id, ok: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { claimed: rows.length, published, rejected, metrics };
}

function loadQueueStats(db) {
  return db.prepare(`
    SELECT type, status, COUNT(*) AS count
    FROM jobs GROUP BY type, status
  `).all();
}

function rebuildEventsAndSnapshot(db, options, scanMetrics, classifyMetrics, extractMetrics, verifyMetrics, startedAt) {
  const rows = db.prepare(`
    SELECT id, outbreak_json FROM articles
    WHERE status = 'PUBLISHED' AND outbreak_json IS NOT NULL
    ORDER BY published_at DESC
  `).all();
  const outbreaks = rows.map((row) => parseJson(row.outbreak_json)).filter(Boolean);
  const merged = mergeEvents(outbreaks);
  const insertEvent = db.prepare(`
    INSERT INTO events(event_key, outbreak_json, source_count, article_ids, latest_published_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM events');
    for (const event of merged) {
      const members = outbreaks.filter((item) => eventKey(item) === eventKey(event));
      insertEvent.run(
        eventKey(event),
        JSON.stringify(event),
        event.sourceCount ?? members.length,
        JSON.stringify(members.map((item) => item.articleId).filter(Boolean)),
        event.latestArticlePublishedAt ?? event.publishedAt,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const newsRows = db.prepare(`
    SELECT * FROM articles
    ORDER BY COALESCE(published_at, last_seen_at) DESC
    LIMIT 50
  `).all();
  const newsItems = newsRows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source_name,
    url: row.url,
    publishedAt: row.published_at ?? row.last_seen_at,
    summary: row.description,
  }));
  const sourceNames = db.prepare('SELECT name FROM sources WHERE last_ok_at IS NOT NULL').all().map((row) => row.name);
  const queueStats = loadQueueStats(db);
  const queueStillProcessing = queueStats.some((row) => ['PENDING', 'RUNNING'].includes(row.status) && Number(row.count) > 0);
  const previousSnapshot = merged.length === 0 && queueStillProcessing
    ? readJsonSync(options.snapshotPath, null)
    : null;
  const publishedOutbreaks = merged.length === 0
    && queueStillProcessing
    && Array.isArray(previousSnapshot?.outbreaks)
    && previousSnapshot.outbreaks.length > 0
    ? previousSnapshot.outbreaks
    : merged;
  const snapshot = {
    outbreaks: publishedOutbreaks,
    news: { items: newsItems, source: 'chatgpt-refresh-queue' },
    fetchedAt: now,
    freshness: buildFreshness(publishedOutbreaks, newsItems, sourceNames),
    sources: sourceNames,
    diagnostics: {
      policyVersion: POLICY_VERSION,
      mode: 'queue',
      pipelineMs: now - startedAt,
      sourceScan: scanMetrics,
      classify: classifyMetrics,
      extract: extractMetrics,
      verify: verifyMetrics,
      queueStats,
      articleCount: db.prepare('SELECT COUNT(*) AS count FROM articles').get().count,
      eventCount: merged.length,
      publishedOutbreakCount: publishedOutbreaks.length,
      snapshotFallback: publishedOutbreaks !== merged ? 'previous-snapshot-while-queue-drains' : undefined,
      config: {
        itemsPerSource: options.itemsPerSource,
        classifyJobLimit: options.classifyJobLimit,
        extractJobLimit: options.extractJobLimit,
        verifyJobLimit: options.verifyJobLimit,
        classifyConcurrency: options.classifyConcurrency,
        classifyBatchSize: options.classifyBatchSize,
      },
    },
  };
  return snapshot;
}

async function deferAiUntilBaseUrlReturns(db, runId, options, scan, baseUrl, startedAt) {
  const classify = {
    claimed: 0,
    processed: 0,
    positives: 0,
    metrics: [],
    deferred: 'base-url-unavailable',
  };
  const extract = {
    claimed: 0,
    published: 0,
    rejected: 0,
    metrics: [],
    deferred: 'base-url-unavailable',
  };
  const verify = {
    claimed: 0,
    published: 0,
    rejected: 0,
    metrics: [],
    deferred: 'base-url-unavailable',
  };

  recordRunEvent(db, runId, 'base-url', 'waiting', 'BASE URL unavailable; AI jobs deferred until reconnect', baseUrl);
  await markRunStage(db, runId, options, 'snapshot', 'running', 'snapshot rebuild started', null, false);
  const snapshot = rebuildEventsAndSnapshot(db, options, scan, classify, extract, verify, startedAt);
  snapshot.diagnostics.baseUrl = baseUrl;
  snapshot.diagnostics.aiDeferred = true;
  await saveJsonAtomic(options.snapshotPath, snapshot);
  await markRunStage(db, runId, options, 'snapshot', 'succeeded', 'snapshot written while AI queue waits for BASE URL', {
    events: snapshot.diagnostics.eventCount,
    publishedOutbreaks: snapshot.diagnostics.publishedOutbreakCount,
    articleCount: snapshot.diagnostics.articleCount,
  }, false);

  const now = Date.now();
  db.prepare('UPDATE worker_runs SET completed_at = ?, metrics_json = ?, current_stage = ?, heartbeat_at = ? WHERE id = ?')
    .run(now, JSON.stringify(snapshot.diagnostics), 'base-url-wait', now, runId);
  await syncTelemetryIfRequested(options);

  console.log(JSON.stringify({
    ok: true,
    mode: 'queue',
    deferred: 'base-url-unavailable',
    snapshotPath: options.snapshotPath,
    queueDbPath: options.queueDbPath,
    articles: snapshot.diagnostics.articleCount,
    events: snapshot.diagnostics.eventCount,
    scanNew: scan.newArticles ?? 0,
    scanChanged: scan.changedArticles ?? 0,
    baseUrl,
    pipelineMs: snapshot.diagnostics.pipelineMs,
  }, null, 2));

  return snapshot;
}

async function runQueueCycle(options) {
  const db = openQueueDb(options.queueDbPath);
  const runners = { classify: [], extract: null, verify: null };
  const startedAt = Date.now();
  const workerId = `worker-${process.pid}`;
  const run = db.prepare(`
    INSERT INTO worker_runs(started_at, mode, worker_id, current_stage, heartbeat_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(startedAt, 'queue', workerId, 'starting', startedAt);
  const runId = Number(run.lastInsertRowid);
  try {
    await markRunStage(db, runId, options, 'starting', 'running', 'worker cycle started', {
      queueDbPath: options.queueDbPath,
      snapshotPath: options.snapshotPath,
      syncD1: options.syncD1,
    }, true);
    await mkdir(options.stateRoot, { recursive: true });
    const keys = options.authKeys.length > 0 ? options.authKeys : [options.authKey];
    for (let index = 0; index < options.classifyConcurrency; index += 1) {
      await mkdir(`${options.stateRoot}/queue-classify-${index + 1}`, { recursive: true });
      runners.classify.push(createRunner({
        lane: `queue-classify-${index + 1}`,
        baseUrl: options.baseUrl,
        apiKey: keys[index % keys.length],
        model: options.model,
        stateRoot: options.stateRoot,
      }));
    }
    for (const lane of ['queue-extract-1', 'queue-verify-1']) {
      await mkdir(`${options.stateRoot}/${lane}`, { recursive: true });
    }
    runners.extract = createRunner({
      lane: 'queue-extract-1',
      baseUrl: options.baseUrl,
      apiKey: keys[0],
      model: options.model,
      stateRoot: options.stateRoot,
    });
    runners.verify = createRunner({
      lane: 'queue-verify-1',
      baseUrl: options.baseUrl,
      apiKey: keys[0],
      model: options.model,
      stateRoot: options.stateRoot,
    });

    await markRunStage(db, runId, options, 'scan', 'running', options.skipScan ? 'RSS scan skipped' : 'RSS scan started', null, true);
    const scan = options.skipScan ? { skipped: true } : await scanSourcesToQueue(db, options);
    await markRunStage(db, runId, options, 'scan', 'succeeded', 'RSS scan finished', {
      newArticles: scan.newArticles ?? 0,
      changedArticles: scan.changedArticles ?? 0,
      seenArticles: scan.seenArticles ?? 0,
      durationMs: scan.durationMs,
    }, true);

    await markRunStage(db, runId, options, 'base-url', 'running', 'checking ChatGPT2API BASE URL', {
      baseUrl: options.baseUrl,
      waitMs: options.baseUrlWaitMs,
    }, true);
    const baseUrl = await waitForBaseUrlReady(options, (probe) => {
      if (probe.ready) return;
      recordRunEvent(db, runId, 'base-url', 'waiting', 'BASE URL unavailable; retrying', probe);
    });
    if (!baseUrl.ready) {
      return await deferAiUntilBaseUrlReturns(db, runId, options, scan, baseUrl, startedAt);
    }
    await markRunStage(db, runId, options, 'base-url', 'succeeded', 'ChatGPT2API BASE URL reachable', baseUrl, true);

    await markRunStage(db, runId, options, 'classify', 'running', 'classification queue started', null, true);
    const classify = await processClassifyQueue(db, runners, options, workerId);
    await markRunStage(db, runId, options, 'classify', 'succeeded', 'classification queue finished', {
      claimed: classify.claimed,
      processed: classify.processed,
      aiOutbreaks: classify.aiOutbreaks,
      positives: classify.positives,
      guardrailRejected: classify.guardrailRejected,
      errors: classify.metrics.filter((metric) => !metric.ok).length,
    }, true);

    await markRunStage(db, runId, options, 'extract', 'running', 'extraction queue started', null, true);
    const extract = await processExtractQueue(db, runners.extract, options, workerId);
    await markRunStage(db, runId, options, 'extract', 'succeeded', 'extraction queue finished', {
      claimed: extract.claimed,
      published: extract.published,
      rejected: extract.rejected,
      errors: extract.metrics.filter((metric) => !metric.ok).length,
    }, true);

    await markRunStage(db, runId, options, 'verify', 'running', options.verifyJobLimit > 0 ? 'verification queue started' : 'verification disabled', null, true);
    const verify = options.verifyJobLimit > 0
      ? await processVerifyQueue(db, runners.verify, options, workerId)
      : { claimed: 0, published: 0, rejected: 0, metrics: [] };
    await markRunStage(db, runId, options, 'verify', 'succeeded', 'verification queue finished', {
      claimed: verify.claimed,
      published: verify.published,
      rejected: verify.rejected,
      errors: verify.metrics.filter((metric) => !metric.ok).length,
    }, true);

    await markRunStage(db, runId, options, 'snapshot', 'running', 'snapshot rebuild started', null, true);
    const snapshot = rebuildEventsAndSnapshot(db, options, scan, classify, extract, verify, startedAt);
    await saveJsonAtomic(options.snapshotPath, snapshot);
    await markRunStage(db, runId, options, 'snapshot', 'succeeded', 'snapshot written', {
      events: snapshot.diagnostics.eventCount,
      publishedOutbreaks: snapshot.diagnostics.publishedOutbreakCount,
      articleCount: snapshot.diagnostics.articleCount,
    }, true);

    await markRunStage(db, runId, options, 'd1-sync', 'running', options.syncD1 ? 'D1 sync started' : 'D1 sync disabled', null, true);
    const d1Sync = await syncD1IfRequested(options);
    await markRunStage(db, runId, options, 'd1-sync', 'succeeded', options.syncD1 ? 'D1 sync finished' : 'D1 sync skipped', {
      itemCount: d1Sync?.itemCount ?? 0,
      publishedCount: d1Sync?.publishedCount ?? 0,
      newsOnlyCount: d1Sync?.newsOnlyCount ?? 0,
      telemetryRunCount: d1Sync?.telemetryRunCount ?? 0,
      telemetryEventCount: d1Sync?.telemetryEventCount ?? 0,
    }, false);
    db.prepare('UPDATE worker_runs SET completed_at = ?, metrics_json = ? WHERE id = ?')
      .run(Date.now(), JSON.stringify({ ...snapshot.diagnostics, d1Sync }), runId);
    await markRunStage(db, runId, options, 'completed', 'succeeded', 'worker cycle completed', {
      pipelineMs: snapshot.diagnostics.pipelineMs,
    }, true);
    console.log(JSON.stringify({
      ok: true,
      mode: 'queue',
      snapshotPath: options.snapshotPath,
      queueDbPath: options.queueDbPath,
      articles: snapshot.diagnostics.articleCount,
      events: snapshot.diagnostics.eventCount,
      scanNew: scan.newArticles ?? 0,
      scanChanged: scan.changedArticles ?? 0,
      classified: classify.processed,
      aiOutbreaks: classify.aiOutbreaks,
      positives: classify.positives,
      guardrailRejected: classify.guardrailRejected,
      extracted: extract.claimed,
      verified: verify.claimed,
      classifyErrors: classify.metrics.filter((metric) => !metric.ok).map((metric) => metric.error).slice(0, 3),
      d1Sync,
      pipelineMs: snapshot.diagnostics.pipelineMs,
    }, null, 2));
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRunEvent(db, runId, 'failed', 'failed', message);
    db.prepare('UPDATE worker_runs SET completed_at = ?, error = ?, current_stage = ?, heartbeat_at = ? WHERE id = ?')
      .run(Date.now(), message, 'failed', Date.now(), runId);
    await syncTelemetryIfRequested(options);
    throw error;
  } finally {
    for (const runner of runners.classify) runner.close();
    runners.extract?.close();
    runners.verify?.close();
    db.close();
  }
}

async function runOnce(options) {
  const releaseLock = await acquireLock(options.lockPath, options.hardTimeoutMs * 2);
  const runners = { classify: [], extract: null };
  try {
    await mkdir(options.stateRoot, { recursive: true });
    const keys = options.authKeys.length > 0 ? options.authKeys : [options.authKey];
    for (let index = 0; index < options.classifyConcurrency; index += 1) {
      await mkdir(`${options.stateRoot}/classify-${index + 1}`, { recursive: true });
      runners.classify.push(createRunner({
        lane: `classify-${index + 1}`,
        baseUrl: options.baseUrl,
        apiKey: keys[index % keys.length],
        model: options.model,
        stateRoot: options.stateRoot,
      }));
    }
    await mkdir(`${options.stateRoot}/extract-1`, { recursive: true });
    runners.extract = createRunner({
      lane: 'extract-1',
      baseUrl: options.baseUrl,
      apiKey: keys[0],
      model: options.model,
      stateRoot: options.stateRoot,
    });

    const startedAt = Date.now();
    const seen = await loadSeenCache(options.seenCachePath);
    const rssStarted = Date.now();
    const sourceResults = await Promise.all(RSS_SOURCES.map((source) => fetchSource(source, options.itemsPerSource)));
    const sourceMetrics = sourceResults.map((result) => result.metric);
    const allItems = sourceResults.flatMap((result) => result.items);
    const okSources = sourceMetrics.filter((metric) => metric.ok).map((metric) => metric.name);
    const uniqueItems = Array.from(new Map(allItems.map((item) => [contentKey(item) || articleKey(item), item])).values())
      .sort(compareAiCandidate)
      .slice(0, options.maxAiItems);
    const rssFetchMs = Date.now() - rssStarted;

    const classifyStarted = Date.now();
    const classified = await classifyArticles({ items: uniqueItems, seen, runners, options });
    const classifyMs = Date.now() - classifyStarted;

    const extractStarted = Date.now();
    const extracted = await extractDetails({ classified: classified.classified, seen, runner: runners.extract, options });
    const extractMs = Date.now() - extractStarted;

    const newsItems = buildNewsItems(allItems);
    const snapshot = {
      outbreaks: extracted.outbreaks,
      news: { items: newsItems, source: 'chatgpt-refresh-worker' },
      fetchedAt: Date.now(),
      freshness: buildFreshness(extracted.outbreaks, newsItems, okSources),
      sources: okSources,
      diagnostics: {
        policyVersion: POLICY_VERSION,
        scannedArticleCount: allItems.length,
        aiCandidateCount: uniqueItems.length,
        classifiedOutbreakCount: classified.classified.length,
        outbreakCount: extracted.outbreaks.length,
        cacheHits: classified.cacheHits,
        uncachedCount: classified.uncachedCount,
        processedCount: classified.processedCount,
        rssFetchMs,
        classifyMs,
        extractMs,
        pipelineMs: Date.now() - startedAt,
        sourceMetrics,
        classifyMetrics: classified.metrics,
        extractMetrics: extracted.metrics,
        config: {
          itemsPerSource: options.itemsPerSource,
          maxAiItems: options.maxAiItems,
          classifyBatchSize: options.classifyBatchSize,
          classifyConcurrency: options.classifyConcurrency,
          stage2Items: options.stage2Items,
        },
      },
    };

    await saveJsonAtomic(options.snapshotPath, snapshot);
    await saveJsonAtomic(options.seenCachePath, seen);
    const d1Sync = await syncD1IfRequested(options);
    console.log(JSON.stringify({
      ok: true,
      snapshotPath: options.snapshotPath,
      outbreaks: snapshot.outbreaks.length,
      scannedArticleCount: snapshot.diagnostics.scannedArticleCount,
      aiCandidateCount: snapshot.diagnostics.aiCandidateCount,
      cacheHits: snapshot.diagnostics.cacheHits,
      pipelineMs: snapshot.diagnostics.pipelineMs,
      classifyMs: snapshot.diagnostics.classifyMs,
      extractMs: snapshot.diagnostics.extractMs,
      d1Sync,
    }, null, 2));
    return snapshot;
  } finally {
    for (const runner of runners.classify) runner.close();
    runners.extract?.close();
    await releaseLock();
  }
}

function buildOptions(args) {
  loadEnvLocal();
  const authKeys = splitKeys(process.env.CHATGPT2API_AUTH_KEYS);
  const authKey = process.env.CHATGPT2API_AUTH_KEY || authKeys[0];
  const baseUrl = process.env.CHATGPT2API_BASE_URL || 'http://127.0.0.1:8010';
  const legacy = flag(args.legacy);
  const hardTimeoutMs = positiveInt(args['hard-timeout-ms'] ?? process.env.OUTBREAK_REFRESH_HARD_TIMEOUT_MS, 8 * 60_000);
  if (!authKey && authKeys.length === 0) {
    throw new Error('Missing CHATGPT2API_AUTH_KEY or CHATGPT2API_AUTH_KEYS.');
  }
  return {
    legacy,
    baseUrl,
    authKey,
    authKeys,
    model: process.env.CHATGPT2API_MODEL || 'auto',
    snapshotPath: resolve(process.cwd(), args.snapshot || process.env.CHATGPT_REFRESH_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH),
    seenCachePath: resolve(process.cwd(), args['seen-cache'] || process.env.CHATGPT_REFRESH_SEEN_CACHE_PATH || DEFAULT_SEEN_CACHE_PATH),
    queueDbPath: resolve(process.cwd(), args['queue-db'] || process.env.CHATGPT_REFRESH_QUEUE_DB_PATH || DEFAULT_QUEUE_DB_PATH),
    lockPath: resolve(process.cwd(), args.lock || process.env.CHATGPT_REFRESH_LOCK_PATH || DEFAULT_LOCK_PATH),
    stateRoot: resolve(process.cwd(), args['state-root'] || process.env.CHATGPT_REFRESH_STATE_ROOT || '.chatgpt-to-sdk/refresh-worker'),
    itemsPerSource: nonNegativeInt(args['items-per-source'] ?? process.env.RSS_ITEMS_PER_SOURCE, legacy ? 8 : 60),
    maxAiItems: positiveInt(args['max-ai-items'] ?? process.env.CHATGPT2API_MAX_RSS_ITEMS, 50),
    stage2Items: positiveInt(args['stage2-items'] ?? process.env.CHATGPT2API_MAX_STAGE2_ITEMS, 4),
    classifyBatchSize: positiveInt(args['classify-batch-size'] ?? process.env.CHATGPT2API_CLASSIFY_BATCH_SIZE, 25),
    classifyConcurrency: positiveInt(args['classify-concurrency'] ?? process.env.CHATGPT2API_CLASSIFY_CONCURRENCY, Math.max(1, Math.min(4, authKeys.length || 2))),
    classifyJobLimit: nonNegativeInt(args['classify-job-limit'] ?? process.env.CHATGPT_REFRESH_CLASSIFY_JOB_LIMIT ?? process.env.CHATGPT2API_MAX_RSS_ITEMS, 50),
    extractJobLimit: nonNegativeInt(args['extract-job-limit'] ?? process.env.CHATGPT_REFRESH_EXTRACT_JOB_LIMIT ?? process.env.CHATGPT2API_MAX_STAGE2_ITEMS, 4),
    verifyJobLimit: nonNegativeInt(args['verify-job-limit'] ?? process.env.CHATGPT_REFRESH_VERIFY_JOB_LIMIT, 2),
    syncD1: flag(args['sync-d1']) || flag(process.env.CHATGPT_SYNC_D1),
    d1Database: args['d1-database'] || process.env.CHATGPT_D1_DATABASE || 'epidemic-monitor',
    d1Remote: flag(args['d1-remote']) || flag(args.remote) || flag(process.env.CHATGPT_D1_REMOTE),
    d1Local: flag(args['d1-local']) || flag(args.local) || flag(process.env.CHATGPT_D1_LOCAL),
    d1PersistTo: args['d1-persist-to'] || args['persist-to'] || process.env.CHATGPT_D1_PERSIST_TO,
    d1DryRun: flag(args['d1-dry-run']) || flag(args['dry-run']) || flag(process.env.CHATGPT_D1_DRY_RUN),
    d1Telemetry: !flag(args['no-d1-telemetry']) && !flag(process.env.CHATGPT_D1_TELEMETRY_DISABLED),
    d1SyncLimit: positiveInt(args['d1-sync-limit'] ?? process.env.CHATGPT_D1_SYNC_LIMIT, 1000),
    classifyTimeoutMs: positiveInt(args['classify-timeout-ms'] ?? process.env.CHATGPT2API_CLASSIFY_TIMEOUT_MS, 110_000),
    extractTimeoutMs: positiveInt(args['extract-timeout-ms'] ?? process.env.CHATGPT2API_EXTRACT_TIMEOUT_MS, 65_000),
    baseUrlWaitMs: nonNegativeInt(args['base-url-wait-ms'] ?? process.env.CHATGPT2API_BASE_URL_WAIT_MS, 5 * 60_000),
    baseUrlProbeTimeoutMs: positiveInt(args['base-url-probe-timeout-ms'] ?? process.env.CHATGPT2API_BASE_URL_PROBE_TIMEOUT_MS, 7_000),
    baseUrlRetryDelayMs: positiveInt(args['base-url-retry-delay-ms'] ?? process.env.CHATGPT2API_BASE_URL_RETRY_DELAY_MS, 15_000),
    baseUrlMaxRetryDelayMs: positiveInt(args['base-url-max-retry-delay-ms'] ?? process.env.CHATGPT2API_BASE_URL_MAX_RETRY_DELAY_MS, 60_000),
    intervalMs: positiveInt(args['interval-ms'] ?? process.env.OUTBREAK_REFRESH_INTERVAL_MS, 10 * 60_000),
    hardTimeoutMs,
    jobLockTtlMs: positiveInt(args['job-lock-ttl-ms'] ?? process.env.CHATGPT_REFRESH_JOB_LOCK_TTL_MS, hardTimeoutMs),
    skipScan: flag(args['skip-scan']) || flag(process.env.CHATGPT_REFRESH_SKIP_SCAN),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = buildOptions(args);
  const run = options.legacy ? runOnce : runQueueCycle;
  if (!args.loop) {
    await run(options);
    return;
  }
  while (true) {
    try {
      await run(options);
    } catch (error) {
      console.error('[chatgpt-refresh-worker] run failed:', error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolveLoop) => setTimeout(resolveLoop, options.intervalMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
