import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../server/devices/executor.js';
import { simulatedLight, simulatedAudio, simulatedFan, BrowserAudio, createAdapters } from '../server/devices/adapters.js';
import { zonedToUtc } from '../server/time.js';
import { plan, TZ, MIN } from './helpers.js';

function rig({ now, light = simulatedLight(), audio = simulatedAudio(), fan = simulatedFan() } = {}) {
  const clock = { t: now };
  const ex = new Executor({ adapters: { light, audio, fan }, clock: () => clock.t, minIntervalMs: 2000 });
  return { ex, clock, light, audio, fan };
}

async function run(ex, clock, seconds, step = 2) {
  for (let s = 0; s < seconds; s += step) {
    clock.t += step * 1000;
    await ex.tick().settled;
  }
}

test('manual override wins over the plan, then glides back without a jump', async () => {
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  const p = plan('alex', { now: start });
  const { ex, clock, light } = rig({ now: start });
  ex.setPlan(p, { maxVolume: 50 });
  await run(ex, clock, 10);
  const planned = light.state.brightness;
  ex.setOverride('light', { brightness: 70 }, 10);
  await run(ex, clock, 4);
  assert.equal(light.state.brightness, 70, 'override applied');
  assert.equal(ex.snapshot().outputs.light.source, 'override');
  await run(ex, clock, 10 * 60 - 4); // until expiry
  const atExpiry = light.state.brightness;
  await run(ex, clock, 4);
  assert.ok(Math.abs(light.state.brightness - atExpiry) < 5, 'no jump right after expiry');
  await run(ex, clock, 6 * 60);
  assert.equal(ex.snapshot().outputs.light.source, 'plan');
  assert.ok(light.state.brightness < planned, 'back on the dimming plan');
});

test('automatic changes are slew-limited: a plan step never becomes a volume or brightness jump', async () => {
  const start = zonedToUtc('2026-10-23', '23:20', TZ);
  const p = plan('alex', { now: start });
  const { ex, clock, audio } = rig({ now: start });
  ex.setPlan(p, { maxVolume: 50 });
  let prev = 0;
  for (let i = 0; i < 40; i++) {
    clock.t += 2000;
    await ex.tick().settled;
    const v = Object.values(audio.state?.channels ?? {}).reduce((a, b) => a + b, 0);
    assert.ok(v - prev <= 1.01, `volume rose ${v - prev} in 2s`);
    prev = v;
  }
  assert.ok(prev > 0 && prev <= 35);
});

test('volume never exceeds the user cap, even via override', async () => {
  const start = zonedToUtc('2026-10-23', '23:20', TZ);
  const { ex, clock, audio } = rig({ now: start });
  ex.setPlan(plan('alex', { now: start }), { maxVolume: 20 });
  ex.setOverride('audio', { channels: { brown: 90 } }, null);
  await run(ex, clock, 600);
  const v = Object.values(audio.state.channels).reduce((a, b) => a + b, 0);
  assert.ok(v <= 20.0001, `volume ${v}`);
});

test('color temperature is only sent when the light supports it', async () => {
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  const { ex, clock, light } = rig({ now: start, light: simulatedLight({ colorTemp: false }) });
  ex.setPlan(plan('alex', { now: start }), { maxVolume: 50 });
  await run(ex, clock, 4);
  assert.equal(light.state.colorTempK, undefined);
  assert.ok(typeof light.state.brightness === 'number');
});

test('identical commands are deduplicated and commands are rate-limited', async () => {
  const start = zonedToUtc('2026-10-24', '02:00', TZ); // steady overnight
  const { ex, clock, light } = rig({ now: start });
  let calls = 0;
  const orig = light.apply.bind(light);
  light.apply = (c) => (calls++, orig(c));
  ex.setPlan(plan('alex', { now: start }), { maxVolume: 50 });
  await run(ex, clock, 120);
  assert.equal(calls, 1, 'only one command for an unchanging target');
  // Rate limit: ticking faster than minInterval doesn't send faster.
  ex.setOverride('light', { brightness: 10 }, 5);
  ex.setOverride('light', { brightness: 20 }, 5);
  await ex.tick().settled;
  await ex.tick().settled;
  assert.ok(calls <= 2);
});

