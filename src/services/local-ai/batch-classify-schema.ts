import type { JsonObject } from '@chatgpt-to-sdk/core';

/**
 * JSON Schema for Stage 1 Batch Classification output.
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
                required: ['index', 'classification', 'disease_vn', 'confidence'],
                additionalProperties: false,
                properties: {
                    index: { type: 'number' },
                    classification: {
                        type: 'string',
                        enum: ['OUTBREAK', 'HEALTH_NEWS', 'IRRELEVANT'],
                    },
                    disease_vn: { type: ['string', 'null'] },
                    confidence: { type: 'number' },
                },
            },
        },
    },
};
