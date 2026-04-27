import { createChatGPTtoSDK, fileArtifactStore, type ChatGPTtoSDK } from '@chatgpt-to-sdk/sdk-ts';
import { sqliteStore, type SQLiteSessionStore } from '@chatgpt-to-sdk/session-sqlite';
import { openAICompatibleProvider } from '@chatgpt-to-sdk/provider-openai-compatible';
import { buildOutbreakExtractionSystemPrompt, buildOutbreakExtractionUserPrompt } from './outbreak-extraction-prompt';
import { OUTBREAK_EXTRACTION_SCHEMA } from './outbreak-extraction-schema';
import type { OutbreakExtractionResult } from './outbreak-extraction-types';
import { buildBatchClassifySystemPrompt, buildBatchClassifyUserPrompt } from './batch-classify-prompt';
import { BATCH_CLASSIFY_SCHEMA } from './batch-classify-schema';
import {
  canonicalizeOutbreakExtraction,
  isUsableOutbreakExtraction,
} from './outbreak-extraction-validator';

export interface SdkOutbreakExtractorProfile {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  inputLimit?: number;
  stateRoot?: string;
  sessionKey?: string;
  includeExamples?: boolean;
  providerId?: string;
  experimental?: boolean;
}

export interface BatchClassifyItem {
  index: number;
  title: string;
  summary: string;
}

export interface BatchClassifyResult {
  index: number;
  classification: 'OUTBREAK' | 'HEALTH_NEWS' | 'IRRELEVANT';
  disease_vn: string | null;
  confidence: number;
}

export interface SdkOutbreakExtractor {
  sdk: ChatGPTtoSDK;
  store: SQLiteSessionStore;
  extract(articleText: string, options?: {
    sessionKey?: string;
    sourceUrl?: string;
    sourceId?: string;
  }): Promise<OutbreakExtractionResult | null>;
  classifyBatch(items: BatchClassifyItem[]): Promise<BatchClassifyResult[]>;
  extractBatch(articles: Array<{ text: string; sourceUrl?: string }>): Promise<Array<OutbreakExtractionResult | null>>;
  close(): void;
}

const DEFAULT_STATE_ROOT = '.chatgpt-to-sdk/epidemic-monitor';
const DEFAULT_PROVIDER_ID = 'chatgpt2api-local';
const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_INPUT_LIMIT = 6000;

export function createSdkOutbreakExtractor(
  profile: SdkOutbreakExtractorProfile,
): SdkOutbreakExtractor {
  const providerId = profile.providerId ?? DEFAULT_PROVIDER_ID;
  const stateRoot = profile.stateRoot ?? DEFAULT_STATE_ROOT;
  const store = sqliteStore({
    path: `${stateRoot}/state.db`,
  });
  const sdk = createChatGPTtoSDK({
    store,
    artifactStore: fileArtifactStore({
      root: `${stateRoot}/artifacts`,
    }),
    providers: [
      openAICompatibleProvider({
        id: providerId,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        defaultModel: profile.model ?? DEFAULT_MODEL,
        experimental: profile.experimental ?? true,
        productionReady: false,
      }),
    ],
    defaultProviderId: providerId,
  });

  return {
    sdk,
    store,
    extract: (articleText, options) =>
      extractOutbreakJsonWithSdk(sdk, profile, articleText, options),
    classifyBatch: (items) =>
      classifyBatchWithSdk(sdk, profile, items),
    extractBatch: (articles) =>
      extractBatchWithSdk(sdk, profile, articles),
    close: () => store.close(),
  };
}

