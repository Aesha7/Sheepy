// Classify "tomorrow" (the local date the user next wakes up on) into an editable day category.
// Rules: explicit user labels win; inferred labels are shown for correction;
// an empty or missing calendar is "unknown", never "day off"; conflicting signals ask the user.

import { zonedToUtc, addDays, formatClock, MIN } from '../time.js';
import { DAY_CATEGORIES, DAY_CATEGORY_LABELS } from '../profile.js';
import { effectiveCategory, EVENT_CATEGORY_LABELS } from './events.js';

const BUSY_EVENT_COUNT = 5;
const BUSY_TOTAL_MINUTES = 6 * 60;

function eventsOnDate(events, date, tz) {
  const dayStart = zonedToUtc(date, '00:00', tz);
  const dayEnd = zonedToUtc(addDays(date, 1), '00:00', tz);
  return events.filter((e) =>
    e.allDay ? e.startDate <= date && date <= e.endDate : e.start < dayEnd && e.end > dayStart,
  );
}

function describe(e) {
  const cat = effectiveCategory(e);
  return e.title || EVENT_CATEGORY_LABELS[cat] || 'Event';
}

/**
 * @param {object} cal normalized calendar context {status, events, dayLabels}
 * @param {string} date local wake date ("tomorrow")
 * @param {number} wakeEnd confirmed wake instant for that date
 */
export function classifyDay(cal, date, wakeEnd, tz, profile) {
  const result = {
    date,
    category: 'unknown',
    label: DAY_CATEGORY_LABELS.unknown,
    source: 'default',
    needsChoice: false,
    candidates: [],
    reasons: [],
    notices: [],
    events: [],
    firstEvent: null,
  };

  const dayEvents = eventsOnDate(cal.events, date, tz);
  result.events = dayEvents.map((e) => ({
    id: e.id,
    title: describe(e),
    category: effectiveCategory(e),
    categoryInferred: !e.category && !!e.inferredCategory,
    importance: e.importance,
    allDay: e.allDay,
    start: e.start,
    end: e.end,
    prepMinutes: e.prepMinutes,
    travelMinutes: e.travelMinutes,
    source: e.source,
  }));

  // Timing facts are useful even when the user labels the day themselves.
  // Events that started the previous evening (e.g. a late party) don't count as tomorrow's start.
  const dayStart = zonedToUtc(date, '00:00', tz);
  const timed = dayEvents.filter((e) => !e.allDay && e.start >= dayStart).sort((a, b) => a.start - b.start);
  let earlySignal = null;
  if (timed.length) {
    const first = timed[0];
    const lead = (first.prepMinutes ?? 0) + (first.travelMinutes ?? 0);
    const readyBy = first.start - lead * MIN;
    result.firstEvent = { title: describe(first), start: first.start, readyBy, leadMinutesProvided: lead > 0 ? lead : null };
    if (readyBy < wakeEnd) {
      const what = lead > 0 ? `you need to be ready at ${formatClock(readyBy, tz)} (with your ${lead} min prep/travel)` : `it starts at ${formatClock(first.start, tz)}`;
      result.notices.push(`"${describe(first)}" is before your confirmed wake time: ${what}. Nothing has been changed; edit your wake time if you need to.`);
    }
    const threshold = profile.routines.early.earlyThresholdMinutes;
    if (readyBy - wakeEnd <= threshold * MIN) {
      earlySignal = lead > 0
        ? `"${describe(first)}" at ${formatClock(first.start, tz)} plus your ${lead} min prep/travel leaves under ${threshold} min after waking`
        : `"${describe(first)}" starts at ${formatClock(first.start, tz)}, within ${threshold} min of your wake time`;
    }
    const totalMinutes = timed.reduce((s, e) => s + (e.end - e.start) / MIN, 0);
    if (!earlySignal && (timed.length >= BUSY_EVENT_COUNT || totalMinutes >= BUSY_TOTAL_MINUTES)) {
      earlySignal = `${timed.length} timed events (${Math.round(totalMinutes / 60)} h scheduled)`;
    }
  }

  const label = cal.dayLabels?.[date];
  if (label && DAY_CATEGORIES.includes(label)) {
    result.category = label;
    result.label = DAY_CATEGORY_LABELS[label];
    result.source = 'user';
    result.reasons.push(`You labeled ${date} as "${DAY_CATEGORY_LABELS[label]}".`);
    return result;
  }

  if (cal.status === 'not_connected' || cal.status === 'error') {
    if (!dayEvents.length) {
      result.reasons.push(cal.status === 'error'
        ? 'Your calendar could not be read, so tomorrow is unknown. The standard routine is used.'
        : 'No calendar is connected and no events were entered, so tomorrow is unknown. The standard routine is used.');
      return result;
    }
  }
  if (!dayEvents.length) {
    result.reasons.push('No events tomorrow. An empty calendar does not mean a day off, so tomorrow is "unknown" and the standard routine is used. Label it yourself if you like.');
    return result;
  }

  const important = dayEvents.filter((e) => e.importance === 'important' || (e.importance !== 'normal' && ['exam', 'presentation'].includes(effectiveCategory(e))));
  const relaxed = dayEvents.filter((e) => effectiveCategory(e) === 'dayoff');
  const signals = [];
  if (important.length) {
    const e = important[0];
    const why = e.importance === 'important' ? 'you marked it important' : e.category ? `category "${EVENT_CATEGORY_LABELS[e.category]}"` : `the title suggests "${EVENT_CATEGORY_LABELS[e.inferredCategory]}"`;
    signals.push(['important', `"${describe(e)}" (${why})`]);
  }
  if (earlySignal) signals.push(['early', earlySignal]);
  if (relaxed.length) {
    const e = relaxed[0];
    signals.push(['relaxed', `"${describe(e)}" (${e.category ? 'you chose day off' : 'the title suggests a day off'})`]);
  }

  result.source = 'inferred';
  const has = (k) => signals.some(([c]) => c === k);
  if (has('relaxed') && (has('important') || has('early'))) {
    result.category = 'normal';
    result.label = DAY_CATEGORY_LABELS.normal;
    result.needsChoice = true;
    result.candidates = signals.map(([c]) => c);
    result.reasons.push(`Mixed signals: ${signals.map(([, r]) => r).join('; ')}. Using your standard routine until you choose.`);
  } else if (has('important')) {
    result.category = 'important';
    result.reasons.push(`Inferred from ${signals.find(([c]) => c === 'important')[1]}.`);
    if (has('early')) result.reasons.push(`Also an early start: ${earlySignal}.`);
  } else if (has('early')) {
    result.category = 'early';
    result.reasons.push(`Inferred from ${earlySignal}.`);
  } else if (has('relaxed')) {
    result.category = 'relaxed';
    result.reasons.push(`Inferred from ${signals[0][1]}.`);
  } else {
    result.category = 'normal';
    result.reasons.push(`${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'} tomorrow, none marked important, early, or relaxing.`);
  }
  result.label = DAY_CATEGORY_LABELS[result.category];
  return result;
}
