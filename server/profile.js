// User preference schema: defaults, validation and normalization.
// Missing values fall back to defaults and are reported in `defaultsUsed`; invalid values are errors.

import { isClock, isValidTimeZone, clockMinutes } from './time.js';

export const NOISE_SOUNDS = ['white', 'pink', 'brown', 'rain'];
// Wind-down music is generated in the browser (original, no licensing or streaming needed).
export const MUSIC_TRACKS = ['pads', 'chimes'];
export const PLAYABLE_SOUNDS = [...NOISE_SOUNDS, ...MUSIC_TRACKS];
export const SOUND_PREFS = [...NOISE_SOUNDS, 'silence'];
export const WINDDOWN_TRACKS = ['none', ...MUSIC_TRACKS];
// mirror: rain ambience when rain is forecast and you enjoy it · mask: your masking sound for
// weather you find disruptive · normal: weather never changes sound · silence: nothing starts automatically
export const WEATHER_AUDIO_MODES = ['mirror', 'mask', 'normal', 'silence'];
export const WEATHER_AUDIO_MODE_LABELS = { mirror: 'Mirror weather', mask: 'Mask distracting weather', normal: 'Keep my normal routine', silence: 'Silence' };
export const RAIN_FEELINGS = ['calming', 'neutral', 'distracting'];
export const CLOUDY_RESPONSES = ['softer', 'dimmer', 'unchanged'];

export const DAY_CATEGORIES = ['important', 'early', 'normal', 'relaxed', 'unknown'];
export const DAY_CATEGORY_LABELS = {
  important: 'Exam / important presentation',
  early: 'Early start / busy day',
  normal: 'Normal day',
  relaxed: 'Relaxation day / day off',
  unknown: 'Unknown',
};

export const SOUND_LABELS = {
  white: 'white noise',
  pink: 'pink noise',
  brown: 'brown noise',
  rain: 'rain ambience',
  pads: 'Warm pads (wind-down music)',
  chimes: 'Soft chimes (wind-down music)',
  silence: 'silence',
};

export function defaultProfile(id = 'guest') {
  return {
    id,
    name: 'Guest',
    location: { label: '', lat: null, lon: null },
    timezone: 'America/Los_Angeles',
    schedule: { bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 30 },
    lighting: {
      maxBrightness: 80,
      eveningWarmthK: 2700,
      dayColorTempK: 4500,
      mirrorDaylight: true,
      cloudyResponse: 'softer',
      wakeLight: true,
      wakeRampMinutes: 20,
      nightLightBrightness: 0,
    },
    sound: {
      preferred: 'pink',
      volume: 35,
      maxVolume: 50,
      overnight: true,
      rainFeeling: 'neutral',
      stormsBother: false,
      windBothers: false,
      weatherMode: 'normal',
      stormSound: 'brown',
      windDownTrack: 'none',
      timerMinutes: 30,
      weatherTransitions: false,
    },
    routines: {
      important: { windDownMinutes: 45 },
      early: { bedtimeShiftMinutes: 30, earlyThresholdMinutes: 90 },
      relaxed: { windDownMinutes: 45, wakeRampMinutes: 40, allowWakeChange: false, relaxedWakeTime: '08:30' },
    },
    fan: { enabled: false, overnightLevel: 1 },
  };
}

const ok = (value) => ({ ok: true, value });
const bad = (msg) => ({ ok: false, msg });

const num = (min, max) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return bad('must be a number');
  if (n < min || n > max) return bad(`must be between ${min} and ${max}`);
  return ok(Math.round(n));
};
const coord = (limit) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit) return bad(`must be a number within ±${limit}`);
  return ok(Math.round(n * 1000) / 1000); // ~100 m: city-level precision is enough
};
const bool = (v) => {
  if (typeof v === 'boolean') return ok(v);
  if (v === 'true' || v === 'false') return ok(v === 'true');
  return bad('must be true or false');
};
const oneOf = (list) => (v) => (list.includes(v) ? ok(v) : bad(`must be one of: ${list.join(', ')}`));
const clock = (v) => (isClock(v) ? ok(v) : bad('must be a time like 23:00'));
const text = (max) => (v) => (typeof v === 'string' && v.length <= max ? ok(v.trim()) : bad(`must be text up to ${max} characters`));
const slug = (v) => (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? ok(v) : bad('must be lowercase letters, digits or dashes'));
const tz = (v) => (isValidTimeZone(v) ? ok(v) : bad('must be an IANA timezone such as America/New_York'));

/**
 * @returns {{profile: object, errors: string[], warnings: string[], defaultsUsed: string[]}}
 */
