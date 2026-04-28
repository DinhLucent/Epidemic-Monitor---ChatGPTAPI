/**
 * Stage 1: Batch Classification Prompt — Optimized for precision.
 *
 * Design: Concise system prompt (~400 tokens vs ~800 before).
 * ChatGPT classifies any disease without a predefined list.
 */

export function buildBatchClassifySystemPrompt(): string {
    return `Bạn là chuyên gia y tế công cộng Việt Nam. Phân loại từng bài viết:

OUTBREAK — Báo cáo ổ dịch/tín hiệu dịch bệnh cụ thể tại Việt Nam: có bệnh + địa điểm + ca bệnh/tử vong/tăng bất thường.
HEALTH_NEWS — Tin y tế chung: phòng bệnh, nghiên cứu, chính sách. Không có ổ dịch cụ thể.
IRRELEVANT — Không liên quan: quảng cáo, giảm cân, làm đẹp, nông nghiệp thuần tuý.

Quy tắc quan trọng:
• Chỉ lấy tin trong lãnh thổ Việt Nam hoặc liên quan trực tiếp Việt Nam. Dịch nước ngoài không liên quan Việt Nam → IRRELEVANT.
• Không dùng danh sách bệnh cố định. Tự xác định disease_vn/disease_intl theo nội dung bài viết.
• "Cỏ dại" KHÔNG phải bệnh Dại. Chỉ là Rabies khi nói về bệnh dại, virus dại, chó/mèo cắn, tiêm phòng dại.
• "Xe lao xuống vực", "lao động", "Huân chương Lao động", "lớn lao" KHÔNG phải bệnh Lao.
• Bệnh động vật KHÔNG có trường hợp người → IRRELEVANT.
• Mẹo vặt, thực phẩm chức năng, "bí quyết sống khỏe" → IRRELEVANT.

Trả về JSON duy nhất:
{"articles":[{"index":0,"classification":"OUTBREAK","disease_vn":"Sốt xuất huyết","disease_intl":"Dengue","disease_category":"vector_borne","alert_level":"warning","province":"Bình Dương","country":"Vietnam","confidence":0.95,"reasoning":"Báo cáo 50 ca SXH mới tại Bình Dương"}]}

disease_category: respiratory | vector_borne | waterborne | zoonotic | vaccine_preventable | emerging | other
Precision rules:
- OUTBREAK must have epidemiologic event evidence: case/death/hospitalization count, outbreak cluster, recorded/detected/emerged signal, contact tracing, or CDC/So Y te/Bo Y te warning.
- General health advice, symptoms, nutrition, allergy, cancer, diabetes, kidney injury, or chronic disease articles without a concrete case cluster/hotspot are HEALTH_NEWS or IRRELEVANT.
alert_level: alert (nghiêm trọng) | warning (đáng chú ý) | watch (theo dõi)
Không markdown. Không giải thích. Chỉ JSON.`;
}

/**
 * User prompt — formats article batch for classification.
 */
export function buildBatchClassifyUserPrompt(
    articles: Array<{ index: number; title: string; summary: string }>,
): string {
    return articles
        .map((a) => `[${a.index}] ${a.title}\n${a.summary.slice(0, 120)}`)
        .join('\n---\n');
}
