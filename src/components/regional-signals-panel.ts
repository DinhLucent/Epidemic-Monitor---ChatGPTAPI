import { Panel } from '@/components/panel-base';
import { h } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { emit } from '@/app/app-context';
import { canonicalProvinceName } from '@/services/province-normalizer';
import type { DiseaseOutbreakItem } from '@/types';
import type { ClimateForecast } from '@/services/climate-service';

interface RegionalSignal {
  province: string;
  reports: number;
  alerts: number;
  cases: number;
  maxRiskScore: number;
  avgConfidence: number;
  sourceCount: number;
  envRisk: number;
  signalScore: number;
  lat?: number;
  lng?: number;
  drivers: string[];
}

function riskLevel(score: number): string {
  if (score >= 70) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function climateRisk(forecast: ClimateForecast | undefined): number {
  if (!forecast) return 0;
  return Math.max(
    forecast.dengueRisk ?? 0,
    forecast.hfmdRisk ?? 0,
    forecast.respiratoryRisk ?? 0,
    forecast.airQualityRisk ?? 0,
  );
}

function buildSignals(
  outbreaks: DiseaseOutbreakItem[],
  forecasts: ClimateForecast[],
): RegionalSignal[] {
  const climateByProvince = new Map<string, ClimateForecast>();
  for (const forecast of forecasts) {
    climateByProvince.set(canonicalProvinceName(forecast.province), forecast);
  }

  const groups = new Map<string, DiseaseOutbreakItem[]>();
  for (const outbreak of outbreaks) {
    const province = canonicalProvinceName(outbreak.province ?? '');
    if (!province) continue;
    const items = groups.get(province) ?? [];
    items.push(outbreak);
    groups.set(province, items);
  }

  const allProvinces = new Set<string>([
    ...Array.from(groups.keys()),
    ...Array.from(climateByProvince.keys()),
  ]);

  const signals: RegionalSignal[] = [];
  for (const province of allProvinces) {
    const items = groups.get(province) ?? [];
    const forecast = climateByProvince.get(province);
    const envRisk = climateRisk(forecast);
    const reports = items.length;
    const alerts = items.filter((item) => item.alertLevel === 'alert').length;
    const cases = items.reduce((sum, item) => sum + (item.cases ?? 0), 0);
    const maxRiskScore = Math.max(0, ...items.map((item) => item.riskScore ?? 0));
    const avgConfidence = items.length > 0
      ? items.reduce((sum, item) => sum + (item.confidence ?? 0.45), 0) / items.length
      : 0;
    const sources = new Set<string>();
    for (const item of items) {
      for (const label of item.sourceLabels ?? []) sources.add(label);
      if (item.source) sources.add(item.source);
    }

    const reportScore = Math.min(40, reports * 6 + alerts * 8);
    const evidenceScore = maxRiskScore * 0.35 + avgConfidence * 20 + Math.min(12, sources.size * 2);
    const environmentScore = envRisk * 28;
    const signalScore = Math.min(100, Math.round(reportScore + evidenceScore + environmentScore));

    const drivers = [
      reports > 0 ? `${reports} tin` : null,
      alerts > 0 ? `${alerts} cụm nhiều tin` : null,
      cases > 0 ? `${cases.toLocaleString('vi-VN')} ca được nêu` : null,
      envRisk >= 0.6 ? 'môi trường rủi ro cao' : envRisk >= 0.3 ? 'môi trường rủi ro vừa' : null,
      sources.size > 1 ? `${sources.size} nguồn` : null,
    ].filter((driver): driver is string => Boolean(driver));

    if (signalScore <= 0) continue;
    signals.push({
      province,
      reports,
      alerts,
      cases,
      maxRiskScore,
      avgConfidence,
      sourceCount: sources.size,
      envRisk,
      signalScore,
      lat: forecast?.lat ?? items[0]?.lat,
      lng: forecast?.lng ?? items[0]?.lng,
      drivers,
    });
  }

  return signals
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, 10);
}

export class RegionalSignalsPanel extends Panel {
  private _outbreaks: DiseaseOutbreakItem[] = [];
  private _forecasts: ClimateForecast[] = [];

  constructor() {
    super({ id: 'regional-signals', title: 'Tín hiệu vùng', showCount: true, defaultRowSpan: 2 });
  }

  updateData(outbreaks: DiseaseOutbreakItem[], forecasts: ClimateForecast[] = []): void {
    this._outbreaks = outbreaks;
    this._forecasts = forecasts;
    this._render();
  }

  private _render(): void {
    const signals = buildSignals(this._outbreaks, this._forecasts);
    this.setCount(signals.length);

    if (signals.length === 0) {
      this.setContentNode(h('p', { className: 'regional-empty' }, 'Chưa có tín hiệu vùng.'));
      return;
    }

    const rows = signals.map((signal) => {
      const level = riskLevel(signal.signalScore);
      const row = h('button', {
        className: `regional-row regional-row--${level}`,
        type: 'button',
        title: signal.drivers.join(' | '),
      },
        h('span', { className: 'regional-score' }, String(signal.signalScore)),
        h('span', { className: 'regional-main' },
          h('span', { className: 'regional-province' }, escapeHtml(signal.province)),
          h('span', { className: 'regional-meta' },
            `${signal.reports} tin · MT ${pct(signal.envRisk)} · tin cậy ${pct(signal.avgConfidence)}`,
          ),
        ),
        h('span', { className: 'regional-sources' }, signal.sourceCount ? `${signal.sourceCount} nguồn` : 'MT'),
      );
      row.addEventListener('click', () => {
        if (signal.lat != null && signal.lng != null) {
          emit('province-selected', { lat: signal.lat, lng: signal.lng, province: signal.province });
        }
      });
      return row;
    });

    this.setContentNode(h('div', { className: 'regional-list' }, ...rows));
  }
}
