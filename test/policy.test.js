import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, PlanInputError } from '../server/policy/buildPlan.js';
import { SAMPLE_USERS, simulatedWeather, simulatedCalendar } from '../server/scenarios.js';
import { zonedToUtc, HOUR } from '../server/time.js';
import { plan, sample, clone, totalVolume, valueAt, EVENING, TZ, MIN } from './helpers.js';

test('different users receive different plans from the same context', () => {
  const ctx = { calendar: 'normal', weather: 'rain' };
  const alex = plan('alex', ctx);
  const sam = plan('sam', ctx);
  const jordan = plan('jordan', ctx);
  const at3am = zonedToUtc('2026-10-24', '03:00', TZ);
  const a = valueAt(alex.outputs.audio, at3am, 'audio');
  const s = valueAt(sam.outputs.audio, at3am, 'audio');
  const j = valueAt(jordan.outputs.audio, at3am, 'audio');
  assert.deepEqual(a.channels, { rain: 35 }, 'Alex (enjoys rain, Mirror weather) gets rain ambience at the saved level');
  assert.deepEqual(Object.keys(s.channels), ['brown'], 'Sam (rain distracting, mask) gets their brown masking preset');
  assert.deepEqual(j.channels, {}, 'Jordan (silence) gets no sound');
  assert.notEqual(alex.schedule.windDownStart, sam.schedule.windDownStart);
  const lightAt = (p) => valueAt(p.outputs.light, zonedToUtc('2026-10-23', '22:50', TZ), 'light').brightness;
  assert.notEqual(lightAt(alex), lightAt(sam));
});

test('plan is deterministic: same inputs give identical output', () => {
  const a = plan('alex', { calendar: 'exam', weather: 'storm' });
  const b = plan('alex', { calendar: 'exam', weather: 'storm' });
  assert.deepEqual(a, b);
});

test('invalid profile is rejected; missing values fall back with an explicit notice', () => {
  assert.throws(() => buildPlan({ ...SAMPLE_USERS.alex, sound: { ...SAMPLE_USERS.alex.sound, maxVolume: 400 } }, null, null, EVENING), PlanInputError);
  assert.throws(() => buildPlan(SAMPLE_USERS.alex, null, null, 'not a date'), PlanInputError);
  const p = buildPlan({ id: 'x', name: 'X' }, null, null, EVENING);
  assert.ok(p.explanations.some((e) => /defaults for timezone, schedule.bedtime, schedule.wakeTime/.test(e.text)));
});

test('sunrise during the sleep window never brightens the room', () => {
  // Summer-like early sunrise: use a June night where sunrise (~5:50) is well before the 7:00 wake.
  const now = zonedToUtc('2026-06-20', '20:00', TZ);
  const p = plan('alex', { now, weather: simulatedWeather('clear', now), calendar: simulatedCalendar('normal', now) });
  const sunrise = p.sun.find((s) => s.date === '2026-06-21').sunrise;
  assert.ok(sunrise < p.schedule.wakeStart, 'fixture: sunrise is before the wake window');
  for (const { t, v } of sample(p, 'light', p.schedule.settleEnd, p.schedule.wakeStart - MIN)) {
    assert.equal(v.brightness, SAMPLE_USERS.alex.lighting.nightLightBrightness, `light stays at night level at ${new Date(t).toISOString()}`);
  }
  assert.ok(p.explanations.some((e) => e.kind === 'sun' && /before your wake window/.test(e.text)));
});

test('weather never causes flashing lights or sudden volume jumps', () => {
  for (const user of ['alex', 'sam', 'jordan']) {
    for (const weather of ['storm', 'rain']) {
      const p = plan(user, { weather, calendar: 'normal' });
      const lights = sample(p, 'light', p.schedule.awakeStart, p.schedule.morningEnd);
      let reversals = 0;
      let lastDir = 0;
      for (let i = 1; i < lights.length; i++) {
        const d = lights[i].v.brightness - lights[i - 1].v.brightness;
        assert.ok(Math.abs(d) <= 10, `${user}/${weather}: brightness moved ${d.toFixed(1)}% in one minute`);
        const dir = Math.sign(Math.round(d * 100));
        if (dir && lastDir && dir !== lastDir) reversals++;
        if (dir) lastDir = dir;
      }
      assert.ok(reversals <= 8, `${user}/${weather}: no flicker (${reversals} direction changes over a day)`);
      // During sleep, lights are completely steady regardless of storms.
      const night = sample(p, 'light', p.schedule.settleEnd, p.schedule.wakeStart - MIN);
      assert.ok(night.every((x) => x.v.brightness === night[0].v.brightness), `${user}/${weather}: steady overnight`);
      const audio = sample(p, 'audio', p.schedule.windDownStart, p.schedule.morningEnd);
      for (let i = 1; i < audio.length; i++) {
        const up = totalVolume(audio[i].v) - totalVolume(audio[i - 1].v);
        assert.ok(up <= 3, `${user}/${weather}: volume rose ${up.toFixed(1)}% in one minute`);
        assert.ok(totalVolume(audio[i].v) <= SAMPLE_USERS[user].sound.maxVolume + 1e-9, 'volume never exceeds the cap');
      }
    }
  }
});

