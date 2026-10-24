import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWeatherAudio, AudioPolicyError, FORECAST_CAVEAT } from '../server/policy/weatherAudio.js';
import { assessWeather } from '../server/weather/analyze.js';
import { offlineWeather } from '../server/weather/offline.js';
import { buildPlan } from '../server/policy/buildPlan.js';
import { valueAt, totalVolume } from '../server/policy/timeline.js';
import { Executor } from '../server/devices/executor.js';
import { BrowserAudio, simulatedLight } from '../server/devices/adapters.js';
import { SAMPLE_USERS } from '../server/scenarios.js';
import { defaultProfile } from '../server/profile.js';
import { zonedToUtc, HOUR, MIN } from '../server/time.js';

const TZ = 'America/Los_Angeles';
const LOC = { label: 'Berkeley', lat: 37.872, lon: -122.273, timezone: TZ };
const EVENING = zonedToUtc('2026-10-23', '19:30', TZ);
const BED = zonedToUtc('2026-10-23', '23:00', TZ);
const WAKE = zonedToUtc('2026-10-24', '06:40', TZ);
const sleepPhase = { key: 'sleep', start: BED, end: WAKE, timezone: TZ };
const winddown = { key: 'winddown', start: BED - 30 * MIN, end: BED, timezone: TZ };

const wx = (scenario, now = EVENING) => assessWeather(offlineWeather(scenario, now, LOC), now, WAKE + 30 * MIN);
const prefs = (over = {}) => ({ ...defaultProfile().sound, preferred: 'pink', volume: 30, maxVolume: 45, ...over });

test('rain + mirror + enjoys rain -> gentle rain ambience at the saved level', () => {
  const s = selectWeatherAudio(wx('rain'), prefs({ weatherMode: 'mirror', rainFeeling: 'calming' }), sleepPhase, {}, EVENING);
  assert.equal(s.soundId, 'rain');
  assert.equal(s.rule, 'mirror-rain');
  assert.equal(s.volume, 30);
  assert.match(s.reason, /You enjoy rain sounds/);
  assert.ok(s.reason.includes(FORECAST_CAVEAT), 'explains that a forecast is not the bedroom');
});

test('rain + mask + rain is distracting -> saved masking sound', () => {
  const s = selectWeatherAudio(wx('rain'), prefs({ weatherMode: 'mask', rainFeeling: 'distracting', stormSound: 'brown' }), sleepPhase, {}, EVENING);
  assert.equal(s.soundId, 'brown');
  assert.equal(s.rule, 'mask-rain');
});

test('thunderstorm + mask + storms disruptive -> steady masking preset, no thunder, never louder', () => {
  const s = selectWeatherAudio(wx('thunderstorm'), prefs({ weatherMode: 'mask', stormsBother: true, stormSound: 'brown' }), sleepPhase, {}, EVENING);
  assert.equal(s.soundId, 'brown');
  assert.equal(s.rule, 'mask-storm');
  assert.deepEqual(Object.keys(s.channels), ['brown']);
  assert.equal(s.volume, 30, 'saved level, not raised');
  assert.match(s.reason, /never adds thunder sounds or gets louder/);
});

test('strong wind + mask + wind is disruptive -> masking preset', () => {
  const s = selectWeatherAudio(wx('strong-wind'), prefs({ weatherMode: 'mask', windBothers: true, stormSound: 'white' }), sleepPhase, {}, EVENING);
  assert.equal(s.soundId, 'white');
  assert.equal(s.rule, 'mask-wind');
  const calm = selectWeatherAudio(wx('strong-wind'), prefs({ weatherMode: 'mask', windBothers: false }), sleepPhase, {}, EVENING);
  assert.equal(calm.soundId, 'pink', 'wind not marked disruptive -> normal routine');
});

test('clear, cloudy, fog-free or snowy nights keep the normal routine', () => {
  for (const sc of ['clear-evening', 'cloudy']) {
    for (const mode of ['mirror', 'mask']) {
      const s = selectWeatherAudio(wx(sc), prefs({ weatherMode: mode, rainFeeling: 'distracting', stormsBother: true, windBothers: true }), sleepPhase, {}, EVENING);
      assert.equal(s.soundId, 'pink', `${sc}/${mode}`);
      assert.equal(s.rule, 'normal-routine');
    }
  }
  const snowy = structuredClone(wx('rain'));
  for (const h of snowy.hourly) Object.assign(h, { category: 'snow', condition: 'snow', rain: 0, showers: 0, precipProbability: 90 });
  const s = selectWeatherAudio(snowy, prefs({ weatherMode: 'mask', rainFeeling: 'distracting' }), sleepPhase, {}, EVENING);
  assert.equal(s.soundId, 'pink', 'snow is not rain');
});