export function normalizeProfile(input) {
  const errors = [];
  const warnings = [];
  const defaultsUsed = [];
  const src = input && typeof input === 'object' ? structuredClone(input) : {};
  // Renamed mode: "off" is now "Keep my normal routine".
  if (src.sound?.weatherMode === 'off') src.sound.weatherMode = 'normal';
  const d = defaultProfile();

  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), src);
  const fallback = (path) => path.split('.').reduce((o, k) => o[k], d);
  const pick = (path, check) => {
    const v = get(path);
    if (v === undefined || v === null || v === '') {
      defaultsUsed.push(path);
      return fallback(path);
    }
    const r = check(v);
    if (!r.ok) {
      errors.push(`${path} ${r.msg}`);
      return fallback(path);
    }
    return r.value;
  };
  const optionalCoord = (path, limit) => {
    const v = get(path);
    if (v === undefined || v === null || v === '') return null;
    const r = coord(limit)(v);
    if (!r.ok) {
      errors.push(`${path} ${r.msg}`);
      return null;
    }
    return r.value;
  };

  const profile = {
    id: pick('id', slug),
    name: pick('name', text(60)),
    location: {
      label: get('location.label') ? pick('location.label', text(120)) : '',
      lat: optionalCoord('location.lat', 90),
      lon: optionalCoord('location.lon', 180),
    },
    timezone: pick('timezone', tz),
    schedule: {
      bedtime: pick('schedule.bedtime', clock),
      wakeTime: pick('schedule.wakeTime', clock),
      windDownMinutes: pick('schedule.windDownMinutes', num(10, 120)),
    },
    lighting: {
      maxBrightness: pick('lighting.maxBrightness', num(5, 100)),
      eveningWarmthK: pick('lighting.eveningWarmthK', num(1800, 4000)),
      dayColorTempK: pick('lighting.dayColorTempK', num(3000, 6500)),
      mirrorDaylight: pick('lighting.mirrorDaylight', bool),
      cloudyResponse: pick('lighting.cloudyResponse', oneOf(CLOUDY_RESPONSES)),
      wakeLight: pick('lighting.wakeLight', bool),
      wakeRampMinutes: pick('lighting.wakeRampMinutes', num(5, 60)),
      nightLightBrightness: pick('lighting.nightLightBrightness', num(0, 10)),
    },
    sound: {
      preferred: pick('sound.preferred', oneOf(SOUND_PREFS)),
      volume: pick('sound.volume', num(0, 100)),
      maxVolume: pick('sound.maxVolume', num(0, 100)),
      overnight: pick('sound.overnight', bool),
      rainFeeling: pick('sound.rainFeeling', oneOf(RAIN_FEELINGS)),
      stormsBother: pick('sound.stormsBother', bool),
      windBothers: pick('sound.windBothers', bool),
      weatherMode: pick('sound.weatherMode', oneOf(WEATHER_AUDIO_MODES)),
      stormSound: pick('sound.stormSound', oneOf(NOISE_SOUNDS)),
      windDownTrack: pick('sound.windDownTrack', oneOf(WINDDOWN_TRACKS)),
      timerMinutes: pick('sound.timerMinutes', num(5, 240)),
      weatherTransitions: pick('sound.weatherTransitions', bool),
    },
    routines: {
      important: { windDownMinutes: pick('routines.important.windDownMinutes', num(10, 120)) },
      early: {
        bedtimeShiftMinutes: pick('routines.early.bedtimeShiftMinutes', num(0, 120)),
        earlyThresholdMinutes: pick('routines.early.earlyThresholdMinutes', num(15, 240)),
      },
      relaxed: {
        windDownMinutes: pick('routines.relaxed.windDownMinutes', num(10, 120)),
        wakeRampMinutes: pick('routines.relaxed.wakeRampMinutes', num(5, 60)),
        allowWakeChange: pick('routines.relaxed.allowWakeChange', bool),
        relaxedWakeTime: pick('routines.relaxed.relaxedWakeTime', clock),
      },
    },
    fan: {
      enabled: pick('fan.enabled', bool),
      overnightLevel: pick('fan.overnightLevel', num(0, 3)),
    },
  };

  if ((profile.location.lat === null) !== (profile.location.lon === null)) {
    errors.push('location needs both latitude and longitude');
    profile.location.lat = null;
    profile.location.lon = null;
  }
  if (profile.sound.volume > profile.sound.maxVolume) {
    warnings.push(`usual volume ${profile.sound.volume}% was above your ${profile.sound.maxVolume}% cap, so it was lowered to the cap`);
    profile.sound.volume = profile.sound.maxVolume;
  }
  const sleepMinutes = (clockMinutes(profile.schedule.wakeTime) - clockMinutes(profile.schedule.bedtime) + 1440) % 1440;
  if (sleepMinutes < 180 || sleepMinutes > 16 * 60) {
    errors.push('bedtime and wake time must be between 3 and 16 hours apart');
  }
  if (profile.routines.relaxed.allowWakeChange) {
    const relaxedSleep = (clockMinutes(profile.routines.relaxed.relaxedWakeTime) - clockMinutes(profile.schedule.bedtime) + 1440) % 1440;
    if (relaxedSleep < 180 || relaxedSleep > 16 * 60) errors.push('relaxed wake time must be 3-16 hours after bedtime');
  }

  return { profile, errors, warnings, defaultsUsed };
}
