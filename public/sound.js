// Browser sound engine: white, pink, brown noise, rain ambience, and two wind-down music loops,
// all synthesized locally with Web Audio (no recordings, streaming, or licensing needed).
// Browsers block audio until the user interacts, so nothing plays until enable() runs from a click.
// Levels are digital output levels (0-100), not measured loudness in the room.
// Loops never restart: a channel's source starts once and only its gain is ramped afterwards.

export const MUSIC_TRACKS = ['pads', 'chimes'];

const BUFFER_SECONDS = 8;
const LOOP_FADE_SECONDS = 0.5;

function fillNoise(kind, data, rate) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') data[i] = w * 0.25;
    else if (kind === 'brown') {
      brown = (brown + 0.02 * w) / 1.02;
      data[i] = brown * 3.2;
    } else {
      // Paul Kellet's pink noise filter.
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.09;
      b6 = w * 0.115926;
    }
  }
  if (kind === 'rain') {
    // Soft droplets: short decaying bursts scattered over the pink-noise bed.
    const drops = Math.floor(data.length / rate * 45);
    for (let d = 0; d < drops; d++) {
      const at = Math.floor(Math.random() * data.length);
      const amp = 0.04 + Math.random() * 0.12;
      const len = Math.floor(rate * (0.004 + Math.random() * 0.01));
      for (let j = 0; j < len && at + j < data.length; j++) data[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / (len / 4));
    }
  }
}

// Fixed, gentle material: the same notes and tempo every night. Weather never changes them.
const PAD_CHORDS = [[220.0, 277.18, 329.63], [196.0, 246.94, 293.66], [174.61, 220.0, 261.63], [196.0, 246.94, 329.63]];
const CHIME_NOTES = [523.25, 587.33, 659.25, 783.99, 880.0];
const CHIME_PATTERN = [0, 2, 4, 3, 1, 2, 0, 3, 4, 1, 2, 3];

/** Render a music loop offline once; the loop length is an exact multiple of the pattern so it is seamless. */
async function renderMusic(kind, sampleRate) {
  const seconds = kind === 'pads' ? 32 : 24;
  const off = new OfflineAudioContext(1, Math.floor(sampleRate * seconds), sampleRate);
  const master = off.createGain();
  master.gain.value = 0.5;
  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = kind === 'pads' ? 1400 : 3200;
  lp.connect(master).connect(off.destination);
  if (kind === 'pads') {
    PAD_CHORDS.forEach((chord, i) => {
      const t0 = i * 8;
      for (const f of chord) {
        for (const detune of [-4, 4]) {
          const o = off.createOscillator();
          o.type = 'triangle';
          o.frequency.value = f;
          o.detune.value = detune;
          const g = off.createGain();
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(0.05, t0 + 3);
          g.gain.setValueAtTime(0.05, t0 + 6);
          g.gain.linearRampToValueAtTime(0, t0 + 10);
          o.connect(g).connect(lp);
          o.start(t0);
          o.stop(Math.min(seconds, t0 + 10.5));
        }
      }
    });
    // The last chord's tail wraps into the start of the loop.
    for (const f of PAD_CHORDS[PAD_CHORDS.length - 1]) {
      const o = off.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = off.createGain();
      g.gain.setValueAtTime(0.05 * 0.66, 0);
      g.gain.linearRampToValueAtTime(0, 2);
      o.connect(g).connect(lp);
      o.start(0);
      o.stop(2.1);
    }
  } else {
    CHIME_PATTERN.forEach((n, i) => {
      const t0 = i * 2;
      const o = off.createOscillator();
      o.type = 'sine';
      o.frequency.value = CHIME_NOTES[n];
      const g = off.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 1.9);
      o.connect(g).connect(lp);
      o.start(t0);
      o.stop(t0 + 1.95);
    });
  }
  return off.startRendering();
}

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.channels = {};
    this.levels = {};
    this.error = null;
  }

  get enabled() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  async enable() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('This browser does not support Web Audio');
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.enabled;
  }

  buffer(kind) {
    if (this.buffers[kind]) return this.buffers[kind];
    const rate = this.ctx.sampleRate;
    const fade = Math.floor(rate * LOOP_FADE_SECONDS);
    const raw = new Float32Array(Math.floor(rate * BUFFER_SECONDS) + fade);
    fillNoise(kind, raw, rate);
    // Crossfade the tail into the head so the loop point is seamless.
    const len = raw.length - fade;
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) out[i] = raw[i];
    for (let i = 0; i < fade; i++) {
      const f = i / fade;
      out[i] = raw[i] * f + raw[len + i] * (1 - f);
    }
    this.buffers[kind] = buf;
    return buf;
  }

  channel(kind) {
    if (this.channels[kind]) return this.channels[kind];
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    this.channels[kind] = { src: null, gain };
    if (MUSIC_TRACKS.includes(kind)) {
      // Music renders asynchronously; the gain ramp is already scheduled, the loop joins when ready.
      renderMusic(kind, this.ctx.sampleRate).then((buf) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(gain);
        src.start();
        this.channels[kind].src = src;
      }).catch((e) => { this.error = `Could not render ${kind}: ${e.message}`; });
      return this.channels[kind];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(kind);
    src.loop = true;
    let node = src;
    if (kind === 'rain') {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      src.connect(hp).connect(lp);
      node = lp;
    }
    node.connect(gain);
    src.start();
    this.channels[kind].src = src;
    return this.channels[kind];
  }

  /** Perceptual-ish curve with headroom; 100 is the loudest this page will ever play. */
  static gainFor(level) {
    const x = Math.max(0, Math.min(100, level)) / 100;
    return x * x * 0.8;
  }

  /** Glide every channel to its new level. Never jumps: rises and falls are ramped. */
  set(channels, rampSeconds = 2) {
    if (!this.enabled) return false;
    try {
      this.apply(channels, rampSeconds);
      this.error = null;
    } catch (e) {
      this.error = e.message;
      return false;
    }
    return true;
  }

  apply(channels, rampSeconds) {
    const t = this.ctx.currentTime;
    for (const kind of new Set([...Object.keys(this.channels), ...Object.keys(channels)])) {
      const level = channels[kind] ?? 0;
      if (level <= 0 && !this.channels[kind]) continue;
      const { gain } = this.channel(kind);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(SoundEngine.gainFor(level), t + rampSeconds);
    }
    this.levels = { ...channels };
  }

  stopAll() {
    this.set({}, 0.3);
  }
}
