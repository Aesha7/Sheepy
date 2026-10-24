// Builds the calendar context for a user from: manual events (always available), an optional
// private iCalendar feed URL (Google/Outlook/Apple "secret address"), or simulated demo data.
// Drift never writes to a calendar and never changes alarms.

import { parseIcs } from './ics.js';
import { simulatedCalendar } from '../scenarios.js';
import { localDate, addDays } from '../time.js';

const ICS_CACHE_MS = 15 * 60_000;
const ICS_MAX_BYTES = 5 * 1024 * 1024;
const icsCache = new Map();

export function validateIcsUrl(url) {
  let u;
  try {
    u = new URL(url.replace(/^webcal:/i, 'https:'));
  } catch {
    return { error: 'Not a valid URL' };
  }
  if (u.protocol !== 'https:') return { error: 'Calendar feed must use https (or webcal)' };
  return { url: u.toString() };
}

/** "https://calendar.google.com/…/basic.ics" -> "calendar.google.com/…" so the secret isn't echoed back. */
export function maskUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}/…${u.pathname.slice(-8)}`;
  } catch {
    return '(hidden)';
  }
}

async function fetchIcs(url, now) {
  const cached = icsCache.get(url);
  if (cached && now - cached.at < ICS_CACHE_MS) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > ICS_MAX_BYTES) throw new Error('calendar feed too large');
  const entry = { at: now, text };
  icsCache.set(url, entry);
  return entry;
}

function annotate(events, annotations) {
  return events.map((e) => {
    const a = e.id ? annotations[e.id] : null;
    return a ? { ...e, ...a } : e;
  });
}

/**
 * @param {object} rec stored user record
 * @param {{simulation: boolean, simCalendar: string}} opts
 */
export async function calendarContextFor(rec, now, opts = {}) {
  const tz = rec.profile.timezone;
  const cal = rec.calendar;
  const manual = annotate(cal.events.map((e) => ({ ...e, source: 'manual' })), cal.annotations);

  if (cal.mode === 'simulated') {
    const sim = simulatedCalendar(cal.simPreset || 'exam', now, tz);
    return { ...sim, events: [...annotate(sim.events, cal.annotations), ...manual], dayLabels: cal.dayLabels };
  }
  if (cal.mode === 'ics' && cal.icsUrl) {
    const today = localDate(now, tz);
    try {
      const { at, text } = await fetchIcs(cal.icsUrl, now);
      const { events, warnings } = parseIcs(text, tz, { from: addDays(today, -1), to: addDays(today, 3) });
      const shaped = cal.storeTitles === false ? events.map((e) => ({ ...e, title: '' , category: e.category ?? 'other' })) : events;
      return { status: 'connected', source: 'ics', fetchedAt: at, warnings, events: [...annotate(shaped, cal.annotations), ...manual], dayLabels: cal.dayLabels };
    } catch (e) {
      return { status: 'error', source: 'ics', error: `Calendar feed could not be read: ${e.message}`, events: manual, dayLabels: cal.dayLabels };
    }
  }
  return { status: 'manual', source: 'manual', fetchedAt: now, events: manual, dayLabels: cal.dayLabels };
}
