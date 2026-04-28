import type { JsonObject } from '@chatgpt-to-sdk/core';

/**
 * JSON Schema for Stage 1 — optimized to extract more in one pass.
 * Now includes alert_level and province to reduce Stage 2 calls.
 */
export const BATCH_CLASSIFY_SCHEMA: JsonObject = {
    type: 'object',
    required: ['articles'],
    additionalProperties: false,
    properties: {
        articles: {
            type: 'array',
            items: {
                type: 'object',
                required: ['index', 'classification', 'confidence', 'reasoning'],
                additionalProperties: false,
                properties: {
                    index: { type: 'number' },
                    classification: { type: 'string', enum: ['OUTBREAK', 'HEALTH_NEWS', 'IRRELEVANT'] },
                    disease_vn: { type: ['string', 'null'] },
                    disease_intl: { type: ['string', 'null'] },
                    disease_category: { type: ['string', 'null'] },
                    alert_level: { type: ['string', 'null'] },
                    province: { type: ['string', 'null'] },
                    country: { type: ['string', 'null'] },
                    confidence: { type: 'number' },
                    reasoning: { type: 'string' },
                },
            },
        },
    },
};