export async function extractOutbreakJsonWithSdk(
  sdk: ChatGPTtoSDK,
  profile: SdkOutbreakExtractorProfile,
  articleText: string,
  options: {
    sessionKey?: string;
    sourceUrl?: string;
    sourceId?: string;
  } = {},
): Promise<OutbreakExtractionResult | null> {
  if (articleText.length < 100) return null;

  const article = articleText.slice(0, profile.inputLimit ?? DEFAULT_INPUT_LIMIT);
  const sessionKey = options.sessionKey
    ?? profile.sessionKey
    ?? buildDefaultSessionKey(options.sourceId ?? options.sourceUrl ?? article);
  const result = await sdk.runJson<
    { article: string; sourceUrl?: string; sourceId?: string },
    OutbreakExtractionResult
  >({
    sessionKey,
    model: profile.model ?? DEFAULT_MODEL,
    timeoutMs: profile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    provider: {
      strategy: 'fixed',
      preferredProviderId: profile.providerId ?? DEFAULT_PROVIDER_ID,
      allow: [profile.providerId ?? DEFAULT_PROVIDER_ID],
      profile: 'research',
    },
    input: {
      article,
      sourceUrl: options.sourceUrl,
      sourceId: options.sourceId,
    },
    schema: OUTBREAK_EXTRACTION_SCHEMA,
    messages: [
      {
        role: 'system',
        content: buildOutbreakExtractionSystemPrompt({
          includeExamples: profile.includeExamples ?? false,
        }),
      },
      {
        role: 'user',
        content: buildOutbreakExtractionUserPrompt(article),
      },
    ],
    metadata: {
      caller: 'epidemic-monitor',
      sourceUrl: options.sourceUrl,
      sourceId: options.sourceId,
      sdkAdapter: 'chatgpt-to-sdk',
    },
  });

  if (!result.ok) {
    return null;
  }

  const canonical = canonicalizeOutbreakExtraction(result.data as unknown as Record<string, unknown>);
  return isUsableOutbreakExtraction(canonical) ? canonical : null;
}

function buildDefaultSessionKey(value: string): string {
  return `epidemic-monitor:outbreak-extraction:${hashText(value)}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Stage 1: Batch Classification
// ---------------------------------------------------------------------------

async function classifyBatchWithSdk(
  sdk: ChatGPTtoSDK,
  profile: SdkOutbreakExtractorProfile,
  items: BatchClassifyItem[],
): Promise<BatchClassifyResult[]> {
  if (items.length === 0) return [];

  // Process in chunks of 25 to control token usage
  const CHUNK_SIZE = 25;
  const allResults: BatchClassifyResult[] = [];

  for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + CHUNK_SIZE);
    const sessionKey = `epidemic-monitor:batch-classify:${hashText(
      chunk.map((c) => c.title).join('|'),
    )}`;

    const result = await sdk.runJson<
      { articles: BatchClassifyItem[] },
      { articles: BatchClassifyResult[] }
    >({
      sessionKey,
      model: profile.model ?? DEFAULT_MODEL,
      timeoutMs: profile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      provider: {
        strategy: 'fixed',
        preferredProviderId: profile.providerId ?? DEFAULT_PROVIDER_ID,
        allow: [profile.providerId ?? DEFAULT_PROVIDER_ID],
        profile: 'research',
      },
      input: { articles: chunk },
      schema: BATCH_CLASSIFY_SCHEMA,
      messages: [
        {
          role: 'system',
          content: buildBatchClassifySystemPrompt({ includeAntiPatterns: true }),
        },
        {
          role: 'user',
          content: buildBatchClassifyUserPrompt(chunk),
        },
      ],
      metadata: {
        caller: 'epidemic-monitor',
        stage: 'batch-classify',
        sdkAdapter: 'chatgpt-to-sdk',
      },
    });

    if (result.ok && result.data?.articles) {
      // Re-map indices back to the global offset
      for (const r of result.data.articles) {
        allResults.push({ ...r, index: r.index + offset });
      }
    }
  }

  return allResults;
}

// ---------------------------------------------------------------------------
// Stage 2: Batch Extraction (sequential, reuse existing single-article prompt)
// ---------------------------------------------------------------------------

async function extractBatchWithSdk(
  sdk: ChatGPTtoSDK,
  profile: SdkOutbreakExtractorProfile,
  articles: Array<{ text: string; sourceUrl?: string }>,
): Promise<Array<OutbreakExtractionResult | null>> {
  // Process in batches of 3 (parallel within batch, sequential between)
  const BATCH_SIZE = 3;
  const results: Array<OutbreakExtractionResult | null> = new Array(articles.length).fill(null);

  for (let batch = 0; batch < articles.length; batch += BATCH_SIZE) {
    const batchItems = articles.slice(batch, batch + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batchItems.map((item) =>
        extractOutbreakJsonWithSdk(sdk, profile, item.text, {
          sourceUrl: item.sourceUrl,
        }),
      ),
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      results[batch + j] = r.status === 'fulfilled' ? r.value : null;
    }
  }

  return results;
}
