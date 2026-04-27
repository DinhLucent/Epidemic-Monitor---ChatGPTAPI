/**
 * Climate Predictive Alerts endpoint — Cloudflare Pages Function.
 * Fetches 14-day weather forecast + 5-day air quality forecast from Open-Meteo
 * for Vietnam's 34 current province-level units. Cache TTL: 6 hours.
 * No D1 needed — external API only.
 */
import { jsonResponse, errorResponse } from '../../../_shared/cors';
import { getCached, setCached } from '../../../_shared/cache';
import { VIETNAM_PROVINCES_2025, type VietnamProvince } from '../../../_shared/vietnam-provinces';

const CACHE_KEY = 'climate-forecasts';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const PROVINCES: VietnamProvince[] = VIETNAM_PROVINCES_2025;

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  relative_humidity_2m_mean: number[];
}

interface OpenMeteoResponse { daily: OpenMeteoDaily; }

interface OpenMeteoAirQualityHourly {
  time: string[];
  pm2_5?: number[];
  pm10?: number[];
  ozone?: number[];
  nitrogen_dioxide?: number[];
}

interface OpenMeteoAirQualityResponse { hourly: OpenMeteoAirQualityHourly; }

async function fetchWeather(lat: number, lng: number): Promise<OpenMeteoResponse> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean` +
    `&forecast_days=14&timezone=Asia%2FBangkok`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${lat},${lng}`);
  return res.json() as Promise<OpenMeteoResponse>;
}

async function fetchAirQuality(lat: number, lng: number): Promise<OpenMeteoAirQualityResponse> {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${lat}&longitude=${lng}` +
    `&hourly=pm2_5,pm10,ozone,nitrogen_dioxide` +
    `&forecast_days=5&timezone=Asia%2FBangkok`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo AQ ${res.status} for ${lat},${lng}`);
  return res.json() as Promise<OpenMeteoAirQualityResponse>;
}

type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH';
function riskLevel(score: number): RiskLevel {
  if (score >= 0.6) return 'HIGH';
  if (score >= 0.3) return 'MODERATE';
  return 'LOW';
}

function dengueScore(tempMax: number, rainfall: number, humidity: number): number {
  const tempFactor = tempMax >= 25 && tempMax <= 35 ? 1.0
    : tempMax > 35 ? 0.7 : tempMax >= 20 ? 0.3 : 0.1;
  const rainFactor  = rainfall > 20 ? 1.0 : rainfall > 5 ? 0.7 : rainfall > 0 ? 0.3 : 0.05;
  const humidFactor = humidity > 80 ? 1.0 : humidity > 70 ? 0.7 : humidity > 60 ? 0.4 : 0.1;
  return Math.min(1, tempFactor * 0.4 + rainFactor * 0.35 + humidFactor * 0.25);
}

function hfmdScore(tempMax: number, humidity: number): number {
  const tempFactor  = tempMax > 28 ? 1.0 : tempMax > 24 ? 0.5 : 0.2;
  const humidFactor = humidity > 80 ? 1.0 : humidity > 70 ? 0.6 : humidity > 60 ? 0.3 : 0.1;
  return Math.min(1, tempFactor * 0.5 + humidFactor * 0.5);
}

