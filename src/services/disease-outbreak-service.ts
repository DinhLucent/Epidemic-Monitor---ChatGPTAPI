/**
 * Client service for fetching disease outbreak data from the WHO DON feed proxy.
 * Caches results for 5 minutes to avoid redundant API calls.
 */
import type { DiseaseOutbreakItem } from '@/types/index';
import { apiFetch } from '@/services/api-client';
import { cachedFetch } from '@/services/fetch-cache';

const CACHE_KEY = 'disease-outbreaks';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface FetchDiseaseOutbreaksOptions {
  graceful?: boolean;
}

interface OutbreaksResponse {
  outbreaks: DiseaseOutbreakItem[];
  fetchedAt: number;
}

/**
 * Fetch active disease outbreaks.
 * Returns empty array on error so callers can render gracefully in dev mode.
 */
export async function fetchDiseaseOutbreaks(
  options: FetchDiseaseOutbreaksOptions = {},
): Promise<DiseaseOutbreakItem[]> {
  const { graceful = true } = options;
  try {
    return await cachedFetch(
      CACHE_KEY,
      async () => {
        const res = await apiFetch<OutbreaksResponse>('/api/health/v1/outbreaks');
        return res.outbreaks;
      },
      CACHE_TTL,
    );
  } catch (err) {
    if (!graceful) throw err;
    // Edge functions unavailable in Vite dev mode — return empty gracefully
    return [];
  }
}
