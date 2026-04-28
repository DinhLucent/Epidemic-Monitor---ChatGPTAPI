import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_QUEUE_DB_PATH = '.chatgpt-refresh/queue.db';
const DEFAULT_SNAPSHOT_PATH = '.chatgpt-refresh/latest-snapshot.json';
const DEFAULT_SQL_PATH = '.chatgpt-refresh/d1-sync.sql';
const DEFAULT_DATABASE = 'epidemic-monitor';
const DEFAULT_LIMIT = 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outbreak_items (
  id TEXT PRIMARY KEY,
  article_key TEXT,
  content_key TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  source TEXT,
  source_type TEXT NOT NULL DEFAULT 'web',
  country TEXT,
  province TEXT,
  district TEXT,
  disease TEXT,
  alert_level TEXT NOT NULL DEFAULT 'watch',
  cases INTEGER,
  deaths INTEGER,
  published_at INTEGER,
  ingested_at INTEGER NOT NULL,
  confidence REAL,
  status TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbreak_items_published_at
  ON outbreak_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbreak_items_ingested_at
  ON outbreak_items(ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbreak_items_source_type
  ON outbreak_items(source_type);
CREATE INDEX IF NOT EXISTS idx_outbreak_items_hotspot
  ON outbreak_items(source_type, disease, province, published_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbreak_items_article_key
  ON outbreak_items(article_key)
  WHERE article_key IS NOT NULL;
`;

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

function flag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function mkdirForFile(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sqlText(value) {
  if (value == null || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : 'NULL';
}

function sqlInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : 'NULL';
}

function publishedAtFromRow(row) {
  const direct = Number(row.published_at);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = new Date(row.pub_date ?? '').getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeAlert(value) {
  return value === 'alert' || value === 'warning' || value === 'watch' ? value : 'watch';
}

function rowToD1Item(row) {
  const outbreak = parseJson(row.outbreak_json, null);
  const classification = parseJson(row.classification_json, {});
  const extraction = parseJson(row.extraction_json, {});
  const isPublished = row.status === 'PUBLISHED' && outbreak;
  const url = String(row.url ?? outbreak?.url ?? '');
  const publishedAt = Number(outbreak?.publishedAt) || publishedAtFromRow(row);
  const ingestedAt = Number(row.updated_at) || Date.now();

  return {
    id: `chatgpt-${row.id}`,
    articleKey: row.article_key ?? null,
    contentKey: row.content_key ?? null,
    title: String(outbreak?.title ?? row.title ?? '').slice(0, 500),
    summary: String(outbreak?.summary ?? extraction?.summary_vi ?? row.description ?? '').slice(0, 2000),
    url,
    source: String(row.source_name ?? outbreak?.source ?? hostFromUrl(url) ?? 'unknown'),
    sourceType: 'web',
    country: 'Vietnam',
    province: isPublished ? outbreak.province ?? classification.province ?? null : null,
    district: isPublished ? outbreak.district ?? extraction?.district ?? null : null,
    disease: isPublished ? outbreak.disease ?? classification.disease ?? null : null,
    alertLevel: isPublished ? normalizeAlert(outbreak.alertLevel) : 'watch',
    cases: isPublished ? outbreak.cases ?? extraction?.cases ?? null : null,
    deaths: isPublished ? outbreak.deaths ?? extraction?.deaths ?? null : null,
    publishedAt,
    ingestedAt,
    confidence: isPublished ? outbreak.confidence ?? classification.confidence ?? null : classification.confidence ?? null,
    status: row.status,
    rawJson: JSON.stringify({
      source: 'chatgpt-refresh-queue',
      articleId: row.id,
      classification,
      extraction,
      outbreak,
      verify: parseJson(row.verify_json, null),
    }),
  };
}

function snapshotOutbreakToD1Item(outbreak) {
  const url = String(outbreak.url ?? '');
  return {
    id: `snapshot-${String(outbreak.id ?? hostFromUrl(url) ?? Date.now())}`,
    articleKey: url || null,
    contentKey: null,
    title: String(outbreak.title ?? '').slice(0, 500),
    summary: String(outbreak.summary ?? '').slice(0, 2000),
    url,
    source: String(outbreak.source ?? hostFromUrl(url) ?? 'unknown'),
    sourceType: 'web',
    country: 'Vietnam',
    province: outbreak.province ?? null,
    district: outbreak.district ?? null,
    disease: outbreak.disease ?? null,
    alertLevel: normalizeAlert(outbreak.alertLevel),
    cases: outbreak.cases ?? null,
    deaths: outbreak.deaths ?? null,
    publishedAt: Number(outbreak.publishedAt) || Date.now(),
    ingestedAt: Number(outbreak.pipelineUpdatedAt) || Date.now(),
    confidence: outbreak.confidence ?? null,
    status: 'PUBLISHED',
    rawJson: JSON.stringify({ source: 'chatgpt-refresh-snapshot', outbreak }),
  };
}

function loadItemsFromQueue(queueDbPath, limit) {
  if (!existsSync(queueDbPath)) return [];
  const db = new DatabaseSync(queueDbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT *
      FROM articles
      WHERE status IN ('PUBLISHED', 'NEWS_ONLY')
      ORDER BY COALESCE(published_at, updated_at, last_seen_at) DESC
      LIMIT ?
    `).all(limit);
    return rows.map(rowToD1Item).filter((item) => item.title && item.url);
  } finally {
    db.close();
  }
}

