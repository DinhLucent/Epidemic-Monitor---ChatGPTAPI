export interface OutbreakExtractionPromptOptions {
  includeExamples?: boolean;
}

const EXAMPLES_BLOCK = `<examples>
Input: "TP HCM ghi nhận 37 ca sởi tại quận Bình Tân, chưa ghi nhận tử vong."
Output: {"disease_vn":"sởi","province":"TP HCM","district":"Bình Tân","ward":null,"cases":37,"deaths":0,"severity":"outbreak","date":null,"is_outbreak_news":true,"summary_vi":"TP HCM ghi nhận 37 ca sởi tại Bình Tân, chưa có tử vong."}

Input: "Bộ Y tế khuyến cáo người dân phòng cúm mùa, không đề cập ổ dịch hay số ca mới."
Output: {"disease_vn":"cúm mùa","province":null,"district":null,"ward":null,"cases":null,"deaths":null,"severity":"watch","date":null,"is_outbreak_news":false,"summary_vi":"Bài viết là khuyến cáo phòng cúm mùa, không nêu ổ dịch cụ thể."}
</examples>`;

export function buildOutbreakExtractionSystemPrompt(
  options: OutbreakExtractionPromptOptions = {},
): string {
  const examples = options.includeExamples ? `\n\n${EXAMPLES_BLOCK}` : '';

  return `<role>
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
- Do not extract tuberculosis from action/labor phrases: "xe lao xuống vực", "lao động", "Huân chương Lao động", "lớn lao".
- Do not extract rabies from plant/common-language phrases: "cỏ dại", "cây mọc dại", "thuốc dại", or generic "đại dịch".
</normalization_rules>${examples}`;
}

export function buildOutbreakExtractionUserPrompt(articleText: string): string {
  return `<article>
${articleText}
</article>

Return the JSON object now.`;
}

export function buildOutbreakExtractionGeneratePrompt(
  articleText: string,
  options: OutbreakExtractionPromptOptions = {},
): string {
  return `${buildOutbreakExtractionSystemPrompt(options)}

${buildOutbreakExtractionUserPrompt(articleText)}`;
}

export function buildOutbreakExtractionRepairPrompt(rawContent: string): string {
  return `<repair_task>
The previous model output was not valid JSON for the outbreak extraction schema.
Convert it into exactly one valid JSON object using the same schema. No markdown. No explanation.
</repair_task>

<previous_output>
${rawContent}
</previous_output>`;
}
