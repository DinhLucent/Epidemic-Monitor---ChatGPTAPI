import type { OutbreakExtractionResult, OutbreakSeverity } from './outbreak-extraction-types';

const NULL_TEXT = new Set(['', 'null', 'none', 'n/a', 'na', 'khong co', 'khong ro', 'khong de cap']);
const SEVERITIES = new Set<OutbreakSeverity>(['outbreak', 'warning', 'watch']);

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function normalizeKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return removeDiacritics(String(value))
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (NULL_TEXT.has(normalizeKey(text))) return null;
  return text;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value).match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeKey(value);
  return normalized === 'true' || normalized === 'co' || normalized === 'yes';
}

function asSeverity(value: unknown): OutbreakSeverity {
  const normalized = normalizeKey(value);
  return SEVERITIES.has(normalized as OutbreakSeverity) ? normalized as OutbreakSeverity : 'watch';
}

function asDate(value: unknown): string | null {
  const text = asNullableText(value);
  if (!text) return null;
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : text;
}

function cleanDisease(value: unknown): string | null {
  const text = asNullableText(value);
  if (!text) return null;
  return text
    .replace(/^(?:chùm ca|ổ dịch|ca bệnh|bệnh)\s+/i, '')
    .replace(/^nguoc doc/i, 'ngộ độc')
    .trim();
}

function cleanLocation(value: unknown): string | null {
  const text = asNullableText(value);
  if (!text) return null;
  const normalized = normalizeKey(text);
  if (normalized === 'ho chi minh' || normalized === 'thanh pho ho chi minh') return 'TP HCM';
  return text
    .replace(/^(?:TP|thành phố|quận|huyện|phường|xã)\s+/i, '')
    .trim();
}

export function canonicalizeOutbreakExtraction(
  raw: Record<string, unknown>,
): OutbreakExtractionResult {
  return {
    disease_vn: cleanDisease(raw.disease_vn),
    province: cleanLocation(raw.province),
    district: cleanLocation(raw.district),
    ward: cleanLocation(raw.ward),
    cases: asNullableNumber(raw.cases),
    deaths: asNullableNumber(raw.deaths),
    severity: asSeverity(raw.severity),
    date: asDate(raw.date),
    is_outbreak_news: asBoolean(raw.is_outbreak_news),
    summary_vi: asNullableText(raw.summary_vi) ?? '',
  };
}

export function isUsableOutbreakExtraction(result: OutbreakExtractionResult): boolean {
  if (!result.summary_vi) return false;
  if (!SEVERITIES.has(result.severity)) return false;
  if (result.is_outbreak_news) {
    return Boolean(result.disease_vn && (result.province || result.cases !== null));
  }
  return true;
}
