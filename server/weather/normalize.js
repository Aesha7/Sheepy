// Normalized weather schema shared by every provider (live Open-Meteo and offline scenarios).
//
// {
//   schemaVersion: 2,
//   provider: 'open-meteo' | 'scenario',
//   simulated, scenario,                    // scenario name for offline data, else null
//   status: 'fresh' | 'stale' | 'unavailable' | 'simulated',
//   location: { label, lat, lon, gridLat, gridLon, elevation },
//   timezone, fetchedAt, validFrom, validUntil,   // epoch ms
//   units: { ... },                         // explicit units for every numeric field
//   thresholds: { strongWindSpeed, strongWindGust, unit, note },
//   current: Conditions | null,             // model estimate for outdoors, never a bedroom measurement
//   hourly: Conditions[],                   // one entry per hour, `time` = start of the hour
//   sun: { 'YYYY-MM-DD': { sunrise, sunset } },
//   attribution, error
// }
// Conditions: { time, weatherCode, category, condition, label, precipProbability, rain, showers,
//               windSpeed, windGusts, cloudCover, windRatio, strongWind }
// Missing values stay null ("unknown"), never 0.

import { localDate } from '../time.js';

export const SCHEMA_VERSION = 2;
export const CATEGORIES = ['clear', 'cloudy', 'rain', 'snow', 'fog', 'thunderstorm', 'unknown'];
export const ATTRIBUTION = {
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

// Engineering choice, not a provider value: roughly Beaufort 6 ("strong breeze") sustained, or gusty.
export const DEFAULT_WIND_THRESHOLDS = { strongWindSpeed: 40, strongWindGust: 60, unit: 'km/h' };

// WMO weather interpretation codes as documented at https://open-meteo.com/en/docs
const WMO = {
  0: ['clear', 'clear', 'Clear sky'],
  1: ['clear', 'clear', 'Mainly clear'],
  2: ['cloudy', 'partly_cloudy', 'Partly cloudy'],
  3: ['cloudy', 'cloudy', 'Overcast'],
  45: ['fog', 'fog', 'Fog'],
  48: ['fog', 'fog', 'Depositing rime fog'],
  51: ['rain', 'drizzle', 'Light drizzle'],
  53: ['rain', 'drizzle', 'Moderate drizzle'],
  55: ['rain', 'drizzle', 'Dense drizzle'],
  56: ['rain', 'drizzle', 'Light freezing drizzle'],
  57: ['rain', 'drizzle', 'Dense freezing drizzle'],
  61: ['rain', 'rain', 'Slight rain'],
  63: ['rain', 'rain', 'Moderate rain'],
  65: ['rain', 'rain', 'Heavy rain'],
  66: ['rain', 'rain', 'Light freezing rain'],
  67: ['rain', 'rain', 'Heavy freezing rain'],
  71: ['snow', 'snow', 'Slight snowfall'],
  73: ['snow', 'snow', 'Moderate snowfall'],
  75: ['snow', 'snow', 'Heavy snowfall'],
  77: ['snow', 'snow', 'Snow grains'],
  80: ['rain', 'rain', 'Slight rain showers'],
  81: ['rain', 'rain', 'Moderate rain showers'],
  82: ['rain', 'rain', 'Violent rain showers'],
  85: ['snow', 'snow', 'Slight snow showers'],
  86: ['snow', 'snow', 'Heavy snow showers'],
  95: ['thunderstorm', 'thunderstorm', 'Thunderstorm'],
  96: ['thunderstorm', 'thunderstorm', 'Thunderstorm with slight hail'],
  97: ['thunderstorm', 'thunderstorm', 'Heavy thunderstorm'],
  99: ['thunderstorm', 'thunderstorm', 'Thunderstorm with heavy hail'],
};

export function describeWmo(code) {
  const hit = Number.isInteger(code) ? WMO[code] : undefined;
  if (!hit) return { category: 'unknown', condition: null, label: code == null ? 'Unknown' : `Unknown code ${code}` };
  return { category: hit[0], condition: hit[1], label: hit[2] };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const TO_KMH = { 'km/h': 1, kmh: 1, 'm/s': 3.6, ms: 3.6, mph: 1.609344, kn: 1.852, knots: 1.852 };
const TO_MM = { mm: 1, inch: 25.4, in: 25.4 };
const convert = (v, unit, table) => (v == null ? null : v * (table[unit] ?? 1));

export function windRatio(speed, gust, thresholds = DEFAULT_WIND_THRESHOLDS) {
  const parts = [];
  if (speed != null) parts.push(speed / thresholds.strongWindSpeed);
  if (gust != null) parts.push(gust / thresholds.strongWindGust);
  return parts.length ? Math.max(...parts) : null;
}

function conditions(src, units, thresholds) {
  const code = num(src.weather_code);
  const d = describeWmo(code == null ? null : Math.round(code));
  const windSpeed = convert(num(src.wind_speed_10m), units.wind_speed_10m, TO_KMH);
  const windGusts = convert(num(src.wind_gusts_10m), units.wind_gusts_10m, TO_KMH);
  const ratio = windRatio(windSpeed, windGusts, thresholds);
  return {
    weatherCode: code,
    ...d,
    precipProbability: num(src.precipitation_probability),
    rain: convert(num(src.rain), units.rain, TO_MM),
    showers: convert(num(src.showers), units.showers, TO_MM),
    windSpeed,
    windGusts,
    cloudCover: num(src.cloud_cover),
    windRatio: ratio,
    strongWind: ratio == null ? null : ratio >= 1,
  };
}

/** Columnar Open-Meteo `hourly` object -> array of row objects. */
function rows(block) {
  if (!block || !Array.isArray(block.time)) return [];
  const keys = Object.keys(block).filter((k) => Array.isArray(block[k]));
  return block.time.map((_, i) => Object.fromEntries(keys.map((k) => [k, block[k][i]])));
}

/**
 * Open-Meteo forecast JSON (requested with timeformat=unixtime) -> normalized schema.
 * @param {object} json provider response
 * @param {{location, timezone, fetchedAt, thresholds?, provider?, simulated?, scenario?}} meta
 */
export function normalizeOpenMeteo(json, meta) {
  const thresholds = { ...DEFAULT_WIND_THRESHOLDS, ...(meta.thresholds ?? {}) };
  const hu = json?.hourly_units ?? {};
  const cu = json?.current_units ?? hu;
  const tz = typeof json?.timezone === 'string' && json.timezone !== 'GMT' ? json.timezone : meta.timezone;
  const hourly = rows(json?.hourly)
    .filter((r) => num(r.time) != null)
    .map((r) => ({ time: r.time * 1000, ...conditions(r, hu, thresholds) }))
    .sort((a, b) => a.time - b.time);
  const c = json?.current;
  const current = c && num(c.time) != null
    ? { time: c.time * 1000, intervalSeconds: num(c.interval), kind: 'model-estimate', ...conditions(c, cu, thresholds) }
    : null;
  const sun = {};
  const daily = json?.daily;
  if (daily && Array.isArray(daily.time)) {
    daily.time.forEach((_, i) => {
      const sr = num(daily.sunrise?.[i]);
      const ss = num(daily.sunset?.[i]);
      const anchor = sr ?? ss;
      if (anchor == null) return;
      sun[localDate(anchor * 1000, tz)] = { sunrise: sr == null ? null : sr * 1000, sunset: ss == null ? null : ss * 1000 };
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: meta.provider ?? 'open-meteo',
    simulated: !!meta.simulated,
    scenario: meta.scenario ?? null,
    status: meta.simulated ? 'simulated' : 'fresh',
    location: {
      label: meta.location?.label ?? '',
      lat: meta.location?.lat ?? null,
      lon: meta.location?.lon ?? null,
      gridLat: num(json?.latitude),
      gridLon: num(json?.longitude),
      elevation: num(json?.elevation),
    },
    timezone: tz,
    fetchedAt: meta.fetchedAt,
    validFrom: hourly.length ? hourly[0].time : null,
    validUntil: hourly.length ? hourly[hourly.length - 1].time + 3_600_000 : null,
    units: {
      time: 'epoch ms',
      precipProbability: '%',
      rain: 'mm',
      showers: 'mm',
      windSpeed: 'km/h',
      windGusts: 'km/h',
      cloudCover: '%',
    },
    thresholds: { ...thresholds, note: 'Strong-wind thresholds are an engineering choice for this app, not a provider value.' },
    current,
    hourly,
    sun,
    attribution: meta.simulated ? null : ATTRIBUTION,
    error: null,
  };
}

/** A context that explicitly says weather is unavailable (never an empty "clear" forecast). */
export function unavailableWeather(meta, error) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: meta.provider ?? 'open-meteo',
    simulated: !!meta.simulated,
    scenario: meta.scenario ?? null,
    status: 'unavailable',
    location: { label: meta.location?.label ?? '', lat: meta.location?.lat ?? null, lon: meta.location?.lon ?? null, gridLat: null, gridLon: null, elevation: null },
    timezone: meta.timezone ?? null,
    fetchedAt: null,
    validFrom: null,
    validUntil: null,
    units: null,
    thresholds: null,
    current: null,
    hourly: [],
    sun: {},
    attribution: meta.simulated ? null : ATTRIBUTION,
    error,
  };
}
