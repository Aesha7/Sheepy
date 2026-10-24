// The policy engine: a deterministic, pure function.
//
//   buildPlan(userProfile, calendarContext, weatherContext, now, controls?) -> plan
//
// It never reads the clock, the network or hardware. The same inputs always give the same plan.
// Priority (highest first): hardware limits & stop (executor) > manual overrides > confirmed
// sleep/wake schedule > user preferences > calendar routine > weather & outdoor mirroring.
//
// `controls` (optional) carries user decisions that are not preferences:
//   decisions:          { [wakeDate]: { accepted: {windDownMinutes?, bedtime?, wakeTime?, wakeRampMinutes?}, declined: [proposalId] } }
//   overrides:          { light?|audio?|fan?: { target, setAt, expiresAt|null } }
//   previousWindows:    weather windows from the previous plan, for anti-oscillation
//   audioLock:          { night, selection } saved once the night started (keeps overnight sound stable)
//   stopped:            Stop is active (only affects the reported "now" audio selection)

import {
  MIN, HOUR, toInstant, localDate, addDays, zonedToUtc, formatClock, formatDate, formatClockString, shiftClock, isDate,
} from '../time.js';
import { sunTimes } from '../sun.js';
import { normalizeProfile, DAY_CATEGORIES, DAY_CATEGORY_LABELS, WEATHER_AUDIO_MODE_LABELS } from '../profile.js';
import { normalizeEvents } from '../calendar/events.js';
import { classifyDay } from '../calendar/classify.js';
import { assessWeather, findWeatherWindows, stabilizeWindows, skyBucket, CONDITION_LABELS } from '../weather/analyze.js';
import { overrideActive, OUTPUTS } from './timeline.js';
import { planAudioSegments, selectWeatherAudio } from './weatherAudio.js';

export const PLAN_VERSION = 1;

export class PlanInputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PlanInputError';
    this.details = details;
  }
}

const CAL_STATUSES = ['connected', 'manual', 'not_connected', 'error', 'simulated'];
const SETTLE_MINUTES = 15;
const MORNING_HOURS = 4;
const MIN_SKY_RUN = 2 * HOUR;

function normalizeCalendar(ctx, tz) {
  const status = CAL_STATUSES.includes(ctx?.status) ? ctx.status : ctx ? 'manual' : 'not_connected';
  const { events, dropped } = normalizeEvents(ctx?.events, tz);
  const dayLabels = {};
  for (const [date, cat] of Object.entries(ctx?.dayLabels ?? {})) {
    if (isDate(date) && DAY_CATEGORIES.includes(cat)) dayLabels[date] = cat;
  }
  return {
    status,
    source: ctx?.source ?? (status === 'not_connected' ? 'none' : 'manual'),
    simulated: status === 'simulated' || !!ctx?.simulated,
    fetchedAt: toInstant(ctx?.fetchedAt),
    error: ctx?.error ?? null,
    events,
    dropped,
    dayLabels,
  };
}

const clampK = (k) => Math.max(1800, Math.min(6500, Math.round(k)));
const input = (kind, text) => ({ kind, text });

/**
 * @returns {object} plan: schedule, day, proposals, weather, sun, outputs (per-output segments), phases, explanations
 */
