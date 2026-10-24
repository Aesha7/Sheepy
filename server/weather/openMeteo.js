// Live Open-Meteo client (https://open-meteo.com/en/docs). Free tier: non-commercial use,
// under 10,000 calls/day; data licensed CC BY 4.0 ("Weather data by Open-Meteo.com").
//
// Network concerns live here and nowhere else: request timeouts, bounded retries with backoff,
// a cache keyed by location + request parameters, de-duplication of in-flight requests, and a
// refresh interval. Personalization rules never see raw responses, only the normalized schema.

import { normalizeOpenMeteo, unavailableWeather } from './normalize.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// Everything we request. Changing this list changes the cache key.
export const REQUEST_FIELDS = {
  current: ['weather_code', 'cloud_cover', 'rain', 'showers', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m'],
  hourly: ['weather_code', 'precipitation_probability', 'rain', 'showers', 'wind_speed_10m', 'wind_gusts_10m', 'cloud_cover'],
  daily: ['sunrise', 'sunset'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Query string for one location. past_days=1 + forecast_days=3 always covers tonight past midnight. */
export function buildParams({ lat, lon, timezone }) {
  return new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: REQUEST_FIELDS.current.join(','),
    hourly: REQUEST_FIELDS.hourly.join(','),
    daily: REQUEST_FIELDS.daily.join(','),
    timezone: timezone || 'auto',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '3',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  });
}

export class OpenMeteoClient {
  constructor({
    fetchImpl = (...a) => fetch(...a),
    baseUrl = OPEN_METEO_URL,
    timeoutMs = 6000,
    retries = 2,
    retryDelayMs = 500,
    refreshMinutes = 30,
    staleAfterMinutes = 180,
    failureBackoffMinutes = 2,
    thresholds,
    wait = sleep,
  } = {}) {
    Object.assign(this, { fetchImpl, baseUrl, timeoutMs, retries, retryDelayMs, refreshMinutes, staleAfterMinutes, failureBackoffMinutes, thresholds, wait });
    this.name = 'open-meteo';
    this.cache = new Map(); // key -> { data, fetchedAt, failedAt, error }
    this.inflight = new Map(); // key -> Promise
    this.requests = 0;
  }

  cacheKey(loc) {
    return buildParams(loc).toString();
  }

  /** Mark cached data fresh/stale by age. Data older than staleAfterMinutes is "stale", never dropped silently. */
  withStatus(data, now, error = null) {
    const age = (now - data.fetchedAt) / 60_000;
    return { ...data, status: age <= this.staleAfterMinutes ? 'fresh' : 'stale', staleAfterMinutes: this.staleAfterMinutes, error: error ?? data.error };
  }

  async request(url) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.wait(this.retryDelayMs * 2 ** (attempt - 1));
      try {
        this.requests += 1;
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const err = new HttpError(res.status, `HTTP ${res.status}${body?.reason ? `: ${body.reason}` : ''}`);
          // 4xx (except 429) means our request is wrong: retrying won't help.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { final: true });
          throw err;
        }
        if (!body || !body.hourly) throw new Error('response had no hourly forecast');
        return body;
      } catch (e) {
        lastErr = e.name === 'TimeoutError' ? new Error(`timed out after ${this.timeoutMs} ms`) : e;
        if (e.final) break;
      }
    }
    throw lastErr;
  }

  /**
   * Forecast for one location. Serves cache within the refresh interval, backs off after failures,
   * and returns stale data (labeled stale) or an explicit "unavailable" context when offline.
   * @param {{lat, lon, label, timezone}} loc
   */
  async get(loc, now) {
    const meta = { provider: this.name, location: loc, timezone: loc.timezone };
    if (loc.lat == null || loc.lon == null) return unavailableWeather(meta, 'No location set. Choose a city in Preferences.');
    const key = this.cacheKey(loc);
    const entry = this.cache.get(key);
    if (entry?.data && now - entry.fetchedAt < this.refreshMinutes * 60_000) return this.withStatus(entry.data, now);
    if (entry?.failedAt != null && now - entry.failedAt < this.failureBackoffMinutes * 60_000) {
      return entry.data ? this.withStatus(entry.data, now, entry.error) : unavailableWeather(meta, entry.error);
    }
    if (!this.inflight.has(key)) {
      const p = this.request(`${this.baseUrl}?${key}`)
        .then((json) => {
          const data = normalizeOpenMeteo(json, { ...meta, fetchedAt: now, thresholds: this.thresholds });
          this.cache.set(key, { data, fetchedAt: now, failedAt: null, error: null });
          return { ok: true };
        })
        .catch((e) => {
          const prev = this.cache.get(key);
          const error = `Open-Meteo request failed: ${e.message}`;
          this.cache.set(key, { ...(prev ?? {}), fetchedAt: prev?.fetchedAt ?? null, failedAt: now, error });
          return { ok: false };
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    await this.inflight.get(key);
    const after = this.cache.get(key);
    if (after?.data && after.failedAt == null) return this.withStatus(after.data, now);
    return after?.data ? this.withStatus(after.data, now, after.error) : unavailableWeather(meta, after?.error ?? 'unknown error');
  }
}
