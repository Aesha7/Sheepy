// Timezone helpers built on Intl so the project needs no date library.
// All instants are epoch milliseconds; local dates are 'YYYY-MM-DD'; clock times are 'HH:MM'.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms, tz) {
  const p = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second),
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, '0')}:${p.minute}`,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. -7h for PDT). */
export function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Local wall-clock date + time in `tz` -> epoch ms.
 * Two passes handle DST: the second pass uses the offset in force at the first estimate.
 * Non-existent times (spring-forward gap) resolve to the shifted instant.
 */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

export function localDate(ms, tz) {
  return zonedParts(ms, tz).date;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isClock(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function clockMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToClock(total) {
  const t = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function shiftClock(clock, minutes) {
  return minutesToClock(clockMinutes(clock) + minutes);
}

const clockFormatters = new Map();
/** "9:15 PM" in the user's timezone. */
export function formatClock(ms, tz) {
  let f = clockFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    clockFormatters.set(tz, f);
  }
  return f.format(new Date(ms));
}

/** "Sat, Oct 24" for a local date string. */
export function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatClockString(clock) {
  const [h, m] = clock.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function toInstant(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
