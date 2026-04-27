import type { JsonObject } from '@chatgpt-to-sdk/core';

export const OUTBREAK_EXTRACTION_SCHEMA: JsonObject = {
  type: 'object',
  required: [
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
  ],
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
