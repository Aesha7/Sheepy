import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, localDate, HOUR } from '../server/time.js';
import { SAMPLE_USERS } from '../server/scenarios.js';
import { buildPlan } from '../server/policy/buildPlan.js';
import { sunTimes } from '../server/sun.js';
import { plan, clone } from './helpers.js';

test('"tomorrow" is evaluated in the user timezone', () => {
  const t = Date.parse('2026-10-24T06:30:00Z'); // 11:30 PM Fri in LA, 3:30 PM Sat in Tokyo
  const la = buildPlan(SAMPLE_USERS.alex, null, null, t);
  assert.equal(la.schedule.wakeDate, '2026-10-24');
  const tokyo = buildPlan({ ...clone(SAMPLE_USERS.alex), timezone: 'Asia/Tokyo', location: { label: 'Tokyo', lat: 35.68, lon: 139.69 } }, null, null, t);
  assert.equal(tokyo.schedule.wakeDate, '2026-10-25');
});

test('after midnight we are still in the same night; after wake we plan the next one', () => {
  const twoAm = zonedToUtc('2026-10-24', '02:00', 'America/Los_Angeles');
  const p = buildPlan(SAMPLE_USERS.alex, null, null, twoAm);
  assert.equal(p.schedule.wakeDate, '2026-10-24');
  assert.equal(p.currentPhase, 'overnight');
  const afterWake = zonedToUtc('2026-10-24', '07:05', 'America/Los_Angeles');
  const q = buildPlan(SAMPLE_USERS.alex, null, null, afterWake);
  assert.equal(q.schedule.wakeDate, '2026-10-25');
  assert.equal(q.currentPhase, 'awake');
});

test('bedtime after midnight belongs to the right night', () => {
  const owl = { ...clone(SAMPLE_USERS.alex), schedule: { bedtime: '00:30', wakeTime: '08:30', windDownMinutes: 30 } };
  const evening = zonedToUtc('2026-10-23', '21:00', 'America/Los_Angeles');
  const p = buildPlan(owl, null, null, evening);
  assert.equal(p.schedule.bedtime, zonedToUtc('2026-10-24', '00:30', 'America/Los_Angeles'));
  assert.equal(p.schedule.windDownStart, zonedToUtc('2026-10-24', '00:00', 'America/Los_Angeles'));
  assert.equal(p.schedule.wakeDate, '2026-10-24');
});

test('DST fall-back night keeps local wall-clock times (9 hours in bed)', () => {
  const evening = zonedToUtc('2026-10-31', '20:00', 'America/Los_Angeles');
  const p = buildPlan(SAMPLE_USERS.alex, null, null, evening);
  assert.equal(new Date(p.schedule.bedtime).toISOString(), '2026-11-01T06:00:00.000Z'); // 11 PM PDT
  assert.equal(new Date(p.schedule.wakeEnd).toISOString(), '2026-11-01T15:00:00.000Z'); // 7 AM PST
  assert.equal((p.schedule.wakeEnd - p.schedule.bedtime) / HOUR, 9);
});

test('half-hour timezone offsets work (India)', () => {
  const t = Date.parse('2026-10-23T15:00:00Z'); // 8:30 PM IST
  const p = buildPlan({ ...clone(SAMPLE_USERS.alex), timezone: 'Asia/Kolkata', location: { label: 'Bengaluru', lat: 12.97, lon: 77.59 } }, null, null, t);
  assert.equal(new Date(p.schedule.bedtime).toISOString(), '2026-10-23T17:30:00.000Z');
  assert.equal(p.schedule.labels.bedtime, '11:00 PM');
});

test('sunrise/sunset calculation is close to published values', () => {
  const { sunrise, sunset } = sunTimes('2026-06-21', 51.5, -0.12); // London: ~04:43 / 21:21 BST
  const fmt = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(ms);
  assert.match(fmt(sunrise), /^04:4[2-6]$/);
  assert.match(fmt(sunset), /^21:(19|2[0-4])$/);
  assert.equal(sunTimes('2026-12-21', 78.2, 15.6).polar, 'night');
  assert.equal(sunTimes('2026-06-21', 78.2, 15.6).polar, 'day');
});

test('zonedToUtc round-trips through localDate', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/Berlin', 'Australia/Sydney', 'Pacific/Auckland', 'UTC']) {
    const t = zonedToUtc('2026-03-29', '23:45', tz);
    assert.equal(localDate(t, tz), '2026-03-29', tz);
  }
});

test('plan for a user in a different timezone uses their local wind-down time', () => {
  const t = Date.parse('2026-10-23T10:00:00Z');
  const berlin = plan({ ...clone(SAMPLE_USERS.alex), timezone: 'Europe/Berlin', location: { label: 'Berlin', lat: 52.52, lon: 13.4 } }, { now: t, calendar: 'none', weather: 'none' });
  assert.equal(berlin.schedule.labels.windDownStart, '10:30 PM');
});