test('storm forecast but weather sound off or silence preferred: stays silent', () => {
  const silent = plan('jordan', { weather: 'storm' });
  for (const { v } of sample(silent, 'audio', silent.schedule.awakeStart, silent.schedule.morningEnd, 5)) assert.deepEqual(v.channels, {});
  const off = plan('alex', { weather: 'storm', patch: (p) => { p.sound.weatherMode = 'off'; } });
  const at1am = zonedToUtc('2026-10-24', '01:00', TZ);
  assert.deepEqual(Object.keys(valueAt(off.outputs.audio, at1am, 'audio').channels), ['pink'], 'base sound unchanged, no storm preset');
  assert.ok(off.explanations.some((e) => /Keep my normal routine/.test(e.text)));
});

test('storm masking uses the user preset, steady, at their usual level (never raised)', () => {
  const p = plan('sam', { weather: 'storm', calendar: 'normal' });
  const at1am = zonedToUtc('2026-10-24', '01:00', TZ);
  assert.deepEqual(valueAt(p.outputs.audio, at1am, 'audio'), { channels: { brown: 30 } });
  assert.ok(p.explanations.some((e) => /You find storms disruptive and chose Mask, so your saved steady brown noise preset/.test(e.text)));
  assert.ok(!p.explanations.some((e) => /cancel/i.test(e.text)), 'never claims to cancel thunder');
});

test('missing calendar data does not imply a free day', () => {
  const none = plan('alex', { calendar: 'none' });
  assert.equal(none.day.category, 'unknown');
  assert.equal(none.routine.key, 'standard');
  const empty = plan('alex', { calendar: 'empty' });
  assert.equal(empty.day.category, 'unknown');
  assert.match(empty.day.reasons[0], /does not mean a day off/);
});

test('explicit user label overrides inference; conflicts ask the user and stay conservative', () => {
  const cal = simulatedCalendar('exam', EVENING);
  cal.dayLabels = { '2026-10-24': 'relaxed' };
  const p = plan('alex', { calendar: cal });
  assert.equal(p.day.category, 'relaxed');
  assert.equal(p.day.source, 'user');

  const conflict = plan('alex', { calendar: 'conflict' });
  assert.equal(conflict.day.needsChoice, true);
  assert.equal(conflict.routine.key, 'standard');
  assert.deepEqual(conflict.day.candidates.sort(), ['important', 'relaxed']);
});

test('proposed schedule changes are not applied until accepted; wake time never changes silently', () => {
  const cal = simulatedCalendar('relaxed', EVENING);
  const pending = plan('alex', { calendar: cal });
  assert.equal(pending.day.category, 'relaxed');
  assert.ok(pending.proposals.length >= 2 && pending.proposals.every((p) => p.status === 'pending'));
  assert.equal(pending.schedule.wakeClock, '07:00', 'wake time unchanged while pending');
  assert.equal(pending.schedule.windDownMinutes, 30);

  const accepted = plan('alex', { calendar: cal, controls: { decisions: { '2026-10-24': { accepted: { wakeTime: '08:30' } } } } });
  assert.equal(accepted.schedule.wakeClock, '08:30');
  assert.equal(accepted.schedule.wakeEnd, zonedToUtc('2026-10-24', '08:30', TZ));

  const declined = plan('alex', { calendar: cal, controls: { decisions: { '2026-10-24': { declined: ['relaxed.wakeTime'] } } } });
  assert.equal(declined.proposals.find((p) => p.id === 'relaxed.wakeTime').status, 'declined');
  assert.equal(declined.schedule.wakeClock, '07:00');
});

test('early start: earlier bedtime is offered, prep time never inferred, conflicts noticed not changed', () => {
  const p = plan('sam', { calendar: 'early' });
  assert.equal(p.day.category, 'early');
  assert.equal(p.proposals[0].field, 'bedtime');
  assert.equal(p.proposals[0].status, 'pending');
  // Event before wake with no prep time given: notice only; nothing is invented.
  const now = EVENING;
  const tomorrow = '2026-10-24';
  const cal = { status: 'manual', events: [{ title: 'Flight', start: zonedToUtc(tomorrow, '07:00', TZ), end: zonedToUtc(tomorrow, '09:00', TZ) }] };
  const q = plan('sam', { calendar: cal, now });
  assert.equal(q.day.firstEvent.leadMinutesProvided, null);
  assert.ok(q.explanations.some((e) => /before your confirmed wake time/.test(e.text)));
  assert.equal(q.schedule.wakeClock, '07:30');
});

