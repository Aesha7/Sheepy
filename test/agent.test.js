import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DriftAgent, AgentRunError, DEFAULT_MODEL } from '../server/agent/agent.js';
import { AgentController } from '../server/agent/controller.js';
import { ToolHost, SHEEP_TOOLS, ALL_TOOLS } from '../server/agent/tools.js';
import { LampGuard, capVolume } from '../server/agent/safety.js';
import { SYSTEM_PROMPT } from '../server/agent/prompt.js';
import { SheepHub, lampCommand, parseBleStatus } from '../server/sheep/hub.js';
import { SheepLight, simulatedAudio } from '../server/devices/adapters.js';
import { Executor } from '../server/devices/executor.js';
import { buildPlan } from '../server/policy/buildPlan.js';
import { SAMPLE_USERS, simulatedWeather } from '../server/scenarios.js';
import { normalizeProfile } from '../server/profile.js';
import { zonedToUtc, MIN } from '../server/time.js';

const TZ = 'America/Los_Angeles';
const NOW = zonedToUtc('2026-10-23', '22:00', TZ);

/** Scripted stand-in for the Anthropic client: returns queued responses, records requests. */
class FakeClient {
  constructor(responses) {
    this.responses = [...responses];
    this.requests = [];
    this.beta = { messages: { create: (params, opts) => this.create(params, opts) } };
  }
  async create(params, opts) {
    this.requests.push(structuredClone({ ...params, messages: params.messages }));
    const next = this.responses.shift();
    if (typeof next === 'function') return next(params, opts);
    if (next instanceof Error) throw next;
    return next;
  }
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop_reason = 'tool_use') => ({ model: DEFAULT_MODEL, stop_reason, content, usage: { input_tokens: 100, output_tokens: 20 } });
const done = (text) => reply([{ type: 'text', text }], 'end_turn');

function rig({ now = NOW, profilePatch } = {}) {
  const clock = { t: now };
  const hub = new SheepHub({ simulate: true, clock: () => clock.t });
  const executor = new Executor({ adapters: { light: new SheepLight(hub), audio: simulatedAudio(), fan: null }, clock: () => clock.t, minIntervalMs: 2000 });
  const raw = structuredClone(SAMPLE_USERS.alex);
  if (profilePatch) profilePatch(raw);
  const profile = normalizeProfile(raw).profile;
  const plan = buildPlan(profile, null, simulatedWeather('rain', now), now);
  executor.setPlan({ ...plan, outputs: { ...plan.outputs, light: [], audio: [] } }, { maxVolume: profile.sound.maxVolume });
  const ctx = () => ({ profile, plan });
  return { clock, hub, executor, profile, plan, ctx, sleep: async (ms) => { clock.t += ms; } };
}

test('the three sheep tools match sheep.py exactly', (t) => {
  let pyTools;
  try {
    const out = execFileSync('python', ['-c', 'import json, sheep; print(json.dumps(sheep.TOOLS))'], { cwd: path.resolve('hardware_integration'), env: { ...process.env, SHEEP_FAKE: '1' }, encoding: 'utf8' });
    pyTools = JSON.parse(out);
  } catch {
    t.skip('python not available');
    return;
  }
  assert.deepEqual(SHEEP_TOOLS, pyTools);
});

test('lamp command clamps and demo speedup match the hardware guide', () => {
  assert.equal(lampCommand(80, 30, 1).text, 'L,80,1800.0');
  assert.equal(lampCommand(500, 9999, 1).text, 'L,100,1800.0', 'clamped to 100% and 30 minutes');
  assert.equal(lampCommand(80, 30, 60).text, 'L,80,30.0', 'speedup 60: 30 min plays in 30 s');
  assert.equal(lampCommand(-5, -1).text, 'L,0,0.0');
  assert.deepEqual(parseBleStatus('4,412,35,80'), { pats: 4, light: 412, level: 35, target: 80 });
  assert.ok(parseBleStatus('ERR').error);
  assert.ok(parseBleStatus('garbage').error);
});

