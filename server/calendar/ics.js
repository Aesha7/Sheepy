// Minimal iCalendar (.ics) reader for "secret address" calendar feeds (Google, Outlook, Apple).
// Reads only SUMMARY, DTSTART/DTEND/DURATION, UID, STATUS and a DAILY/WEEKLY RRULE subset;
// descriptions, locations and attendees are ignored on purpose.

import { zonedToUtc, isValidTimeZone, addDays } from '../time.js';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_EXPANSIONS = 1000;

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

const unescapeText = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

/** -> {allDay, date, time} in local terms, or {utc} for UTC datetimes. */
function parseDateValue(value, params) {
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { allDay: true, date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  if (m[7] === 'Z') return { allDay: false, utc: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  return { allDay: false, date, time, tzid: params.TZID };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+min || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function parseRrule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) rule[k.toUpperCase()] = v;
  }
  return rule;
}

/** Local occurrence dates for a DAILY/WEEKLY rule, within [from, to]. */
function expandDates(startDate, rule, from, to, exdates) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` : null;
  const out = [];
  let produced = 0;
  const emit = (date) => {
    produced += 1;
    if (date >= from && date <= to && !exdates.has(date)) out.push(date);
  };
  if (rule.FREQ === 'DAILY') {
    for (let k = 0; k < MAX_EXPANSIONS && produced < count; k++) {
      const date = addDays(startDate, k * interval);
      if ((until && date > until) || date > to) break;
      emit(date);
    }
  } else if (rule.FREQ === 'WEEKLY') {
    const days = rule.BYDAY
      ? rule.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0)
      : [weekday(startDate)];
    // Weeks start Monday (RFC 5545 default WKST=MO).
    const startDow = (weekday(startDate) + 6) % 7;
    const weekStart = addDays(startDate, -startDow);
    const ordered = [...new Set(days.map((d) => (d + 6) % 7))].sort((a, b) => a - b);
    outer: for (let w = 0; w < MAX_EXPANSIONS; w++) {
      const ws = addDays(weekStart, w * 7 * interval);
      for (const dow of ordered) {
        const date = addDays(ws, dow);
        if (date < startDate) continue;
        if ((until && date > until) || date > to || produced >= count) break outer;
        emit(date);
      }
    }
  }
  return out;
}

/**
 * @param {string} text raw .ics
 * @param {string} userTz fallback timezone for floating times
 * @param {{from: string, to: string}} range local dates to keep (inclusive)
 * @returns {{events: object[], warnings: string[]}} raw events ready for normalizeEvent()
 */
export function parseIcs(text, userTz, range) {
  const events = [];
  const warnings = new Set();
  const lines = unfold(String(text || ''));
  if (!lines.some((l) => l.startsWith('BEGIN:VCALENDAR'))) {
    return { events, warnings: ['Not an iCalendar feed (missing BEGIN:VCALENDAR).'] };
  }

  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = { props: [] };
    else if (line === 'END:VEVENT') {
      if (cur) blocks.push(cur);
      cur = null;
    } else if (cur) {
      const p = parseLine(line);
      if (p) cur.props.push(p);
    }
  }

  const overridden = new Map(); // uid -> Set of local dates replaced by RECURRENCE-ID instances
  const parsed = [];
  for (const b of blocks) {
    const get = (n) => b.props.find((p) => p.name === n);
    const status = get('STATUS')?.value?.toUpperCase();
    const uid = get('UID')?.value ?? null;
    const dtstartP = get('DTSTART');
    if (!dtstartP) continue;
    const start = parseDateValue(dtstartP.value, dtstartP.params);
    if (!start) {
      warnings.add('Some events had unreadable start times and were skipped.');
      continue;
    }
    const recurrenceId = get('RECURRENCE-ID');
    if (recurrenceId && uid) {
      const rid = parseDateValue(recurrenceId.value, recurrenceId.params);
      const ridDate = rid?.date ?? (rid?.utc != null ? new Date(rid.utc).toISOString().slice(0, 10) : null);
      if (ridDate) {
        if (!overridden.has(uid)) overridden.set(uid, new Set());
        overridden.get(uid).add(ridDate);
      }
    }
    if (status === 'CANCELLED') continue;
    const endP = get('DTEND');
    const durP = get('DURATION');
    const exdates = new Set();
    for (const p of b.props.filter((x) => x.name === 'EXDATE')) {
      for (const v of p.value.split(',')) {
        const ex = parseDateValue(v, p.params);
        if (ex?.date) exdates.add(ex.date);
        else if (ex?.utc != null) exdates.add(new Date(ex.utc).toISOString().slice(0, 10));
      }
    }
    parsed.push({
      uid,
      title: unescapeText(get('SUMMARY')?.value ?? ''),
      start,
      end: endP ? parseDateValue(endP.value, endP.params) : null,
      duration: durP ? parseDuration(durP.value) : null,
      rrule: get('RRULE') ? parseRrule(get('RRULE').value) : null,
      isOverride: !!recurrenceId,
      exdates,
    });
  }

  for (const ev of parsed) {
    const tz = ev.start.tzid && isValidTimeZone(ev.start.tzid) ? ev.start.tzid : userTz;
    if (ev.start.tzid && !isValidTimeZone(ev.start.tzid)) warnings.add(`Unknown timezone "${ev.start.tzid}"; used your timezone instead.`);
    if (ev.rrule && !ev.isOverride) {
      for (const d of overridden.get(ev.uid) ?? []) ev.exdates.add(d);
    }

    if (ev.start.allDay) {
      const endExclusive = ev.end?.date ?? addDays(ev.start.date, 1);
      const spanDays = Math.max(1, daysBetween(ev.start.date, endExclusive));
      const dates = ev.rrule && !ev.isOverride
        ? expandDates(ev.start.date, ev.rrule, addDays(range.from, -spanDays), range.to, ev.exdates)
        : [ev.start.date];
      if (ev.rrule && !['DAILY', 'WEEKLY'].includes(ev.rrule.FREQ)) warnings.add(`Repeating rule FREQ=${ev.rrule.FREQ} is not expanded; only the first occurrence is shown.`);
      for (const date of dates) {
        const endDate = addDays(date, spanDays - 1);
        if (endDate < range.from || date > range.to) continue;
        events.push({ id: `${ev.uid ?? ev.title}@${date}`, title: ev.title, allDay: true, date, endDate, source: 'ics' });
      }
      continue;
    }

    // Timed events: expand in local wall-clock time so DST shifts keep the same local start.
    const startLocal = ev.start.utc != null ? null : { date: ev.start.date, time: ev.start.time };
    const startMs = ev.start.utc ?? zonedToUtc(startLocal.date, startLocal.time, tz);
    let durationMs = 60 * 60_000;
    if (ev.end) {
      const endMs = ev.end.utc ?? (ev.end.date && ev.end.time ? zonedToUtc(ev.end.date, ev.end.time, ev.end.tzid && isValidTimeZone(ev.end.tzid) ? ev.end.tzid : tz) : null);
      if (endMs != null && endMs >= startMs) durationMs = endMs - startMs;
    } else if (ev.duration != null && ev.duration >= 0) {
      durationMs = ev.duration;
    }

    if (!ev.rrule || ev.isOverride) {
      events.push({ id: ev.uid ? `${ev.uid}@${startMs}` : null, title: ev.title, start: startMs, end: startMs + durationMs, source: 'ics' });
      continue;
    }
    if (!['DAILY', 'WEEKLY'].includes(ev.rrule.FREQ)) {
      warnings.add(`Repeating rule FREQ=${ev.rrule.FREQ} is not expanded; only the first occurrence is shown.`);
      events.push({ id: ev.uid ? `${ev.uid}@${startMs}` : null, title: ev.title, start: startMs, end: startMs + durationMs, source: 'ics' });
      continue;
    }
    const baseDate = startLocal ? startLocal.date : new Date(startMs).toISOString().slice(0, 10);
    for (const date of expandDates(baseDate, ev.rrule, addDays(range.from, -1), range.to, ev.exdates)) {
      const occStart = startLocal
        ? zonedToUtc(date, startLocal.time, tz)
        : startMs + daysBetween(baseDate, date) * 86_400_000;
      events.push({ id: ev.uid ? `${ev.uid}@${occStart}` : null, title: ev.title, start: occStart, end: occStart + durationMs, source: 'ics' });
    }
  }

  // Keep only events near the requested range (padded a day for timezone differences).
  const lo = Date.parse(range.from) - 86_400_000;
  const hi = Date.parse(addDays(range.to, 1)) + 86_400_000;
  const kept = events.filter((e) => e.allDay || (e.end >= lo && e.start <= hi));
  return { events: kept, warnings: [...warnings] };
}
