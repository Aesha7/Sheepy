// The executor turns a plan into device commands. It is the only code that talks to hardware.
// Policy decides *what*; the executor enforces *how safely*:
//   - hardware limits and Stop come first, then manual overrides, then the plan;
//   - volume is capped at the user's maximum, color temperature is only sent if supported;
//   - automatic changes are slew-limited (no sudden jumps or flashing), deduplicated and rate-limited;
//   - desired, sent and confirmed state are tracked separately.

import { MIN } from '../time.js';
import { OUTPUTS, resolveOutput, applyOverride, overrideActive, RESUME_MINUTES, totalVolume } from '../policy/timeline.js';

export const SLEW = {
  brightnessPerSec: 1, // % per second
  colorTempPerSec: 40, // K per second
  volumeUpPerSec: 0.5, // % per second: a full-scale rise takes over 3 minutes
  volumeDownPerSec: 1, // automatic fades only; Stop is never slowed
};
const MAX_TICK_SECONDS = 5;
const LOG_SIZE = 40;

const DEFAULTS = {
  light: { brightness: 0, colorTempK: 2700 },
  audio: { channels: {} },
  fan: { level: 0 },
};

const stepToward = (from, to, maxStep) => (Math.abs(to - from) <= maxStep ? to : from + Math.sign(to - from) * maxStep);
const round1 = (x) => Math.round(x * 10) / 10;

function validateTarget(output, target, sounds) {
  if (!target || typeof target !== 'object') throw new Error('override target must be an object');
  if (output === 'light') {
    const out = {};
    if (target.brightness !== undefined) {
      if (typeof target.brightness !== 'number' || target.brightness < 0 || target.brightness > 100) throw new Error('brightness must be 0-100');
      out.brightness = target.brightness;
    }
    if (target.colorTempK !== undefined) {
      if (typeof target.colorTempK !== 'number' || target.colorTempK < 1800 || target.colorTempK > 6500) throw new Error('colorTempK must be 1800-6500');
      out.colorTempK = target.colorTempK;
    }
    if (!Object.keys(out).length) throw new Error('light override needs brightness or colorTempK');
    return out;
  }
  if (output === 'audio') {
    if (target.channels) {
      const channels = {};
      for (const [k, v] of Object.entries(target.channels)) {
        if (!sounds.includes(k)) throw new Error(`unknown sound "${k}"`);
        if (typeof v !== 'number' || v < 0 || v > 100) throw new Error('volume must be 0-100');
        if (v > 0) channels[k] = v;
      }
      return { channels };
    }
    if (typeof target.volume === 'number' && target.volume >= 0 && target.volume <= 100) return { volume: target.volume };
    throw new Error('audio override needs channels or volume');
  }
  if (output === 'fan') {
    if (!Number.isInteger(target.level) || target.level < 0 || target.level > 3) throw new Error('fan level must be 0-3');
    return { level: target.level };
  }
  throw new Error(`unknown output "${output}"`);
}

export class Executor {
  constructor({ adapters, clock = () => Date.now(), minIntervalMs = 2000, hardwareMaxBrightness = 100 } = {}) {
    this.adapters = adapters;
    this.clock = clock;
    this.minIntervalMs = minIntervalMs;
    this.hardwareMaxBrightness = hardwareMaxBrightness;
    this.plan = null;
    this.maxVolume = 0;
    this.overrides = {};
    // Direct targets from the LLM agent (agent mode). Priority: Stop > manual override > agent > plan.
    this.direct = {};
    this.paused = false;
    this.stopped = false;
    this.stopTargets = {};
    this.gen = 0;
    this.lastTick = null;
    this.log = [];
    this.outputs = Object.fromEntries(OUTPUTS.map((o) => [o, {
      desired: null, sent: null, confirmed: null, confirmedAt: null,
      status: adapters[o] ? 'idle' : 'not_available', detail: '', source: null,
      lastSentAt: -Infinity, inflight: false, dirty: false, sentSeq: null,
    }]));
  }

  setPlan(plan, { maxVolume }) {
    this.plan = plan;
    this.maxVolume = maxVolume;
  }

  setOverride(output, target, minutes = null) {
    const adapter = this.adapters[output];
    if (!adapter) throw new Error(`${output} is not available`);
    const now = this.clock();
    const clean = validateTarget(output, target, adapter.capabilities?.sounds ?? []);
    if (minutes != null && !(Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60)) throw new Error('minutes must be 1-1440 or null');
    this.overrides[output] = { target: clean, setAt: now, expiresAt: minutes == null ? null : now + minutes * MIN };
    return this.overrides[output];
  }

