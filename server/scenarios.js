// Deterministic, clearly simulated demo scenarios. Every value here is made up for the demo:
// fixed clock, fixed weather, fixed calendar. Nothing here talks to real services or hardware.

import { HOUR, zonedToUtc, localDate, addDays } from './time.js';
import { defaultProfile } from './profile.js';
import { offlineWeather } from './weather/offline.js';

const TZ = 'America/Los_Angeles';
const BERKELEY = { label: 'Berkeley, CA (demo)', lat: 37.872, lon: -122.273 };

export const SAMPLE_USERS = {
  alex: {
    ...defaultProfile('alex'),
    name: 'Alex',
    location: BERKELEY,
    timezone: TZ,
    schedule: { bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 30 },
    lighting: { ...defaultProfile().lighting, maxBrightness: 80, eveningWarmthK: 2700, mirrorDaylight: true, cloudyResponse: 'softer', wakeLight: true, wakeRampMinutes: 20 },
    sound: { ...defaultProfile().sound, preferred: 'pink', volume: 35, maxVolume: 50, overnight: true, rainFeeling: 'calming', stormsBother: false, windBothers: false, weatherMode: 'mirror', stormSound: 'brown', windDownTrack: 'none' },
    routines: {
      important: { windDownMinutes: 45 },
      early: { bedtimeShiftMinutes: 30, earlyThresholdMinutes: 90 },
      relaxed: { windDownMinutes: 45, wakeRampMinutes: 40, allowWakeChange: true, relaxedWakeTime: '08:30' },
    },
  },
  sam: {
    ...defaultProfile('sam'),
    name: 'Sam',
    location: BERKELEY,
    timezone: TZ,
    schedule: { bedtime: '23:30', wakeTime: '07:30', windDownMinutes: 40 },
    lighting: { ...defaultProfile().lighting, maxBrightness: 60, eveningWarmthK: 2200, mirrorDaylight: false, cloudyResponse: 'unchanged', wakeLight: true, wakeRampMinutes: 15, nightLightBrightness: 3 },
    sound: { ...defaultProfile().sound, preferred: 'white', volume: 30, maxVolume: 40, overnight: true, rainFeeling: 'distracting', stormsBother: true, windBothers: true, weatherMode: 'mask', stormSound: 'brown', windDownTrack: 'pads' },
    routines: {
      important: { windDownMinutes: 60 },
      early: { bedtimeShiftMinutes: 45, earlyThresholdMinutes: 120 },
      relaxed: { windDownMinutes: 40, wakeRampMinutes: 30, allowWakeChange: false, relaxedWakeTime: '09:00' },
    },
    fan: { enabled: true, overnightLevel: 1 },
  },
  jordan: {
    ...defaultProfile('jordan'),
    name: 'Jordan',
    location: BERKELEY,
    timezone: TZ,
    schedule: { bedtime: '22:30', wakeTime: '06:30', windDownMinutes: 20 },
    lighting: { ...defaultProfile().lighting, maxBrightness: 90, eveningWarmthK: 3000, mirrorDaylight: true, cloudyResponse: 'dimmer', wakeLight: true, wakeRampMinutes: 30 },
    sound: { ...defaultProfile().sound, preferred: 'silence', volume: 0, maxVolume: 30, overnight: false, rainFeeling: 'neutral', stormsBother: false, weatherMode: 'silence', stormSound: 'pink' },
  },
};

/**
 * Offline weather for demos and tests, in the same normalized schema as live data.
 * kind: rain | storm (thunderstorm) | clear (clear-evening) | cloudy | wind (strong-wind) | stale | none (missing)
 */
export function simulatedWeather(kind, now, tz = TZ, location = BERKELEY) {
  return offlineWeather(kind, now, { ...location, timezone: tz });
}

export function simulatedCalendar(kind, now, tz = TZ) {
  const tomorrow = addDays(localDate(now - 6 * HOUR, tz), 1);
  const at = (time) => zonedToUtc(tomorrow, time, tz);
  const base = { status: 'simulated', source: 'simulated', simulated: true, fetchedAt: now, dayLabels: {} };
  switch (kind) {
    case 'exam':
      return { ...base, events: [
        { id: 'sim-exam', title: 'CS 170 Midterm', start: at('09:00'), end: at('11:00'), importance: 'important', source: 'simulated' },
        { id: 'sim-lunch', title: 'Lunch with Priya', start: at('12:30'), end: at('13:30'), source: 'simulated' },
      ] };
    case 'relaxed':
      return { ...base, events: [{ id: 'sim-off', title: 'Day off', allDay: true, date: tomorrow, category: 'dayoff', source: 'simulated' }] };
    case 'early':
      return { ...base, events: [
        { id: 'sim-early', title: 'Client meeting', start: at('08:30'), end: at('09:30'), prepMinutes: 20, travelMinutes: 25, source: 'simulated' },
        { id: 'sim-work', title: 'Design review', start: at('10:00'), end: at('12:00'), source: 'simulated' },
      ] };
    case 'normal':
      return { ...base, events: [{ id: 'sim-class', title: 'Linear algebra lecture', start: at('11:00'), end: at('12:30'), source: 'simulated' }] };
    case 'conflict':
      return { ...base, events: [
        { id: 'sim-off2', title: 'Vacation', allDay: true, date: tomorrow, source: 'simulated' },
        { id: 'sim-pres', title: 'Thesis presentation', start: at('15:00'), end: at('16:00'), source: 'simulated' },
      ] };
    case 'empty':
      return { ...base, events: [] };
    default:
      return { status: 'not_connected', source: 'none', events: [], dayLabels: {} };
  }
}

