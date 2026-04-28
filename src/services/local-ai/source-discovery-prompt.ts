/**
 * Source Discovery Prompt — ChatGPT suggests additional data sources.
 *
 * Given current outbreak topics and locations being monitored,
 * ChatGPT recommends URLs/sources to check for more data.
 */

export interface SourceDiscoveryContext {
    /** Current diseases being tracked */
    activeDiseases: string[];
    /** Current provinces with outbreaks */
    activeProvinces: string[];
    /** Existing source domains already being crawled */
    existingSources: string[];
}

export function buildSourceDiscoverySystemPrompt(): string {
    return `<role>
You are a Vietnamese public-health data analyst. Your task is to suggest additional online sources
that may contain outbreak reports for diseases and locations currently being monitored.
</role>

<task>
Given the current diseases and provinces being tracked, suggest 3-5 additional Vietnam-only URLs
or RSS feeds from Vietnamese government health agencies, hospitals, or reputable Vietnamese news
outlets that are likely to have relevant outbreak information NOT already covered by the existing sources.
</task>

<source_priorities>
1. OFFICIAL government health portals (Cục Y tế dự phòng, Sở Y tế tỉnh, CDC địa phương)
2. WHO Vietnam / WPRO regional updates only when the content is Vietnam-related
3. Vietnamese medical journals or hospital bulletins
4. Provincial newspapers with health columns
</source_priorities>

<output_contract>
Return exactly one JSON object:
{
  "suggested_sources": [
    {
      "url": string (full URL to check),
      "source_type": "rss" | "web" | "api",
      "reason": string (why this source is relevant),
      "expected_diseases": string[] (diseases likely found here),
      "expected_provinces": string[] (provinces covered),
      "priority": "high" | "medium" | "low"
    }
  ]
}
No markdown. No prose. No code fence.
</output_contract>`;
}

export function buildSourceDiscoveryUserPrompt(context: SourceDiscoveryContext): string {
    return `<monitoring_context>
Active diseases: ${context.activeDiseases.join(', ') || 'None yet'}
Active provinces: ${context.activeProvinces.join(', ') || 'Nationwide'}
Existing sources: ${context.existingSources.join(', ')}
</monitoring_context>

Suggest additional sources. Return the JSON object now.`;
}