test('silence never auto-enables sound', () => {
  for (const sc of ['rain', 'thunderstorm', 'strong-wind']) {
    const s = selectWeatherAudio(wx(sc), prefs({ weatherMode: 'silence', stormsBother: true, rainFeeling: 'calming', windBothers: true }), sleepPhase, {}, EVENING);
    assert.equal(s.soundId, 'silence', sc);
    assert.deepEqual(s.channels, {});
  }
  const mirrorSilent = selectWeatherAudio(wx('rain'), prefs({ preferred: 'silence', weatherMode: 'mirror', rainFeeling: 'calming' }), sleepPhase, {}, EVENING);
  assert.equal(mirrorSilent.soundId, 'silence', 'preferring silence: mirror never starts rain');
});

test('same forecast, different preferences -> different selections', () => {
  const w = wx('rain');
  const ids = [
    prefs({ weatherMode: 'mirror', rainFeeling: 'calming' }),
    prefs({ weatherMode: 'mask', rainFeeling: 'distracting', stormSound: 'brown' }),
    prefs({ weatherMode: 'normal', preferred: 'white' }),
    prefs({ weatherMode: 'silence' }),
  ].map((p) => selectWeatherAudio(w, p, sleepPhase, {}, EVENING).soundId);
  assert.deepEqual(ids, ['rain', 'brown', 'white', 'silence']);
});

test('manual override beats weather; Stop beats everything', () => {
  const p = prefs({ weatherMode: 'mask', stormsBother: true });
  const ov = { audio: { target: { channels: { white: 90 } }, setAt: EVENING, expiresAt: EVENING + HOUR } };
  const s = selectWeatherAudio(wx('thunderstorm'), p, sleepPhase, ov, EVENING + MIN);
  assert.equal(s.rule, 'override');
  assert.equal(s.soundId, 'white');
  assert.ok(s.volume <= 45, 'override is still capped');
  const stopped = selectWeatherAudio(wx('thunderstorm'), p, sleepPhase, { ...ov, stopped: true }, EVENING + MIN);
  assert.equal(stopped.soundId, 'silence');
  assert.equal(stopped.rule, 'stop');
});

test('stale or unavailable weather falls back to the normal routine (never "clear")', () => {
  for (const sc of ['missing', 'stale']) {
    const s = selectWeatherAudio(wx(sc), prefs({ weatherMode: 'mask', stormsBother: true, rainFeeling: 'distracting' }), sleepPhase, {}, EVENING);
    assert.equal(s.rule, 'weather-unusable', sc);
    assert.equal(s.soundId, 'pink');
    assert.doesNotMatch(s.reason, /clear/i);
    assert.match(s.reason, new RegExp(sc === 'missing' ? 'unavailable' : 'stale'));
  }
  const unknown = structuredClone(wx('rain'));
  for (const h of unknown.hourly) Object.assign(h, { category: 'unknown', condition: null, precipProbability: null, rain: null, showers: null });
  const u = selectWeatherAudio(unknown, prefs({ weatherMode: 'mirror', rainFeeling: 'calming' }), sleepPhase, {}, EVENING);
  assert.equal(u.soundId, 'pink');
  assert.match(u.reason, /treated as unknown, not clear/);
});

test('wind-down music is the chosen track whatever the weather', () => {
  for (const sc of ['rain', 'thunderstorm', 'clear-evening']) {
    const s = selectWeatherAudio(wx(sc), prefs({ weatherMode: 'mirror', rainFeeling: 'calming', windDownTrack: 'chimes' }), winddown, {}, EVENING);
    assert.equal(s.soundId, 'chimes', sc);
    assert.equal(s.kind, 'music');
    assert.match(s.reason, /weather doesn’t change your music/);
  }
});

