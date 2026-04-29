import { jsonResponse } from '../../../_shared/cors';
import { getCached, setCached } from '../../../_shared/cache';

const CACHE_KEY = 'pipeline-status';
const CACHE_TTL = 30 * 1000;
const STALE_HEARTBEAT_MS = 15 * 60 * 1000;

function bypassCache(request: Request): boolean {
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh');
  return refresh === '1' || refresh === 'true';
}

interface PipelineRunRow {
  run_id: string;
  mode: string;
  status: string;
  current_stage: string | null;
  worker_id: string | null;
  started_at: number;
  heartbeat_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  article_count: number;
  event_count: number;
  scan_new: number;
  scan_changed: number;
  classified: number;
  positives: number;
  extracted: number;
  verified: number;
  pending_jobs: number;
  running_jobs: number;
  done_jobs: number;
  dead_jobs: number;
  d1_item_count: number;
  d1_published_count: number;
  error: string | null;
  updated_at: number;
}

interface PipelineEventRow {
  event_id: string;
  run_id: string;
  created_at: number;
  stage: string;
  status: string;
  message: string | null;
  meta_json: string | null;
}

function asTimestamp(value: number | string | null | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mapRun(row: PipelineRunRow) {
  return {
    runId: String(row.run_id),
    mode: String(row.mode ?? 'queue'),
    status: String(row.status ?? 'unknown'),
    currentStage: row.current_stage ? String(row.current_stage) : undefined,
    workerId: row.worker_id ? String(row.worker_id) : undefined,
    startedAt: asTimestamp(row.started_at) ?? Date.now(),
    heartbeatAt: asTimestamp(row.heartbeat_at),
    completedAt: asTimestamp(row.completed_at),
    durationMs: Number(row.duration_ms ?? 0) || undefined,
    articleCount: Number(row.article_count ?? 0),
    eventCount: Number(row.event_count ?? 0),
    scanNew: Number(row.scan_new ?? 0),
    scanChanged: Number(row.scan_changed ?? 0),
    classified: Number(row.classified ?? 0),
    positives: Number(row.positives ?? 0),
    extracted: Number(row.extracted ?? 0),
    verified: Number(row.verified ?? 0),
    pendingJobs: Number(row.pending_jobs ?? 0),
    runningJobs: Number(row.running_jobs ?? 0),
    doneJobs: Number(row.done_jobs ?? 0),
    deadJobs: Number(row.dead_jobs ?? 0),
    d1ItemCount: Number(row.d1_item_count ?? 0),
    d1PublishedCount: Number(row.d1_published_count ?? 0),
    error: row.error ? String(row.error) : undefined,
    updatedAt: asTimestamp(row.updated_at) ?? Date.now(),
  };
}

function mapEvent(row: PipelineEventRow) {
  return {
    eventId: String(row.event_id),
    runId: String(row.run_id),
    createdAt: asTimestamp(row.created_at) ?? Date.now(),
    stage: String(row.stage ?? 'unknown'),
    status: String(row.status ?? 'info'),
    message: row.message ? String(row.message) : undefined,
    meta: row.meta_json ? safeParseJson(row.meta_json) : undefined,
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function deriveHealth(latestRun: ReturnType<typeof mapRun> | undefined) {
  if (!latestRun) return { state: 'unknown', reason: 'No pipeline run telemetry has been published yet.' };
  const heartbeatAgeMs = latestRun.heartbeatAt ? Date.now() - latestRun.heartbeatAt : undefined;
  if (heartbeatAgeMs != null && heartbeatAgeMs > STALE_HEARTBEAT_MS) {
    return { state: 'stalled', reason: 'Worker heartbeat is stale.', heartbeatAgeMs };
  }
  if (latestRun.currentStage === 'base-url-wait') {
    return { state: 'waiting', reason: 'ChatGPT2API BASE URL is unavailable; AI jobs are deferred.', heartbeatAgeMs };
  }
  if (latestRun.status === 'failed') {
    return { state: 'failed', reason: latestRun.error ?? 'Last worker run failed.', heartbeatAgeMs };
  }
  if (latestRun.runningJobs > 0 || latestRun.pendingJobs > 0) {
    return { state: 'draining', reason: 'Queue still has work to process.', heartbeatAgeMs };
  }
  return { state: 'healthy', reason: 'Last worker run completed and no active queue backlog was reported.', heartbeatAgeMs };
}

async function fetchPipelineStatus(db: D1Database) {
  const runsResult = await db.prepare(`
    SELECT *
    FROM pipeline_runs
    ORDER BY started_at DESC
    LIMIT 12
  `).all<PipelineRunRow>();

  const runs = (runsResult.results ?? []).map(mapRun);
  const latestRun = runs[0];
  const eventsResult = await db.prepare(`
    SELECT *
    FROM pipeline_run_events
    ORDER BY created_at DESC
    LIMIT 80
  `).all<PipelineEventRow>();
  const events = (eventsResult.results ?? []).map(mapEvent).sort((a, b) => b.createdAt - a.createdAt);
  const latest = latestRun ? {
    run: latestRun,
    events: events.filter((event) => event.runId === latestRun.runId).slice(0, 30),
  } : undefined;

  return {
    health: deriveHealth(latestRun),
    latest,
    recentRuns: runs,
    recentEvents: events,
    fetchedAt: Date.now(),
    staleHeartbeatMs: STALE_HEARTBEAT_MS,
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!bypassCache(context.request)) {
    const cached = getCached<unknown>(CACHE_KEY);
    if (cached) return jsonResponse(cached, 200, 30);
  }

  try {
    const payload = await fetchPipelineStatus(context.env.DB);
    setCached(CACHE_KEY, payload, CACHE_TTL);
    return jsonResponse(payload, 200, 30);
  } catch (err) {
    const payload = {
      health: {
        state: 'unknown',
        reason: err instanceof Error ? err.message : 'Pipeline telemetry is unavailable.',
      },
      latest: undefined,
      recentRuns: [],
      recentEvents: [],
      fetchedAt: Date.now(),
      staleHeartbeatMs: STALE_HEARTBEAT_MS,
    };
    return jsonResponse(payload, 200, 30);
  }
};