function avg(values: Array<number | null | undefined>): number | undefined {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (valid.length === 0) return undefined;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function pollutantScore(value: number | undefined, moderate: number, high: number): number {
  if (value == null) return 0;
  if (value >= high) return 1;
  if (value >= moderate) return 0.6;
  return value > 0 ? 0.2 : 0;
}

function airQualityScore(pm25?: number, pm10?: number, ozone?: number, no2?: number): number {
  return Math.max(
    pollutantScore(pm25, 15, 35),
    pollutantScore(pm10, 45, 100),
    pollutantScore(ozone, 100, 180),
    pollutantScore(no2, 25, 100),
  );
}

function respiratoryScore(airScore: number, tempMax: number, humidity: number): number {
  const humidFactor = humidity >= 85 ? 0.8 : humidity >= 75 ? 0.55 : humidity >= 65 ? 0.35 : 0.15;
  const heatFactor = tempMax >= 35 ? 0.55 : tempMax >= 30 ? 0.35 : 0.15;
  return Math.min(1, airScore * 0.65 + humidFactor * 0.2 + heatFactor * 0.15);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ClimateForecast {
  province: string; lat: number; lng: number;
  dengueRisk: number; hfmdRisk: number;
  dengueLevel: RiskLevel; hfmdLevel: RiskLevel;
  airQualityRisk: number; airQualityLevel: RiskLevel;
  respiratoryRisk: number; respiratoryLevel: RiskLevel;
  tempMax: number; tempMin: number; rainfall: number; humidity: number;
  pm25?: number; pm10?: number; ozone?: number; nitrogenDioxide?: number;
  forecastDays: number; peakRiskDay: string;
}

function buildForecast(
  province: VietnamProvince,
  data: OpenMeteoDaily,
  airData?: OpenMeteoAirQualityHourly,
): ClimateForecast {
  const { time, temperature_2m_max, temperature_2m_min, precipitation_sum, relative_humidity_2m_mean } = data;

  const tempMax  = parseFloat((avg(temperature_2m_max) ?? 0).toFixed(1));
  const tempMin  = parseFloat((avg(temperature_2m_min) ?? 0).toFixed(1));
  const rainfall = parseFloat((avg(precipitation_sum) ?? 0).toFixed(1));
  const humidity = parseFloat((avg(relative_humidity_2m_mean) ?? 0).toFixed(1));
  const pm25 = avg(airData?.pm2_5 ?? []);
  const pm10 = avg(airData?.pm10 ?? []);
  const ozone = avg(airData?.ozone ?? []);
  const nitrogenDioxide = avg(airData?.nitrogen_dioxide ?? []);
  const airQualityRisk = parseFloat(airQualityScore(pm25, pm10, ozone, nitrogenDioxide).toFixed(2));
  const respiratoryRisk = parseFloat(respiratoryScore(airQualityRisk, tempMax, humidity).toFixed(2));
  const dengueRisk = parseFloat(dengueScore(tempMax, rainfall, humidity).toFixed(2));
  const hfmdRisk = parseFloat(hfmdScore(tempMax, humidity).toFixed(2));

  let peakScore = -1;
  let peakRiskDay = time[0] ?? '';
  for (let i = 0; i < time.length; i++) {
    const dayScore = dengueScore(
      temperature_2m_max[i] ?? 0,
      precipitation_sum[i] ?? 0,
      relative_humidity_2m_mean[i] ?? 0,
    );
    if (dayScore > peakScore) { peakScore = dayScore; peakRiskDay = time[i] ?? ''; }
  }

  return {
    province: province.name, lat: province.lat, lng: province.lng,
    dengueRisk,
    hfmdRisk,
    dengueLevel: riskLevel(dengueRisk),
    hfmdLevel: riskLevel(hfmdRisk),
    airQualityRisk,
    airQualityLevel: riskLevel(airQualityRisk),
    respiratoryRisk,
    respiratoryLevel: riskLevel(respiratoryRisk),
    tempMax, tempMin, rainfall, humidity,
    pm25: pm25 == null ? undefined : parseFloat(pm25.toFixed(1)),
    pm10: pm10 == null ? undefined : parseFloat(pm10.toFixed(1)),
    ozone: ozone == null ? undefined : parseFloat(ozone.toFixed(1)),
    nitrogenDioxide: nitrogenDioxide == null ? undefined : parseFloat(nitrogenDioxide.toFixed(1)),
    forecastDays: time.length, peakRiskDay,
  };
}

export const onRequestGet: PagesFunction<Env> = async (_context) => {
  const cached = getCached<{ forecasts: ClimateForecast[]; fetchedAt: number }>(CACHE_KEY);
  if (cached) return jsonResponse(cached, 200, 21600);

  const results = await mapLimit(PROVINCES, 4, async (p) => {
    const [weather, airQuality] = await Promise.allSettled([
      fetchWeather(p.lat, p.lng),
      fetchAirQuality(p.lat, p.lng),
    ]);
    if (weather.status !== 'fulfilled') throw weather.reason;
    return buildForecast(p, weather.value.daily, airQuality.status === 'fulfilled' ? airQuality.value.hourly : undefined);
  });

  const forecasts: ClimateForecast[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      try { forecasts.push(result.value); } catch { /* skip */ }
    }
  }

  if (forecasts.length === 0) return errorResponse('All province weather fetches failed', 502);

  const payload = { forecasts, fetchedAt: Date.now() };
  setCached(CACHE_KEY, payload, CACHE_TTL);
  return jsonResponse(payload, 200, 21600);
};
