// Decides when the agent runs and who controls the devices.
//   mode "agent": the agent's commands drive the light and sound (rules plan withheld from the executor)
//   mode "rules": the deterministic backup plan drives them (no API key, API down, refusal, bad output)
// Runs are event-driven: phase changes, weather and calendar updates, preference edits, overrides,
// head pats, Stop/Resume, or "Run agent now". Events are debounced and runs are capped per hour.

import { EventEmitter } from 'node:events';
import { DriftAgent, describeApiError } from './agent.js';
import { ToolHost } from './tools.js';

const DEBOUNCE_MS = 1500;
const MIN_GAP_MS = 20_000; // between automatic runs (user-initiated runs skip this)
const BACKOFF_MS = 5 * 60_000; // after a retryable failure
const MAX_LOG = 15;

export class Scheduler {
  constructor(clock) {
    this.clock = clock;
    this.items = [];
    this.nextId = 1;
  }
  add({ at, action, args, note }) {
    const item = { id: `s${this.nextId++}`, at, action, args, note, createdAt: this.clock() };
    this.items.push(item);
    this.items.sort((a, b) => a.at - b.at);
    return item;
  }
  list() {
    return [...this.items];
  }
  cancel(id) {
    const n = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    return this.items.length < n;
  }
  clear() {
    this.items = [];
  }
  due(now) {
    const due = this.items.filter((i) => i.at <= now);
    this.items = this.items.filter((i) => i.at > now);
    return due;
  }
}

export class AgentController extends EventEmitter {
  /**
   * @param {{client, model, effort, maxRunsPerHour, executor, hub, ctx, prepare?, clock?, sleep?, enabled?}} opts
   *   ctx(): {profile, plan} for the person the device belongs to (null if none)
   */
  constructor({ client, model, effort, maxRunsPerHour = 20, executor, hub, ctx, prepare, clock = () => Date.now(), sleep, enabled = true }) {
    super();
    this.prepare = prepare; // async: refresh the plan/context before a run
    this.clock = clock;
    this.executor = executor;
    this.ctx = ctx;
    this.client = client;
    this.enabled = enabled && !!client;
    this.disabledReason = !client ? 'No Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart.' : !enabled ? 'Agent turned off (DRIFT_AGENT=off).' : null;
    this.maxRunsPerHour = maxRunsPerHour;
    this.scheduler = new Scheduler(clock);
    this.tools = new ToolHost({ executor, hub, ctx: () => this.requireCtx(), scheduler: this.scheduler, clock, sleep });
    this.agent = new DriftAgent({ client, model, effort, execute: (name, input) => this.tools.execute(name, input) });
    this.model = model;
    this.mode = 'rules';
    this.reason = this.disabledReason ?? 'Waiting for the agent’s first run.';
    this.running = null;
    this.pending = [];
    this.debounce = null;
    this.lastRunAt = -Infinity;
    this.backoffUntil = 0;
    this.runTimes = [];
    this.log = [];
    this.lastPhase = null;
    this.lastWeatherSig = null;
    hub?.on?.('pat', (p) => this.trigger('pat', `${p.count} head pat${p.count === 1 ? '' : 's'} on the sheep`));
  }

  requireCtx() {
    const c = this.ctx();
    if (!c) throw new Error('No profile is active on the device.');
    return c;
  }

  setMode(mode, reason) {
    const changed = mode !== this.mode || reason !== this.reason;
    this.mode = mode;
    this.reason = reason;
    if (mode === 'rules') this.executor.clearDirect();
    if (changed) this.emit('mode', { mode, reason });
  }

