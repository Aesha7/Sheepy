// Weather context assessment and night-window detection, on the normalized schema (normalize.js).
// Distinguishes current conditions, forecasts, and stale/unavailable data. Forecasts describe
// possible outdoor conditions: they cannot say how loud the bedroom will be or when a thunderclap
// will happen.

import { MIN, HOUR } from '../time.js';
import { describeWmo } from './normalize.js';

export const CONDITIONS = ['clear', 'partly_cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'thunderstorm'];
export const CONDITION_LABELS = {
  clear: 'Clear',
  partly_cloudy: 'Partly cloudy',
  cloudy: 'Overcast',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  thunderstorm: 'Thunderstorms',
};
const CATEGORY_OF_CONDITION = { clear: 'clear', partly_cloudy: 'cloudy', cloudy: 'cloudy', fog: 'fog', drizzle: 'rain', rain: 'rain', snow: 'snow', thunderstorm: 'thunderstorm' };

export const DEFAULT_STALE_AFTER_MIN = 180;

// Hysteresis: a window opens at >= ENTER and stays open while >= STAY, so a forecast wobbling
// around one threshold does not flip the plan on and off.
export const RAIN_ENTER = 50;
export const RAIN_STAY = 30;
export const STORM_ENTER = 40;
export const STORM_STAY = 25;
export const WIND_ENTER = 1; // windRatio: 1 = at the configured strong-wind threshold
export const WIND_STAY = 0.8;
const SHIFT_TOLERANCE = 45 * MIN;
const RELEASE_HOLD = 60 * MIN;
const WINDOW_KINDS = ['rain', 'storm', 'wind'];

/** Kept for older callers: WMO code -> fine-grained condition. */
export function conditionFromWmo(code) {
  return describeWmo(code).condition;
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
const val = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeEntry(h) {
  const condition = CONDITIONS.includes(h.condition) ? h.condition : null;
  const category = h.category ?? (condition ? CATEGORY_OF_CONDITION[condition] : 'unknown');
  return {
    time: h.time,
    weatherCode: val(h.weatherCode),
    category,
    condition,
    label: h.label ?? (condition ? CONDITION_LABELS[condition] : 'Unknown'),
    precipProbability: pct(h.precipProbability),
    rain: val(h.rain),
    showers: val(h.showers),
    windSpeed: val(h.windSpeed),
    windGusts: val(h.windGusts),
    cloudCover: pct(h.cloudCover),
    windRatio: val(h.windRatio),
    strongWind: typeof h.strongWind === 'boolean' ? h.strongWind : null,
    thunderProbability: pct(h.thunderProbability),
  };
}

/**
 * @param {object|null} raw normalized weather context from a provider
 * @param {number} now
 * @param {number} needUntil the forecast must cover until this instant to be usable
 * @returns status: 'fresh' | 'stale' | 'unavailable' | 'simulated', plus usable, notes, hourly...
 */
export function assessWeather(raw, now, needUntil) {
  const out = {
    source: raw?.provider ?? raw?.source ?? 'none',
    simulated: !!raw?.simulated,
    scenario: raw?.scenario ?? null,
    location: raw?.location ?? null,
    attribution: raw?.attribution ?? null,
    units: raw?.units ?? null,
    thresholds: raw?.thresholds ?? null,
    fetchedAt: val(raw?.fetchedAt),
    validFrom: null,
    validUntil: null,
    status: 'unavailable',
    usable: false,
    currentStatus: 'unavailable',
    forecastStatus: 'unavailable',
    current: null,
    hourly: [],
    notes: [],
    error: raw?.error ?? null,
  };
  if (!raw || typeof raw !== 'object') {
    out.notes.push('No weather data. Weather is not used; sunrise and sunset are calculated from your location.');
    return out;
  }
  if (raw.error) out.notes.push(`Weather unavailable: ${raw.error}`);
  const staleAfter = val(raw.staleAfterMinutes) ?? DEFAULT_STALE_AFTER_MIN;

  const c = raw.current;
  const cTime = val(c?.time) ?? val(c?.observedAt);
  if (c && cTime != null) {
    out.current = { ...normalizeEntry(c), time: cTime, observedAt: cTime, kind: c.kind ?? 'model-estimate' };
    const age = (now - cTime) / MIN;
    out.currentStatus = age <= DEFAULT_STALE_AFTER_MIN && age >= -60 ? 'fresh' : 'stale';
  }

  for (const h of Array.isArray(raw.hourly) ? raw.hourly : []) {
    if (val(h?.time) == null) continue;
    out.hourly.push(normalizeEntry(h));
  }
  out.hourly.sort((a, b) => a.time - b.time);

  if (out.hourly.length) {
    out.validFrom = out.hourly[0].time;
    out.validUntil = out.hourly[out.hourly.length - 1].time + HOUR;
    const age = out.fetchedAt == null ? Infinity : (now - out.fetchedAt) / MIN;
    if (raw.status === 'stale' || age > staleAfter) {
      out.forecastStatus = 'stale';
      out.notes.push(`The forecast is over ${Math.round(staleAfter / 60)} hours old, so weather is not used tonight. Your normal routine applies.`);
    } else if (out.validUntil < needUntil) {
      out.forecastStatus = 'stale';
      out.notes.push('The forecast ends before your wake time, so weather is not used tonight. Your normal routine applies.');
    } else {
      out.forecastStatus = 'fresh';
    }
  } else if (!raw.error) {
    out.notes.push('No forecast data available.');
  }
  if (out.currentStatus === 'stale') out.notes.push('The latest current-conditions estimate is more than 3 hours old.');

  out.usable = out.forecastStatus === 'fresh';
  out.status = out.usable ? (out.simulated ? 'simulated' : 'fresh') : out.forecastStatus === 'stale' ? 'stale' : 'unavailable';
  return out;
}

const amount = (h) => (h.rain == null && h.showers == null ? null : (h.rain ?? 0) + (h.showers ?? 0));

/** Rain likely this hour? Snow, fog, clear and dry cloud never count; unknown hours rely on probability. */
export function isRainy(h, threshold = RAIN_ENTER) {
  if (h.category === 'snow') return false;
  const wet = h.category === 'rain' || h.category === 'thunderstorm' || (amount(h) ?? 0) >= 0.1;
  if (wet) return h.precipProbability == null || h.precipProbability >= threshold;
  if (!h.category || h.category === 'unknown') return amount(h) == null && h.precipProbability != null && h.precipProbability >= threshold;
  return false;
}

export function isStormy(h, threshold = STORM_ENTER) {
  if (h.thunderProbability != null) return h.thunderProbability >= threshold;
  return h.category === 'thunderstorm' && (h.precipProbability == null || h.precipProbability >= threshold);
}

export function isWindy(h, threshold = WIND_ENTER) {
  return h.windRatio != null && h.windRatio >= threshold;
}

const TESTS = {
  rain: [isRainy, RAIN_ENTER, RAIN_STAY, (h) => h.precipProbability],
  storm: [isStormy, STORM_ENTER, STORM_STAY, (h) => h.thunderProbability ?? h.precipProbability],
  wind: [isWindy, WIND_ENTER, WIND_STAY, (h) => h.windGusts ?? h.windSpeed],
};

function windows(hourly, from, to, kind) {
  const [test, enter, stay, peakOf] = TESTS[kind];
  const out = [];
  let open = null;
  for (const h of hourly) {
    const hEnd = h.time + HOUR;
    if (hEnd <= from || h.time >= to) continue;
    const peak = peakOf(h);
    if (open ? test(h, stay) : test(h, enter)) {
      if (!open) open = { kind, start: Math.max(h.time, from), end: Math.min(hEnd, to), peak };
      else {
        open.end = Math.min(hEnd, to);
        if (peak != null) open.peak = Math.max(open.peak ?? 0, peak);
      }
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/** Rain, storm and strong-wind windows between `from` and `to` from a usable forecast. */
export function findWeatherWindows(hourly, from, to) {
  const list = hourly.map(normalizeEntry);
  return WINDOW_KINDS.flatMap((k) => windows(list, from, to, k));
}

function mergeSorted(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.committed = last.committed || w.committed;
      last.released = last.released && w.released;
      if (w.peak != null) last.peak = Math.max(last.peak ?? 0, w.peak);
    } else out.push({ ...w });
  }
  return out;
}

/**
 * Keep the plan steady when forecasts change between refreshes:
 * - a window that already started keeps its start; if the new forecast drops it, it is held
 *   for up to an hour (then fades out) instead of cutting off abruptly;
 * - future windows ignore start/end shifts smaller than 45 minutes.
 */
export function stabilizeWindows(fresh, previous, now) {
  const out = [];
  for (const kind of WINDOW_KINDS) {
    const result = fresh.filter((w) => w.kind === kind).map((w) => ({ ...w }));
    for (const p of (previous ?? []).filter((w) => w.kind === kind)) {
      const overlapping = result.filter((w) => w.start < p.end && w.end > p.start);
      if (p.start <= now && now < p.end) {
        if (overlapping.length) {
          overlapping[0].start = Math.min(overlapping[0].start, p.start);
          overlapping[0].committed = true;
        } else if (p.released) {
          result.push({ ...p });
        } else {
          result.push({ ...p, end: Math.min(p.end, now + RELEASE_HOLD), committed: true, released: true });
        }
      } else if (p.start > now) {
        for (const w of overlapping) {
          if (Math.abs(w.start - p.start) < SHIFT_TOLERANCE) w.start = p.start;
          if (Math.abs(w.end - p.end) < SHIFT_TOLERANCE) w.end = p.end;
        }
      }
    }
    out.push(...mergeSorted(result));
  }
  return out;
}

/** Bucket for daytime light mirroring; null = unknown (never assumed clear). */
export function skyBucket(h) {
  if (!h) return null;
  const cat = h.category ?? (h.condition ? CATEGORY_OF_CONDITION[h.condition] : null);
  if (['rain', 'thunderstorm', 'snow', 'fog'].includes(cat) || h.condition === 'cloudy') return 'overcast';
  if (h.cloudCover != null) return h.cloudCover < 30 ? 'clear' : h.cloudCover < 70 ? 'partly' : 'overcast';
  if (cat === 'clear') return 'clear';
  if (h.condition === 'partly_cloudy') return 'partly';
  return null;
}