  /**
   * Agent command: hold this value until changed. The device does the fade (fadeSeconds), so no
   * slew limit is applied; hardware limits, the volume cap, manual overrides and Stop still win.
   */
  setDirect(output, target, fadeSeconds = 0) {
    const adapter = this.adapters[output];
    if (!adapter) throw new Error(`${output} is not available`);
    const value = validateTarget(output, target, adapter.capabilities?.sounds ?? []);
    if (output === 'audio' && value.volume !== undefined) throw new Error('audio target needs channels');
    const fade = Math.max(0, Math.min(1800, Number(fadeSeconds) || 0));
    this.direct[output] = { value: output === 'light' ? { brightness: value.brightness ?? 0 } : value, fadeSeconds: fade, setAt: this.clock() };
    return this.direct[output];
  }

  clearDirect(output) {
    if (output) delete this.direct[output];
    else this.direct = {};
  }

  /** Clearing glides back to the plan over RESUME_MINUTES instead of jumping. */
  clearOverride(output) {
    const o = this.overrides[output];
    if (!o) return;
    const now = this.clock();
    if (o.expiresAt == null || o.expiresAt > now) o.expiresAt = now;
    o.cleared = true;
  }

  /** Overrides as the policy engine should see them (active or scheduled, not resuming). */
  activeOverrides() {
    const now = this.clock();
    return Object.fromEntries(Object.entries(this.overrides).filter(([, o]) => o.expiresAt == null || o.expiresAt > now));
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.stopped = false;
    this.stopTargets = {};
    this.gen += 1;
  }

  /**
   * Stop: cancel every pending or in-progress change and overrides, silence audio, turn the fan off and
   * hold lights at their last confirmed level (no sudden darkness). Automation stays paused until resumed.
   */
  stop() {
    this.gen += 1;
    this.stopped = true;
    this.paused = true;
    this.overrides = {};
    this.direct = {};
    this.stopTargets = {
      light: this.outputs.light.confirmed ?? this.outputs.light.sent ?? null,
      audio: { channels: {} },
      fan: { level: 0 },
    };
    for (const o of OUTPUTS) this.outputs[o].dirty = true;
    return this.tick();
  }

  limit(output, value, adapter) {
    if (output === 'light') {
      const out = { brightness: Math.max(0, Math.min(this.hardwareMaxBrightness, value.brightness ?? 0)) };
      if (adapter.capabilities?.colorTemp && value.colorTempK) {
        out.colorTempK = Math.max(adapter.capabilities.minK, Math.min(adapter.capabilities.maxK, value.colorTempK));
      }
      return out;
    }
    if (output === 'audio') {
      const sounds = adapter.capabilities?.sounds ?? [];
      const channels = {};
      for (const [k, v] of Object.entries(value.channels ?? {})) if (sounds.includes(k) && v > 0) channels[k] = v;
      const total = totalVolume({ channels });
      if (total > this.maxVolume) {
        const k = total > 0 ? this.maxVolume / total : 0;
        for (const s of Object.keys(channels)) channels[s] *= k;
      }
      return { channels };
    }
    return { level: Math.max(0, Math.min(adapter.capabilities?.maxLevel ?? 3, Math.round(value.level ?? 0))) };
  }

  slew(output, from, to, dt) {
    if (output === 'light') {
      if (!from) return to;
      const out = { brightness: stepToward(from.brightness, to.brightness, SLEW.brightnessPerSec * dt) };
      if (to.colorTempK != null) out.colorTempK = from.colorTempK == null ? to.colorTempK : stepToward(from.colorTempK, to.colorTempK, SLEW.colorTempPerSec * dt);
      return out;
    }
    if (output === 'audio') {
      const prev = from?.channels ?? {};
      const channels = {};
      for (const k of new Set([...Object.keys(prev), ...Object.keys(to.channels)])) {
        const a = prev[k] ?? 0;
        const b = to.channels[k] ?? 0;
        const v = b > a ? Math.min(b, a + SLEW.volumeUpPerSec * dt) : Math.max(b, a - SLEW.volumeDownPerSec * dt);
        if (v > 0) channels[k] = v;
      }
      return { channels };
    }
    return to;
  }

  same(output, a, b) {
    if (!a || !b) return false;
    if (output === 'light') return Math.abs(a.brightness - b.brightness) < 0.5 && Math.abs((a.colorTempK ?? 0) - (b.colorTempK ?? 0)) < 25;
    if (output === 'audio') {
      for (const k of new Set([...Object.keys(a.channels), ...Object.keys(b.channels)])) {
        if (Math.abs((a.channels[k] ?? 0) - (b.channels[k] ?? 0)) >= 0.5) return false;
      }
      return true;
    }
    return a.level === b.level;
  }

  toCommand(output, value, fadeSeconds) {
    const fade = fadeSeconds == null ? {} : { fadeSeconds };
    if (output === 'light') return value.colorTempK != null ? { brightness: round1(value.brightness), colorTempK: Math.round(value.colorTempK), ...fade } : { brightness: round1(value.brightness), ...fade };
    if (output === 'audio') return { channels: Object.fromEntries(Object.entries(value.channels).map(([k, v]) => [k, round1(v)]).filter(([, v]) => v >= 0.5)), ...fade };
    return { level: value.level };
  }