  /** Queue an event. Coalesces bursts into one run. user=true skips the gap and hourly cap. */
  trigger(event, detail = '', { user = false } = {}) {
    if (!this.enabled) return false;
    this.pending.push({ event, detail, at: this.clock(), user });
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.drain().catch(() => {}), user ? 0 : DEBOUNCE_MS);
    this.debounce.unref?.();
    return true;
  }

  canRunAutomatically(now) {
    if (now < this.backoffUntil) return `Backing off after an API problem until ${new Date(this.backoffUntil).toISOString().slice(11, 16)} UTC.`;
    if (now - this.lastRunAt < MIN_GAP_MS) return 'Last run was moments ago.';
    this.runTimes = this.runTimes.filter((t) => now - t < 3_600_000);
    if (this.runTimes.length >= this.maxRunsPerHour) return `Hourly limit of ${this.maxRunsPerHour} agent runs reached.`;
    return null;
  }

  async drain() {
    if (this.running || !this.pending.length) return null;
    if (this.executor.stopped && !this.pending.some((p) => p.event === 'resume')) {
      this.pending = [];
      return null;
    }
    const now = this.clock();
    const user = this.pending.some((p) => p.user);
    const blocked = user ? null : this.canRunAutomatically(now);
    if (blocked) {
      // Retry once the gap has passed; events stay queued.
      clearTimeout(this.debounce);
      const wait = Math.max(MIN_GAP_MS - (now - this.lastRunAt), this.backoffUntil - now, 5_000);
      if (now - this.lastRunAt < MIN_GAP_MS || now < this.backoffUntil) this.debounce = setTimeout(() => this.drain().catch(() => {}), wait);
      else this.pending = [];
      return null;
    }
    const events = this.pending.splice(0);
    return this.runOnce(events);
  }

  snapshot(events) {
    const c = this.ctx();
    const sheep = this.tools.hub?.latest ? this.tools.hub.statusOut() : null;
    return {
      events: events.map((e) => (e.detail ? `${e.event}: ${e.detail}` : e.event)),
      local_time: c?.plan?.nowLabel,
      phase: c?.plan?.currentPhase,
      person: c?.profile?.name,
      stopped: this.executor.stopped,
      paused: this.executor.paused,
      manual_overrides: Object.keys(this.executor.activeOverrides()),
      sheep: sheep ? { connected_via: sheep.transport, simulated: sheep.simulated, level: sheep.level, target: sheep.target, room_light: sheep.light, pats_since_power_on: sheep.pats } : 'not connected',
      scheduled: this.scheduler.list().length,
    };
  }

  async runOnce(events) {
    const now = this.clock();
    this.lastRunAt = now;
    this.runTimes.push(now);
    const abort = new AbortController();
    const entry = { id: `r${now}`, startedAt: now, events: events.map((e) => (e.detail ? `${e.event}: ${e.detail}` : e.event)), steps: [], status: 'running' };
    this.running = { entry, abort };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, MAX_LOG);
    this.emit('run', entry);
    try {
      await this.prepare?.();
      if (!this.ctx()) throw new Error('No profile is active on the device.');
      const out = await this.agent.run({
        event: entry.events.join('; '),
        snapshot: this.snapshot(events),
        signal: abort.signal,
        onStep: (s) => entry.steps.push(s),
      });
      Object.assign(entry, { status: 'ok', text: out.text, usage: out.usage, iterations: out.iterations, model: out.model, finishedAt: this.clock() });
      this.backoffUntil = 0;
      this.setMode('agent', `Agent (${out.model}) is in control.`);
    } catch (e) {
      const err = describeApiError(e);
      Object.assign(entry, { status: err.kind === 'aborted' ? 'stopped' : 'failed', error: err.message, finishedAt: this.clock() });
      if (err.kind === 'aborted') {
        // Stop: the person is in control; rules stay withheld until they resume.
      } else {
        if (!err.retryable) {
          if (['auth', 'permission', 'model'].includes(err.kind)) {
            this.enabled = false;
            this.disabledReason = err.message;
          }
        } else this.backoffUntil = this.clock() + BACKOFF_MS;
        this.setMode('rules', `Agent unavailable: ${err.message}`);
      }
    } finally {
      this.running = null;
      this.emit('run', entry);
      if (this.pending.length) setTimeout(() => this.drain().catch(() => {}), 0);
    }
    return entry;
  }

  /** Called every server tick: fires scheduled actions and turns state changes into events. */
  async tick() {
    const c = this.ctx();
    if (!c) return;
    const now = this.clock();
    // Due items always leave the queue; they run only if the agent is in control and on time.
    for (const item of this.scheduler.due(now)) {
      const entry = { id: `x${item.id}`, startedAt: now, events: [`scheduled: ${item.note || item.action}`], steps: [], status: 'running' };
      const skip = this.mode !== 'agent' ? 'backup rules are in control'
        : this.executor.stopped ? 'Stop is active'
          : this.executor.paused ? 'automation is paused'
            : now - item.at > 10 * 60_000 ? `it is ${Math.round((now - item.at) / 60_000)} minutes late` : null;
      if (skip) {
        Object.assign(entry, { status: 'skipped', error: `Skipped scheduled ${item.action}: ${skip}.`, finishedAt: now });
        this.log.unshift(entry);
        this.log.length = Math.min(this.log.length, MAX_LOG);
        continue;
      }
      {
        try {
          const result = await this.tools.execute(item.action, item.args);
          entry.steps.push({ tool: item.action, input: item.args, result: JSON.stringify(result).slice(0, 800), at: now });
          entry.status = 'ok';
          entry.text = `Ran the scheduled ${item.action === 'set_lamp' ? 'light change' : 'sound change'}: ${item.note}`;
        } catch (e) {
          entry.steps.push({ tool: item.action, input: item.args, error: e.message, at: now });
          entry.status = 'failed';
          entry.error = e.message;
        }
        entry.finishedAt = this.clock();
        this.log.unshift(entry);
        this.log.length = Math.min(this.log.length, MAX_LOG);
      }
    }
    const phase = c.plan.currentPhase;
    if (this.lastPhase !== null && phase !== this.lastPhase) this.trigger('phase', `entered ${phase} (was ${this.lastPhase})`);
    this.lastPhase = phase;
    const w = c.plan.weather;
    const sig = JSON.stringify([w.status, w.source, w.scenario, w.night]);
    if (this.lastWeatherSig !== null && sig !== this.lastWeatherSig) this.trigger('weather', `weather is now ${w.status}${w.simulated ? ' (offline scenario)' : ''}; tonight: ${JSON.stringify(w.night)}`);
    this.lastWeatherSig = sig;
  }

  /** Stop: abort a run in flight and drop everything scheduled. */
  stop() {
    this.running?.abort.abort();
    this.pending = [];
    clearTimeout(this.debounce);
    this.scheduler.clear();
    this.executor.clearDirect();
  }

  status() {
    return {
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      model: this.model,
      mode: this.mode,
      reason: this.reason,
      running: this.running ? this.running.entry : null,
      queued: this.pending.map((p) => p.event),
      runsLastHour: this.runTimes.filter((t) => this.clock() - t < 3_600_000).length,
      maxRunsPerHour: this.maxRunsPerHour,
      scheduled: this.scheduler.list(),
      log: this.log,
    };
  }
}