test('agent loop: request shape, tool execution, results appended in order', async () => {
  const r = rig();
  const client = new FakeClient([
    reply([{ type: 'text', text: 'Dimming for wind-down.' }, toolUse('t1', 'set_lamp', { brightness: 20, minutes: 30 }), toolUse('t2', 'play_sound', { sound: 'rain', level: 35, fade_seconds: 60 })]),
    done('Rain is forecast and you enjoy rain sounds, so rain ambience is playing and the light is dimming over 30 minutes.'),
  ]);
  const host = new ToolHost({ executor: r.executor, hub: r.hub, ctx: r.ctx, scheduler: { add: () => ({}), list: () => [], cancel: () => false }, clock: () => r.clock.t, sleep: r.sleep });
  const agent = new DriftAgent({ client, execute: (n, i) => host.execute(n, i) });
  const out = await agent.run({ event: 'phase: entered winddown', snapshot: { phase: 'winddown' } });

  assert.match(out.text, /rain ambience is playing/);
  assert.equal(out.steps.length, 2);
  const req = client.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.equal(req.system[0].text, SYSTEM_PROMPT);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(req.tool_choice, undefined, 'no forced tool_choice');
  assert.deepEqual(req.tools.map((x) => x.name), ALL_TOOLS.map((x) => x.name));
  const second = client.requests[1].messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content.length, 3, 'assistant turn appended unchanged');
  assert.deepEqual(second[2].content.map((b) => [b.type, b.tool_use_id]), [['tool_result', 't1'], ['tool_result', 't2']], 'all results in one user message, in order');
  assert.equal(r.hub.sim.to, 20, 'the (simulated) sheep received the fade');
  assert.deepEqual(r.executor.outputs.audio.sent.channels, { rain: 35 });
  assert.equal(r.executor.outputs.audio.sent.fadeSeconds, 60);
});

test('agent loop: tool errors go back as is_error; refusal and iteration cap fail cleanly', async () => {
  const r = rig();
  const host = new ToolHost({ executor: r.executor, hub: r.hub, ctx: r.ctx, scheduler: { add: () => ({}), list: () => [], cancel: () => false }, clock: () => r.clock.t, sleep: r.sleep });
  const exec = (n, i) => host.execute(n, i);
  const c1 = new FakeClient([reply([toolUse('a', 'launch_rocket', {})]), done('ok')]);
  const out = await new DriftAgent({ client: c1, execute: exec }).run({ event: 'x', snapshot: {} });
  const res = c1.requests[1].messages[2].content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /Unknown tool/);
  assert.equal(out.steps[0].error, 'Unknown tool launch_rocket');

  const c2 = new FakeClient([{ ...reply([], 'refusal'), stop_details: { category: 'cyber' } }]);
  await assert.rejects(new DriftAgent({ client: c2, execute: exec }).run({ event: 'x', snapshot: {} }), (e) => e instanceof AgentRunError && e.kind === 'refusal');

  const loops = Array.from({ length: 5 }, (_, i) => reply([toolUse(`g${i}`, 'get_status', {})]));
  await assert.rejects(new DriftAgent({ client: new FakeClient(loops), execute: exec, maxIterations: 3 }).run({ event: 'x', snapshot: {} }), (e) => e.kind === 'iterations');
});

test('safety floor: no flashing, volume cap, Stop/Pause and manual overrides win', async () => {
  const g = new LampGuard();
  assert.equal(g.check(0, 80, 0), null);
  g.record(0, 80, 0);
  assert.match(g.check(3000, 0, 80), /would flash/, 'up then down within seconds is refused');
  assert.equal(g.check(20_000, 0, 80), null, 'a later reversal is fine');
  const many = new LampGuard();
  for (let i = 0; i < 6; i++) many.record(i * 1000, 10 + i, 10 + i - 1);
  assert.match(many.check(7000, 30, 15), /light changes in the last minute/);
  assert.deepEqual(capVolume(90, 50), { level: 50, capped: true });

  const r = rig();
  const host = new ToolHost({ executor: r.executor, hub: r.hub, ctx: r.ctx, scheduler: { add: () => ({}), list: () => [], cancel: () => false }, clock: () => r.clock.t, sleep: r.sleep });
  const loud = await host.execute('play_sound', { sound: 'brown', level: 100, fade_seconds: 0 });
  assert.equal(loud.level, r.profile.sound.maxVolume);
  assert.ok(loud.capped);
  await host.execute('set_lamp', { brightness: 60, minutes: 0 });
  r.clock.t += 2000;
  await assert.rejects(host.execute('set_lamp', { brightness: 0, minutes: 0 }), /would flash/);

  r.executor.setOverride('light', { brightness: 10 }, 30);
  r.clock.t += 60_000;
  await assert.rejects(host.execute('set_lamp', { brightness: 50, minutes: 5 }), /manual light override/);
  r.executor.pause();
  await assert.rejects(host.execute('play_sound', { sound: 'pink', level: 20, fade_seconds: 5 }), /paused/);
  r.executor.resume();
  await r.executor.stop().settled;
  await assert.rejects(host.execute('play_sound', { sound: 'pink', level: 20, fade_seconds: 5 }), /Stopped/);
  await assert.rejects(host.execute('schedule_action', { at: '06:40', action: 'set_lamp', brightness: 80, minutes: 20, note: 'sunrise' }), /Stopped/);
});

