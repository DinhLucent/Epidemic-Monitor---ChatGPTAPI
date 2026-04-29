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
