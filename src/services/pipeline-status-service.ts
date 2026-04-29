import type { PipelineStatus } from '@/types/index';
import { apiFetch } from '@/services/api-client';
import { cachedFetch, invalidateCache } from '@/services/fetch-cache';

const CACHE_KEY = 'pipeline-status';
const CACHE_TTL = 30 * 1000;

function emptyPipelineStatus(reason = 'Pipeline status unavailable.'): PipelineStatus {
  return {
    health: {
      state: 'unknown',
      reason,
    },
    recentRuns: [],
    recentEvents: [],
    fetchedAt: Date.now(),
    staleHeartbeatMs: 15 * 60 * 1000,
  };
}

export async function fetchPipelineStatus(options: { graceful?: boolean; refresh?: boolean } = {}): Promise<PipelineStatus> {
  const { graceful = true, refresh = false } = options;
  if (refresh) invalidateCache(CACHE_KEY);

  try {
    return await cachedFetch(
      CACHE_KEY,
      () => apiFetch<PipelineStatus>(
        refresh ? `/api/health/v1/pipeline-status?refresh=1&ts=${Date.now()}` : '/api/health/v1/pipeline-status',
        10_000,
      ),
      CACHE_TTL,
    );
  } catch (err) {
    if (!graceful) throw err;
    return emptyPipelineStatus(err instanceof Error ? err.message : undefined);
  }
}
