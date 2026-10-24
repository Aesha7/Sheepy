import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenMeteo, describeWmo } from '../server/weather/normalize.js';
import { OpenMeteoClient, buildParams, REQUEST_FIELDS } from '../server/weather/openMeteo.js';
import { WeatherService } from '../server/weather/providers.js';
import { offlineWeather, OFFLINE_SCENARIOS } from '../server/weather/offline.js';
import { assessWeather, isRainy, skyBucket, findWeatherWindows } from '../server/weather/analyze.js';
import { buildPlan } from '../server/policy/buildPlan.js';
import { SAMPLE_USERS } from '../server/scenarios.js';
import { zonedToUtc, HOUR, MIN } from '../server/time.js';

const TZ = 'America/Los_Angeles';
const LOC = { label: 'Berkeley, CA', lat: 37.872, lon: -122.273, timezone: TZ };
const EVENING = zonedToUtc('2026-10-23', '19:30', TZ);

/** A small Open-Meteo response in the documented shape (timeformat=unixtime), with gaps on purpose. */
function sampleResponse(start = EVENING - 2 * HOUR, hours = 20) {
  const s = (ms) => Math.floor(ms / 1000);
  const time = Array.from({ length: hours }, (_, i) => s(start + i * HOUR));
  const codes = [0, 1, 2, 3, 45, 61, 63, 80, 95, 97, 71, null, 42, 3, 3, 3, 2, 1, 0, 0];
  return {
    latitude: 37.87, longitude: -122.27, elevation: 52, timezone: TZ, utc_offset_seconds: -25200,
    current_units: { time: 'unixtime', interval: 'seconds', weather_code: 'wmo code', cloud_cover: '%', rain: 'mm', showers: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h' },
    current: { time: s(EVENING - 10 * MIN), interval: 900, weather_code: 3, cloud_cover: 88, rain: 0, showers: 0, wind_speed_10m: 12.5, wind_gusts_10m: 30.2 },
    hourly_units: { time: 'unixtime', weather_code: 'wmo code', precipitation_probability: '%', rain: 'mm', showers: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', cloud_cover: '%' },
    hourly: {
      time,
      weather_code: codes.slice(0, hours),
      precipitation_probability: time.map((_, i) => (i === 3 ? null : i * 5)),
      rain: time.map((_, i) => (i === 5 ? null : i >= 5 && i <= 9 ? 1.2 : 0)),
      showers: time.map(() => 0),
      wind_speed_10m: time.map((_, i) => (i === 12 ? null : i === 8 ? 45 : 10)),
      wind_gusts_10m: time.map((_, i) => (i === 12 ? null : i === 9 ? 65 : 20)),
      cloud_cover: time.map((_, i) => (i === 4 ? null : 50)),
    },
    daily_units: { time: 'unixtime', sunrise: 'unixtime', sunset: 'unixtime' },
    daily: { time: [s(zonedToUtc('2026-10-23', '00:00', TZ)), s(zonedToUtc('2026-10-24', '00:00', TZ))], sunrise: [s(zonedToUtc('2026-10-23', '07:26', TZ)), s(zonedToUtc('2026-10-24', '07:27', TZ))], sunset: [s(zonedToUtc('2026-10-23', '18:22', TZ)), s(zonedToUtc('2026-10-24', '18:21', TZ))] },
  };
}

const okResponse = (json) => ({ ok: true, status: 200, json: async () => json });

test('normalized schema: provider, location, timezone, units, validity, sun by date', () => {
  const n = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING });
  assert.equal(n.schemaVersion, 2);
  assert.equal(n.provider, 'open-meteo');
  assert.equal(n.status, 'fresh');
  assert.equal(n.simulated, false);
  assert.equal(n.timezone, TZ);
  assert.equal(n.location.label, 'Berkeley, CA');
  assert.equal(n.location.gridLat, 37.87);
  assert.deepEqual(n.units, { time: 'epoch ms', precipProbability: '%', rain: 'mm', showers: 'mm', windSpeed: 'km/h', windGusts: 'km/h', cloudCover: '%' });
  assert.equal(n.validFrom, EVENING - 2 * HOUR);
  assert.equal(n.validUntil, EVENING - 2 * HOUR + 20 * HOUR);
  assert.equal(n.current.kind, 'model-estimate', 'current values are model estimates, never bedroom measurements');
  assert.equal(n.current.time, Math.floor((EVENING - 10 * MIN) / 1000) * 1000);
  assert.equal(n.sun['2026-10-24'].sunrise, zonedToUtc('2026-10-24', '07:27', TZ));
  assert.equal(n.attribution.text, 'Weather data by Open-Meteo.com');
  assert.match(n.thresholds.note, /engineering choice/);
});