test('important day: exam explanation text and steady familiar sound (no rain layer)', () => {
  const p = plan('alex', { calendar: 'exam', weather: 'rain', controls: { decisions: { '2026-10-24': { accepted: { windDownMinutes: 45 } } } } });
  const text = p.explanations.map((e) => e.text).join('\n');
  assert.match(text, /You marked tomorrow’s CS 170 Midterm as important and selected a 45-minute wind-down\. Your evening lighting will gradually dim at 10:15 PM\./);
  const at3am = zonedToUtc('2026-10-24', '03:00', TZ);
  assert.deepEqual(valueAt(p.outputs.audio, at3am, 'audio'), { channels: { pink: 35 } });
  assert.ok(!/improve|guarantee better/i.test(text.replace(p.disclaimer, '')));
});

test('stale weather falls back to the standard routine', () => {
  const wx = simulatedWeather('storm', EVENING);
  wx.fetchedAt = EVENING - 20 * HOUR;
  const p = plan('sam', { weather: wx });
  assert.equal(p.weather.status, 'stale');
  assert.equal(p.weather.windows.length, 0);
  const at1am = zonedToUtc('2026-10-24', '01:00', TZ);
  assert.deepEqual(Object.keys(valueAt(p.outputs.audio, at1am, 'audio').channels), ['white'], 'standard sound, no storm preset');
  assert.ok(p.explanations.some((e) => /stale/.test(e.text)));
  // A forecast that ends before wake time is also not trusted.
  const short = simulatedWeather('rain', EVENING);
  short.hourly = short.hourly.filter((h) => h.time < EVENING + 2 * HOUR);
  assert.equal(plan('alex', { weather: short }).weather.forecastStatus, 'stale');
});

test('outdoor mirroring off uses scheduled scenes; cloudy preference changes daytime scene', () => {
  const noon = zonedToUtc('2026-10-23', '12:00', TZ);
  const clear = plan('alex', { weather: simulatedWeather('clear', noon), now: noon });
  const cloudy = plan('alex', { weather: simulatedWeather('cloudy', noon), now: noon });
  const at2pm = zonedToUtc('2026-10-23', '14:00', TZ);
  const b = (p) => valueAt(p.outputs.light, at2pm, 'light').brightness;
  assert.equal(b(clear), 80);
  assert.equal(b(cloudy), 56, 'softer scene on overcast days');
  const unmirrored = plan('alex', { weather: simulatedWeather('cloudy', noon), now: noon, patch: (p) => { p.lighting.mirrorDaylight = false; } });
  assert.equal(b(unmirrored), 80);
  assert.ok(unmirrored.outputs.light.some((s) => /Outdoor mirroring is off/.test(s.reason)));
});

test('manual override marks planned segments and appears in explanations', () => {
  const t = zonedToUtc('2026-10-23', '22:40', TZ);
  const p = plan('alex', { now: t, controls: { overrides: { light: { target: { brightness: 60 }, setAt: t, expiresAt: t + 30 * MIN } } } });
  assert.ok(p.overrides.light.active);
  assert.ok(p.outputs.light.some((s) => s.overridden));
  assert.ok(p.outputs.light.filter((s) => s.start >= t + 30 * MIN).every((s) => !s.overridden));
});

test('every planned output has target, times, transition, reason and inputs', () => {
  const p = plan('sam', { calendar: 'early', weather: 'storm' });
  for (const output of ['light', 'audio', 'fan']) {
    for (const s of p.outputs[output]) {
      assert.ok(s.target && s.start < s.end && s.transitionMinutes >= 0 && s.reason && Array.isArray(s.inputs) && s.inputs.length, `${output} ${s.id}`);
      assert.equal(typeof s.overridden, 'boolean');
    }
    for (let i = 1; i < p.outputs[output].length; i++) assert.equal(p.outputs[output][i].start, p.outputs[output][i - 1].end, 'segments are contiguous');
  }
});

test('weather does not enable audio when user sound is off overnight (mirror mode)', () => {
  const p = plan('alex', { weather: 'rain', patch: (x) => { x.sound.overnight = false; } });
  const at3am = zonedToUtc('2026-10-24', '03:00', TZ);
  assert.deepEqual(valueAt(p.outputs.audio, at3am, 'audio').channels, {});
});

test('profile volume above cap is clamped with a warning', () => {
  const profile = clone(SAMPLE_USERS.alex);
  profile.sound.volume = 90;
  const p = buildPlan(profile, null, null, EVENING);
  assert.ok(p.explanations.some((e) => /lowered to the cap/.test(e.text)));
  const at1am = zonedToUtc('2026-10-24', '01:00', TZ);
  assert.ok(totalVolume(valueAt(p.outputs.audio, at1am, 'audio')) <= 50);
});
