import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_QUEUE_DB_PATH = '.chatgpt-refresh/queue.db';
const DEFAULT_SNAPSHOT_PATH = '.chatgpt-refresh/latest-snapshot.json';
const DEFAULT_SQL_PATH = '.chatgpt-refresh/d1-sync.sql';
const DEFAULT_TELEMETRY_SQL_PATH = '.chatgpt-refresh/d1-telemetry-sync.sql';
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

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'queue',
  status TEXT NOT NULL DEFAULT 'running',
  current_stage TEXT,
  worker_id TEXT,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  article_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  scan_new INTEGER NOT NULL DEFAULT 0,
  scan_changed INTEGER NOT NULL DEFAULT 0,
  classified INTEGER NOT NULL DEFAULT 0,
  positives INTEGER NOT NULL DEFAULT 0,
  extracted INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  pending_jobs INTEGER NOT NULL DEFAULT 0,
  running_jobs INTEGER NOT NULL DEFAULT 0,
  done_jobs INTEGER NOT NULL DEFAULT 0,
  dead_jobs INTEGER NOT NULL DEFAULT 0,
  d1_item_count INTEGER NOT NULL DEFAULT 0,
  d1_published_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON pipeline_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
  ON pipeline_runs(status, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_events_run_id
  ON pipeline_run_events(run_id, created_at);
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

function safeJson(value, limit = 8000) {
  try {
    return JSON.stringify(value ?? null).slice(0, limit);
  } catch {
    return null;
  }
}

function tableExists(db, tableName) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return Boolean(row);
  } catch {
    return false;
  }
}

function tableColumns(db, tableName) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function jobCounts(db) {
  const counts = { pending: 0, running: 0, done: 0, dead: 0 };
  if (!tableExists(db, 'jobs')) return counts;
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all()) {
    const status = String(row.status ?? '').toUpperCase();
    const count = Number(row.count ?? 0);
    if (status === 'PENDING') counts.pending += count;
    else if (status === 'RUNNING') counts.running += count;
    else if (status === 'DONE') counts.done += count;
    else if (status === 'DEAD_LETTER') counts.dead += count;
  }
  return counts;
}

function parseMetricsJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function loadPipelineTelemetry(queueDbPath, { runLimit = 30, eventLimit = 200 } = {}) {
  if (!existsSync(queueDbPath)) return { runs: [], events: [] };
  const db = new DatabaseSync(queueDbPath, { readOnly: true });
  try {
    if (!tableExists(db, 'worker_runs')) return { runs: [], events: [] };
    const counts = jobCounts(db);
    const eventCounts = tableExists(db, 'pipeline_run_events')
      ? new Map(db.prepare('SELECT run_id, COUNT(*) AS count FROM pipeline_run_events GROUP BY run_id').all()
        .map((row) => [String(row.run_id), Number(row.count ?? 0)]))
      : new Map();
    const articleCount = tableExists(db, 'articles')
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count ?? 0)
      : 0;

    const workerRunColumns = tableColumns(db, 'worker_runs');
    const currentStageSelect = workerRunColumns.has('current_stage') ? 'current_stage' : 'NULL AS current_stage';
    const heartbeatAtSelect = workerRunColumns.has('heartbeat_at') ? 'heartbeat_at' : 'NULL AS heartbeat_at';
    const workerIdSelect = workerRunColumns.has('worker_id') ? 'worker_id' : 'NULL AS worker_id';
    const runRows = db.prepare(`
      SELECT id, started_at, completed_at, mode, metrics_json, error,
        ${currentStageSelect}, ${heartbeatAtSelect}, ${workerIdSelect}
      FROM worker_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(runLimit);

    const runs = runRows.map((row) => {
      const metrics = parseMetricsJson(row.metrics_json);
      const d1Sync = metrics.d1Sync ?? {};
      const completedAt = Number(row.completed_at ?? 0) || undefined;
      const startedAt = Number(row.started_at ?? 0) || Date.now();
      return {
        runId: `queue-${row.id}`,
        mode: String(row.mode ?? 'queue'),
        status: row.error ? 'failed' : completedAt ? 'succeeded' : 'running',
        currentStage: String(row.current_stage ?? (row.error ? 'failed' : completedAt ? 'idle' : 'running')),
        workerId: row.worker_id ? String(row.worker_id) : undefined,
        startedAt,
        heartbeatAt: Number(row.heartbeat_at ?? completedAt ?? startedAt) || startedAt,
        completedAt,
        durationMs: completedAt ? completedAt - startedAt : undefined,
        articleCount: Number(metrics.articleCount ?? articleCount),
        eventCount: Number(eventCounts.get(String(row.id)) ?? 0),
        scanNew: Number(metrics.sourceScan?.newArticles ?? 0),
        scanChanged: Number(metrics.sourceScan?.changedArticles ?? 0),
        classified: Number(metrics.classify?.processed ?? 0),
        positives: Number(metrics.classify?.positives ?? 0),
        extracted: Number(metrics.extract?.claimed ?? 0),
        verified: Number(metrics.verify?.claimed ?? 0),
        pendingJobs: counts.pending,
        runningJobs: counts.running,
        doneJobs: counts.done,
        deadJobs: counts.dead,
        d1ItemCount: Number(d1Sync.itemCount ?? 0),
        d1PublishedCount: Number(d1Sync.publishedCount ?? 0),
        error: row.error ? String(row.error).slice(0, 1000) : undefined,
        updatedAt: Number(row.heartbeat_at ?? completedAt ?? startedAt) || Date.now(),
      };
    });

    const eventRows = tableExists(db, 'pipeline_run_events')
      ? db.prepare(`
          SELECT id, run_id, created_at, stage, status, message, meta_json
          FROM pipeline_run_events
          ORDER BY id DESC
          LIMIT ?
        `).all(eventLimit)
      : [];
    const events = eventRows.map((row) => ({
      eventId: `queue-${row.run_id}-${row.id}`,
      runId: `queue-${row.run_id}`,
      createdAt: Number(row.created_at ?? Date.now()),
      stage: String(row.stage ?? 'unknown'),
      status: String(row.status ?? 'info'),
      message: row.message ? String(row.message).slice(0, 500) : undefined,
      metaJson: row.meta_json ? String(row.meta_json).slice(0, 8000) : undefined,
    })).reverse();

    return { runs, events };
  } finally {
    db.close();
  }
}

const UPSERT_COLUMNS = `(
  id, article_key, content_key, title, summary, url, source, source_type,
  country, province, district, disease, alert_level, cases, deaths,
  published_at, ingested_at, confidence, status, raw_json
)`;

const UPSERT_UPDATE = `ON CONFLICT(id) DO UPDATE SET
  article_key = excluded.article_key,
  content_key = excluded.content_key,
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
  deaths = excluded.deaths,
  published_at = excluded.published_at,
  ingested_at = excluded.ingested_at,
  confidence = excluded.confidence,
  status = excluded.status,
  raw_json = excluded.raw_json;`;

function upsertRowSql(item) {
  return `(
    ${sqlText(item.id)},
    ${sqlText(item.articleKey)},
    ${sqlText(item.contentKey)},
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
    ${sqlInteger(item.deaths)},
    ${sqlInteger(item.publishedAt)},
    ${sqlInteger(item.ingestedAt)},
    ${sqlNumber(item.confidence)},
    ${sqlText(item.status)},
    ${sqlText(item.rawJson)}
  )`;
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildUpsertSql(items) {
  if (!items.length) return `${SCHEMA_SQL}\n`;

  const statements = chunkItems(items, 50).map((batch) => `INSERT INTO outbreak_items ${UPSERT_COLUMNS}
VALUES
${batch.map(upsertRowSql).join(',\n')}
${UPSERT_UPDATE}`);

  return `${SCHEMA_SQL}\n${statements.join('\n\n')}\n`;
}

function pipelineRunRowSql(run) {
  return `(
    ${sqlText(run.runId)},
    ${sqlText(run.mode)},
    ${sqlText(run.status)},
    ${sqlText(run.currentStage)},
    ${sqlText(run.workerId)},
    ${sqlInteger(run.startedAt)},
    ${sqlInteger(run.heartbeatAt)},
    ${sqlInteger(run.completedAt)},
    ${sqlInteger(run.durationMs)},
    ${sqlInteger(run.articleCount)},
    ${sqlInteger(run.eventCount)},
    ${sqlInteger(run.scanNew)},
    ${sqlInteger(run.scanChanged)},
    ${sqlInteger(run.classified)},
    ${sqlInteger(run.positives)},
    ${sqlInteger(run.extracted)},
    ${sqlInteger(run.verified)},
    ${sqlInteger(run.pendingJobs)},
    ${sqlInteger(run.runningJobs)},
    ${sqlInteger(run.doneJobs)},
    ${sqlInteger(run.deadJobs)},
    ${sqlInteger(run.d1ItemCount)},
    ${sqlInteger(run.d1PublishedCount)},
    ${sqlText(run.error)},
    ${sqlInteger(run.updatedAt)}
  )`;
}

function pipelineEventRowSql(event) {
  return `(
    ${sqlText(event.eventId)},
    ${sqlText(event.runId)},
    ${sqlInteger(event.createdAt)},
    ${sqlText(event.stage)},
    ${sqlText(event.status)},
    ${sqlText(event.message)},
    ${sqlText(event.metaJson)}
  )`;
}

function buildPipelineTelemetrySql(telemetry) {
  const statements = [];
  if (telemetry.runs.length > 0) {
    statements.push(...chunkItems(telemetry.runs, 50).map((batch) => `INSERT INTO pipeline_runs (
  run_id, mode, status, current_stage, worker_id, started_at, heartbeat_at,
  completed_at, duration_ms, article_count, event_count, scan_new, scan_changed,
  classified, positives, extracted, verified, pending_jobs, running_jobs,
  done_jobs, dead_jobs, d1_item_count, d1_published_count, error, updated_at
)
VALUES
${batch.map(pipelineRunRowSql).join(',\n')}
ON CONFLICT(run_id) DO UPDATE SET
  mode = excluded.mode,
  status = excluded.status,
  current_stage = excluded.current_stage,
  worker_id = excluded.worker_id,
  heartbeat_at = excluded.heartbeat_at,
  completed_at = excluded.completed_at,
  duration_ms = excluded.duration_ms,
  article_count = excluded.article_count,
  event_count = excluded.event_count,
  scan_new = excluded.scan_new,
  scan_changed = excluded.scan_changed,
  classified = excluded.classified,
  positives = excluded.positives,
  extracted = excluded.extracted,
  verified = excluded.verified,
  pending_jobs = excluded.pending_jobs,
  running_jobs = excluded.running_jobs,
  done_jobs = excluded.done_jobs,
  dead_jobs = excluded.dead_jobs,
  d1_item_count = excluded.d1_item_count,
  d1_published_count = excluded.d1_published_count,
  error = excluded.error,
  updated_at = excluded.updated_at;`));
  }

  if (telemetry.events.length > 0) {
    statements.push(...chunkItems(telemetry.events, 50).map((batch) => `INSERT INTO pipeline_run_events (
  event_id, run_id, created_at, stage, status, message, meta_json
)
VALUES
${batch.map(pipelineEventRowSql).join(',\n')}
ON CONFLICT(event_id) DO UPDATE SET
  run_id = excluded.run_id,
  created_at = excluded.created_at,
  stage = excluded.stage,
  status = excluded.status,
  message = excluded.message,
  meta_json = excluded.meta_json;`));
  }

  return statements.join('\n\n');
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
  const telemetry = loadPipelineTelemetry(queueDbPath, {
    runLimit: input.runLimit ?? 30,
    eventLimit: input.eventLimit ?? 200,
  });
  mkdirForFile(sqlPath);
  const telemetrySql = buildPipelineTelemetrySql(telemetry);
  await writeFile(sqlPath, `${buildUpsertSql(items)}${telemetrySql ? `\n${telemetrySql}\n` : ''}`, 'utf8');

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
    telemetryRunCount: telemetry.runs.length,
    telemetryEventCount: telemetry.events.length,
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

export async function syncPipelineTelemetryToD1(input = {}) {
  loadEnvLocal();
  const queueDbPath = resolve(process.cwd(), input.queueDbPath ?? DEFAULT_QUEUE_DB_PATH);
  const sqlPath = resolve(process.cwd(), input.sqlPath ?? DEFAULT_TELEMETRY_SQL_PATH);
  const database = String(input.database ?? process.env.CHATGPT_D1_DATABASE ?? DEFAULT_DATABASE);
  const remote = input.remote === true;
  const local = input.local === true || (!remote && input.local !== false);
  const dryRun = input.dryRun === true;
  const persistTo = input.persistTo ?? process.env.CHATGPT_D1_PERSIST_TO;
  const telemetry = loadPipelineTelemetry(queueDbPath, {
    runLimit: input.runLimit ?? 10,
    eventLimit: input.eventLimit ?? 100,
  });
  mkdirForFile(sqlPath);
  const telemetrySql = buildPipelineTelemetrySql(telemetry);
  await writeFile(sqlPath, `${SCHEMA_SQL}\n${telemetrySql ? `${telemetrySql}\n` : ''}`, 'utf8');

  const summary = {
    ok: true,
    database,
    target: dryRun ? 'dry-run' : remote ? 'remote' : 'local',
    sqlPath,
    queueDbPath,
    telemetryRunCount: telemetry.runs.length,
    telemetryEventCount: telemetry.events.length,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
