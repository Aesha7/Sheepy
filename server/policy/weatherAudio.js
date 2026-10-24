// Weather-aware sound selection. Deterministic and pure: no clock, network, playback or hardware.
//
//   selectWeatherAudio(weatherContext, userPreferences, routinePhase, overrides, now) -> selection
//
// Priority (highest first): Stop and device limits -> manual overrides -> confirmed sleep schedule
// (the phase window is given, never changed here) -> user preferences -> calendar routine -> weather.
//
// Choices are preference-based. No sound is presented as scientifically best for any weather, and
// weather never invents a frequency or tempo: music is the user's chosen track, unchanged.

import { MIN, HOUR, formatClock } from '../time.js';
import { SOUND_LABELS, WEATHER_AUDIO_MODE_LABELS, MUSIC_TRACKS } from '../profile.js';
import { isRainy, isStormy, isWindy } from '../weather/analyze.js';
import { overlay, overrideActive } from './timeline.js';

export const FORECAST_CAVEAT = 'Forecasts describe possible outdoor conditions, not how your bedroom will sound.';
const PHASE_TEXT = { winddown: 'your wind-down', sleep: 'the night', awake: 'the day', wake: 'your wake routine' };
const CATEGORY_TEXT = { clear: 'clear skies', cloudy: 'clouds', fog: 'fog', snow: 'snow', rain: 'rain', thunderstorm: 'thunderstorms', unknown: 'unknown conditions' };

export class AudioPolicyError extends Error {}

const input = (kind, text) => ({ kind, text });
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the forecast says inside [start, end). Missing hours stay "unknown", never "clear". */
export function conditionsIn(wx, start, end) {
  const hours = (wx?.hourly ?? []).filter((h) => h.time + HOUR > start && h.time < end);
  const span = (pred, peakOf) => {
    const hits = hours.filter(pred);
    if (!hits.length) return null;
    const peaks = hits.map(peakOf).filter((v) => v != null);
    return { from: Math.max(hits[0].time, start), to: Math.min(hits[hits.length - 1].time + HOUR, end), peak: peaks.length ? Math.max(...peaks) : null, hours: hits.length };
  };
  return {
    hours: hours.length,
    rain: span((h) => isRainy(h), (h) => h.precipProbability),
    storm: span((h) => isStormy(h), (h) => h.thunderProbability ?? h.precipProbability),
    wind: span((h) => isWindy(h), (h) => h.windGusts ?? h.windSpeed),
    categories: [...new Set(hours.map((h) => h.category ?? 'unknown'))],
    unknownHours: hours.filter((h) => !h.category || h.category === 'unknown').length,
  };
}

function validate(prefs, phase, now) {
  if (!prefs || typeof prefs !== 'object') throw new AudioPolicyError('userPreferences must be an object');
  for (const k of ['preferred', 'volume', 'maxVolume', 'weatherMode', 'stormSound']) {
    if (prefs[k] === undefined) throw new AudioPolicyError(`userPreferences.${k} is required`);
  }
  if (!phase || typeof phase.key !== 'string' || !Number.isFinite(phase.start) || !Number.isFinite(phase.end) || phase.end < phase.start) {
    throw new AudioPolicyError('routinePhase needs key, start and end (end >= start)');
  }
  if (!Number.isFinite(now)) throw new AudioPolicyError('now must be epoch milliseconds');
}

/**
 * @param {object|null} weatherContext assessed weather (assessWeather output)
 * @param {object} userPreferences normalized profile.sound
 * @param {{key, start, end, timezone?, steady?, transitionMinutes?, lock?, ignoreWeather?}} routinePhase
 *   key: 'awake' | 'winddown' | 'sleep' | 'wake'. steady = calendar marks tomorrow important.
 *   lock = selection saved once the night started (keeps overnight sound stable).
 * @param {{stopped?: boolean, audio?: {target, setAt, expiresAt}}} overrides
 * @param {number} now epoch ms
 */