test('explanations are preference-based and make no scientific claims', () => {
  const texts = [];
  for (const sc of ['rain', 'thunderstorm', 'strong-wind', 'clear-evening', 'missing']) {
    for (const mode of ['mirror', 'mask', 'normal', 'silence']) {
      texts.push(selectWeatherAudio(wx(sc), prefs({ weatherMode: mode, rainFeeling: 'calming', stormsBother: true, windBothers: true }), sleepPhase, {}, EVENING).reason);
    }
  }
  for (const t of texts) assert.doesNotMatch(t, /optimal|scientific|proven|best (sound|for)|clinically|therapeutic|frequency|Hz/i, t);
});

test('returns start/end, duration, saved volume, transition, reason, inputs and weather status', () => {
  const s = selectWeatherAudio(wx('rain'), prefs({ weatherMode: 'mirror', rainFeeling: 'calming', overnight: false, timerMinutes: 45 }), sleepPhase, {}, EVENING);
  assert.equal(s.start, BED);
  assert.equal(s.end, BED + 45 * MIN, 'playback timer ends it');
  assert.equal(s.durationMinutes, 45);
  assert.equal(s.transitionMinutes, 10);
  assert.ok(s.inputs.some((i) => i.kind === 'weather' && /simulated|offline/.test(i.text)));
  assert.equal(s.weather.status, 'simulated');
  assert.throws(() => selectWeatherAudio(null, null, sleepPhase, {}, EVENING), AudioPolicyError);
  assert.throws(() => selectWeatherAudio(null, prefs(), { key: 'sleep', start: 5, end: 1 }, {}, EVENING), AudioPolicyError);
});

// ---- integration with the plan ----

const plan = (user, scenario, { now = EVENING, patch, controls = {} } = {}) => {
  const profile = structuredClone(SAMPLE_USERS[user]);
  if (patch) patch(profile);
  return buildPlan(profile, null, offlineWeather(scenario, now, LOC), now, controls);
};
const sample = (p, from, to, step = MIN) => {
  const out = [];
  for (let t = from; t <= to; t += step) out.push(valueAt(p.outputs.audio, t, 'audio'));
  return out;
};

test('storms never cause volume spikes; overnight sound is stable by default', () => {
  const p = plan('sam', 'thunderstorm');
  const v = sample(p, p.schedule.windDownStart, p.schedule.wakeEnd);
  for (let i = 1; i < v.length; i++) {
    assert.ok(totalVolume(v[i]) - totalVolume(v[i - 1]) <= 3, 'no jump');
    assert.ok(totalVolume(v[i]) <= 30 + 1e-9, 'never above the saved level');
    assert.ok(!('thunder' in v[i].channels));
  }
  const night = sample(p, p.schedule.settleEnd, p.schedule.wakeStart - MIN);
  assert.ok(night.every((x) => JSON.stringify(x) === JSON.stringify(night[0])), 'one steady sound all night');
  assert.deepEqual(night[0], { channels: { brown: 30 } });
});

test('overnight weather changes only with the saved opt-in, as 20-minute crossfades', () => {
  const p = plan('sam', 'thunderstorm', { patch: (x) => { x.sound.weatherTransitions = true; x.sound.rainFeeling = 'neutral'; } });
  const at = (h, m = '00') => valueAt(p.outputs.audio, zonedToUtc('2026-10-24', `${h}:${m}`, TZ), 'audio');
  assert.deepEqual(at('04'), { channels: { white: 30 } }, 'normal sound outside the storm window');
  assert.deepEqual(at('01'), { channels: { brown: 30 } }, 'masking preset inside it');
  assert.equal(p.audio.switched.length, 1);
  const seg = p.outputs.audio.find((s) => s.weather === 'mask-storm');
  assert.equal(seg.transitionMinutes, 20);
});

test('locked overnight sound survives forecast changes and stale data', () => {
  const t = zonedToUtc('2026-10-24', '01:00', TZ);
  const first = plan('alex', 'rain', { now: t });
  assert.equal(first.audio.sleep.soundId, 'rain');
  const lock = { night: first.schedule.eveningDate, selection: { soundId: 'rain', rule: 'mirror-rain', reason: first.audio.sleep.reason } };
  for (const sc of ['clear-evening', 'missing', 'stale']) {
    const later = plan('alex', sc, { now: t + 10 * MIN, controls: { audioLock: lock } });
    assert.equal(later.audio.sleep.soundId, 'rain', sc);
    assert.equal(later.audio.sleep.locked, true);
    assert.deepEqual(valueAt(later.outputs.audio, t + 10 * MIN, 'audio'), { channels: { rain: 35 } }, `${sc}: no interruption`);
  }
});