function loadItemsFromSnapshot(snapshotPath, limit) {
  const snapshot = readJson(snapshotPath, {});
  const outbreaks = Array.isArray(snapshot?.outbreaks) ? snapshot.outbreaks : [];
  return outbreaks.slice(0, limit).map(snapshotOutbreakToD1Item).filter((item) => item.title && item.url);
}

function buildUpsertSql(items) {
  const rows = items.map((item) => `(
    ${sqlText(item.id)},
    ${sqlText(item.title)},
    ${sqlText(item.summary)},
    ${sqlText(item.url)},
    ${sqlText(item.source)},
    ${sqlText(item.sourceType)},
    ${sqlText(item.country)},
    ${sqlText(item.province)},
    ${sqlText(item.district)},
    ${sqlText(item.disease)},
    ${sqlText(item.alertLevel)},
    ${sqlInteger(item.cases)},
    ${sqlInteger(item.publishedAt)},
    ${sqlInteger(item.ingestedAt)}
  )`).join(',\n');

  if (!rows) return `${SCHEMA_SQL}\n`;

  return `${SCHEMA_SQL}
INSERT INTO outbreak_items (
  id, title, summary, url, source, source_type, country, province, district,
  disease, alert_level, cases, published_at, ingested_at
)
VALUES
${rows}
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  summary = excluded.summary,
  url = excluded.url,
  source = excluded.source,
  source_type = excluded.source_type,
  country = excluded.country,
  province = excluded.province,
  district = excluded.district,
  disease = excluded.disease,
  alert_level = excluded.alert_level,
  cases = excluded.cases,
  published_at = excluded.published_at,
  ingested_at = excluded.ingested_at;
`;
}

function runWranglerD1({ database, sqlPath, remote, local, persistTo }) {
  const command = process.execPath;
  const wranglerBin = resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
  const args = [wranglerBin, 'd1', 'execute', database, '--file', sqlPath, '--yes'];
  if (remote) args.push('--remote');
  if (local) {
    args.push('--local');
    if (persistTo) args.push('--persist-to', persistTo);
  }
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function syncQueueToD1(input = {}) {
  loadEnvLocal();
  const queueDbPath = resolve(process.cwd(), input.queueDbPath ?? DEFAULT_QUEUE_DB_PATH);
  const snapshotPath = resolve(process.cwd(), input.snapshotPath ?? DEFAULT_SNAPSHOT_PATH);
  const sqlPath = resolve(process.cwd(), input.sqlPath ?? DEFAULT_SQL_PATH);
  const limit = positiveInt(input.limit ?? process.env.CHATGPT_D1_SYNC_LIMIT, DEFAULT_LIMIT);
  const database = String(input.database ?? process.env.CHATGPT_D1_DATABASE ?? DEFAULT_DATABASE);
  const remote = input.remote === true;
  const local = input.local === true || (!remote && input.local !== false);
  const dryRun = input.dryRun === true;
  const persistTo = input.persistTo ?? process.env.CHATGPT_D1_PERSIST_TO;

  const queueItems = loadItemsFromQueue(queueDbPath, limit);
  const items = queueItems.length > 0 ? queueItems : loadItemsFromSnapshot(snapshotPath, limit);
  mkdirForFile(sqlPath);
  await writeFile(sqlPath, buildUpsertSql(items), 'utf8');

  const summary = {
    ok: true,
    database,
    target: dryRun ? 'dry-run' : remote ? 'remote' : 'local',
    sqlPath,
    queueDbPath,
    snapshotPath,
    itemCount: items.length,
    publishedCount: items.filter((item) => item.status === 'PUBLISHED').length,
    newsOnlyCount: items.filter((item) => item.status !== 'PUBLISHED').length,
  };

  if (!dryRun) {
    const wrangler = runWranglerD1({ database, sqlPath, remote, local, persistTo });
    summary.wrangler = {
      stdout: wrangler.stdout.trim().slice(-1000),
      stderr: wrangler.stderr.trim().slice(-1000),
    };
  }

  return summary;
}

function buildOptions(args) {
  loadEnvLocal();
  return {
    queueDbPath: resolve(process.cwd(), args['queue-db'] || process.env.CHATGPT_REFRESH_QUEUE_DB_PATH || DEFAULT_QUEUE_DB_PATH),
    snapshotPath: resolve(process.cwd(), args.snapshot || process.env.CHATGPT_REFRESH_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH),
    sqlPath: resolve(process.cwd(), args.sql || process.env.CHATGPT_D1_SYNC_SQL_PATH || DEFAULT_SQL_PATH),
    database: args.database || args['d1-database'] || process.env.CHATGPT_D1_DATABASE || DEFAULT_DATABASE,
    remote: flag(args.remote) || flag(args['d1-remote']),
    local: flag(args.local) || flag(args['d1-local']),
    persistTo: args['persist-to'] || args['d1-persist-to'] || process.env.CHATGPT_D1_PERSIST_TO,
    dryRun: flag(args['dry-run']),
    limit: args.limit || process.env.CHATGPT_D1_SYNC_LIMIT || DEFAULT_LIMIT,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = buildOptions(parseArgs(process.argv.slice(2)));
  syncQueueToD1(options)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
