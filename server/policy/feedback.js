// Morning feedback -> explicit, user-approved preference suggestions.
// Nothing here changes a preference by itself: the user must press "Apply" on a suggestion.
// Volume is never raised past the user's own cap, and wake times are never suggested from feedback.

import { normalizeProfile } from '../profile.js';

export const FEEDBACK_FIELDS = {
  light: ['too_bright', 'too_dim', 'comfortable'],
  sound: ['too_loud', 'too_quiet', 'comfortable'],
  soundHelpful: ['yes', 'no', 'unsure'],
  keepRoutine: ['yes', 'no'],
};

export function validateFeedback(raw) {
  const out = {};
  for (const [k, allowed] of Object.entries(FEEDBACK_FIELDS)) {
    if (raw?.[k] == null || raw[k] === '') continue;
    if (!allowed.includes(raw[k])) return { error: `${k} must be one of ${allowed.join(', ')}` };
    out[k] = raw[k];
  }
  if (!Object.keys(out).length) return { error: 'answer at least one question' };
  if (typeof raw.night !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.night)) return { error: 'night must be a date' };
  out.night = raw.night;
  out.routine = typeof raw.routine === 'string' ? raw.routine.slice(0, 40) : null;
  return { feedback: out };
}

const RECENT = 5;

export function feedbackSuggestions(profile, feedback) {
  const recent = (feedback ?? []).slice(-RECENT);
  const latest = recent[recent.length - 1];
  if (!latest) return [];
  const count = (k, v) => recent.filter((f) => f[k] === v).length;
  const basis = (k, v) => `${count(k, v)} of your last ${recent.length} night${recent.length === 1 ? '' : 's'}`;
  const out = [];
  const L = profile.lighting;
  const S = profile.sound;

  if (latest.light === 'too_bright' && L.maxBrightness > 5) {
    const to = Math.max(5, L.maxBrightness - 10);
    out.push({ id: 'light-down', text: `Lower your brightness limit from ${L.maxBrightness}% to ${to}%? Evening and wind-down scenes scale with it.`, basis: basis('light', 'too_bright'), patch: { lighting: { maxBrightness: to } } });
  }
  if (latest.light === 'too_dim' && L.maxBrightness < 100) {
    const to = Math.min(100, L.maxBrightness + 10);
    out.push({ id: 'light-up', text: `Raise your brightness limit from ${L.maxBrightness}% to ${to}%?`, basis: basis('light', 'too_dim'), patch: { lighting: { maxBrightness: to } } });
  }
  if (latest.sound === 'too_loud' && S.volume > 0) {
    const to = Math.max(0, S.volume - 5);
    out.push({ id: 'sound-down', text: `Lower your usual sound level from ${S.volume}% to ${to}%?`, basis: basis('sound', 'too_loud'), patch: { sound: { volume: to } } });
  }
  if (latest.sound === 'too_quiet') {
    if (S.volume < S.maxVolume) {
      const to = Math.min(S.maxVolume, S.volume + 5);
      out.push({ id: 'sound-up', text: `Raise your usual sound level from ${S.volume}% to ${to}%? It stays within your ${S.maxVolume}% cap.`, basis: basis('sound', 'too_quiet'), patch: { sound: { volume: to } } });
    } else {
      out.push({ id: 'sound-cap', text: `Your usual level is already at your ${S.maxVolume}% cap. Drift won’t go above it; raise the cap in Preferences if you want to.`, basis: basis('sound', 'too_quiet'), patch: null });
    }
  }
  if (latest.soundHelpful === 'no' && S.preferred !== 'silence') {
    if (count('soundHelpful', 'no') >= 2) {
      out.push({ id: 'sound-silence', text: 'Sound hasn’t felt helpful lately. Switch to silence?', basis: basis('soundHelpful', 'no'), patch: { sound: { preferred: 'silence', weatherMode: 'off' } } });
    } else if (S.overnight) {
      out.push({ id: 'sound-bedtime-only', text: 'Play sound only at bedtime (fading out after 30 minutes) instead of all night?', basis: basis('soundHelpful', 'no'), patch: { sound: { overnight: false } } });
    }
  }
  if (latest.keepRoutine === 'no' && latest.routine && latest.routine !== 'standard') {
    out.push({ id: 'routine-review', text: `You’d rather not repeat the ${latest.routine} routine. Review that preset in Preferences; Drift will keep asking before using it.`, basis: 'last night', patch: null });
  }
  return out;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] ?? {}, v) : v;
  return out;
}

export function applySuggestion(profile, suggestion) {
  if (!suggestion?.patch) return { error: 'this suggestion has nothing to apply' };
  const { profile: next, errors } = normalizeProfile(deepMerge(profile, suggestion.patch));
  return errors.length ? { error: errors.join('; ') } : { profile: next };
}
