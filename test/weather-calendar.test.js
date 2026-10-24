import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWeather, findWeatherWindows, stabilizeWindows } from '../server/weather/analyze.js';
import { parseIcs } from '../server/calendar/ics.js';
import { normalizeEvent, inferCategory } from '../server/calendar/events.js';
import { feedbackSuggestions, applySuggestion } from '../server/policy/feedback.js';
import { simulatedWeather, SAMPLE_USERS, SCENARIOS, scenarioInputs } from '../server/scenarios.js';
import { buildPlan } from '../server/policy/buildPlan.js';
import { zonedToUtc, HOUR, MIN } from '../server/time.js';
import { valueAt } from '../server/policy/timeline.js';
import { plan, EVENING, TZ } from './helpers.js';

test('weather assessment distinguishes current, forecast, missing and stale', () => {
  assert.equal(assessWeather(null, EVENING, EVENING).status, 'unavailable');
  const wx = simulatedWeather('rain', EVENING);
  const fresh = assessWeather(wx, EVENING, EVENING + 12 * HOUR);
  assert.equal(fresh.status, 'simulated', 'usable offline data is labeled simulated, never "fresh"');
  assert.equal(fresh.usable, true);
  assert.equal(fresh.currentStatus, 'fresh');
  const oldObs = assessWeather({ ...wx, current: { ...wx.current, time: EVENING - 5 * HOUR } }, EVENING, EVENING + 12 * HOUR);
  assert.equal(oldObs.currentStatus, 'stale');
  assert.equal(oldObs.forecastStatus, 'fresh');
  const errored = assessWeather({ source: 'open-meteo', error: 'timeout' }, EVENING, EVENING);
  assert.equal(errored.status, 'unavailable');
  assert.ok(errored.notes.some((n) => /timeout/.test(n)));
});

test('rain windows use hysteresis (enter at 50%, stay open at 30%)', () => {
  const h = (i, p) => ({ time: EVENING + i * HOUR, condition: null, precipProbability: p, cloudCover: 80, thunderProbability: null });
  const hourly = [h(0, 20), h(1, 55), h(2, 35), h(3, 40), h(4, 20), h(5, 45)];
  const w = findWeatherWindows(hourly, EVENING, EVENING + 6 * HOUR).filter((x) => x.kind === 'rain');
  assert.equal(w.length, 1);
  assert.equal(w[0].start, EVENING + HOUR);
  assert.equal(w[0].end, EVENING + 4 * HOUR);
});

test('forecast changes do not repeatedly restart transitions', () => {
  const t0 = zonedToUtc('2026-10-24', '01:10', TZ);
  const prev = [{ kind: 'rain', start: zonedToUtc('2026-10-24', '01:00', TZ), end: zonedToUtc('2026-10-24', '04:00', TZ) }];
  // New forecast moves the start to 1:15 while we are already at 1:10: keep the original start.
  const shifted = stabilizeWindows([{ kind: 'rain', start: zonedToUtc('2026-10-24', '01:15', TZ), end: zonedToUtc('2026-10-24', '04:30', TZ) }], prev, t0);
  assert.equal(shifted[0].start, prev[0].start);
  // New forecast drops the rain entirely: hold for up to an hour, then fade, rather than cutting off.
  const dropped = stabilizeWindows([], prev, t0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].end, t0 + 60 * MIN);
  // Running again with the released window does not extend it further.
  const again = stabilizeWindows([], dropped, t0 + 30 * MIN);
  assert.equal(again[0].end, dropped[0].end);
  // Future windows ignore small shifts.
  const future = stabilizeWindows([{ kind: 'rain', start: prev[0].start + 30 * MIN, end: prev[0].end }], prev, prev[0].start - 2 * HOUR);
  assert.equal(future[0].start, prev[0].start);

  // End to end: a plan at 1:10 AM with a shifted forecast keeps the audio value continuous.
  const mk = (wx, controls) => plan('alex', { now: t0, weather: wx, controls });
  const wxA = simulatedWeather('rain', EVENING);
  const before = mk(wxA, {});
  const wxB = structuredClone(wxA);
  for (const e of wxB.hourly) if (e.time === zonedToUtc('2026-10-24', '01:00', TZ)) e.precipProbability = 10;
  const after = mk(wxB, { previousWindows: before.weather.windows });
  const v = (p) => valueAt(p.outputs.audio, t0, 'audio').channels.rain;
  assert.equal(v(after), v(before));
});