test('Stop cancels pending output changes and silences audio immediately', async () => {
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  // A light whose commands only complete when the test releases them.
  const slowLight = simulatedLight();
  const applied = [];
  const waiting = [];
  slowLight.apply = (cmd) => new Promise((resolve) => {
    applied.push(cmd);
    waiting.push(() => resolve({ ok: true, state: cmd }));
  });
  const drain = () => { while (waiting.length) waiting.shift()(); };
  // Device calls start in a microtask, so keep releasing until this tick's calls have all finished.
  const finish = async ({ settled }) => {
    let done = false;
    settled.then(() => { done = true; });
    while (!done) {
      await new Promise((r) => setImmediate(r));
      drain();
    }
  };
  const { ex, clock, audio } = rig({ now: start, light: slowLight });
  ex.setPlan(plan('alex', { now: start }), { maxVolume: 50 });
  ex.setOverride('audio', { channels: { pink: 30 } }, null);
  for (let i = 0; i < 30; i++) {
    clock.t += 2000;
    ex.tick(); // the first light command stays in flight the whole time
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(Object.keys(audio.state.channels).length, 'audio was playing');
  // The user asks for 90% brightness, but the device is still busy: the change is pending.
  ex.setOverride('light', { brightness: 90 }, 30);
  clock.t += 2000;
  ex.tick();
  assert.ok(applied.every((c) => c.brightness !== 90), 'fixture: 90% not sent yet');
  await finish(ex.stop());
  assert.deepEqual(audio.state.channels, {}, 'audio silenced at once');
  assert.equal(ex.snapshot().stopped, true);
  assert.deepEqual(ex.overrides, {}, 'pending overrides cancelled');
  for (let i = 0; i < 30; i++) {
    clock.t += 2000;
    await finish(ex.tick());
  }
  assert.ok(applied.every((c) => c.brightness !== 90), 'the pending 90% change is never sent after Stop');
  assert.equal(applied.at(-1).brightness, applied[0].brightness, 'light holds its last level');
  // Resume brings audio back gradually, not as a jump.
  ex.resume();
  clock.t += 2000;
  await finish(ex.tick());
  const v = Object.values(audio.state.channels ?? {}).reduce((a, b) => a + b, 0);
  assert.ok(v <= 3, `resume starts quietly (${v})`);
});

test('pause holds outputs; desired and confirmed state are tracked separately', async () => {
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  const browser = new BrowserAudio();
  const { ex, clock } = rig({ now: start, audio: browser });
  ex.setPlan(plan('alex', { now: start }), { maxVolume: 50 });
  await run(ex, clock, 4);
  let snap = ex.snapshot().outputs.audio;
  assert.equal(snap.status, 'disconnected', 'no tab open -> disconnected, not "applied"');
  assert.match(snap.detail, /No dashboard tab/);
  browser.heartbeat(clock.t, { enabled: true });
  await run(ex, clock, 4);
  snap = ex.snapshot().outputs.audio;
  assert.equal(snap.status, 'pending', 'sent but not acknowledged');
  assert.equal(snap.confirmed, null);
  ex.confirm('audio', browser.command.seq, browser.command.cmd);
  browser.heartbeat(clock.t, { enabled: true });
  assert.equal(ex.snapshot().outputs.audio.status, 'playing', 'acknowledged and audible');
  ex.pause();
  const before = browser.seq;
  await run(ex, clock, 60);
  assert.equal(browser.seq, before, 'no commands while paused');
});

test('failed and disconnected devices are reported, not hidden', async () => {
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  const broken = simulatedLight();
  broken.apply = async () => ({ ok: false, error: 'bulb said no' });
  const { ex, clock, fan } = rig({ now: start, light: broken });
  ex.setPlan(plan('sam', { now: start }), { maxVolume: 40 });
  await run(ex, clock, 4);
  assert.equal(ex.snapshot().outputs.light.status, 'failed');
  fan.connected = false;
  await run(ex, clock, 4);
  assert.equal(ex.snapshot().outputs.fan.status, 'disconnected');
});

test('simulated outputs are never represented as real hardware', () => {
  const adapters = createAdapters({ lightAdapter: 'simulated', audioAdapter: 'simulated', fanAdapter: 'simulated', lightColorTemp: true });
  for (const a of Object.values(adapters)) {
    assert.equal(a.simulated, true);
    assert.match(a.label, /simulated/i);
    assert.equal(a.describe(Date.now()).simulated, true);
  }
  const browser = createAdapters({ lightAdapter: 'simulated', audioAdapter: 'browser', fanAdapter: 'none', lightColorTemp: true });
  assert.equal(browser.audio.simulated, false, 'browser audio is a real speaker');
  assert.equal(browser.fan, null, 'no fan unless configured');
  const ex = new Executor({ adapters: browser, clock: () => 0 });
  assert.equal(ex.snapshot().outputs.light.simulated, true);
  assert.equal(ex.snapshot().outputs.fan.device, null);
});

test('forecast changes mid-transition do not restart it', async () => {
  // Covered at the window level in weather.test.js; here: replanning with an equivalent plan sends nothing new.
  const start = zonedToUtc('2026-10-23', '22:40', TZ);
  const { ex, clock, light } = rig({ now: start });
  ex.setPlan(plan('alex', { now: start, weather: 'rain' }), { maxVolume: 50 });
  await run(ex, clock, 10);
  const before = light.state.brightness;
  ex.setPlan(plan('alex', { now: clock.t, weather: 'storm' }), { maxVolume: 50 });
  await run(ex, clock, 2);
  assert.ok(Math.abs(light.state.brightness - before) < 1, 'wind-down dim continues smoothly');
});
