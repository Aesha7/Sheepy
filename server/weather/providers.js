// Weather service: the single place the server asks for weather. It returns the normalized schema
// (normalize.js) from either the live Open-Meteo client or a clearly labeled offline scenario.
// Switching between them is always an explicit choice; live failures are reported as
// "unavailable"/"stale" and are never silently replaced by simulated data.

import { OpenMeteoClient } from './openMeteo.js';
import { offlineWeather, OFFLINE_SCENARIOS, resolveScenario } from './offline.js';

export const WEATHER_MODES = ['live', 'scenario'];

export class WeatherService {
  constructor({ client, mode = 'live', scenario = 'rain', thresholds } = {}) {
    this.client = client ?? new OpenMeteoClient({ thresholds });
    this.thresholds = thresholds;
    this.mode = 'live';
    this.scenario = 'rain';
    this.setSource({ mode, scenario });
    this.currentKey = new Map(); // userId -> latest requested key
  }

  get source() {
    return {
      mode: this.mode,
      provider: this.mode === 'live' ? 'open-meteo' : 'scenario',
      simulated: this.mode !== 'live',
      scenario: this.mode === 'live' ? null : this.scenario,
      scenarios: Object.entries(OFFLINE_SCENARIOS).map(([id, label]) => ({ id, label })),
      refreshMinutes: this.client.refreshMinutes,
      staleAfterMinutes: this.client.staleAfterMinutes,
    };
  }

  setSource({ mode, scenario }) {
    if (!WEATHER_MODES.includes(mode)) throw new Error(`weather mode must be ${WEATHER_MODES.join(' or ')}`);
    if (mode === 'scenario') {
      const s = resolveScenario(scenario ?? this.scenario);
      if (!OFFLINE_SCENARIOS[s]) throw new Error(`unknown offline scenario "${scenario}"`);
      this.scenario = s;
    }
    this.mode = mode;
  }

  keyFor(loc) {
    const c = (v) => (v == null ? 'none' : Number(v).toFixed(3));
    return `${this.mode}|${this.mode === 'live' ? '' : this.scenario}|${c(loc.lat)},${c(loc.lon)}|${loc.timezone ?? ''}`;
  }

  /**
   * Weather for one user's current location. If the location or source changes while a request is
   * in flight, the late response is returned as {superseded: true} so it can't replace newer data.
   */
  async getForUser(userId, loc, now) {
    const key = this.keyFor(loc);
    this.currentKey.set(userId, key);
    const data = this.mode === 'live'
      ? await this.client.get(loc, now)
      : offlineWeather(this.scenario, now, loc, this.thresholds);
    if (this.currentKey.get(userId) !== key || this.keyFor(loc) !== key) return { superseded: true, key };
    return data;
  }
}

export function createWeatherService(config) {
  const thresholds = { strongWindSpeed: config.windStrongSpeedKmh, strongWindGust: config.windStrongGustKmh, unit: 'km/h' };
  const client = new OpenMeteoClient({
    timeoutMs: config.weatherTimeoutMs,
    retries: config.weatherRetries,
    refreshMinutes: config.weatherRefreshMinutes,
    staleAfterMinutes: config.weatherStaleAfterMinutes,
    thresholds,
  });
  return new WeatherService({ client, mode: config.weatherMode, scenario: config.weatherScenario, thresholds });
}