test('categories follow documented WMO codes; unknown codes and nulls stay unknown', () => {
  const cats = [0, 1, 2, 3, 45, 48, 51, 61, 66, 80, 71, 77, 85, 95, 96, 97, 99, 42, null].map((c) => describeWmo(c).category);
  assert.deepEqual(cats, ['clear', 'clear', 'cloudy', 'cloudy', 'fog', 'fog', 'rain', 'rain', 'rain', 'rain', 'snow', 'snow', 'snow', 'thunderstorm', 'thunderstorm', 'thunderstorm', 'thunderstorm', 'unknown', 'unknown']);
  const n = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING });
  assert.equal(n.hourly[11].category, 'unknown');
  assert.equal(n.hourly[11].weatherCode, null);
  assert.equal(n.hourly[12].category, 'unknown');
});

test('missing values are preserved as unknown (null), never zero', () => {
  const n = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING });
  assert.equal(n.hourly[3].precipProbability, null);
  assert.equal(n.hourly[4].cloudCover, null);
  assert.equal(n.hourly[5].rain, null);
  assert.equal(n.hourly[12].windSpeed, null);
  assert.equal(n.hourly[12].strongWind, null, 'no wind data -> unknown, not calm');
});

test('strong wind is a separate flag that can coexist with rain or storms', () => {
  const n = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING });
  assert.equal(n.hourly[8].strongWind, true, '45 km/h sustained >= 40 threshold');
  assert.equal(n.hourly[8].category, 'thunderstorm');
  assert.equal(n.hourly[9].strongWind, true, '65 km/h gusts >= 60 threshold');
  assert.equal(n.hourly[0].strongWind, false);
  const strict = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING, thresholds: { strongWindSpeed: 80, strongWindGust: 100 } });
  assert.equal(strict.hourly[8].strongWind, false, 'thresholds are configurable');
  const ms = sampleResponse();
  ms.hourly_units.wind_speed_10m = 'm/s';
  ms.hourly.wind_speed_10m = ms.hourly.wind_speed_10m.map((v) => (v == null ? null : v / 3.6));
  assert.equal(normalizeOpenMeteo(ms, { location: LOC, timezone: TZ, fetchedAt: EVENING }).hourly[8].windSpeed.toFixed(1), '45.0', 'units converted to km/h');
});

test('request asks for every documented field and covers the night past midnight', () => {
  const p = buildParams(LOC);
  for (const k of ['current', 'hourly', 'daily']) assert.deepEqual(p.get(k).split(','), REQUEST_FIELDS[k]);
  assert.deepEqual(REQUEST_FIELDS.hourly, ['weather_code', 'precipitation_probability', 'rain', 'showers', 'wind_speed_10m', 'wind_gusts_10m', 'cloud_cover']);
  assert.equal(p.get('timezone'), TZ);
  assert.equal(p.get('timeformat'), 'unixtime');
  assert.equal(p.get('past_days'), '1');
  assert.equal(p.get('forecast_days'), '3');
  assert.equal(p.get('wind_speed_unit'), 'kmh');
});

test('client: bounded retries with timeout, then explicit unavailable (never simulated)', async () => {
  let calls = 0;
  const client = new OpenMeteoClient({ fetchImpl: async () => { calls++; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, retries: 2, wait: async () => {} });
  const r = await client.get(LOC, EVENING);
  assert.equal(calls, 3, '1 attempt + 2 retries');
  assert.equal(r.status, 'unavailable');
  assert.equal(r.simulated, false);
  assert.equal(r.hourly.length, 0);
  assert.match(r.error, /timed out/);
  // Failure backoff: no new request right away.
  await client.get(LOC, EVENING + MIN);
  assert.equal(calls, 3);
});

test('client: 4xx is not retried; 5xx is', async () => {
  let calls = 0;
  const c400 = new OpenMeteoClient({ fetchImpl: async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: true, reason: 'Cannot initialize WeatherVariable' }) }; }, wait: async () => {} });
  const r = await c400.get(LOC, EVENING);
  assert.equal(calls, 1);
  assert.match(r.error, /HTTP 400: Cannot initialize/);
  calls = 0;
  const c503 = new OpenMeteoClient({ fetchImpl: async () => { calls++; return calls < 3 ? { ok: false, status: 503, json: async () => null } : okResponse(sampleResponse()); }, wait: async () => {} });
  const ok = await c503.get(LOC, EVENING);
  assert.equal(calls, 3);
  assert.equal(ok.status, 'fresh');
});

