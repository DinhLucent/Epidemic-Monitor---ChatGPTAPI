export type OutbreakSeverity = 'outbreak' | 'warning' | 'watch';

export interface OutbreakExtractionResult {
  disease_vn: string | null;
  province: string | null;
  district: string | null;
  ward: string | null;
  cases: number | null;
  deaths: number | null;
  severity: OutbreakSeverity;
  date: string | null;
  is_outbreak_news: boolean;
  summary_vi: string;
}

export const OUTBREAK_EXTRACTION_FIELDS = [
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
] as const;
