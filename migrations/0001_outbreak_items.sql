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