test('client: cache by location + params, refresh interval, in-flight dedupe, stale fallback', async () => {
  let calls = 0;
  let online = true;
  const client = new OpenMeteoClient({
    fetchImpl: async () => { calls++; if (!online) throw new Error('getaddrinfo ENOTFOUND'); return okResponse(sampleResponse()); },
    refreshMinutes: 30, staleAfterMinutes: 180, failureBackoffMinutes: 2, wait: async () => {},
  });
  const [a, b] = await Promise.all([client.get(LOC, EVENING), client.get(LOC, EVENING)]);
  assert.equal(calls, 1, 'concurrent requests share one fetch');
  assert.deepEqual(a, b);
  await client.get(LOC, EVENING + 10 * MIN);
  assert.equal(calls, 1, 'served from cache within the refresh interval');
  await client.get({ ...LOC, lat: 40.71, lon: -74.0, timezone: 'America/New_York' }, EVENING + 10 * MIN);
  assert.equal(calls, 2, 'another location has its own cache entry');
  online = false;
  const offline = await client.get(LOC, EVENING + 40 * MIN);
  assert.equal(offline.status, 'fresh', 'last good data kept while still within stale threshold');
  assert.match(offline.error, /ENOTFOUND/);
  const old = await client.get(LOC, EVENING + 4 * HOUR);
  assert.equal(old.status, 'stale', 'older than 3 h -> labeled stale');
  assert.equal(old.simulated, false);
});

test('a delayed response for an old location cannot replace the current location', async () => {
  const resolvers = [];
  const client = new OpenMeteoClient({ fetchImpl: () => new Promise((r) => resolvers.push(() => r(okResponse(sampleResponse())))), wait: async () => {} });
  const svc = new WeatherService({ client, mode: 'live' });
  const oldReq = svc.getForUser('alex', { ...LOC, lat: 51.5, lon: -0.12, timezone: 'Europe/London' }, EVENING);
  const newReq = svc.getForUser('alex', LOC, EVENING);
  resolvers[1]();
  const fresh = await newReq;
  resolvers[0]();
  const late = await oldReq;
  assert.equal(late.superseded, true, 'old location response is discarded');
  assert.equal(fresh.status, 'fresh');
});

test('offline scenarios need no network and are always labeled simulated', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network disabled for this test'); };
  try {
    const client = new OpenMeteoClient({ fetchImpl: () => { throw new Error('network disabled'); } });
    const svc = new WeatherService({ client, mode: 'scenario', scenario: 'thunderstorm' });
    const wx = await svc.getForUser('alex', LOC, EVENING);
    assert.equal(wx.simulated, true);
    assert.equal(wx.provider, 'scenario');
    assert.equal(wx.status, 'simulated');
    assert.ok(wx.hourly.some((h) => h.category === 'thunderstorm'));
    for (const id of Object.keys(OFFLINE_SCENARIOS)) {
      const d = offlineWeather(id, EVENING, LOC);
      assert.equal(d.simulated, true, id);
      assert.equal(d.attribution, null, `${id}: no Open-Meteo attribution on fake data`);
    }
    assert.equal(offlineWeather('missing', EVENING, LOC).status, 'unavailable');
    assert.equal(offlineWeather('strong-wind', EVENING, LOC).hourly.filter((h) => h.strongWind).length > 5, true);
    // Live mode while offline: unavailable, not a scenario.
    svc.setSource({ mode: 'live' });
    const live = await svc.getForUser('alex', LOC, EVENING);
    assert.equal(live.status, 'unavailable');
    assert.equal(live.simulated, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('missing data never becomes "clear"; snow probability is not rain', () => {
  const n = normalizeOpenMeteo(sampleResponse(), { location: LOC, timezone: TZ, fetchedAt: EVENING });
  const unknown = n.hourly[11];
  assert.equal(skyBucket({ ...unknown, cloudCover: null }), null);
  assert.equal(isRainy({ category: 'snow', precipProbability: 90, rain: 0, showers: 0 }), false);
  assert.equal(isRainy({ category: 'rain', precipProbability: 80, rain: 1, showers: 0 }), true);
  const empty = assessWeather({ provider: 'open-meteo', hourly: [], fetchedAt: EVENING }, EVENING, EVENING + 10 * HOUR);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.usable, false);
});

test('wind windows are found from the strong-wind flag', () => {
  const wx = offlineWeather('strong-wind', EVENING, LOC);
  const w = findWeatherWindows(wx.hourly, EVENING, EVENING + 12 * HOUR).filter((x) => x.kind === 'wind');
  assert.equal(w.length, 1);
  assert.ok(w[0].peak >= 70);
});

test('a real-shaped live response flows into the plan', () => {
  const json = sampleResponse(EVENING - 30 * HOUR, 80);
  const n = normalizeOpenMeteo(json, { location: LOC, timezone: TZ, fetchedAt: EVENING });
  const p = buildPlan(SAMPLE_USERS.alex, null, n, EVENING);
  assert.equal(p.weather.status, 'fresh');
  assert.equal(p.weather.source, 'open-meteo');
  assert.equal(p.weather.attribution.text, 'Weather data by Open-Meteo.com');
  assert.ok(p.weather.tonight.length > 8, 'hourly strip covers the night');
  assert.equal(p.sun.find((s) => s.date === '2026-10-24').source, 'open-meteo', 'provider sunrise/sunset used');
});