export function selectWeatherAudio(weatherContext, userPreferences, routinePhase, overrides = {}, now) {
  validate(userPreferences, routinePhase, now);
  const S = userPreferences;
  const P = routinePhase;
  const tz = P.timezone ?? 'UTC';
  const at = (ms) => formatClock(ms, tz);
  const span = (w) => `${at(w.from)}–${at(w.to)}`;
  const vol = Math.max(0, Math.min(S.volume, S.maxVolume));
  const wx = weatherContext;
  const wxStatus = wx?.status ?? 'unavailable';
  const usable = !!wx?.usable;
  const phaseText = PHASE_TEXT[P.key] ?? 'this phase';
  const timerApplies = P.key === 'sleep' && S.overnight === false;
  const end = timerApplies ? Math.min(P.end, P.start + (S.timerMinutes ?? 30) * MIN) : P.end;

  const inputs = [
    input('preference', `Weather sound: ${WEATHER_AUDIO_MODE_LABELS[S.weatherMode] ?? S.weatherMode}`),
    input('preference', `Saved level ${vol}% (cap ${S.maxVolume}%)`),
    input('weather', `Weather data: ${wxStatus}${wx?.simulated ? ` (offline scenario${wx.scenario ? ` “${wx.scenario}”` : ''})` : ''}`),
  ];
  const conds = usable ? conditionsIn(wx, P.start, end) : null;

  const make = (soundId, rule, reason, extra = {}) => {
    const silent = soundId === 'silence';
    const channels = extra.channels ?? (silent || vol <= 0 ? {} : { [soundId]: vol });
    const volume = Object.values(channels).reduce((a, b) => a + b, 0);
    return {
      soundId,
      soundLabel: SOUND_LABELS[soundId] ?? soundId,
      kind: silent ? 'silence' : MUSIC_TRACKS.includes(soundId) ? 'music' : 'noise',
      channels,
      volume,
      maxVolume: S.maxVolume,
      start: P.start,
      end: extra.end ?? end,
      durationMinutes: Math.round(((extra.end ?? end) - P.start) / MIN),
      transitionMinutes: extra.transitionMinutes ?? P.transitionMinutes ?? 10,
      rule,
      reason,
      inputs: [...inputs, ...(extra.inputs ?? [])],
      weather: { status: wxStatus, usable, simulated: !!wx?.simulated, scenario: wx?.scenario ?? null, conditions: conds },
      steadyOvernight: P.key === 'sleep' && !S.weatherTransitions,
      locked: !!extra.locked,
    };
  };

  // 1. Stop beats everything.
  if (overrides?.stopped) return make('silence', 'stop', 'Stop is active, so nothing plays and pending changes are cancelled until you resume.', { transitionMinutes: 0 });

  // 2. A manual override wins over every rule below. Its level is still capped.
  const ov = overrides?.audio;
  if (ov && overrideActive(ov, now)) {
    let channels = {};
    if (ov.target?.channels) channels = { ...ov.target.channels };
    else if (typeof ov.target?.volume === 'number' && S.preferred !== 'silence') channels = { [S.preferred]: ov.target.volume };
    const total = Object.values(channels).reduce((a, b) => a + b, 0);
    if (total > S.maxVolume && total > 0) for (const k of Object.keys(channels)) channels[k] *= S.maxVolume / total;
    const top = Object.entries(channels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'silence';
    return make(top, 'override', `Manual override${ov.expiresAt ? ` until ${at(ov.expiresAt)}` : ' until you clear it'}. It takes priority over your routine and the weather.`, {
      channels, transitionMinutes: 0, end: ov.expiresAt ?? end, inputs: [input('override', 'Manual sound override')],
    });
  }

  // 3. The schedule decides when sound may play at all.
  if (P.key === 'awake') return make('silence', 'awake', 'No sound is planned while you’re awake.');
  if (P.key === 'wake') return make('silence', 'wake', `Sound fades out before your wake time at ${at(P.end)}.`);

  // 4. Preferences.
  if (S.weatherMode === 'silence') return make('silence', 'silence-mode', 'You chose Silence, so Drift never starts sound automatically, whatever the weather.');
  const music = P.key === 'winddown' && S.windDownTrack && S.windDownTrack !== 'none' ? S.windDownTrack : null;
  const baseId = music ?? S.preferred;
  const baseText = SOUND_LABELS[baseId] ?? baseId;
  const timerText = timerApplies ? ` Your ${S.timerMinutes}-minute playback timer then fades it out.` : '';
  const steadyText = P.key === 'sleep' && !S.weatherTransitions ? ' Overnight weather changes are off, so it stays steady all night.' : '';
  const base = (reason, rule = 'normal-routine', extra = {}) => (baseId === 'silence'
    ? make('silence', 'preferred-silence', 'You prefer silence, so nothing plays. Weather doesn’t start sound on its own.', extra)
    : make(baseId, rule, `${reason}${timerText}`, extra));

  if (P.lock && P.key === 'sleep' && !S.weatherTransitions && now >= P.start && P.lock.soundId) {
    const reason = `Kept steady since ${at(P.start)} so the night isn’t interrupted: ${P.lock.reason}`;
    return P.lock.soundId === 'silence' ? make('silence', P.lock.rule, reason, { locked: true }) : make(P.lock.soundId, P.lock.rule, reason, { locked: true });
  }
  if (music) {
    return make(music, 'winddown-music', `You chose ${baseText} for wind-down. It plays at your saved ${vol}% level until bedtime; weather doesn’t change your music.`, {
      inputs: [input('preference', `Wind-down music: ${baseText}`)],
    });
  }
  if (P.ignoreWeather) return base(`Overnight weather changes are on: your ${baseText} plays, switching only during the forecast windows listed below.`);
  if (S.weatherMode === 'normal') return base(`You chose “Keep my normal routine”, so your ${baseText} plays and the weather doesn’t change it.`);
  if (!usable) return base(`Weather data is ${wxStatus}, so your normal routine is used: ${baseText}.`, 'weather-unusable');

  // 5. Calendar routine: on an important night the familiar sound stays put.
  const wxText = (w, what) => `${capitalize(what)} ${what.endsWith('s') ? 'are' : 'is'} forecast ${span(w)} during ${phaseText}${w.peak != null && what !== 'strong wind' ? ` (up to ${Math.round(w.peak)}% chance)` : ''}.`;
  const calendarIn = input('calendar', 'Tomorrow is important');

  // 6. Weather, through the user's own choices.
  if (S.weatherMode === 'mirror') {
    const rainy = conds.rain ?? conds.storm;
    if (conds.storm && S.stormsBother) {
      return base(`${wxText(conds.storm, 'thunderstorms')} You find storms disruptive, but Mirror weather doesn’t mask them, so your normal ${baseText} continues. Choose “Mask distracting weather” to use your masking sound instead. ${FORECAST_CAVEAT}`, 'normal-routine', { inputs: [input('weather', `Thunderstorms ${span(conds.storm)}`)] });
    }
    if (rainy && S.rainFeeling === 'calming') {
      if (P.steady) return base(`${wxText(rainy, 'rain')} Tomorrow is important, so your familiar ${baseText} stays as it is.`, 'calendar-steady', { inputs: [calendarIn] });
      if (S.preferred === 'silence') return base('');
      return make('rain', 'mirror-rain', `${wxText(rainy, 'rain')} You enjoy rain sounds and chose Mirror weather, so your gentle, steady rain ambience is scheduled at your saved ${vol}% level. No thunder sounds are ever added.${steadyText}${timerText} ${FORECAST_CAVEAT}`, {
        inputs: [input('preference', 'Rain sounds: enjoyable'), input('weather', `Rain ${span(rainy)}`)],
      });
    }
    if (rainy) return base(`${wxText(rainy, 'rain')} Rain ambience is only used if you enjoy rain sounds, so your normal ${baseText} continues.`);
  } else if (S.weatherMode === 'mask') {
    const triggers = [];
    if (conds.storm && S.stormsBother) triggers.push(['storm', conds.storm, 'thunderstorms', 'storms']);
    if (conds.rain && S.rainFeeling === 'distracting') triggers.push(['rain', conds.rain, 'rain', 'rain']);
    if (conds.wind && S.windBothers) triggers.push(['wind', conds.wind, 'strong wind', 'wind']);
    if (triggers.length) {
      const [kind, w, what, short] = triggers[0];
      const maskId = P.steady && S.preferred !== 'silence' ? S.preferred : S.stormSound;
      const also = triggers.slice(1).map((t) => `${t[2]} ${span(t[1])}`);
      const reason = P.steady && S.preferred !== 'silence'
        ? `${wxText(w, what)} Tomorrow is important, so your familiar ${baseText} keeps playing steadily through it at ${vol}%.`
        : `${wxText(w, what)}${also.length ? ` Also forecast: ${also.join(', ')}.` : ''} You find ${short} disruptive and chose Mask, so your saved steady ${SOUND_LABELS[maskId]} preset is scheduled at your saved ${vol}% level. It never adds thunder sounds or gets louder to chase noise.${steadyText}${timerText} ${FORECAST_CAVEAT}`;
      return make(maskId, P.steady && S.preferred !== 'silence' ? 'calendar-steady' : `mask-${kind}`, reason, {
        inputs: [input('preference', `Masking sound: ${SOUND_LABELS[S.stormSound]}`), input('preference', `${capitalize(short)} disruptive`), input('weather', `${capitalize(what)} ${span(w)}`), ...(P.steady ? [calendarIn] : [])],
      });
    }
    const present = [conds.storm && 'thunderstorms', conds.rain && 'rain', conds.wind && 'strong wind'].filter(Boolean);
    if (present.length) return base(`${capitalize(present.join(' and '))} ${present.length > 1 || present[0].endsWith('s') ? 'are' : 'is'} forecast during ${phaseText}, but you haven’t marked ${present.length > 1 ? 'them' : 'it'} as disruptive, so your normal ${baseText} continues.`);
  }

  // Clear, cloudy, fog, snow, wind in mirror mode, or unknown: keep the normal routine.
  const cats = conds.categories.filter((c) => c !== 'unknown');
  const unknownText = conds.unknownHours ? ` ${conds.unknownHours} forecast hour${conds.unknownHours === 1 ? ' has' : 's have'} no condition and ${conds.unknownHours === 1 ? 'is' : 'are'} treated as unknown, not clear.` : '';
  const windText = conds.wind && S.weatherMode === 'mirror' ? ' Strong wind is possible; Mirror weather has no wind sound, so nothing changes.' : '';
  return base(`Forecast for ${phaseText}: ${cats.length ? cats.map((c) => CATEGORY_TEXT[c]).join(', ') : 'no usable conditions'}. Your normal ${baseText} continues.${windText}${unknownText}`);
}

const sameChannels = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turn selections into contiguous audio segments for the plan.
 * Wind-down and night each get one selection. With the overnight-transitions opt-in, the night uses
 * the normal sound and switches only inside forecast windows (20-minute crossfades).
 */
export function planAudioSegments({ profile, wx, windows, times, steady, lock, now, tz, seg }) {
  const S = profile.sound;
  const { prevWakeEnd, windDownStart, bedtime, settleEnd, wakeFadeStart, wakeEnd, morningEnd, windDownMinutes } = times;
  const common = { timezone: tz, steady };
  const at = (ms) => formatClock(ms, tz);
  const pref = input('preference', `Sound: ${SOUND_LABELS[S.preferred]}`);

  const winddown = selectWeatherAudio(wx, S, { ...common, key: 'winddown', start: windDownStart, end: bedtime, transitionMinutes: Math.min(15, windDownMinutes) }, {}, now);
  const transitions = S.weatherTransitions && S.overnight && (S.weatherMode === 'mirror' || S.weatherMode === 'mask');
  const sleep = selectWeatherAudio(wx, S, { ...common, key: 'sleep', start: bedtime, end: wakeFadeStart, transitionMinutes: 10, lock, ignoreWeather: transitions }, {}, now);

  let segs = [
    seg('audio', 'awake', prevWakeEnd, windDownStart, { channels: {} }, 0, 'No sound is planned while you’re awake.', [pref]),
    seg('audio', 'winddown', windDownStart, bedtime, { channels: winddown.channels }, winddown.transitionMinutes, winddown.reason, winddown.inputs),
  ];
  const sleepEnd = sleep.soundId === 'silence' ? wakeFadeStart : Math.max(bedtime, Math.min(sleep.end, wakeFadeStart));
  const xfade = sameChannels(winddown.channels, sleep.channels) ? 10 : 15;
  segs.push(seg('audio', 'bedtime', bedtime, Math.min(settleEnd, sleepEnd), { channels: sleep.channels }, xfade, sleep.reason, sleep.inputs));
  if (sleepEnd > settleEnd) segs.push(seg('audio', 'overnight', settleEnd, sleepEnd, { channels: sleep.channels }, 0, sleep.reason, sleep.inputs));
  if (sleepEnd < wakeFadeStart) {
    segs.push(seg('audio', 'overnight', sleepEnd, wakeFadeStart, { channels: {} }, 10, `Your ${S.timerMinutes}-minute playback timer ended, so sound fades out.`, [input('preference', `Playback timer ${S.timerMinutes} min`)]));
  }
  segs.push(
    seg('audio', 'wake', wakeFadeStart, wakeEnd, { channels: {} }, Math.max(5, (wakeEnd - wakeFadeStart) / MIN), `Sound fades out gently before ${at(wakeEnd)}.`, [pref]),
    seg('audio', 'morning', wakeEnd, morningEnd, { channels: {} }, 0, 'No sound is planned in the morning.', [pref]),
  );
  segs = segs.filter((s) => s.end > s.start);

  // Opt-in only: switch sound inside forecast windows during the night.
  const switched = [];
  if (transitions && wx?.usable) {
    // Stabilized windows bound where changes may happen; inside them, select hour by hour so a storm
    // doesn't stretch masking across a longer rain window the user doesn't mind.
    const ranges = [];
    for (const w of [...windows].sort((a, b) => a.start - b.start)) {
      const from = Math.max(w.start, bedtime);
      const to = Math.min(w.end, sleepEnd);
      if (to <= from) continue;
      const last = ranges[ranges.length - 1];
      if (last && from <= last.to) last.to = Math.max(last.to, to);
      else ranges.push({ from, to });
    }
    const groups = [];
    for (const r of ranges) {
      for (let h = r.from; h < r.to; h += HOUR) {
        const hEnd = Math.min(h + HOUR, r.to);
        const one = selectWeatherAudio(wx, S, { ...common, key: 'sleep', start: h, end: hEnd }, {}, now);
        const last = groups[groups.length - 1];
        if (last && last.to === h && sameChannels(last.channels, one.channels)) last.to = hEnd;
        else groups.push({ from: h, to: hEnd, channels: one.channels });
      }
    }
    const picked = groups
      .filter((g) => !sameChannels(g.channels, sleep.channels))
      .map((g) => ({ from: Math.max(g.from - 30 * MIN, bedtime), to: g.to, sel: selectWeatherAudio(wx, S, { ...common, key: 'sleep', start: g.from, end: g.to, transitionMinutes: 20 }, {}, now) }));
    for (const m of picked) {
      const sel = m.sel;
      const reason = `${sel.reason} Plays ${at(m.from)}–${at(m.to)} because you allowed overnight weather changes, then your normal sound returns with a 20-minute crossfade.`;
      segs = overlay(segs, m.from, m.to, () => ({ channels: sel.channels }), { transitionIn: 20, transitionOut: 20, reason, inputs: [...sel.inputs, input('preference', 'Overnight weather changes: allowed')], tag: sel.rule }).segments;
      switched.push({ ...sel, start: m.from, end: m.to, reason });
    }
  }
  return { segments: segs, selections: { winddown, sleep, switched } };
}
