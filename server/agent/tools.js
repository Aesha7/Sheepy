// Tools the Drift agent can call, and the host that runs them.
// The three sheep tools match the hardware guide (section 6) exactly; the iOS app sends the same JSON.
// Every device action passes the safety floor (safety.js) before it reaches the executor.

import { HOUR, zonedParts, zonedToUtc, addDays, formatClock, isClock } from '../time.js';
import { PLAYABLE_SOUNDS, SOUND_LABELS, WEATHER_AUDIO_MODE_LABELS } from '../profile.js';
import { LampGuard, capVolume } from './safety.js';

export const SHEEP_TOOLS = [
  {
    name: 'set_lamp',
    description: "Fade the sheep's warm light to a brightness (0-100) over a number of minutes (0-30), starting from its current level. Use long, slow fades (20-30 minutes) for a sunrise. Brightness 0 turns it off.",
    input_schema: {
      type: 'object',
      properties: {
        brightness: { type: 'integer', minimum: 0, maximum: 100 },
        minutes: { type: 'number', minimum: 0, maximum: 30 },
      },
      required: ['brightness', 'minutes'],
    },
  },
  {
    name: 'get_status',
    description: "Read the sheep right now: pats since power-on, room light (relative 0-1023 from a light sensor, not lux; higher is brighter), and the light's current level and target (0-100).",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_pat_log',
    description: 'Timestamped head pats, oldest first. The user pats the sheep at bedtime and again on waking, so this is a rough sleep log (a proxy, not clinical sleep data).',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
  },
];

const SOUND_IDS = [...PLAYABLE_SOUNDS, 'silence'];

