import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkExtractor } from './sdk-extraction-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const REQUIRED_KEYS = [
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
];

const LEGACY_63_PROVINCES = [
  'An Giang',
  'Ba Ria - Vung Tau',
  'Bac Giang',
  'Bac Kan',
  'Bac Lieu',
  'Bac Ninh',
  'Ben Tre',
  'Binh Dinh',
  'Binh Duong',
  'Binh Phuoc',
  'Binh Thuan',
  'Ca Mau',
  'Can Tho',
  'Cao Bang',
  'Da Nang',
  'Dak Lak',
  'Dak Nong',
  'Dien Bien',
  'Dong Nai',
  'Dong Thap',
  'Gia Lai',
  'Ha Giang',
  'Ha Nam',
  'Ha Noi',
  'Ha Tinh',
  'Hai Duong',
  'Hai Phong',
  'Hau Giang',
  'Hoa Binh',
  'Hung Yen',
  'Khanh Hoa',
  'Kien Giang',
  'Kon Tum',
  'Lai Chau',
  'Lam Dong',
  'Lang Son',
  'Lao Cai',
  'Long An',
  'Nam Dinh',
  'Nghe An',
  'Ninh Binh',
  'Ninh Thuan',
  'Phu Tho',
  'Phu Yen',
  'Quang Binh',
  'Quang Nam',
  'Quang Ngai',
  'Quang Ninh',
  'Quang Tri',
  'Soc Trang',
  'Son La',
  'Tay Ninh',
  'Thai Binh',
  'Thai Nguyen',
  'Thanh Hoa',
  'Thua Thien Hue',
  'Tien Giang',
  'TP. Ho Chi Minh',
  'Tra Vinh',
  'Tuyen Quang',
  'Vinh Long',
  'Vinh Phuc',
  'Yen Bai',
];

// Vietnam has 34 provincial-level administrative units after the 2025 reform.
// Keep both sets because health news often still mentions legacy names.
const CURRENT_34_PROVINCES = [
  'Ha Noi',
  'Hue',
  'Lai Chau',
  'Dien Bien',
  'Son La',
  'Lang Son',
  'Quang Ninh',
  'Thanh Hoa',
  'Nghe An',
  'Ha Tinh',
  'Cao Bang',
  'Tuyen Quang',
  'Lao Cai',
  'Thai Nguyen',
  'Phu Tho',
  'Bac Ninh',
  'Hung Yen',
  'Hai Phong',
  'Ninh Binh',
  'Quang Tri',
  'Da Nang',
  'Quang Ngai',
  'Gia Lai',
  'Khanh Hoa',
  'Lam Dong',
  'Dak Lak',
  'TP. Ho Chi Minh',
  'Dong Nai',
  'Tay Ninh',
  'Can Tho',
  'Vinh Long',
  'Dong Thap',
  'Ca Mau',
  'An Giang',
];