export function buildPlan(userProfile, calendarContext, weatherContext, now, controls = {}) {
  const t = toInstant(now);
  if (t == null) throw new PlanInputError('now must be a valid time');
  const { profile, errors, warnings, defaultsUsed } = normalizeProfile(userProfile);
  if (errors.length) throw new PlanInputError(`Invalid profile: ${errors.join('; ')}`, errors);
  const tz = profile.timezone;
  const L = profile.lighting;
  const S = profile.sound;
  const at = (ms) => formatClock(ms, tz);
  const notices = [...warnings];
  const criticalDefaults = defaultsUsed.filter((p) => ['timezone', 'schedule.bedtime', 'schedule.wakeTime'].includes(p));
  if (criticalDefaults.length) notices.push(`Using defaults for ${criticalDefaults.join(', ')} because they are not set.`);

  const cal = normalizeCalendar(calendarContext, tz);
  if (cal.dropped.length) notices.push(`${cal.dropped.length} calendar event(s) were ignored because they were invalid.`);

  // ---- 1. Which night are we planning? The one ending at the next wake time after `now`. ----
  const decisions = controls.decisions && typeof controls.decisions === 'object' ? controls.decisions : {};
  const acceptedFor = (date) => decisions[date]?.accepted ?? {};
  const wakeClockFor = (date) => acceptedFor(date).wakeTime ?? profile.schedule.wakeTime;
  const today = localDate(t, tz);
  let wakeDate = today;
  let wakeEnd = zonedToUtc(today, wakeClockFor(today), tz);
  if (wakeEnd <= t) {
    wakeDate = addDays(today, 1);
    wakeEnd = zonedToUtc(wakeDate, wakeClockFor(wakeDate), tz);
  }
  const eveningDate = addDays(wakeDate, -1);

  // ---- 2. Tomorrow's category (in the user's timezone) and the routine it suggests. ----
  const day = classifyDay(cal, wakeDate, wakeEnd, tz, profile);
  notices.push(...day.notices);
  const accepted = acceptedFor(wakeDate);
  const declined = new Set(decisions[wakeDate]?.declined ?? []);
  const base = {
    bedtime: profile.schedule.bedtime,
    wakeTime: profile.schedule.wakeTime,
    windDownMinutes: profile.schedule.windDownMinutes,
    wakeRampMinutes: L.wakeRampMinutes,
  };

  const proposals = [];
  const propose = (id, field, to, text) => {
    if (to === base[field]) return;
    proposals.push({
      id,
      field,
      from: base[field],
      to,
      text,
      status: accepted[field] !== undefined ? 'accepted' : declined.has(id) ? 'declined' : 'pending',
    });
  };
  const R = profile.routines;
  const routineKey = ['important', 'early', 'relaxed'].includes(day.category) ? day.category : 'standard';
  if (routineKey === 'important') {
    propose('important.windDown', 'windDownMinutes', R.important.windDownMinutes,
      `Use your important-day preset: a ${R.important.windDownMinutes}-minute wind-down instead of ${base.windDownMinutes} minutes. Bedtime and wake time stay the same.`);
  } else if (routineKey === 'early' && R.early.bedtimeShiftMinutes > 0) {
    const to = shiftClock(base.bedtime, -R.early.bedtimeShiftMinutes);
    propose('early.bedtime', 'bedtime', to,
      `Early start: go to bed ${R.early.bedtimeShiftMinutes} minutes earlier (${formatClockString(to)} instead of ${formatClockString(base.bedtime)}). Your wake time stays ${formatClockString(base.wakeTime)}.`);
  } else if (routineKey === 'relaxed') {
    propose('relaxed.windDown', 'windDownMinutes', R.relaxed.windDownMinutes,
      `Use your relaxed preset: a ${R.relaxed.windDownMinutes}-minute wind-down instead of ${base.windDownMinutes} minutes.`);
    if (L.wakeLight) {
      propose('relaxed.wakeRamp', 'wakeRampMinutes', R.relaxed.wakeRampMinutes,
        `Gentler wake: brighten over ${R.relaxed.wakeRampMinutes} minutes instead of ${base.wakeRampMinutes}, with a softer final scene.`);
    }
    if (R.relaxed.allowWakeChange) {
      propose('relaxed.wakeTime', 'wakeTime', R.relaxed.relaxedWakeTime,
        `Wake at ${formatClockString(R.relaxed.relaxedWakeTime)} instead of ${formatClockString(base.wakeTime)}. This only changes Drift's wake routine; your phone alarm is not touched.`);
    }
  }

  // Accepted values are locked for this night until the user edits them.
  const sched = {
    bedtime: accepted.bedtime ?? base.bedtime,
    wakeTime: accepted.wakeTime ?? base.wakeTime,
    windDownMinutes: accepted.windDownMinutes ?? base.windDownMinutes,
    wakeRampMinutes: accepted.wakeRampMinutes ?? base.wakeRampMinutes,
  };
  const routineApplied = routineKey !== 'standard' && proposals.some((p) => p.status === 'accepted');
  const gentleWake = routineKey === 'relaxed' && accepted.wakeRampMinutes !== undefined;
  const steadyAudio = routineKey === 'important';

  let bedtime = zonedToUtc(wakeDate, sched.bedtime, tz);
  if (bedtime >= wakeEnd) bedtime = zonedToUtc(eveningDate, sched.bedtime, tz);
  const windDownStart = bedtime - sched.windDownMinutes * MIN;
  const settleEnd = Math.min(bedtime + SETTLE_MINUTES * MIN, wakeEnd);
  const wakeStart = L.wakeLight ? Math.max(settleEnd, wakeEnd - sched.wakeRampMinutes * MIN) : wakeEnd;
  const prevWakeEnd = Math.min(zonedToUtc(eveningDate, wakeClockFor(eveningDate), tz), windDownStart);
  const morningEnd = wakeEnd + MORNING_HOURS * HOUR;

  const schedule = {
    eveningDate,
    wakeDate,
    awakeStart: prevWakeEnd,
    windDownStart,
    bedtime,
    settleEnd,
    wakeStart,
    wakeEnd,
    morningEnd,
    windDownMinutes: sched.windDownMinutes,
    wakeRampMinutes: L.wakeLight ? sched.wakeRampMinutes : 0,
    bedtimeClock: sched.bedtime,
    wakeClock: sched.wakeTime,
    confirmed: { bedtime: base.bedtime, wakeTime: base.wakeTime },
    locked: Object.keys(accepted),
  };

  // ---- 3. Sun and weather context. ----
  const hasLocation = profile.location.lat != null;
  const sun = {};
  if (hasLocation) {
    for (const date of [eveningDate, wakeDate]) sun[date] = { date, ...sunTimes(date, profile.location.lat, profile.location.lon), source: 'calculated' };
  }
  const wx = assessWeather(weatherContext, t, wakeEnd);
  const weatherUsable = wx.usable;
  // Provider sunrise/sunset (when available) wins over the local calculation.
  for (const date of [eveningDate, wakeDate]) {
    const p = weatherContext?.sun?.[date];
    if (p && (p.sunrise != null || p.sunset != null)) sun[date] = { date, sunrise: p.sunrise, sunset: p.sunset, polar: null, source: wx.simulated ? 'offline scenario' : wx.source };
  }
  let windows = [];
  if (weatherUsable) {
    windows = stabilizeWindows(findWeatherWindows(wx.hourly, windDownStart - HOUR, wakeEnd), controls.previousWindows ?? [], t);
  }
  const wxInput = (text) => input('weather', `${text} (${wx.simulated ? 'simulated ' : ''}forecast${wx.fetchedAt ? `, updated ${at(wx.fetchedAt)}` : ''})`);
  const windowText = (w) => `${at(w.start)}–${at(w.end)}`;

  const explanations = [];
  const explain = (kind, text) => explanations.push({ kind, text });

  // ---- 4. Lighting. Sleep settings outrank outdoor mirroring at night. ----
  const maxB = L.maxBrightness;
  const scenes = {
    day: { brightness: maxB, colorTempK: L.dayColorTempK },
    evening: { brightness: Math.round(maxB * 0.6), colorTempK: L.eveningWarmthK },
    windDown: { brightness: Math.max(3, Math.round(maxB * 0.25)), colorTempK: L.eveningWarmthK },
    night: { brightness: L.nightLightBrightness, colorTempK: clampK(Math.min(L.eveningWarmthK, 2200)) },
    wake: { brightness: Math.round(maxB * (gentleWake ? 0.55 : 0.8)), colorTempK: clampK(Math.min(L.dayColorTempK, 4000)) },
  };
  const skyScene = (bucket) => {
    const r = L.cloudyResponse;
    if (bucket === 'clear' || r === 'unchanged') return scenes.day;
    if (bucket === 'partly') return r === 'softer'
      ? { brightness: Math.round(maxB * 0.85), colorTempK: clampK(L.dayColorTempK - 250) }
      : { brightness: Math.round(maxB * 0.8), colorTempK: L.dayColorTempK };
    return r === 'softer'
      ? { brightness: Math.round(maxB * 0.7), colorTempK: clampK(L.dayColorTempK - 500) }
      : { brightness: Math.round(maxB * 0.55), colorTempK: L.dayColorTempK };
  };
  const seg = (output, phase, start, end, target, transitionMinutes, reason, inputs) =>
    ({ output, phase, start, end, target, transitionMinutes, reason, inputs, overridden: false, override: null });
  const prefLimit = input('preference', `Brightness limit ${maxB}%`);

  const awakeLight = (from, to, phase) => {
    if (to - from < 10 * MIN) return [];
    const out = [];
    if (!L.mirrorDaylight || !hasLocation) {
      const why = !L.mirrorDaylight ? 'Outdoor mirroring is off, so your scheduled daytime scene is used.' : 'No location set, so outdoor conditions can’t be mirrored; your scheduled daytime scene is used.';
      const eveningAt = phase === 'awake' ? to - 2 * HOUR : Infinity;
      out.push(seg('light', phase, from, Math.min(to, Math.max(from, eveningAt)), scenes.day, 15, `${why} Up to ${maxB}% at ${L.dayColorTempK}K.`,
        [input('preference', L.mirrorDaylight ? 'Mirror daylight: on (no location)' : 'Mirror daylight: off'), prefLimit]));
      if (eveningAt < to) {
        out.push(seg('light', phase, Math.max(from, eveningAt), to, scenes.evening, 30, `Your scheduled evening scene (${scenes.evening.brightness}%, ${L.eveningWarmthK}K) starts two hours before wind-down.`,
          [input('preference', `Evening warmth ${L.eveningWarmthK}K`), input('schedule', `Wind-down ${at(windDownStart)}`)]));
      }
      return out.filter((s) => s.end > s.start);
    }
    const sunDay = sun[localDate(from, tz)] ?? sun[localDate(to, tz)];
    const sunsetRamp = sunDay?.polar === 'night' ? from : sunDay?.sunset != null ? sunDay.sunset - 45 * MIN : null;
    const dayEnd = sunsetRamp == null ? to : Math.min(to, Math.max(from, sunsetRamp));

    if (dayEnd > from) {
      if (!weatherUsable) {
        const why = wx.status === 'unavailable' ? 'Weather is unavailable' : 'Weather data is stale';
        out.push(seg('light', phase, from, dayEnd, scenes.day, 20, `${why}, so cloud cover isn’t used. Your standard daytime scene is mirrored to daylight hours (${maxB}%, ${L.dayColorTempK}K).`,
          [input('preference', 'Mirror daylight: on'), prefLimit, input('weather', `Weather: ${wx.status}`)]));
      } else {
        const runs = [];
        for (let h = from; h < dayEnd; h += HOUR) {
          const isNowHour = h <= t && t < h + HOUR;
          const entry = isNowHour && wx.currentStatus === 'fresh' ? wx.current : wx.hourly.find((x) => x.time <= h && h < x.time + HOUR);
          const bucket = skyBucket(entry) ?? 'unknown';
          const condition = entry?.condition ?? null;
          const last = runs[runs.length - 1];
          if (last && last.bucket === bucket) last.end = Math.min(h + HOUR, dayEnd);
          else runs.push({ bucket, condition, start: h, end: Math.min(h + HOUR, dayEnd) });
        }
        // Absorb short blips so a single cloudy hour doesn't wobble the lights.
        for (let i = 0; i < runs.length && runs.length > 1;) {
          if (runs[i].end - runs[i].start < MIN_SKY_RUN) {
            const into = i > 0 ? i - 1 : i + 1;
            runs[into].start = Math.min(runs[into].start, runs[i].start);
            runs[into].end = Math.max(runs[into].end, runs[i].end);
            runs.splice(i, 1);
            i = 0;
          } else i += 1;
        }
        for (const r of runs) {
          if (r.bucket === 'unknown') {
            out.push(seg('light', phase, r.start, r.end, scenes.day, 30, `No sky data for these hours. Missing data is treated as unknown, not clear, so your standard daytime scene is used (${maxB}%).`,
              [input('preference', 'Mirror daylight: on'), prefLimit, wxInput('Sky: unknown')]));
            continue;
          }
          const target = skyScene(r.bucket);
          const cond = CONDITION_LABELS[r.condition] ?? (r.bucket === 'clear' ? 'Clear' : r.bucket === 'partly' ? 'Partly cloudy' : 'Overcast');
          const reason = r.bucket === 'clear'
            ? `${cond} outside. Your daytime scene uses up to your ${maxB}% brightness limit.`
            : L.cloudyResponse === 'unchanged'
              ? `${cond} outside. You chose not to change lighting for clouds, so your daytime scene stays at ${target.brightness}%.`
              : `${cond} outside. You chose a ${L.cloudyResponse} scene for cloudy weather, so lights sit at ${target.brightness}%, ${target.colorTempK}K.`;
          out.push(seg('light', phase, r.start, r.end, target, 30, reason,
            [input('preference', 'Mirror daylight: on'), input('preference', `Cloudy days: ${L.cloudyResponse}`), prefLimit, wxInput(`Sky: ${cond.toLowerCase()}`)]));
        }
      }
    }
    if (sunsetRamp != null && sunsetRamp < to) {
      const reason = sunDay.polar === 'night'
        ? `The sun doesn’t rise here today, so your warm evening scene is used (${scenes.evening.brightness}%, ${L.eveningWarmthK}K).`
        : `Sunset is at ${at(sunDay.sunset)}. Lights ease toward your warm evening scene (${scenes.evening.brightness}%, ${L.eveningWarmthK}K) over an hour.`;
      out.push(seg('light', phase, Math.max(from, sunsetRamp), to, scenes.evening, 60, reason,
        [input('sun', sunDay.sunset ? `Sunset ${at(sunDay.sunset)}` : 'Polar night'), input('preference', `Evening warmth ${L.eveningWarmthK}K`)]));
    }
    return out;
  };

  const winddownEvent = day.events.find((e) => e.importance === 'important') ?? day.events.find((e) => ['exam', 'presentation'].includes(e.category));
  let windDownReason;
  if (routineKey === 'important' && accepted.windDownMinutes !== undefined) {
    const marked = day.source === 'user' ? 'You marked tomorrow as important' : winddownEvent?.importance === 'important' ? `You marked tomorrow’s ${winddownEvent.title} as important` : `Tomorrow looks important (${winddownEvent?.title ?? 'calendar'})`;
    windDownReason = `${marked} and selected a ${sched.windDownMinutes}-minute wind-down. Your evening lighting will gradually dim at ${at(windDownStart)}.`;
  } else if (routineKey === 'relaxed' && accepted.windDownMinutes !== undefined) {
    windDownReason = `Tomorrow is a relaxation day and you accepted your ${sched.windDownMinutes}-minute relaxed wind-down. Lights begin dimming at ${at(windDownStart)}.`;
  } else if (routineKey === 'early' && accepted.bedtime !== undefined) {
    windDownReason = `Tomorrow starts early and you accepted a ${formatClockString(sched.bedtime)} bedtime, so your ${sched.windDownMinutes}-minute wind-down starts at ${at(windDownStart)}.`;
  } else {
    windDownReason = `Your ${sched.windDownMinutes}-minute wind-down starts at ${at(windDownStart)}. Lights dim gradually to ${scenes.windDown.brightness}% at ${L.eveningWarmthK}K by bedtime.`;
  }
  const scheduleInputs = [input('schedule', `Bedtime ${formatClockString(sched.bedtime)}${accepted.bedtime ? ' (accepted for tonight)' : ' (confirmed)'}`), input('preference', `Wind-down ${sched.windDownMinutes} min`)];
  const calendarInputs = routineKey !== 'standard' && routineApplied ? [input('calendar', `Tomorrow: ${DAY_CATEGORY_LABELS[day.category]} (${day.source === 'user' ? 'your label' : 'inferred'})`)] : [];

  const sunrise = sun[wakeDate]?.sunrise ?? null;
  const light = [
    ...awakeLight(prevWakeEnd, windDownStart, 'awake'),
    seg('light', 'winddown', windDownStart, bedtime, scenes.windDown, sched.windDownMinutes, windDownReason,
      [...scheduleInputs, input('preference', `Evening warmth ${L.eveningWarmthK}K`), ...calendarInputs]),
    seg('light', 'bedtime', bedtime, settleEnd, scenes.night, 10,
      `Bedtime ${at(bedtime)}: lights fade ${L.nightLightBrightness > 0 ? `to your ${L.nightLightBrightness}% night light` : 'off'} over 10 minutes.`,
      [input('schedule', `Bedtime ${formatClockString(sched.bedtime)}`), input('preference', `Night light ${L.nightLightBrightness}%`)]),
    seg('light', 'overnight', settleEnd, wakeStart, scenes.night, 0,
      sunrise != null && sunrise < wakeStart
        ? `Sunrise is at ${at(sunrise)}, before your wake window. Sleep settings take priority over outdoor mirroring, so the room stays ${L.nightLightBrightness > 0 ? 'at night-light level' : 'dark'} until ${at(wakeStart)}.`
        : `Lights stay ${L.nightLightBrightness > 0 ? `at ${L.nightLightBrightness}%` : 'off'} through the night. Weather never changes lights while you sleep, and lightning never triggers flashing.`,
      [input('schedule', `Sleep window ${at(bedtime)}–${at(wakeEnd)}`), ...(sunrise != null ? [input('sun', `Sunrise ${at(sunrise)}`)] : [])]),
  ];
  if (L.wakeLight) {
    light.push(seg('light', 'wake', wakeStart, wakeEnd, scenes.wake, sched.wakeRampMinutes,
      `${gentleWake ? 'Gentler relaxed-day wake: lights' : 'Your approved wake window: lights'} brighten over ${sched.wakeRampMinutes} minutes to ${scenes.wake.brightness}% by ${at(wakeEnd)}${accepted.wakeTime ? ' (your accepted later wake time)' : ''}.`,
      [input('schedule', `Wake ${formatClockString(sched.wakeTime)}${accepted.wakeTime ? ' (accepted for tomorrow)' : ' (confirmed)'}`), input('preference', `Wake light ${sched.wakeRampMinutes} min`),
        ...(routineKey === 'relaxed' && gentleWake ? [input('calendar', 'Tomorrow: relaxation day')] : [])]));
  }
  const morning = awakeLight(wakeEnd, morningEnd, 'morning');
  if (!L.wakeLight && morning.length) {
    morning[0] = { ...morning[0], transitionMinutes: 15, reason: `Wake light is off, so lights come up gently after ${at(wakeEnd)}. ${morning[0].reason}` };
  }
  light.push(...morning);

  // ---- 5. Audio: selectWeatherAudio() per phase. Weather never pushes past the volume cap. ----
  const wakeFadeStart = L.wakeLight ? wakeStart : Math.max(settleEnd, wakeEnd - 10 * MIN);
  const lock = controls.audioLock?.night === eveningDate ? controls.audioLock.selection : null;
  const audioPlan = planAudioSegments({
    profile, wx, windows: windows.filter((w) => w.end > bedtime && w.start < wakeFadeStart), steady: steadyAudio, lock, now: t, tz, seg,
    times: { prevWakeEnd, windDownStart, bedtime, settleEnd, wakeFadeStart, wakeEnd, morningEnd, windDownMinutes: sched.windDownMinutes },
  });
  const audio = audioPlan.segments;
  const sel = audioPlan.selections;
  const weatherNotes = [...new Set([sel.winddown.reason, sel.sleep.reason, ...sel.switched.map((x) => x.reason)])];
  const phaseNow = t >= windDownStart && t < bedtime ? { key: 'winddown', start: windDownStart, end: bedtime }
    : t >= bedtime && t < wakeFadeStart ? { key: 'sleep', start: bedtime, end: wakeFadeStart, lock }
      : t >= wakeFadeStart && t < wakeEnd ? { key: 'wake', start: wakeFadeStart, end: wakeEnd }
        : { key: 'awake', start: t, end: windDownStart > t ? windDownStart : t };
  const plannedNow = phaseNow.key === 'winddown' ? sel.winddown
    : phaseNow.key === 'sleep' ? (sel.switched.find((x) => x.start <= t && t < x.end) ?? (t < sel.sleep.end ? sel.sleep : null))
      : null;
  const overrideNow = controls.overrides?.audio && overrideActive(controls.overrides.audio, t) ? controls.overrides.audio : null;
  const audioNow = controls.stopped || overrideNow || !plannedNow
    ? selectWeatherAudio(wx, S, { ...phaseNow, timezone: tz, steady: steadyAudio }, { stopped: !!controls.stopped, audio: overrideNow }, t)
    : plannedNow;

  // ---- 6. Optional fan. ----
  const fan = [];
  if (profile.fan.enabled) {
    fan.push(
      seg('fan', 'awake', prevWakeEnd, bedtime, { level: 0 }, 0, 'Fan off until bedtime.', [input('preference', 'Fan enabled')]),
      seg('fan', 'overnight', bedtime, wakeStart, { level: profile.fan.overnightLevel }, 0, `Fan at your overnight level ${profile.fan.overnightLevel} while you sleep.`, [input('preference', `Fan level ${profile.fan.overnightLevel}`)]),
      seg('fan', 'wake', wakeStart, morningEnd, { level: 0 }, 0, 'Fan off for your wake routine.', [input('schedule', `Wake ${formatClockString(sched.wakeTime)}`)]),
    );
  }

  // ---- 7. Manual overrides outrank everything except hardware limits and Stop. ----
  const overrides = {};
  const outputs = { light, audio, fan };
  for (const output of OUTPUTS) {
    const o = controls.overrides?.[output];
    if (!o || typeof o.setAt !== 'number') continue;
    if (o.expiresAt != null && o.expiresAt <= t) continue;
    overrides[output] = { ...o, active: overrideActive(o, t) };
    outputs[output] = outputs[output].map((s) =>
      s.end > o.setAt && (o.expiresAt == null || s.start < o.expiresAt)
        ? { ...s, overridden: true, override: { target: o.target, setAt: o.setAt, expiresAt: o.expiresAt ?? null } }
        : s);
  }

  // ---- 8. Finalize: ids, labels, explanations. ----
  for (const output of OUTPUTS) {
    outputs[output] = outputs[output]
      .filter((s) => s.end > s.start)
      .map((s, i) => ({ id: `${output}-${i}`, ...s, startLabel: at(s.start), endLabel: at(s.end) }));
  }

  const dayText = day.source === 'user'
    ? `You labeled tomorrow (${formatDate(wakeDate)}) as “${day.label}”.`
    : day.needsChoice
      ? `Tomorrow (${formatDate(wakeDate)}) has mixed signals. Choose a category; until then your standard routine is used.`
      : day.category === 'unknown'
        ? `Tomorrow (${formatDate(wakeDate)}) is unknown. ${day.reasons[0] ?? ''}`
        : `Tomorrow (${formatDate(wakeDate)}) looks like “${day.label}” (inferred; you can change it). ${day.reasons[0] ?? ''}`;
  explain('calendar', dayText.trim());
  for (const p of proposals.filter((x) => x.status === 'pending')) explain('proposal', `Suggested, not applied yet: ${p.text}`);
  for (const p of proposals.filter((x) => x.status === 'declined')) explain('proposal', `You declined: ${p.text} Your standard timing is kept.`);
  for (const field of Object.keys(accepted)) {
    if (!proposals.some((p) => p.field === field)) explain('schedule', `Locked for tonight: you accepted ${field} = ${accepted[field]}. Edit it to change.`);
  }
  explain('schedule', windDownReason);
  if (sunrise != null && sunrise < wakeStart) explain('sun', `Sunrise (${at(sunrise)}) comes before your wake window, so lights stay ${L.nightLightBrightness > 0 ? 'at night-light level' : 'off'} until ${at(wakeStart)}.`);
  for (const n of weatherNotes) explain('weather', n);
  for (const n of wx.notes) explain('data', n);
  if (!hasLocation) explain('data', 'No location set, so sunrise/sunset and weather are not used.');
  for (const n of notices) explain('notice', n);
  for (const o of Object.keys(overrides)) {
    const ov = overrides[o];
    explain('override', `Manual ${o} override ${ov.active ? 'is active' : 'is scheduled'}${ov.expiresAt ? ` until ${at(ov.expiresAt)}` : ' until you clear it'}. It takes priority over the plan.`);
  }

  const phases = [
    { key: 'awake', label: 'Awake / daytime', start: prevWakeEnd, end: windDownStart },
    { key: 'winddown', label: 'Wind-down', start: windDownStart, end: bedtime },
    { key: 'bedtime', label: 'Bedtime routine', start: bedtime, end: settleEnd },
    { key: 'overnight', label: 'Overnight', start: settleEnd, end: wakeStart },
    { key: 'wake', label: 'Wake routine', start: wakeStart, end: wakeEnd },
    { key: 'morning', label: 'Morning', start: wakeEnd, end: morningEnd },
  ].filter((p) => p.end > p.start).map((p) => ({ ...p, startLabel: at(p.start), endLabel: at(p.end) }));

  return {
    version: PLAN_VERSION,
    userId: profile.id,
    userName: profile.name,
    timezone: tz,
    now: t,
    nowLabel: at(t),
    currentPhase: phases.find((p) => p.start <= t && t < p.end)?.key ?? (t < phases[0].start ? 'before' : 'after'),
    schedule: { ...schedule, labels: { windDownStart: at(windDownStart), bedtime: at(bedtime), wakeStart: at(wakeStart), wakeEnd: at(wakeEnd), awakeStart: at(prevWakeEnd) } },
    day,
    routine: {
      key: routineKey,
      label: routineKey === 'standard' ? 'Standard routine' : `${DAY_CATEGORY_LABELS[day.category]} preset`,
      applied: routineApplied,
      status: routineKey === 'standard' ? 'standard' : routineApplied ? 'accepted' : proposals.length ? 'proposed' : 'no changes needed',
    },
    proposals,
    calendar: { status: cal.status, source: cal.source, simulated: cal.simulated, fetchedAt: cal.fetchedAt, error: cal.error, eventCount: cal.events.length },
    weather: {
      status: wx.status,
      usable: wx.usable,
      currentStatus: wx.currentStatus,
      forecastStatus: wx.forecastStatus,
      source: wx.source,
      simulated: wx.simulated,
      scenario: wx.scenario,
      location: wx.location,
      attribution: wx.attribution,
      units: wx.units,
      thresholds: wx.thresholds,
      fetchedAt: wx.fetchedAt,
      validFrom: wx.validFrom,
      validUntil: wx.validUntil,
      current: wx.current,
      notes: wx.notes,
      error: wx.error,
      windows: windows.map((w) => ({ ...w, label: windowText(w) })),
      // Hours from two hours before wind-down to wake, for the dashboard forecast strip.
      tonight: wx.hourly.filter((h) => h.time + HOUR > windDownStart - 2 * HOUR && h.time < wakeEnd).map((h) => ({ ...h, label: h.label, hourLabel: at(h.time) })),
      night: {
        rain: windows.filter((w) => w.kind === 'rain').map(windowText),
        storm: windows.filter((w) => w.kind === 'storm').map(windowText),
        wind: windows.filter((w) => w.kind === 'wind').map(windowText),
      },
    },
    audio: {
      mode: S.weatherMode,
      modeLabel: WEATHER_AUDIO_MODE_LABELS[S.weatherMode],
      overnight: S.overnight,
      timerMinutes: S.timerMinutes,
      transitionsAllowed: S.weatherTransitions,
      winddown: sel.winddown,
      sleep: sel.sleep,
      switched: sel.switched,
      now: audioNow,
      lockedSince: lock ? bedtime : null,
    },
    sun: Object.values(sun).map((s) => ({ ...s, sunriseLabel: s.sunrise ? at(s.sunrise) : null, sunsetLabel: s.sunset ? at(s.sunset) : null })),
    outputs,
    overrides,
    phases,
    explanations,
    disclaimer: 'Drift follows your preferences. It is not medical advice and cannot guarantee better sleep or performance.',
  };
}