test('repeated refreshes do not restart or re-send audio', async () => {
  const start = zonedToUtc('2026-10-24', '01:00', TZ);
  const clock = { t: start };
  const browser = new BrowserAudio();
  const ex = new Executor({ adapters: { light: simulatedLight(), audio: browser, fan: null }, clock: () => clock.t });
  browser.heartbeat(clock.t, { enabled: true });
  for (let i = 0; i < 120; i++) {
    if (i % 15 === 0) ex.setPlan(plan('sam', 'thunderstorm', { now: clock.t }), { maxVolume: 40 }); // re-plan every 30 s
    await ex.tick().settled;
    if (browser.command) ex.confirm('audio', browser.command.seq, browser.command.cmd);
    browser.heartbeat(clock.t, { enabled: true });
    clock.t += 2000;
  }
  const seqAfterRamp = browser.seq;
  for (let i = 0; i < 60; i++) {
    if (i % 15 === 0) ex.setPlan(plan('sam', 'thunderstorm', { now: clock.t }), { maxVolume: 40 });
    await ex.tick().settled;
    browser.heartbeat(clock.t, { enabled: true });
    clock.t += 2000;
  }
  assert.equal(browser.seq, seqAfterRamp, 'no new commands once the sound is steady');
  assert.equal(ex.snapshot().outputs.audio.status, 'playing');
});

test('Stop prevents queued weather changes', async () => {
  const start = zonedToUtc('2026-10-23', '23:25', TZ);
  const clock = { t: start };
  const browser = new BrowserAudio();
  const ex = new Executor({ adapters: { light: simulatedLight(), audio: browser, fan: null }, clock: () => clock.t });
  browser.heartbeat(clock.t, { enabled: true });
  ex.setPlan(plan('sam', 'thunderstorm', { now: start }), { maxVolume: 40 });
  await ex.tick().settled;
  await ex.stop().settled;
  assert.deepEqual(browser.command.cmd.channels, {});
  for (let i = 0; i < 300; i++) {
    clock.t += 2000;
    await ex.tick().settled;
  }
  assert.deepEqual(browser.command.cmd.channels, {}, 'storm preset never starts after Stop');
});

test('browser playback states: disconnected, blocked, failed, playing', async () => {
  const clock = { t: BED + 30 * MIN };
  const browser = new BrowserAudio();
  const ex = new Executor({ adapters: { light: simulatedLight(), audio: browser, fan: null }, clock: () => clock.t });
  ex.setPlan(plan('alex', 'rain', { now: clock.t }), { maxVolume: 50 });
  await ex.tick().settled;
  assert.equal(ex.snapshot().outputs.audio.status, 'disconnected');
  browser.heartbeat(clock.t, { enabled: false });
  assert.equal(ex.snapshot().outputs.audio.status, 'blocked');
  browser.heartbeat(clock.t, { enabled: true, error: 'AudioContext could not start' });
  assert.equal(ex.snapshot().outputs.audio.status, 'failed');
  browser.heartbeat(clock.t, { enabled: true });
  ex.confirm('audio', browser.command.seq, browser.command.cmd);
  assert.equal(ex.snapshot().outputs.audio.status, 'playing');
});

test('midnight and timezone boundaries: storms after midnight in Tokyo', () => {
  const tz = 'Asia/Tokyo';
  const loc = { label: 'Tokyo', lat: 35.68, lon: 139.69, timezone: tz };
  const now = zonedToUtc('2026-10-23', '20:00', tz);
  const profile = { ...structuredClone(SAMPLE_USERS.sam), timezone: tz, location: loc };
  const p = buildPlan(profile, null, offlineWeather('thunderstorm', now, loc), now);
  assert.equal(p.schedule.wakeDate, '2026-10-24');
  assert.equal(p.audio.sleep.rule, 'mask-storm');
  assert.match(p.audio.sleep.reason, /12:00 AM–3:00 AM/);
  assert.deepEqual(valueAt(p.outputs.audio, zonedToUtc('2026-10-24', '01:30', tz), 'audio'), { channels: { brown: 30 } });
});

test('dashboard example: rain during wind-down with rain ambience preference', () => {
  const p = plan('alex', 'rain');
  assert.equal(p.audio.winddown.soundId, 'rain');
  assert.match(p.audio.winddown.reason, /Rain is forecast .* during your wind-down .* You enjoy rain sounds and chose Mirror weather, so your gentle, steady rain ambience is scheduled/);
});
