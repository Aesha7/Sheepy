// Timeline primitives shared by the policy engine, the executor and the accelerated preview.
// A plan output is a contiguous, time-ordered list of segments. Each segment ramps linearly
// from wherever the previous segment left off to its target over `transitionMinutes`.

import { MIN } from '../time.js';

export const RESUME_MINUTES = 5;
export const OUTPUTS = ['light', 'audio', 'fan'];

const lerp = (a, b, f) => a + (b - a) * f;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function mixLight(a, b, f) {
  const out = { brightness: lerp(a.brightness, b.brightness, f) };
  if (a.colorTempK && b.colorTempK) {
    // Interpolate in mireds so warm/cool shifts look even to the eye.
    out.colorTempK = 1e6 / lerp(1e6 / a.colorTempK, 1e6 / b.colorTempK, f);
  } else {
    out.colorTempK = b.colorTempK ?? a.colorTempK;
  }
  return out;
}

export function mixAudio(a, b, f) {
  const channels = {};
  for (const k of new Set([...Object.keys(a.channels), ...Object.keys(b.channels)])) {
    const v = lerp(a.channels[k] ?? 0, b.channels[k] ?? 0, f);
    if (v >= 0.05) channels[k] = v;
  }
  return { channels };
}

export function mixFan(a, b, f) {
  return { level: f >= 1 ? b.level : a.level };
}

export const MIXERS = { light: mixLight, audio: mixAudio, fan: mixFan };

export function totalVolume(audio) {
  return Object.values(audio?.channels ?? {}).reduce((s, v) => s + v, 0);
}

export function sameTarget(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Planned value of one output at instant t. A segment whose target equals the ramp in progress
 * continues that ramp instead of restarting it, so splitting a segment never causes a step.
 */
export function valueAt(segments, t, output) {
  if (!segments?.length) return null;
  const mix = MIXERS[output];
  if (t <= segments[0].start) return structuredClone(segments[0].target);
  let ramp = { from: segments[0].target, target: segments[0].target, start: segments[0].start, minutes: 0 };
  const at = (r, time) => mix(r.from, r.target, r.minutes > 0 ? clamp01((time - r.start) / (r.minutes * MIN)) : 1);
  for (let i = 1; i < segments.length && segments[i].start <= t; i++) {
    const s = segments[i];
    if (sameTarget(s.target, ramp.target)) continue;
    ramp = { from: at(ramp, s.start), target: s.target, start: s.start, minutes: s.transitionMinutes };
  }
  return at(ramp, t);
}

export function segmentAt(segments, t) {
  if (!segments?.length) return null;
  let found = segments[0];
  for (const s of segments) if (s.start <= t) found = s;
  return found;
}

/** Split the segment containing t into two, preserving the ramp exactly. */
export function splitAt(segments, t) {
  const i = segments.findIndex((s) => s.start < t && t < s.end);
  if (i < 0) return segments;
  const s = segments[i];
  const elapsed = (t - s.start) / MIN;
  const a = { ...s, end: t };
  const b = { ...s, start: t, transitionMinutes: Math.max(0, s.transitionMinutes - elapsed), inputs: [...s.inputs] };
  return [...segments.slice(0, i), a, b, ...segments.slice(i + 1)];
}

/**
 * Apply `fn` to every segment inside [from, to). fn(target, segment) returns a new target or null (no change).
 * The first changed segment ramps in over `transitionIn`, and the segment after the window ramps out over
 * `transitionOut`, so overlays never create step changes.
 * @returns {{segments: object[], changed: number, unchanged: number}}
 */
export function overlay(segments, from, to, fn, { transitionIn, transitionOut, reason, inputs = [], tag }) {
  if (to <= from) return { segments, changed: 0, unchanged: 0 };
  let segs = splitAt(splitAt(segments, from), to);
  let changed = 0;
  let unchanged = 0;
  let first = true;
  segs = segs.map((s) => {
    if (s.start < from || s.start >= to) return s;
    const next = fn(s.target, s);
    if (next == null) {
      unchanged += 1;
      return s;
    }
    changed += 1;
    const out = {
      ...s,
      target: next,
      reason,
      inputs: [...s.inputs.filter((x) => x.kind === 'schedule'), ...inputs],
      weather: tag,
      transitionMinutes: first ? Math.max(transitionIn, s.transitionMinutes) : s.transitionMinutes,
    };
    first = false;
    return out;
  });
  if (changed) {
    const after = segs.findIndex((s) => s.start >= to);
    if (after >= 0) segs[after] = { ...segs[after], transitionMinutes: Math.max(transitionOut, segs[after].transitionMinutes) };
  }
  return { segments: segs, changed, unchanged };
}

export function applyOverride(value, target, output) {
  if (!target) return value;
  if (output === 'audio') {
    if (target.channels) return { channels: { ...target.channels } };
    if (typeof target.volume === 'number') {
      const total = totalVolume(value);
      if (total <= 0) return value;
      const k = target.volume / total;
      return { channels: Object.fromEntries(Object.entries(value.channels).map(([s, v]) => [s, v * k])) };
    }
    return value;
  }
  return { ...value, ...target };
}

export function overrideActive(override, t) {
  return !!override && override.setAt <= t && (override.expiresAt == null || t < override.expiresAt);
}

/**
 * Plan value with a manual override layered on top. After an override expires or is cleared,
 * the output glides back to the plan over RESUME_MINUTES instead of jumping.
 */
export function resolveOutput(segments, output, override, t) {
  const planned = valueAt(segments, t, output);
  if (planned == null) return { value: null, source: 'none' };
  if (!override) return { value: planned, source: 'plan' };
  if (overrideActive(override, t)) return { value: applyOverride(planned, override.target, output), source: 'override' };
  if (override.expiresAt != null && t >= override.expiresAt && t - override.expiresAt < RESUME_MINUTES * MIN) {
    const from = applyOverride(valueAt(segments, override.expiresAt, output), override.target, output);
    return { value: MIXERS[output](from, planned, (t - override.expiresAt) / (RESUME_MINUTES * MIN)), source: 'resuming' };
  }
  return { value: planned, source: 'plan' };
}

/** Sampled frames for the accelerated preview. Pure: never touches devices or real timers. */
export function previewFrames(plan, { from, to, stepMinutes = 5, overrides = {} } = {}) {
  const start = from ?? plan.schedule.windDownStart - 30 * MIN;
  const end = to ?? plan.schedule.wakeEnd + 60 * MIN;
  const frames = [];
  for (let t = start; t <= end; t += stepMinutes * MIN) {
    const frame = { t };
    for (const output of OUTPUTS) {
      const segs = plan.outputs[output];
      if (!segs?.length) continue;
      const r = resolveOutput(segs, output, overrides[output], t);
      frame[output] = r.value;
      frame[`${output}Source`] = r.source;
    }
    frame.phase = plan.phases.find((p) => p.start <= t && t < p.end)?.key ?? null;
    frames.push(frame);
  }
  return frames;
}