  /** One control step. Returns {settled} which resolves when this step's device calls finish. */
  tick() {
    const now = this.clock();
    const dt = this.lastTick == null ? 1 : Math.max(0, Math.min(MAX_TICK_SECONDS, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const jobs = [];

    for (const output of OUTPUTS) {
      const adapter = this.adapters[output];
      const st = this.outputs[output];
      if (!adapter) {
        st.status = 'not_available';
        continue;
      }
      const ov = this.overrides[output];
      if (ov && ov.expiresAt != null && now - ov.expiresAt >= RESUME_MINUTES * MIN) delete this.overrides[output];

      let desired;
      let source;
      if (this.stopped) {
        desired = this.stopTargets[output];
        source = 'stop';
        if (!desired) continue;
      } else {
        const segs = this.plan?.outputs?.[output];
        const ovr = this.overrides[output];
        const direct = this.direct[output];
        if (direct && !(ovr && overrideActive(ovr, now))) {
          desired = direct.value;
          source = 'agent';
        } else if (segs?.length) {
          const r = resolveOutput(segs, output, ovr, now);
          desired = r.value;
          source = r.source;
        } else if (ovr) {
          desired = applyOverride(st.sent ?? direct?.value ?? DEFAULTS[output], ovr.target, output);
          source = 'override';
        } else {
          st.desired = null;
          st.source = null;
          continue;
        }
        if (this.paused && source !== 'override') {
          st.source = 'paused';
          st.desired = st.sent;
          continue;
        }
      }

      desired = this.limit(output, desired, adapter);
      // Automatic changes are smoothed. Manual overrides act immediately, except that audio still never
      // jumps up. Stop is never smoothed.
      if (source === 'plan' || source === 'resuming') desired = this.slew(output, st.sent, desired, dt);
      else if (output === 'audio' && source === 'override') desired = this.slew(output, st.sent ?? DEFAULTS.audio, desired, Math.max(dt, 4));
      st.desired = desired;
      st.source = source;

      if (!st.dirty && this.same(output, st.sent, desired)) continue;
      const urgent = source === 'stop';
      if (!urgent && (st.inflight || now - st.lastSentAt < this.minIntervalMs)) continue;

      const cmd = this.toCommand(output, desired, source === 'agent' ? this.direct[output].fadeSeconds : undefined);
      const gen = this.gen;
      st.inflight = true;
      st.sent = cmd;
      st.lastSentAt = now;
      st.status = 'pending';
      st.detail = '';
      st.dirty = false;
      this.log.unshift({ at: now, output, source, cmd, simulated: adapter.simulated });
      this.log.length = Math.min(this.log.length, LOG_SIZE);

      jobs.push(Promise.resolve()
        .then(() => adapter.apply(cmd))
        .then((res) => {
          st.inflight = false;
          if (res?.ok && res.awaitingAck) {
            st.sentSeq = res.seq;
          } else if (res?.ok) {
            st.confirmed = res.state ?? cmd;
            st.confirmedAt = this.clock();
            st.status = 'applied';
          } else {
            st.status = res?.disconnected ? 'disconnected' : 'failed';
            st.detail = res?.error ?? 'unknown error';
            st.dirty = true;
          }
          // A Stop happened while this command was in flight: make sure the stop state is re-sent.
          if (gen !== this.gen) st.dirty = true;
        }, (err) => {
          st.inflight = false;
          st.status = 'failed';
          st.detail = String(err?.message ?? err);
          st.dirty = true;
        }));
    }
    return { settled: Promise.all(jobs) };
  }

  /** Acknowledgement from a device that confirms asynchronously (browser audio). */
  confirm(output, seq, state) {
    const st = this.outputs[output];
    if (!st || !state) return;
    st.confirmed = state;
    st.confirmedAt = this.clock();
    if (seq === st.sentSeq) st.status = 'applied';
  }

  snapshot() {
    const now = this.clock();
    const outputs = {};
    for (const output of OUTPUTS) {
      const adapter = this.adapters[output];
      const st = this.outputs[output];
      const device = adapter ? adapter.describe(now) : null;
      let status = st.status;
      let detail = st.detail;
      const deviceState = adapter?.deviceState?.(now);
      if (deviceState) {
        ({ status, detail } = deviceState);
      } else if (device && !device.connected) {
        status = 'disconnected';
        detail = device.disconnectReason;
      } else if (output === 'audio' && status === 'applied') {
        // Confirmed by the device: say what is actually audible, not just "applied".
        status = Object.keys(st.confirmed?.channels ?? {}).length ? 'playing' : 'silent';
      }
      outputs[output] = {
        device,
        simulated: device?.simulated ?? null,
        status,
        detail,
        source: st.source,
        desired: st.desired,
        sent: st.sent,
        confirmed: st.confirmed,
        confirmedAt: st.confirmedAt,
        override: this.overrides[output] ?? null,
      };
    }
    return { now, paused: this.paused, stopped: this.stopped, outputs, log: this.log.slice(0, 15) };
  }
}
