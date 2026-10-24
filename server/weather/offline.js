// Offline weather scenarios for demos without internet. Every scenario is clearly labeled
// (provider "scenario", simulated: true, status "simulated") and goes through the same normalizer
// as live data. Nothing here is ever substituted for real data automatically.

import { HOUR, MIN, zonedParts, localDate, addDays } from '../time.js';
import { sunTimes } from '../sun.js';
import { normalizeOpenMeteo, unavailableWeather } from './normalize.js';

export const OFFLINE_SCENARIOS = {
  rain: 'Rain (from early evening through the night)',
  thunderstorm: 'Thunderstorm (around midnight to 3 AM)',
  'clear-evening': 'Clear evening',
  'strong-wind': 'Strong wind overnight',
  missing: 'Missing weather (simulated outage)',
  cloudy: 'Overcast, dry',
  stale: 'Stale forecast (fetched 20 hours ago)',
};

// Older preset names used elsewhere in the app and tests.
const ALIASES = { storm: 'thunderstorm', clear: 'clear-evening', wind: 'strong-wind', none: 'missing' };
export const resolveScenario = (name) => ALIASES[name] ?? name;

/** hour-of-night index: evening date hours 0-23, next day 24-47. */
const nightHour = (p, evening) => (p.date === evening ? p.hour : p.date === addDays(evening, 1) ? p.hour + 24 : -100);
const between = (k, a, b) => k >= a && k < b;

function hourFor(kind, k) {
  const calm = { weather_code: 1, precipitation_probability: 5, rain: 0, showers: 0, wind_speed_10m: 8, wind_gusts_10m: 15, cloud_cover: 15 };
  switch (kind) {
    case 'rain':
      if (between(k, 21, 30)) return { weather_code: 63, precipitation_probability: 80, rain: 0.8, showers: 0.1, wind_speed_10m: 14, wind_gusts_10m: 28, cloud_cover: 100 };
      if (between(k, 15, 21)) return { weather_code: 3, precipitation_probability: 30, rain: 0, showers: 0, wind_speed_10m: 12, wind_gusts_10m: 22, cloud_cover: 95 };
      return { ...calm, weather_code: 2, cloud_cover: 55 };
    case 'thunderstorm':
      if (between(k, 24, 27)) return { weather_code: 95, precipitation_probability: 85, rain: 2.5, showers: 1.8, wind_speed_10m: 30, wind_gusts_10m: 58, cloud_cover: 100 };
      if (between(k, 22, 29)) return { weather_code: 61, precipitation_probability: 65, rain: 0.4, showers: 0.2, wind_speed_10m: 20, wind_gusts_10m: 38, cloud_cover: 100 };
      if (between(k, 14, 22)) return { weather_code: 3, precipitation_probability: 25, rain: 0, showers: 0, wind_speed_10m: 15, wind_gusts_10m: 30, cloud_cover: 90 };
      return { ...calm, weather_code: 2, cloud_cover: 45 };
    case 'strong-wind':
      if (between(k, 20, 31)) return { weather_code: 3, precipitation_probability: 10, rain: 0, showers: 0, wind_speed_10m: 46, wind_gusts_10m: 78, cloud_cover: 80 };
      return { ...calm, weather_code: 2, wind_speed_10m: 22, wind_gusts_10m: 40, cloud_cover: 50 };
    case 'cloudy':
      return { ...calm, weather_code: 3, precipitation_probability: 15, cloud_cover: 92 };
    case 'clear-evening':
    default:
      return { ...calm, weather_code: 0, cloud_cover: 3 };
  }
}

/** Open-Meteo-shaped JSON for a scenario, anchored to the local evening of `now`. */
export function scenarioJson(kind, now, { lat, lon, timezone }) {
  const evening = localDate(now - 6 * HOUR, timezone);
  const start = Math.floor((now - 30 * HOUR) / HOUR) * HOUR;
  const hourly = { time: [], weather_code: [], precipitation_probability: [], rain: [], showers: [], wind_speed_10m: [], wind_gusts_10m: [], cloud_cover: [] };
  for (let t = start; t < now + 48 * HOUR; t += HOUR) {
    const h = hourFor(kind, nightHour(zonedParts(t, timezone), evening));
    hourly.time.push(t / 1000);
    for (const k of Object.keys(h)) hourly[k].push(h[k]);
  }
  const nowIdx = hourly.time.findIndex((s) => s * 1000 <= now && now < s * 1000 + HOUR);
  const pick = (k) => hourly[k][nowIdx >= 0 ? nowIdx : 0];
  const days = [addDays(evening, -1), evening, addDays(evening, 1), addDays(evening, 2)];
  const sun = days.map((d) => sunTimes(d, lat, lon));
  const units = { time: 'unixtime', weather_code: 'wmo code', precipitation_probability: '%', rain: 'mm', showers: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', cloud_cover: '%' };
  return {
    latitude: lat,
    longitude: lon,
    timezone,
    current_units: units,
    current: { time: Math.floor((now - 15 * MIN) / 1000), interval: 900, ...Object.fromEntries(['weather_code', 'cloud_cover', 'rain', 'showers', 'wind_speed_10m', 'wind_gusts_10m'].map((k) => [k, pick(k)])) },
    hourly_units: units,
    hourly,
    daily: { time: days.map((d) => Date.parse(`${d}T12:00:00Z`) / 1000), sunrise: sun.map((s) => (s.sunrise == null ? null : s.sunrise / 1000)), sunset: sun.map((s) => (s.sunset == null ? null : s.sunset / 1000)) },
  };
}

/**
 * Normalized offline weather for a location. Re-anchored to whole hours so repeated refreshes
 * return identical data (no audio restarts from a "changing" fake forecast).
 */
export function offlineWeather(name, now, loc, thresholds) {
  const kind = resolveScenario(name);
  const meta = { provider: 'scenario', simulated: true, scenario: kind, location: loc, timezone: loc.timezone, thresholds };
  if (!OFFLINE_SCENARIOS[kind]) return unavailableWeather(meta, `Unknown offline scenario "${name}"`);
  if (loc.lat == null || loc.lon == null) return unavailableWeather(meta, 'No location set. Choose a city in Preferences.');
  if (kind === 'missing') return unavailableWeather(meta, 'Simulated outage: offline scenario “Missing weather”.');
  const anchored = Math.floor(now / HOUR) * HOUR;
  const base = kind === 'stale' ? 'rain' : kind;
  const data = normalizeOpenMeteo(scenarioJson(base, anchored, loc), { ...meta, fetchedAt: anchored - 20 * MIN });
  if (kind === 'stale') return { ...data, fetchedAt: now - 20 * HOUR, status: 'stale' };
  return data;
}
