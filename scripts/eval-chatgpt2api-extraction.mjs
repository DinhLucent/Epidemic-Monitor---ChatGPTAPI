import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSdkExtractor,
  fetchArticleText,
  parseArgs,
  readDataset,
  summarizeExtraction,
} from './sdk-extraction-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl || process.env.CHATGPT2API_BASE_URL || 'http://127.0.0.1:8010';
  const apiKey = args.apiKey || process.env.CHATGPT2API_AUTH_KEY;
  const model = args.model || process.env.CHATGPT2API_MODEL || 'auto';
  const timeoutMs = Number(args.timeout || process.env.CHATGPT2API_TIMEOUT_MS || 120000);

  if (args.url) {
    const article = await fetchArticleText(args.url);
    console.log(`Fetched article text from ${args.url}`);
    console.log(`Chars: ${article.length}`);
    console.log(`Preview: ${article.slice(0, 500)}`);
    if (args['fetch-only']) return;

    if (!apiKey) {
      throw new Error('CHATGPT2API_AUTH_KEY is required. The script does not read .env or token files.');
    }

    const extractor = createSdkExtractor({ baseUrl, apiKey, model });
    try {
      const extracted = await extractor.extract({
        article,
        timeoutMs,
        sourceUrl: args.url,
      });
      console.log(JSON.stringify(summarizeExtraction(extracted), null, 2));
    } finally {
      extractor.close();
    }
    return;
  }

  if (!apiKey) {
    throw new Error('CHATGPT2API_AUTH_KEY is required. The script does not read .env or token files.');
  }

  const datasetPath = path.resolve(repoRoot, args.dataset || 'evals/local-llm/health-extraction-cases.json');
  const limit = args.limit ? Number(args.limit) : null;
  const dataset = await readDataset(datasetPath);
  const samples = Number.isFinite(limit) && limit ? dataset.slice(0, limit) : dataset;
  const extractor = createSdkExtractor({ baseUrl, apiKey, model });

  try {
    let complete = 0;
    for (const sample of samples) {
      const extracted = await extractor.extract({
        article: sample.article,
        timeoutMs,
        sourceId: sample.id,
      });
      const summary = summarizeExtraction(extracted);
      if (summary.complete) complete += 1;
      console.log(`[${summary.complete ? 'COMPLETE' : 'INCOMPLETE'}] ${sample.id}`);
      console.log(JSON.stringify(summary.data, null, 2));
    }

    console.log(`Schema completeness: ${complete}/${samples.length}`);
  } finally {
    extractor.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