test('controller: no API key -> backup rules, clearly explained', () => {
  const r = rig();
  const c = new AgentController({ client: null, executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t });
  assert.equal(c.enabled, false);
  assert.equal(c.mode, 'rules');
  assert.match(c.status().reason, /No Anthropic API key/);
  assert.equal(c.trigger('phase'), false, 'no runs without a key');
});

test('controller: success hands control to the agent; failures fall back to rules', async () => {
  const r = rig();
  const modes = [];
  const client = new FakeClient([
    reply([toolUse('a', 'set_lamp', { brightness: 25, minutes: 20 })]),
    done('Dimming to 25% over 20 minutes for your wind-down.'),
    new Anthropic.APIConnectionError({ message: 'getaddrinfo ENOTFOUND api.anthropic.com' }),
  ]);
  const c = new AgentController({ client, model: DEFAULT_MODEL, effort: 'medium', executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t, sleep: r.sleep });
  c.on('mode', (m) => modes.push(m.mode));
  const ok = await c.runOnce([{ event: 'phase', detail: 'entered winddown' }]);
  assert.equal(ok.status, 'ok');
  assert.equal(c.mode, 'agent');
  assert.equal(ok.steps[0].tool, 'set_lamp');
  r.clock.t += 60_000;
  const bad = await c.runOnce([{ event: 'weather' }]);
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /Can’t reach the Anthropic API/);
  assert.equal(c.mode, 'rules');
  assert.deepEqual(r.executor.direct, {}, 'agent targets cleared so the rules plan can take over');
  assert.deepEqual(modes, ['agent', 'rules']);
  assert.ok(c.backoffUntil > r.clock.t, 'backs off before retrying automatically');
  assert.match(c.canRunAutomatically(r.clock.t), /Backing off/);
});

test('controller: a rejected key disables the agent for good', async () => {
  const r = rig();
  const err = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  const c = new AgentController({ client: new FakeClient([err]), executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t, sleep: r.sleep });
  await c.runOnce([{ event: 'startup' }]);
  assert.equal(c.enabled, false);
  assert.match(c.disabledReason, /API key was rejected/);
});

test('Stop aborts a run in flight and drops scheduled actions', async () => {
  const r = rig();
  // Stop while the API request is in flight: the request is aborted.
  let sawAbort = false;
  let called;
  const inFlight = new Promise((res) => { called = res; });
  const client = new FakeClient([(params, opts) => {
    called();
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Anthropic.APIUserAbortError());
      });
    });
  }]);
  const c = new AgentController({ client, executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t, sleep: r.sleep });
  c.scheduler.add({ at: r.clock.t + 3_600_000, action: 'set_lamp', args: { brightness: 80, minutes: 20 }, note: 'sunrise' });
  const running = c.runOnce([{ event: 'phase' }]);
  await inFlight;
  c.stop();
  const entry = await running;
  assert.ok(sawAbort);
  assert.equal(entry.status, 'stopped');
  assert.equal(c.scheduler.list().length, 0);

  // Stop pressed just as a run starts: no request is sent at all.
  const quiet = new FakeClient([done('should never be sent')]);
  const c2 = new AgentController({ client: quiet, executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t, sleep: r.sleep });
  const early = c2.runOnce([{ event: 'phase' }]);
  c2.stop();
  assert.equal((await early).status, 'stopped');
  assert.equal(quiet.requests.length, 0);
});