const DISEASES = [
  'sot xuat huyet Dengue',
  'tay chan mieng',
  'soi',
  'ho ga',
  'tieu chay cap',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function removeDiacritics(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function normalizeName(value) {
  const normalized = removeDiacritics(value)
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\b(thanh pho|tp|tinh)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  if (['hcm', 'tphcm', 'tp hcm', 'ho chi minh', 'sai gon', 'saigon'].includes(normalized)) {
    return 'ho chi minh';
  }
  return normalized;
}

function provinceAliases(province) {
  const normalized = normalizeName(province);
  if (normalized === 'ho chi minh') {
    return new Set(['ho chi minh', 'hcm', 'tp hcm', 'tphcm', 'sai gon', 'saigon']);
  }
  if (normalized === 'hue' || normalized === 'thua thien hue') {
    return new Set([normalized, 'hue', 'thua thien hue']);
  }
  if (normalized === 'ba ria vung tau') {
    return new Set(['ba ria vung tau', 'vung tau']);
  }
  return new Set([normalized]);
}

function isProvinceMatch(expected, actual) {
  if (!actual) return false;
  const actualNormalized = normalizeName(actual);
  return provinceAliases(expected).has(actualNormalized);
}

function makeSample({ suite, province, index }) {
  const cases = 17 + (index % 71);
  const deaths = index % 17 === 0 ? 1 : 0;
  const disease = DISEASES[index % DISEASES.length];
  const deathText = deaths
    ? `ghi nhan ${deaths} truong hop tu vong`
    : 'chua ghi nhan tu vong';

  return {
    id: `${suite}:${province}`,
    suite,
    expected: {
      province,
      cases,
      deaths,
      date: '2026-04-15',
      severity: 'outbreak',
      is_outbreak_news: true,
    },
    article: `Ngay 15/04/2026, Trung tam Kiem soat benh tat ${province} cho biet tren dia ban ${province} ghi nhan ${cases} ca ${disease} trong 14 ngay qua, tang so voi tuan truoc. Co quan y te nhan dinh day la tin o dich can giam sat, ${deathText}. Dia phuong da khoanh vung, xu ly moi truong va truyen thong phong chong dich.`,
  };
}

function buildSamples(scope) {
  const legacy = LEGACY_63_PROVINCES.map((province, index) => makeSample({
    suite: 'legacy63',
    province,
    index,
  }));
  const current = CURRENT_34_PROVINCES.map((province, index) => makeSample({
    suite: 'current34',
    province,
    index,
  }));

  if (scope === 'legacy63') return legacy;
  if (scope === 'current34') return current;
  if (scope === 'both') return [...legacy, ...current];
  throw new Error(`Unknown --set value "${scope}". Use legacy63, current34, or both.`);
}

function evaluateExtraction(sample, data) {
  const issues = [];
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data || {}, key)) {
      issues.push(`missing:${key}`);
    }
  }

  if (!isProvinceMatch(sample.expected.province, data?.province)) {
    issues.push(`province:mismatch expected=${sample.expected.province} actual=${data?.province ?? 'null'}`);
  }
  if (Number(data?.cases) !== sample.expected.cases) {
    issues.push(`cases:mismatch expected=${sample.expected.cases} actual=${data?.cases ?? 'null'}`);
  }
  if (Number(data?.deaths) !== sample.expected.deaths) {
    issues.push(`deaths:mismatch expected=${sample.expected.deaths} actual=${data?.deaths ?? 'null'}`);
  }
  if (data?.date !== sample.expected.date) {
    issues.push(`date:mismatch expected=${sample.expected.date} actual=${data?.date ?? 'null'}`);
  }
  if (data?.severity !== sample.expected.severity) {
    issues.push(`severity:mismatch expected=${sample.expected.severity} actual=${data?.severity ?? 'null'}`);
  }
  if (data?.is_outbreak_news !== sample.expected.is_outbreak_news) {
    issues.push(`is_outbreak_news:mismatch expected=true actual=${data?.is_outbreak_news}`);
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
  return results;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function issueBucket(issue) {
  return String(issue).split(':')[0] || 'unknown';
}

function renderMarkdownReport({ summary, results, config }) {
  const failures = results.filter((result) => !result.ok);
  const lines = [
    '# ChatGPT2API Province Coverage Report',
    '',
    `- Generated: ${new Date(summary.generatedAt).toISOString()}`,
    `- Scope: ${config.scope}`,
    `- Base URL: ${config.baseUrl}`,
    `- Model: ${config.model}`,
    `- Concurrency: ${config.concurrency}`,
    `- Total: ${summary.total}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    '',
    '## By Suite',
    '',
    '| Suite | Total | Passed | Failed |',
    '| --- | ---: | ---: | ---: |',
  ];

  for (const [suite, stats] of Object.entries(summary.bySuite)) {
    lines.push(`| ${suite} | ${stats.total} | ${stats.passed} | ${stats.failed} |`);
  }

  lines.push('', '## Issue Counts', '');
  if (Object.keys(summary.issueCounts).length === 0) {
    lines.push('No issues.');
  } else {
    lines.push('| Issue | Count |', '| --- | ---: |');
    for (const [issue, count] of Object.entries(summary.issueCounts)) {
      lines.push(`| ${issue} | ${count} |`);
    }
  }

  lines.push('', '## Failures', '');
  if (failures.length === 0) {
    lines.push('No failures.');
  } else {
    lines.push('| ID | Extracted Province | Issues |', '| --- | --- | --- |');
    for (const failure of failures) {
      lines.push(`| ${failure.id} | ${failure.data?.province ?? ''} | ${failure.issues.join('<br>')} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function runSample(sample, index, config) {
  try {
    const data = await config.extractor.extract({
      article: sample.article,
      timeoutMs: config.timeoutMs,
      sourceId: sample.id,
      sessionKey: `epidemic-monitor:province-coverage:${sample.id}`,
    });
    const evaluation = evaluateExtraction(sample, data);
    const status = evaluation.ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${index + 1}/${config.total} ${sample.id} -> ${data.province ?? 'null'}`);
    return {
      id: sample.id,
      suite: sample.suite,
      expected: sample.expected,
      data,
      ok: evaluation.ok,
      issues: evaluation.issues,
    };
  } catch (error) {
    console.log(`[ERROR] ${index + 1}/${config.total} ${sample.id}: ${error instanceof Error ? error.message : String(error)}`);
    return {
      id: sample.id,
      suite: sample.suite,
      expected: sample.expected,
      data: null,
      ok: false,
      issues: [`request:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = String(args.set || 'legacy63');
  const baseUrl = args.baseUrl || process.env.CHATGPT2API_BASE_URL || 'http://127.0.0.1:8010';
  const apiKey = args.apiKey || process.env.CHATGPT2API_AUTH_KEY;
  const model = args.model || process.env.CHATGPT2API_MODEL || 'auto';
  const timeoutMs = Number(args.timeout || process.env.CHATGPT2API_TIMEOUT_MS || 120000);
  const concurrency = Number(args.concurrency || process.env.CHATGPT2API_CONCURRENCY || 1);
  const limit = args.limit ? Number(args.limit) : null;

  if (!apiKey) {
    throw new Error('CHATGPT2API_AUTH_KEY is required. The script does not read .env or token files.');
  }

  const allSamples = buildSamples(scope);
  const samples = Number.isFinite(limit) && limit ? allSamples.slice(0, limit) : allSamples;
  const startedAt = Date.now();
  const extractor = createSdkExtractor({ baseUrl, apiKey, model });
  const config = {
    scope,
    baseUrl,
    model,
    timeoutMs,
    concurrency,
    total: samples.length,
    apiKey: '[redacted]',
    extractor,
  };

  let results;
  try {
    results = await mapLimit(samples, concurrency, (sample, index) => runSample(sample, index, config));
  } finally {
    extractor.close();
  }

  const failures = results.filter((result) => !result.ok);
  const bySuite = {};
  for (const suite of Object.keys(countBy(results, (result) => result.suite))) {
    const suiteResults = results.filter((result) => result.suite === suite);
    bySuite[suite] = {
      total: suiteResults.length,
      passed: suiteResults.filter((result) => result.ok).length,
      failed: suiteResults.filter((result) => !result.ok).length,
    };
  }

  const issueCounts = {};
  for (const result of failures) {
    for (const issue of result.issues) {
      const bucket = issueBucket(issue);
      issueCounts[bucket] = (issueCounts[bucket] ?? 0) + 1;
    }
  }

  const summary = {
    generatedAt: startedAt,
    durationMs: Date.now() - startedAt,
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: failures.length,
    bySuite,
    issueCounts,
  };

  const outputDir = path.resolve(repoRoot, 'test-results');
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `chatgpt2api-province-coverage-${stamp}.json`);
  const mdPath = path.join(outputDir, `chatgpt2api-province-coverage-${stamp}.md`);
  const reportConfig = { ...config, extractor: undefined };
  await writeFile(jsonPath, JSON.stringify({ config: reportConfig, summary, results }, null, 2), 'utf8');
  await writeFile(mdPath, renderMarkdownReport({ summary, results, config }), 'utf8');

  console.log('');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report JSON: ${jsonPath}`);
  console.log(`Report MD: ${mdPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
