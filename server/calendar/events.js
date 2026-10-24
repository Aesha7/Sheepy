// Calendar event normalization. We keep only what the plan needs:
// title (or a category), start/end, all-day flag, importance, optional prep/travel minutes.

import { isDate, isClock, zonedToUtc, toInstant, addDays } from '../time.js';

export const EVENT_CATEGORIES = ['exam', 'presentation', 'early', 'work', 'class', 'social', 'travel', 'dayoff', 'other'];
export const EVENT_CATEGORY_LABELS = {
  exam: 'Exam',
  presentation: 'Important presentation',
  early: 'Early commitment',
  work: 'Work / meeting',
  class: 'Class',
  social: 'Social',
  travel: 'Travel',
  dayoff: 'Day off / relaxation',
  other: 'Other',
};

// Keyword hints only: results are shown as "inferred" so the user can correct them.
const KEYWORDS = [
  ['exam', /\b(exam|midterm|final exam|finals|quiz|test)\b/i],
  ['presentation', /\b(presentation|presenting|interview|defen[cs]e|pitch|demo day|recital|audition|competition)\b/i],
  ['dayoff', /\b(day off|vacation|holiday|pto|rest day|relax(ation)?|spa day|no class(es)?|staycation)\b/i],
  ['travel', /\b(flight|airport|train to|road trip)\b/i],
  ['class', /\b(class|lecture|lab|seminar|section)\b/i],
  ['work', /\b(meeting|standup|stand-up|sync|1:1|shift|work)\b/i],
];

export function inferCategory(title) {
  if (typeof title !== 'string' || !title) return null;
  for (const [category, re] of KEYWORDS) if (re.test(title)) return category;
  return null;
}

const optMinutes = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 600 ? Math.round(n) : undefined;
};

/**
 * Validate one raw event. Returns {event} or {error}.
 * Accepts timed events as {start, end} instants or {date, startTime, endTime} in the user's timezone,
 * and all-day events as {allDay: true, date, endDate?} (endDate inclusive).
 */
export function normalizeEvent(raw, tz, source = 'manual') {
  if (!raw || typeof raw !== 'object') return { error: 'event must be an object' };
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
  const category = raw.category == null || raw.category === '' ? null : raw.category;
  if (category !== null && !EVENT_CATEGORIES.includes(category)) return { error: `unknown category "${raw.category}"` };
  if (!title && !category) return { error: 'event needs a title or a category' };
  const importance = raw.importance == null || raw.importance === '' ? null : raw.importance;
  if (importance !== null && importance !== 'important' && importance !== 'normal') return { error: 'importance must be important or normal' };
  const prepMinutes = optMinutes(raw.prepMinutes);
  const travelMinutes = optMinutes(raw.travelMinutes);
  if (prepMinutes === undefined || travelMinutes === undefined) return { error: 'prep/travel minutes must be 0-600' };

  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 200) : null,
    title,
    category,
    inferredCategory: category ? null : inferCategory(title),
    importance,
    prepMinutes,
    travelMinutes,
    source: raw.source || source,
  };

  if (raw.allDay === true || raw.allDay === 'true') {
    if (!isDate(raw.date)) return { error: 'all-day event needs a date (YYYY-MM-DD)' };
    const endDate = raw.endDate == null || raw.endDate === '' ? raw.date : raw.endDate;
    if (!isDate(endDate) || endDate < raw.date) return { error: 'all-day endDate must be on or after date' };
    return { event: { ...base, allDay: true, startDate: raw.date, endDate, start: null, end: null } };
  }

  let start;
  let end;
  if (raw.date !== undefined && raw.startTime !== undefined) {
    if (!isDate(raw.date) || !isClock(raw.startTime)) return { error: 'timed event needs date and startTime (HH:MM)' };
    start = zonedToUtc(raw.date, raw.startTime, tz);
    if (raw.endTime && isClock(raw.endTime)) {
      end = zonedToUtc(raw.date, raw.endTime, tz);
      if (end <= start) end = zonedToUtc(addDays(raw.date, 1), raw.endTime, tz);
    } else {
      end = start + 60 * 60_000;
    }
  } else {
    start = toInstant(raw.start);
    end = raw.end == null ? (start == null ? null : start + 60 * 60_000) : toInstant(raw.end);
  }
  if (start == null || end == null) return { error: 'timed event needs a valid start and end' };
  if (end < start) return { error: 'event ends before it starts' };
  return { event: { ...base, allDay: false, start, end, startDate: null, endDate: null } };
}

export function normalizeEvents(rawEvents, tz) {
  const events = [];
  const dropped = [];
  for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
    const r = normalizeEvent(raw, tz, raw?.source);
    if (r.error) dropped.push({ title: raw?.title ?? '(untitled)', error: r.error });
    else events.push(r.event);
  }
  return { events, dropped };
}

export function effectiveCategory(event) {
  return event.category ?? event.inferredCategory ?? null;
}