test('scheduled actions: next local occurrence, run on time, skipped when late or stopped', async () => {
  const r = rig();
  const c = new AgentController({ client: new FakeClient([]), executor: r.executor, hub: r.hub, ctx: r.ctx, clock: () => r.clock.t, sleep: r.sleep });
  c.mode = 'agent';
  const s = await c.tools.execute('schedule_action', { at: '06:40', action: 'set_lamp', brightness: 80, minutes: 20, note: 'sunrise in the wake window' });
  assert.equal(s.scheduled.at, '6:40 AM');
  const item = c.scheduler.list()[0];
  assert.equal(item.at, zonedToUtc('2026-10-24', '06:40', TZ), 'next occurrence is tomorrow morning in the person’s timezone');
  await assert.rejects(c.tools.execute('schedule_action', { at: '7pm', action: 'set_lamp', brightness: 1, minutes: 1, note: 'x' }), /HH:MM|local time/);

  r.clock.t = item.at + 1000;
  await c.tick();
  assert.equal(c.log[0].status, 'ok');
  assert.equal(r.hub.sim.to, 80, 'sunrise started on the sheep');

  c.scheduler.add({ at: r.clock.t + 1000, action: 'play_sound', args: { sound: 'pink', level: 20, fade_seconds: 10 }, note: 'late one' });
  r.clock.t += 30 * MIN;
  await c.tick();
  assert.equal(c.log[0].status, 'skipped');
  assert.match(c.log[0].error, /minutes late/);
});

test('sheep hub: pats are timestamped on the server; a restart resets the baseline', () => {
  const clock = { t: NOW };
  const hub = new SheepHub({ simulate: true, clock: () => clock.t });
  const pats = [];
  hub.on('pat', (p) => pats.push(p));
  hub.onStatus({ pats: 3, light: 300, level: 0, target: 0 }, 'sim'); // first reading: baseline only
  hub.onStatus({ pats: 5, light: 300, level: 0, target: 0 }, 'sim');
  assert.equal(hub.readPatLog().length, 2);
  assert.equal(pats[0].count, 2);
  hub.onStatus({ pats: 0, light: 300, level: 0, target: 0 }, 'sim'); // Arduino restarted
  assert.equal(hub.readPatLog().length, 2, 'no pats logged on a restart');
  hub.onStatus({ pats: 1, light: 300, level: 0, target: 0 }, 'sim');
  assert.equal(hub.readPatLog().length, 3);
  hub.close();
});

test('sheep hub: Bluetooth relay writes the command and returns the next status', async () => {
  const clock = { t: NOW };
  const hub = new SheepHub({ clock: () => clock.t });
  const written = [];
  let onClose;
  const res = { writeHead() {}, write: (s) => written.push(s), on: (ev, cb) => { if (ev === 'close') onClose = cb; } };
  hub.ble.attach(res);
  hub.ble.setConnected(true, 'SleepSheep');
  hub.ble.onStatus('0,410,0,0', clock.t);
  assert.equal(hub.active(), 'ble');
  const pending = hub.setLamp(60, 1);
  await new Promise((r) => setImmediate(r));
  const sent = JSON.parse(written.find((w) => w.startsWith('data:')).slice(6));
  assert.equal(sent.text, 'L,60,60.0');
  hub.ble.ack(sent.id, true);
  await new Promise((r) => setImmediate(r));
  hub.ble.onStatus('0,410,5,60', clock.t);
  const status = await pending;
  assert.equal(status.target, 60);
  assert.equal(status.transport, 'ble');
  assert.equal(status.simulated, false);
  onClose();
  assert.equal(hub.ble.connected, false, 'closing the tab disconnects Bluetooth');
});

test('sheep not connected: tools return a clear error, never a fake success', async () => {
  const clock = { t: NOW };
  const hub = new SheepHub({ clock: () => clock.t });
  await assert.rejects(hub.setLamp(50, 1), /Sheep not connected/);
  const light = new SheepLight(hub);
  const r = await light.apply({ brightness: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
  assert.equal(light.simulated, false);
});