test('ICS parsing: timed, all-day, TZID, weekly RRULE with EXDATE, cancelled', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:CS 170 Midterm', 'DTSTART;TZID=America/Los_Angeles:20261024T090000', 'DTEND;TZID=America/Los_Angeles:20261024T110000', 'DESCRIPTION:room 101 secret notes', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Vacation', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261027', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Standup', 'DTSTART;TZID=America/Los_Angeles:20261019T083000', 'DURATION:PT15M',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR,SA', 'EXDATE;TZID=America/Los_Angeles:20261024T083000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'DTSTART:20261024T170000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { events } = parseIcs(ics, TZ, { from: '2026-10-23', to: '2026-10-27' });
  const exam = events.find((e) => e.title === 'CS 170 Midterm');
  assert.equal(exam.start, zonedToUtc('2026-10-24', '09:00', TZ));
  assert.equal(exam.description, undefined, 'descriptions are not kept');
  const vac = events.find((e) => e.title === 'Vacation');
  assert.deepEqual([vac.date, vac.endDate], ['2026-10-25', '2026-10-26']);
  const standups = events.filter((e) => e.title === 'Standup').map((e) => new Date(e.start).toISOString());
  assert.ok(standups.includes(new Date(zonedToUtc('2026-10-23', '08:30', TZ)).toISOString()));
  assert.ok(!standups.includes(new Date(zonedToUtc('2026-10-24', '08:30', TZ)).toISOString()), 'EXDATE respected');
  assert.ok(standups.includes(new Date(zonedToUtc('2026-10-26', '08:30', TZ)).toISOString()));
  assert.ok(!events.some((e) => e.title === 'Cancelled thing'));
});

test('event normalization: manual entry fallback and keyword inference', () => {
  const r = normalizeEvent({ category: 'exam', date: '2026-10-24', startTime: '09:00', endTime: '11:00', importance: 'important' }, TZ);
  assert.equal(r.event.start, zonedToUtc('2026-10-24', '09:00', TZ));
  assert.ok(normalizeEvent({ date: '2026-10-24', startTime: '09:00' }, TZ).error, 'needs a title or category');
  assert.ok(normalizeEvent({ title: 'x', date: '2026-02-30', startTime: '09:00' }, TZ).error);
  assert.equal(inferCategory('Physics final exam'), 'exam');
  assert.equal(inferCategory('Coffee with Sam'), null);
});

test('feedback produces suggestions only; nothing changes until applied; cap respected', () => {
  const p = structuredClone(SAMPLE_USERS.alex);
  p.sound.volume = p.sound.maxVolume;
  const s = feedbackSuggestions(p, [{ night: '2026-10-23', light: 'too_bright', sound: 'too_quiet' }]);
  assert.ok(s.find((x) => x.id === 'light-down').patch);
  const cap = s.find((x) => x.id === 'sound-cap');
  assert.equal(cap.patch, null, 'never suggests going over the cap');
  assert.equal(p.lighting.maxBrightness, 80, 'profile untouched');
  const applied = applySuggestion(p, s.find((x) => x.id === 'light-down'));
  assert.equal(applied.profile.lighting.maxBrightness, 70);
  assert.ok(!s.some((x) => JSON.stringify(x.patch ?? {}).includes('wakeTime')), 'no wake-time changes from feedback');
});

test('all demo scenarios build and are marked simulated', () => {
  for (const sc of SCENARIOS) {
    for (const run of sc.runs) {
      const i = scenarioInputs(sc, run);
      const p = buildPlan(i.profile, i.calendar, i.weather, i.now, i.controls);
      if (run.weather !== 'none') assert.equal(p.weather.simulated, true, sc.id);
      if (run.calendar !== 'none') assert.equal(p.calendar.simulated, true, sc.id);
    }
  }
});
