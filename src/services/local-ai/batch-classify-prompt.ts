export interface BatchClassifyPromptOptions {
    includeAntiPatterns?: boolean;
}

/**
 * System prompt for Stage 1: Batch Classification.
 * Receives an array of article titles + summaries.
 * Returns classification for each: OUTBREAK, HEALTH_NEWS, or IRRELEVANT.
 */
export function buildBatchClassifySystemPrompt(
    options: BatchClassifyPromptOptions = {},
): string {
    const antiPatterns = options.includeAntiPatterns !== false
        ? `\n\n<anti_patterns>
CRITICAL false-positive rules for Vietnamese text:
- "Cỏ dại" (weeds) is NOT "bệnh Dại" (Rabies). Only match Rabies when the article clearly discusses the disease (chó dại, virus dại, tiêm phòng dại).
- "Thuốc dại" (folk medicine) is NOT a disease outbreak.
- "Đại dịch" as a generic term (not naming a specific disease) is IRRELEVANT.
- "Mẹo giảm cân", "bí quyết sống khỏe", "quảng cáo thực phẩm chức năng" → IRRELEVANT.
- Articles about animal diseases only (dịch tả lợn châu Phi, cúm gia cầm) without human cases → IRRELEVANT.
- General health advice with no specific outbreak, location, or case count → HEALTH_NEWS (not OUTBREAK).
</anti_patterns>`
        : '';

    return `<role>
You are a Vietnamese public-health news classifier. You receive a batch of article titles and summaries from Vietnamese health news RSS feeds.
</role>

<task>
For each article, classify it into exactly one category:
- OUTBREAK: Reports a specific disease outbreak, cluster, or confirmed cases at a specific location in Vietnam.
- HEALTH_NEWS: General health news, prevention advice, policy, or medical research. No specific outbreak.
- IRRELEVANT: Not related to infectious disease monitoring (ads, weight loss tips, cosmetics, agriculture-only diseases).
</task>

<output_contract>
Return exactly one JSON object with key "articles" containing an array.
Each element must have:
{
  "index": number (0-based, matching input order),
  "classification": "OUTBREAK" | "HEALTH_NEWS" | "IRRELEVANT",
  "disease_vn": string | null (Vietnamese disease name if OUTBREAK, else null),
  "confidence": number (0.0 to 1.0)
}
No markdown. No prose. No code fence.
</output_contract>${antiPatterns}`;
}

/**
 * User prompt for Stage 1: formats the batch of articles.
 */
export function buildBatchClassifyUserPrompt(
    articles: Array<{ index: number; title: string; summary: string }>,
): string {
    const items = articles
        .map((a) => `[${a.index}] ${a.title}\n    ${a.summary.slice(0, 150)}`)
        .join('\n\n');

    return `<batch>
${items}
</batch>

Classify each article. Return the JSON object now.`;
}
