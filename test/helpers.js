import { buildPlan } from '../server/policy/buildPlan.js';
import { SAMPLE_USERS, simulatedCalendar, simulatedWeather } from '../server/scenarios.js';
import { zonedToUtc, MIN } from '../server/time.js';
import { valueAt, totalVolume } from '../server/policy/timeline.js';

export const TZ = 'America/Los_Angeles';
export const EVENING = zonedToUtc('2026-10-23', '19:30', TZ);
export const clone = (x) => structuredClone(x);

export function plan(user, { calendar = 'normal', weather = 'clear', now = EVENING, controls = {}, patch } = {}) {
  let profile = clone(typeof user === 'string' ? SAMPLE_USERS[user] : user);
  if (patch) profile = patch(profile) ?? profile;
  const cal = typeof calendar === 'string' ? simulatedCalendar(calendar, now) : calendar;
  const wx = typeof weather === 'string' ? (weather === 'none' ? null : simulatedWeather(weather, now)) : weather;
  return buildPlan(profile, cal, wx, now, controls);
}

/** Sample an output every `step` minutes between two instants. */
export function sample(p, output, from, to, step = 1) {
  const out = [];
  for (let t = from; t <= to; t += step * MIN) out.push({ t, v: valueAt(p.outputs[output], t, output) });
  return out;
}

export { totalVolume, valueAt, MIN };
