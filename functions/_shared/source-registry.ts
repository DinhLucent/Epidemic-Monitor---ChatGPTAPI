export type SourceTier = 'official' | 'official_press' | 'major_press' | 'press' | 'unknown';
export type GeoPrecision = 'district' | 'province' | 'unknown';

export interface SourceProfile {
  label: string;
  hosts: string[];
  tier: SourceTier;
  trustWeight: number;
}

export interface SourceSummary {
  sourceCount: number;
  labels: string[];
  hosts: string[];
  officialConfirmed: boolean;
  maxTrustWeight: number;
  avgTrustWeight: number;
}

export interface ScoreInput {
  articleCount: number;
  casesPerMillion: number;
  daysOld: number;
  alertLevel: 'alert' | 'warning' | 'watch';
  geoPrecision: GeoPrecision;
  sources: SourceSummary;
}

export interface ScoreResult {
  riskScore: number;
  confidence: number;
  riskFactors: string[];
  extractionWarnings: string[];
}

const SOURCE_REGISTRY: SourceProfile[] = [
  { label: 'Bo Y te', hosts: ['moh.gov.vn'], tier: 'official', trustWeight: 1 },
  { label: 'Chinh phu', hosts: ['baochinhphu.vn', 'chinhphu.vn'], tier: 'official', trustWeight: 0.95 },
  { label: 'Suc khoe & Doi song', hosts: ['suckhoedoisong.vn'], tier: 'official_press', trustWeight: 0.9 },
  { label: 'VTV', hosts: ['vtv.vn'], tier: 'major_press', trustWeight: 0.84 },
  { label: 'VOV', hosts: ['vov.vn'], tier: 'major_press', trustWeight: 0.84 },
  { label: 'TTXVN/VietnamPlus', hosts: ['vietnamplus.vn', 'vnanet.vn', 'vna.org.vn'], tier: 'major_press', trustWeight: 0.84 },
  { label: 'VnExpress', hosts: ['vnexpress.net'], tier: 'major_press', trustWeight: 0.82 },
  { label: 'Tuoi Tre', hosts: ['tuoitre.vn'], tier: 'major_press', trustWeight: 0.82 },
  { label: 'Thanh Nien', hosts: ['thanhnien.vn'], tier: 'major_press', trustWeight: 0.8 },
  { label: 'VietnamNet', hosts: ['vietnamnet.vn'], tier: 'major_press', trustWeight: 0.78 },
  { label: 'Dan Tri', hosts: ['dantri.com.vn'], tier: 'major_press', trustWeight: 0.76 },
  { label: 'Nhan Dan', hosts: ['nhandan.vn'], tier: 'major_press', trustWeight: 0.78 },
  { label: 'Phap Luat TP.HCM', hosts: ['plo.vn'], tier: 'press', trustWeight: 0.7 },
  { label: 'Lao Dong', hosts: ['laodong.vn'], tier: 'press', trustWeight: 0.68 },
  { label: 'Tien Phong', hosts: ['tienphong.vn'], tier: 'press', trustWeight: 0.68 },
  { label: 'Nguoi Lao Dong', hosts: ['nld.com.vn'], tier: 'press', trustWeight: 0.66 },
  { label: 'Ha Noi Moi', hosts: ['hanoimoi.vn'], tier: 'press', trustWeight: 0.66 },
  { label: 'Sai Gon Giai Phong', hosts: ['sggp.org.vn'], tier: 'press', trustWeight: 0.66 },
  { label: 'Bao Dong Nai', hosts: ['baodongnai.com.vn'], tier: 'press', trustWeight: 0.62 },
  { label: 'Bao Lam Dong', hosts: ['baolamdong.vn'], tier: 'press', trustWeight: 0.62 },
  { label: 'Bao Khanh Hoa', hosts: ['baokhanhhoa.vn'], tier: 'press', trustWeight: 0.62 },
  { label: 'Bao Can Tho', hosts: ['baocantho.com.vn'], tier: 'press', trustWeight: 0.62 },
  { label: 'Bao Nghe An', hosts: ['baonghean.vn'], tier: 'press', trustWeight: 0.62 },
  { label: 'Bao Thanh Hoa', hosts: ['baothanhhoa.vn'], tier: 'press', trustWeight: 0.62 },
];

