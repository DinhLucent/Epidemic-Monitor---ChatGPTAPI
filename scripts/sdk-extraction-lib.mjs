import { readFile } from 'node:fs/promises';
import { createChatGPTtoSDK, fileArtifactStore } from '@chatgpt-to-sdk/sdk-ts';
import { sqliteStore } from '@chatgpt-to-sdk/session-sqlite';
import { openAICompatibleProvider } from '@chatgpt-to-sdk/provider-openai-compatible';

export const REQUIRED_KEYS = [
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

export const OUTBREAK_EXTRACTION_SCHEMA = {
  type: 'object',
  required: REQUIRED_KEYS,
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

export const SYSTEM_PROMPT = `<role>
You are a careful JSON extraction engine for Vietnamese public-health news.
</role>

<task>
Extract only outbreak-monitoring fields from one article. Do not provide medical advice.
</task>

<output_contract>
Return exactly one JSON object. No markdown. No prose. No code fence. No reasoning.
The JSON object must contain all keys:
{
  "disease_vn": string | null,
  "province": string | null,
  "district": string | null,
  "ward": string | null,
  "cases": number | null,
  "deaths": number | null,
  "severity": "outbreak" | "warning" | "watch",
  "date": "YYYY-MM-DD" | null,
  "is_outbreak_news": boolean,
  "summary_vi": string
}
</output_contract>

<normalization_rules>
- disease_vn must be a specific disease or syndrome, not generic text such as "bệnh tật", "chùm ca", or "ổ dịch".
- If the article says "chưa ghi nhận tử vong", "không có tử vong", or equivalent, deaths must be 0.
- If a field is absent, use null. Do not write "không có", "N/A", or an empty string.
- For district and ward, remove administrative prefixes like "TP", "quận", "huyện", "phường", "xã" unless the prefix is part of the proper name.
- Use "outbreak" only for an outbreak, strong increase, or explicit outbreak signal. Use "warning" for a specific smaller cluster. Use "watch" for general advice or non-Vietnam/global watch items.
- If the article is general advice with no concrete Vietnam location and no case count, is_outbreak_news must be false.
</normalization_rules>`;

export function parseArgs(argv) {
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

export async function readDataset(datasetPath) {
  const raw = await readFile(datasetPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Dataset ${datasetPath} is empty or invalid.`);
  }
  return parsed;
}

export function stripHtmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchArticleText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 sdk-extraction-eval/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }
  return stripHtmlToText(await response.text());
}

export function createSdkExtractor({
  baseUrl,
  apiKey,
  model,
  stateRoot = '.chatgpt-to-sdk/evals',
  providerId = 'chatgpt2api-local',
}) {
  const store = sqliteStore({ path: `${stateRoot}/state.db` });
  const sdk = createChatGPTtoSDK({
    store,
    artifactStore: fileArtifactStore({ root: `${stateRoot}/artifacts` }),
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
    async extract({ article, timeoutMs, sourceUrl, sourceId, sessionKey }) {
      const result = await sdk.runJson({
        sessionKey: sessionKey ?? `epidemic-monitor:eval:${hashText(sourceId ?? sourceUrl ?? article)}`,
        model,
        timeoutMs,
        provider: {
          strategy: 'fixed',
          preferredProviderId: providerId,
          allow: [providerId],
          profile: 'research',
        },
        input: {
          article,
          sourceUrl,
          sourceId,
        },
        schema: OUTBREAK_EXTRACTION_SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `<article>\n${article.slice(0, 6000)}\n</article>\n\nReturn the JSON object now.`,
          },
        ],
        metadata: {
          caller: 'epidemic-monitor-eval',
          sourceUrl,
          sourceId,
          sdkAdapter: 'chatgpt-to-sdk',
        },
      });

      if (!result.ok) {
        throw new Error(`SDK extraction failed: ${result.error.code}: ${result.error.message}`);
      }

      return result.data;
    },
    close() {
      store.close();
    },
  };
}

export function summarizeExtraction(value) {
  return {
    complete: isCompleteExtraction(value),
    missingKeys: REQUIRED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(value || {}, key)),
    data: value,
  };
}

export function isCompleteExtraction(value) {
  return value && REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
