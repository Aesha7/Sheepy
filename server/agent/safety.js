// The minimal safety floor around the agent (everything else is the agent's call):
//   1. Stop (and Pause) always win: device tools refuse while active.
//   2. Volume never exceeds the person's own cap.
//   3. The light can't flash: no rapid on/off sequences.
// The sheep firmware separately clamps brightness to 0-100 and fades to 30 minutes.

export const FLASH_RULES = {
  windowMs: 60_000, // look-back window
  maxCommands: 6, // lamp commands allowed per window
  minReversalGapMs: 15_000, // a change of direction (up <-> down) needs this gap since the last command
};

export class LampGuard {
  constructor(rules = FLASH_RULES) {
    this.rules = rules;
    this.history = []; // {at, brightness, dir}
  }

  /** Returns an error message if this command would make the light flash, else null. */
  check(now, brightness, currentTarget) {
    const recent = this.history.filter((h) => now - h.at < this.rules.windowMs);
    if (recent.length >= this.rules.maxCommands) {
      return `Refused: ${recent.length} light changes in the last minute. Rapid changes look like flashing, which Drift never does. Wait and send one slow fade.`;
    }
    const last = recent[recent.length - 1];
    // Unknown starting level: the sheep powers on dark, so assume 0.
    const from = currentTarget ?? last?.brightness ?? 0;
    const dir = Math.sign(brightness - from);
    if (last && dir !== 0 && last.dir !== 0 && dir !== last.dir && now - last.at < this.rules.minReversalGapMs) {
      return `Refused: reversing the light (${last.dir > 0 ? 'up then down' : 'down then up'}) within ${Math.round(this.rules.minReversalGapMs / 1000)} seconds would flash. Wait, or use one slow fade.`;
    }
    return null;
  }

  record(now, brightness, currentTarget) {
    const last = this.history[this.history.length - 1];
    const from = currentTarget ?? last?.brightness ?? 0;
    this.history.push({ at: now, brightness, dir: Math.sign(brightness - from) });
    this.history = this.history.filter((h) => now - h.at < this.rules.windowMs);
  }
}

/** Clamp a requested level to the person's cap. Returns {level, capped}. */
export function capVolume(level, maxVolume) {
  const l = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  return l > maxVolume ? { level: maxVolume, capped: true } : { level: l, capped: false };
}