const OFFICIAL_HOST_PATTERNS = ['cdc', 'soyte', 'syt'];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function hostFromUrl(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function isOfficialHost(host: string): boolean {
  if (host === 'gov.vn' || host.endsWith('.gov.vn')) return true;
  return OFFICIAL_HOST_PATTERNS.some((part) => host.includes(part));
}

function profileForHost(host: string): SourceProfile {
  const profile = SOURCE_REGISTRY.find((entry) =>
    entry.hosts.some((registeredHost) => host === registeredHost || host.endsWith(`.${registeredHost}`)),
  );
  if (profile) return profile;
  if (isOfficialHost(host)) {
    return { label: host, hosts: [host], tier: 'official', trustWeight: 0.92 };
  }
  return { label: host || 'unknown', hosts: host ? [host] : [], tier: 'unknown', trustWeight: 0.45 };
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function summarizeSources(sourceUrls: string, sourceNames = ''): SourceSummary {
  const urls = uniqueNonEmpty(sourceUrls.split(/[|,]+/));
  const hosts = uniqueNonEmpty(urls.map(hostFromUrl));
  const profiles = hosts.map(profileForHost);
  const fallbackNames = uniqueNonEmpty(sourceNames.split(','));
  const labels = uniqueNonEmpty([
    ...profiles.map((profile) => profile.label),
    ...(profiles.length === 0 ? fallbackNames : []),
  ]);
  const weights = profiles.map((profile) => profile.trustWeight);
  const maxTrustWeight = weights.length > 0 ? Math.max(...weights) : 0.45;
  const avgTrustWeight = weights.length > 0
    ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length
    : 0.45;

  return {
    sourceCount: Math.max(hosts.length, fallbackNames.length, urls.length > 0 ? 1 : 0),
    labels,
    hosts,
    officialConfirmed: profiles.some((profile) => profile.tier === 'official' || profile.tier === 'official_press'),
    maxTrustWeight,
    avgTrustWeight,
  };
}

export function scoreOutbreakEvidence(input: ScoreInput): ScoreResult {
  const articleCount = Math.max(1, input.articleCount);
  const evidenceCount = Math.max(input.sources.sourceCount, articleCount);
  const sourceScore = Math.min(24, evidenceCount * 6);
  const trustScore = Math.round(input.sources.maxTrustWeight * 18);
  const officialBonus = input.sources.officialConfirmed ? 8 : 0;
  const caseScore = input.casesPerMillion >= 50 ? 26
    : input.casesPerMillion >= 10 ? 18
      : input.casesPerMillion >= 1 ? 9
        : 0;
  const recencyScore = input.daysOld <= 1 ? 12 : input.daysOld <= 3 ? 8 : input.daysOld <= 7 ? 5 : 2;
  const geoScore = input.geoPrecision === 'district' ? 6 : input.geoPrecision === 'province' ? 4 : 0;
  const priorScore = input.alertLevel === 'alert' ? 12 : input.alertLevel === 'warning' ? 7 : 3;
  const riskScore = Math.min(100, Math.round(
    sourceScore + trustScore + officialBonus + caseScore + recencyScore + geoScore + priorScore,
  ));

  const confidence = Math.min(0.98, Math.round((
    0.32
    + Math.min(0.22, evidenceCount * 0.05)
    + input.sources.avgTrustWeight * 0.18
    + (input.casesPerMillion > 0 ? 0.12 : 0)
    + (input.geoPrecision !== 'unknown' ? 0.08 : 0)
    + (input.daysOld <= 7 ? 0.08 : 0)
  ) * 100) / 100);

  const riskFactors: string[] = [];
  if (input.sources.sourceCount >= 2) riskFactors.push(`${input.sources.sourceCount} sources`);
  else if (articleCount >= 2) riskFactors.push(`${articleCount} articles`);
  if (input.sources.officialConfirmed) riskFactors.push('official/source-of-record');
  if (input.casesPerMillion >= 10) riskFactors.push(`${Math.round(input.casesPerMillion)}/1M people`);
  if (input.geoPrecision === 'district') riskFactors.push('district-level location');
  if (input.daysOld <= 1) riskFactors.push('fresh report');

  const extractionWarnings: string[] = [];
  if (input.sources.sourceCount <= 1 && articleCount <= 1) extractionWarnings.push('single-source');
  if (input.casesPerMillion <= 0) extractionWarnings.push('no-case-count');
  if (input.geoPrecision === 'unknown') extractionWarnings.push('no-location');
  if (input.sources.maxTrustWeight < 0.5) extractionWarnings.push('unknown-source');

  return { riskScore, confidence, riskFactors, extractionWarnings };
}