const FRI_EVENING = zonedToUtc('2026-10-23', '19:30', TZ);

export const SCENARIOS = [
  {
    id: 'exam-rain',
    title: 'Exam tomorrow + rain overnight',
    description: 'Alex has a midterm marked important and accepted the 45-minute exam wind-down. Rain is forecast from 9 PM through the night; Alex enjoys rain sounds, but on an important night the familiar pink noise stays steady.',
    now: FRI_EVENING,
    runs: [{ user: 'alex', calendar: 'exam', weather: 'rain', decisions: { '2026-10-24': { accepted: { windDownMinutes: 45 } } } }],
  },
  {
    id: 'relaxed-sunrise',
    title: 'Relaxation day + clear sunrise',
    description: 'Alex labeled tomorrow a day off and approved a later 8:30 wake with a gentler 40-minute ramp. Sunrise (~7:27) comes before the wake window, so the room stays dark until 7:50.',
    now: FRI_EVENING,
    runs: [{ user: 'alex', calendar: 'relaxed', weather: 'clear', dayLabel: 'relaxed', decisions: { '2026-10-24': { accepted: { wakeTime: '08:30', wakeRampMinutes: 40, windDownMinutes: 45 } } } }],
  },
  {
    id: 'early-storm',
    title: 'Early meeting + thunderstorm forecast',
    description: 'Sam has an 8:30 meeting with 45 min of prep and travel. Drift suggests an earlier bedtime but does not apply it until Sam accepts. Thunderstorms are possible midnight–3 AM. Sam finds storms disruptive and chose brown noise as the masking preset; wind-down plays Sam’s chosen music.',
    now: FRI_EVENING,
    runs: [{ user: 'sam', calendar: 'early', weather: 'storm' }],
  },
  {
    id: 'same-weather',
    title: 'Same weather, different people',
    description: 'Identical rainy night and calendar for three people. Alex (enjoys rain, Mirror weather) gets rain ambience; Sam (rain is disruptive, Mask) gets the saved brown-noise masking preset after wind-down music; Jordan (Silence) gets no sound at all.',
    now: FRI_EVENING,
    runs: [
      { user: 'alex', calendar: 'normal', weather: 'rain' },
      { user: 'sam', calendar: 'normal', weather: 'rain' },
      { user: 'jordan', calendar: 'normal', weather: 'rain' },
    ],
  },
  {
    id: 'strong-wind',
    title: 'Strong wind overnight',
    description: 'Gusts near 78 km/h are forecast (above the app’s 60 km/h gust threshold, an engineering choice). Sam marked wind as disruptive and gets the masking preset; Alex uses Mirror weather, which has no wind sound, so Alex’s normal routine continues.',
    now: FRI_EVENING,
    runs: [
      { user: 'sam', calendar: 'normal', weather: 'wind' },
      { user: 'alex', calendar: 'normal', weather: 'wind' },
    ],
  },
  {
    id: 'missing-data',
    title: 'Missing calendar and weather data',
    description: 'No calendar connected and the weather service is unreachable. Tomorrow is "unknown" (not a day off), weather is unused, and the standard routine runs. Sun times are still calculated from the location.',
    now: FRI_EVENING,
    runs: [{ user: 'alex', calendar: 'none', weather: 'none' }],
  },
  {
    id: 'override-transition',
    title: 'Manual override during wind-down',
    description: 'At 10:40 PM, halfway through the wind-down dim, Alex turns the lamp up to 60% for 30 minutes. The override wins immediately; when it expires the lamp glides back to the plan over 5 minutes instead of jumping.',
    now: zonedToUtc('2026-10-23', '22:40', TZ),
    runs: [{
      user: 'alex', calendar: 'normal', weather: 'clear',
      overrides: { light: { target: { brightness: 60 }, setAt: zonedToUtc('2026-10-23', '22:40', TZ), expiresAt: zonedToUtc('2026-10-23', '23:10', TZ) } },
    }],
  },
];

export function scenarioInputs(scenario, run) {
  const now = scenario.now;
  const calendar = simulatedCalendar(run.calendar, now);
  if (run.dayLabel) calendar.dayLabels = { [addDays(localDate(now - 6 * HOUR, TZ), 1)]: run.dayLabel };
  const weather = simulatedWeather(run.weather, now);
  return {
    profile: SAMPLE_USERS[run.user],
    calendar,
    weather,
    now,
    controls: { decisions: run.decisions ?? {}, overrides: run.overrides ?? {} },
  };
}
