export type AlertLevel = 'alert' | 'warning' | 'watch';

export interface DiseaseOutbreakItem {
  id: string;
  disease: string;
  country: string;
  countryCode: string;
  alertLevel: AlertLevel;
  title: string;
  summary: string;
  url: string;
  publishedAt: number;
  lat?: number;
  lng?: number;
  cases?: number;
  deaths?: number;
  /** Province/city name (tỉnh/thành phố) */
  province?: string;
  /** District name (quận/huyện) — for sub-city precision */
  district?: string;
  /** Data source name (e.g. VnExpress, WHO-DON) */
  source?: string;
  /** Number of distinct source hosts backing this grouped outbreak item. */
  sourceCount?: number;
  /** Short source labels used for evidence/debug display. */
  sourceLabels?: string[];
  /** True when at least one backing source is official or source-of-record. */
  officialConfirmed?: boolean;
  /** 0-100 evidence score derived from sources, recency, case rate, and location precision. */
  riskScore?: number;
  /** 0-1 confidence score for the extracted structured item. */
  confidence?: number;
  riskFactors?: string[];
  extractionWarnings?: string[];
  geoPrecision?: 'district' | 'province' | 'unknown';
  latestArticlePublishedAt?: number;
  pipelineUpdatedAt?: number;
}

export interface DataFreshness {
  apiFetchedAt: number;
  pipelineUpdatedAt?: number;
  latestArticlePublishedAt?: number;
  sourceCount: number;
  backgroundStatus?: 'idle' | 'running' | 'succeeded' | 'failed';
  refreshStartedAt?: number;
  lastSuccessfulRefreshAt?: number;
  nextRefreshAt?: number;
  lastRefreshDurationMs?: number;
}

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  summary?: string;
  imageUrl?: string;
  category?: string;
}

export interface CountryHealthProfile {
  countryCode: string;
  countryName: string;
  activeOutbreaks: number;
  riskLevel: AlertLevel;
  diseases: string[];
  lastUpdated: number;
}

export interface EpidemicStats {
  totalOutbreaks: number;
  activeAlerts: number;
  countriesAffected: number;
  topDiseases: { disease: string; count: number }[];
  lastUpdated: number;
}

export interface OwidCountryRecord {
  location: string;
  iso_code: string;
  total_cases: number;
  total_deaths: number;
  total_cases_per_million: number;
  total_deaths_per_million: number;
  total_vaccinations_per_hundred: number;
  last_updated_date: string;
}