export const DRIFT_TOOLS = [
  {
    name: 'play_sound',
    description: "Play a sound on the paired phone or laptop speaker, crossfading from whatever is playing. Sounds: white, pink or brown noise; rain (gentle rain ambience); pads or chimes (the person's wind-down music, generated in the browser); silence fades out. level is a digital output percentage (not decibels) and is capped at the person's maximum.",
    input_schema: {
      type: 'object',
      properties: {
        sound: { type: 'string', enum: SOUND_IDS },
        level: { type: 'integer', minimum: 0, maximum: 100 },
        fade_seconds: { type: 'number', minimum: 0, maximum: 600 },
      },
      required: ['sound', 'level', 'fade_seconds'],
    },
  },
  {
    name: 'get_sound_status',
    description: 'What the speaker is doing: what was requested, what it confirmed playing, and whether the browser tab is connected or blocking sound.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_preferences',
    description: "The person's saved preferences: schedule, brightness limit and warmth, night light, wake light, preferred sound, usual and maximum level, overnight sound and timer, how rain, storms and wind feel to them, weather sound mode, masking sound, wind-down music, and their routines for important and relaxed days.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_tonight',
    description: "Tonight's context: current local time and phase, confirmed wind-down, bedtime, wake window and wake time, tomorrow's day type and events, pending schedule suggestions, active manual overrides, Stop or Pause, sunrise and sunset, and the backup rules' plan for the light and sound.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_weather',
    description: 'Weather for the person\'s location: data status (fresh, stale, unavailable or simulated), current conditions (a model estimate for outdoors), and hourly forecast for tonight (condition, chance of precipitation, rain mm, wind gusts km/h, strong-wind flag), plus forecast windows for rain, storms and strong wind.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_action',
    description: 'Schedule a set_lamp or play_sound to run later tonight at a local time ("HH:MM", the next occurrence within 24 hours). Use it for things that must start at an exact time, like a sunrise when the wake window opens. Give the lamp fields for set_lamp and the sound fields for play_sound.',
    input_schema: {
      type: 'object',
      properties: {
        at: { type: 'string', description: 'Local time HH:MM' },
        action: { type: 'string', enum: ['set_lamp', 'play_sound'] },
        brightness: { type: 'integer', minimum: 0, maximum: 100 },
        minutes: { type: 'number', minimum: 0, maximum: 30 },
        sound: { type: 'string', enum: SOUND_IDS },
        level: { type: 'integer', minimum: 0, maximum: 100 },
        fade_seconds: { type: 'number', minimum: 0, maximum: 600 },
        note: { type: 'string', description: 'Why, in a few words (shown to the person)' },
      },
      required: ['at', 'action', 'note'],
    },
  },
  {
    name: 'list_scheduled',
    description: 'Actions already scheduled for later, with their ids and times.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_scheduled',
    description: 'Cancel a scheduled action by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

export const ALL_TOOLS = [...SHEEP_TOOLS, ...DRIFT_TOOLS];

export class ToolError extends Error {}

const num = (v, name, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${name} must be a number`);
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Runs tools against the live system. `ctx()` returns the current context for the active person:
 * { profile, plan, weather } (plan = the backup rules' plan, built by buildPlan()).
 */
export class ToolHost {
  constructor({ executor, hub, ctx, scheduler, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.executor = executor;
    this.hub = hub;
    this.ctx = ctx;
    this.scheduler = scheduler;
    this.clock = clock;
    this.sleep = sleep;
    this.lampGuard = new LampGuard();
  }

  gate(output) {
    if (this.executor.stopped) throw new ToolError('Stopped by the person. Nothing changes until they press Resume.');
    if (this.executor.paused) throw new ToolError('Automation is paused by the person. Nothing changes until they resume it.');
    const ov = this.executor.activeOverrides()[output];
    if (ov) {
      const until = ov.expiresAt ? ` until ${formatClock(ov.expiresAt, this.ctx().profile.timezone)}` : ' until they clear it';
      throw new ToolError(`The person set a manual ${output === 'light' ? 'light' : 'sound'} override${until}. It wins; leave the ${output} alone.`);
    }
  }

  /** Push a direct command through the executor and wait for the device to answer. */
  async flush(output) {
    for (let i = 0; i < 4; i++) {
      await this.executor.tick().settled;
      const st = this.executor.outputs[output];
      if (!st.inflight && st.source === 'agent' && st.sent) break;
      await this.sleep(this.executor.minIntervalMs);
    }
    const st = this.executor.snapshot().outputs[output];
    return { status: st.status, detail: st.detail || undefined, sent: st.sent, confirmed: st.confirmed, device: st.device?.label, simulated: st.device?.simulated ?? false };
  }

  async execute(name, input = {}) {
    const fn = this[`tool_${name}`];
    if (!fn) throw new ToolError(`Unknown tool ${name}`);
    return fn.call(this, input ?? {});
  }

  async tool_set_lamp(input) {
    this.gate('light');
    const brightness = Math.round(num(input.brightness, 'brightness', 0, 100));
    const minutes = num(input.minutes, 'minutes', 0, 30);
    const now = this.clock();
    const current = this.executor.outputs.light.sent?.brightness ?? this.hub?.latest?.target ?? null;
    const flash = this.lampGuard.check(now, brightness, current);
    if (flash) throw new ToolError(flash);
    this.lampGuard.record(now, brightness, current);
    this.executor.setDirect('light', { brightness }, minutes * 60);
    const result = await this.flush('light');
    const sheep = this.hub?.latest ? this.hub.statusOut() : null;
    return { ok: !['failed', 'disconnected'].includes(result.status), requested: { brightness, minutes }, light: result, sheep, demoSpeedup: this.hub?.speedup ?? 1 };
  }

  async tool_get_status() {
    if (!this.hub) throw new ToolError('No sheep hardware is configured on this server.');
    return this.hub.getStatus();
  }

  async tool_read_pat_log(input) {
    if (!this.hub) throw new ToolError('No sheep hardware is configured on this server.');
    const tz = this.ctx().profile.timezone;
    return { pats: this.hub.readPatLog(input.limit ?? 50).map((p) => ({ ...p, local: formatClock(Date.parse(p.ts), tz) })), note: 'Timestamps come from the server clock; counts reset when the sheep restarts.' };
  }

  async tool_play_sound(input) {
    this.gate('audio');
    const { profile } = this.ctx();
    const sound = String(input.sound);
    if (![...PLAYABLE_SOUNDS, 'silence'].includes(sound)) throw new ToolError(`Unknown sound "${sound}"`);
    const fade = num(input.fade_seconds ?? 5, 'fade_seconds', 0, 600);
    const { level, capped } = capVolume(input.level, profile.sound.maxVolume);
    const channels = sound === 'silence' || level <= 0 ? {} : { [sound]: level };
    this.executor.setDirect('audio', { channels }, fade);
    const result = await this.flush('audio');
    return {
      ok: !['failed'].includes(result.status),
      playing: sound === 'silence' ? 'silence' : SOUND_LABELS[sound],
      level,
      capped: capped ? `Lowered to the person's ${profile.sound.maxVolume}% cap.` : false,
      speaker: result,
      note: result.status === 'blocked' || result.status === 'disconnected' ? 'Requested, but the speaker is not playing yet (the dashboard tab must be open and Enable Sound clicked).' : undefined,
    };
  }

  async tool_get_sound_status() {
    const a = this.executor.snapshot().outputs.audio;
    return { status: a.status, detail: a.detail || undefined, requested: a.desired, confirmed: a.confirmed, device: a.device?.label, override: a.override };
  }

  async tool_get_preferences() {
    const p = this.ctx().profile;
    return {
      name: p.name,
      timezone: p.timezone,
      location: p.location.label || null,
      schedule: p.schedule,
      lighting: p.lighting,
      sound: { ...p.sound, weatherModeLabel: WEATHER_AUDIO_MODE_LABELS[p.sound.weatherMode] },
      routines: p.routines,
      notes: 'Brightness values are 0-100 of the light; maxBrightness is their limit. Sound levels are digital output percentages, never above maxVolume.',
    };
  }

  async tool_get_tonight() {
    const { profile, plan } = this.ctx();
    const tz = profile.timezone;
    const at = (ms) => (ms == null ? null : formatClock(ms, tz));
    const s = plan.schedule;
    const ov = this.executor.activeOverrides();
    const lightPlan = plan.outputs.light.filter((x) => x.end > this.clock() - HOUR && x.start < s.morningEnd)
      .map((x) => ({ phase: x.phase, from: x.startLabel, to: x.endLabel, brightness: Math.round(x.target.brightness), fade_minutes: Math.round(x.transitionMinutes), why: x.reason }));
    return {
      now: `${zonedParts(this.clock(), tz).date} ${at(this.clock())}`,
      timezone: tz,
      phase: plan.currentPhase,
      schedule: {
        wind_down_start: s.labels.windDownStart,
        bedtime: s.labels.bedtime,
        wake_window_start: s.labels.wakeStart,
        wake_time: s.labels.wakeEnd,
        evening_date: s.eveningDate,
        wake_date: s.wakeDate,
        locked_for_tonight: s.locked,
      },
      tomorrow: {
        date: plan.day.date,
        type: plan.day.label,
        source: plan.day.source,
        needs_their_choice: plan.day.needsChoice,
        reasons: plan.day.reasons,
        events: plan.day.events.map((e) => ({ title: e.title, when: e.allDay ? 'all day' : `${at(e.start)}-${at(e.end)}`, importance: e.importance, category: e.category })),
      },
      pending_suggestions: plan.proposals.filter((p) => p.status === 'pending').map((p) => p.text),
      manual_overrides: Object.fromEntries(Object.entries(ov).map(([k, o]) => [k, { target: o.target, until: o.expiresAt ? at(o.expiresAt) : 'until cleared' }])),
      stopped: this.executor.stopped,
      paused: this.executor.paused,
      sun: plan.sun.map((x) => ({ date: x.date, sunrise: x.sunriseLabel, sunset: x.sunsetLabel, source: x.source })),
      backup_rules_plan: {
        light: lightPlan,
        sound: {
          wind_down: { sound: plan.audio.winddown.soundId, level: plan.audio.winddown.volume, why: plan.audio.winddown.reason },
          night: { sound: plan.audio.sleep.soundId, level: plan.audio.sleep.volume, until: at(plan.audio.sleep.end), why: plan.audio.sleep.reason },
        },
      },
    };
  }

  async tool_get_weather() {
    const { plan } = this.ctx();
    const w = plan.weather;
    const tz = plan.timezone;
    return {
      status: w.status,
      usable_tonight: w.usable,
      simulated: w.simulated ? `yes: offline scenario "${w.scenario}"` : false,
      location: w.location?.label ?? null,
      updated: w.fetchedAt ? formatClock(w.fetchedAt, tz) : null,
      current_outdoors_estimate: w.current ? { condition: w.current.label, cloud_cover: w.current.cloudCover, wind_kmh: w.current.windSpeed, gusts_kmh: w.current.windGusts } : null,
      tonight_hourly: (w.tonight ?? []).map((h) => ({ hour: h.hourLabel, condition: h.category, precip_chance: h.precipProbability, rain_mm: h.rain == null && h.showers == null ? null : (h.rain ?? 0) + (h.showers ?? 0), gusts_kmh: h.windGusts, strong_wind: h.strongWind })),
      windows: w.night,
      units: w.units,
      strong_wind_threshold: w.thresholds ? `sustained >= ${w.thresholds.strongWindSpeed} or gusts >= ${w.thresholds.strongWindGust} km/h (an engineering choice)` : null,
      notes: w.notes,
      reminder: 'Forecasts describe possible outdoor conditions, not the bedroom. null means unknown.',
    };
  }

  /** "HH:MM" -> next occurrence (within 24 h) in the person's timezone. */
  resolveTime(atText) {
    const tz = this.ctx().profile.timezone;
    if (!isClock(atText)) throw new ToolError('at must be a local time like 06:40');
    const now = this.clock();
    const today = zonedParts(now, tz).date;
    let t = zonedToUtc(today, atText, tz);
    if (t <= now + 30_000) t = zonedToUtc(addDays(today, 1), atText, tz);
    if (t - now > 24 * HOUR) throw new ToolError('Scheduled time must be within the next 24 hours');
    return t;
  }

  async tool_schedule_action(input) {
    if (this.executor.stopped) throw new ToolError('Stopped by the person. Nothing can be scheduled until they press Resume.');
    const at = this.resolveTime(String(input.at ?? ''));
    let args;
    if (input.action === 'set_lamp') {
      if (input.brightness == null || input.minutes == null) throw new ToolError('set_lamp needs brightness and minutes');
      args = { brightness: Math.round(num(input.brightness, 'brightness', 0, 100)), minutes: num(input.minutes, 'minutes', 0, 30) };
    } else if (input.action === 'play_sound') {
      if (!input.sound || input.level == null) throw new ToolError('play_sound needs sound and level');
      args = { sound: input.sound, level: input.level, fade_seconds: input.fade_seconds ?? 30 };
    } else throw new ToolError('action must be set_lamp or play_sound');
    const item = this.scheduler.add({ at, action: input.action, args, note: String(input.note ?? '').slice(0, 200) });
    return { scheduled: { id: item.id, at: formatClock(at, this.ctx().profile.timezone), action: item.action, args } };
  }

  async tool_list_scheduled() {
    const tz = this.ctx().profile.timezone;
    return { scheduled: this.scheduler.list().map((s) => ({ id: s.id, at: formatClock(s.at, tz), action: s.action, args: s.args, note: s.note })) };
  }

  async tool_cancel_scheduled(input) {
    if (!this.scheduler.cancel(String(input.id ?? ''))) throw new ToolError(`No scheduled action with id "${input.id}"`);
    return { cancelled: input.id };
  }
}

