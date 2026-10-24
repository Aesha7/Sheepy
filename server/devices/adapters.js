// Output adapters share one small interface so the executor never cares what hardware is attached:
//
//   kind: 'light' | 'audio' | 'fan'
//   id, label, simulated: boolean
//   capabilities: { colorTemp?, minK?, maxK?, sounds?, maxLevel? }
//   isConnected(now) -> boolean;  disconnectReason(now) -> string
//   deviceState(now)? -> {status, detail} | null   (optional: blocked / failed states)
//   apply(command) -> Promise<{ ok, state?, awaitingAck?, seq?, error?, disconnected? }>
//
// Simulated adapters are labeled as such everywhere they are shown.

import { PLAYABLE_SOUNDS } from '../profile.js';

const describe = (a, now) => ({
  id: a.id,
  kind: a.kind,
  label: a.label,
  simulated: a.simulated,
  capabilities: a.capabilities,
  connected: a.isConnected(now),
  disconnectReason: a.isConnected(now) ? null : a.disconnectReason(now),
});

class SimulatedDevice {
  constructor(kind, label, capabilities) {
    this.kind = kind;
    this.id = `sim-${kind}`;
    this.label = `${label} (simulated)`;
    this.simulated = true;
    this.capabilities = capabilities;
    this.state = null;
    this.connected = true;
  }
  isConnected() {
    return this.connected;
  }
  disconnectReason() {
    return 'Simulated device set to disconnected';
  }
  async apply(cmd) {
    if (!this.connected) return { ok: false, disconnected: true, error: 'simulated device disconnected' };
    this.state = structuredClone(cmd);
    return { ok: true, state: structuredClone(cmd) };
  }
  describe(now) {
    return describe(this, now);
  }
}

export const simulatedLight = ({ colorTemp = true } = {}) =>
  new SimulatedDevice('light', 'Virtual lamp', { colorTemp, minK: 1800, maxK: 6500 });
export const simulatedAudio = () => new SimulatedDevice('audio', 'Virtual speaker', { sounds: PLAYABLE_SOUNDS });
export const simulatedFan = () => new SimulatedDevice('fan', 'Virtual fan', { maxLevel: 3 });

/**
 * Real audio played by an open dashboard tab (Web Audio). The tab polls for the latest command,
 * plays it after the user clicks "Enable Sound", and acknowledges what it is actually playing.
 */
export class BrowserAudio {
  constructor({ heartbeatTimeoutMs = 10_000 } = {}) {
    this.kind = 'audio';
    this.id = 'browser-audio';
    this.label = 'Browser speaker (dashboard tab)';
    this.simulated = false;
    this.capabilities = { sounds: PLAYABLE_SOUNDS };
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.error = null;
    this.seq = 0;
    this.command = null;
    this.lastSeen = -Infinity;
    this.enabled = false;
  }
  isConnected(now) {
    return this.enabled && now - this.lastSeen < this.heartbeatTimeoutMs;
  }
  disconnectReason(now) {
    if (now - this.lastSeen >= this.heartbeatTimeoutMs) return 'No dashboard tab is open to play sound';
    return 'Sound is not enabled yet: click “Enable Sound” in the dashboard';
  }
  async apply(cmd) {
    this.seq += 1;
    this.command = { seq: this.seq, cmd: structuredClone(cmd) };
    return { ok: true, awaitingAck: true, seq: this.seq };
  }
  heartbeat(now, { enabled, error }) {
    this.lastSeen = now;
    this.enabled = !!enabled;
    this.error = typeof error === 'string' && error ? error.slice(0, 200) : null;
  }
  /** Distinguishes "no tab", "tab open but the browser is blocking audio", and "playback failed". */
  deviceState(now) {
    if (now - this.lastSeen >= this.heartbeatTimeoutMs) return { status: 'disconnected', detail: 'No dashboard tab is open to play sound' };
    if (this.error) return { status: 'failed', detail: `Playback failed in the browser: ${this.error}` };
    if (!this.enabled) return { status: 'blocked', detail: 'The browser blocks sound until you click “Enable Sound” in the dashboard' };
    return null;
  }
  describe(now) {
    return describe(this, now);
  }
}

async function request(url, init, timeoutMs = 3000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

/** Philips Hue bridge (local API v1). Brightness and color temperature are sent separately. */
export class HueLight {
  constructor({ bridge, username, lightId }) {
    this.kind = 'light';
    this.id = `hue-${lightId}`;
    this.label = `Philips Hue light ${lightId}`;
    this.simulated = false;
    this.capabilities = { colorTemp: true, minK: 2000, maxK: 6500 };
    this.url = `http://${bridge}/api/${username}/lights/${lightId}/state`;
    this.lastError = null;
    this.reachable = null;
  }
  isConnected() {
    return this.reachable !== false;
  }
  disconnectReason() {
    return this.lastError ?? 'Hue bridge not reachable';
  }
  async apply(cmd) {
    const body = { on: cmd.brightness > 0, transitiontime: 20 };
    if (cmd.brightness > 0) body.bri = Math.max(1, Math.min(254, Math.round((cmd.brightness / 100) * 254)));
    if (cmd.colorTempK) body.ct = Math.max(153, Math.min(500, Math.round(1e6 / cmd.colorTempK)));
    try {
      const { res, body: out } = await request(this.url, { method: 'PUT', body: JSON.stringify(body) });
      const err = Array.isArray(out) ? out.find((x) => x.error)?.error : null;
      if (!res.ok || err) {
        this.lastError = err?.description ?? `HTTP ${res.status}`;
        return { ok: false, error: this.lastError };
      }
      this.reachable = true;
      this.lastError = null;
      return { ok: true, state: cmd };
    } catch (e) {
      this.reachable = false;
      this.lastError = `Hue bridge unreachable: ${e.message}`;
      return { ok: false, disconnected: true, error: this.lastError };
    }
  }
  describe(now) {
    return describe(this, now);
  }
}

/** Generic JSON-over-HTTP device (e.g. an ESP32 build). POSTs {kind, ...command}; any 2xx counts as applied. */
export class HttpJsonDevice {
  constructor({ kind, url, colorTemp = false, label }) {
    this.kind = kind;
    this.id = `http-${kind}`;
    this.label = label ?? `HTTP ${kind} (${new URL(url).host})`;
    this.simulated = false;
    this.capabilities = kind === 'light' ? { colorTemp, minK: 1800, maxK: 6500 } : kind === 'audio' ? { sounds: PLAYABLE_SOUNDS } : { maxLevel: 3 };
    this.url = url;
    this.reachable = null;
    this.lastError = null;
  }
  isConnected() {
    return this.reachable !== false;
  }
  disconnectReason() {
    return this.lastError ?? 'Device not reachable';
  }
  async apply(cmd) {
    try {
      const { res } = await request(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: this.kind, ...cmd }) });
      if (!res.ok) {
        this.lastError = `HTTP ${res.status}`;
        return { ok: false, error: this.lastError };
      }
      this.reachable = true;
      this.lastError = null;
      return { ok: true, state: cmd };
    } catch (e) {
      this.reachable = false;
      this.lastError = `Unreachable: ${e.message}`;
      return { ok: false, disconnected: true, error: this.lastError };
    }
  }
  describe(now) {
    return describe(this, now);
  }
}

/**
 * The Sleep Sheep's warm light (brightness only, no color temperature). The firmware does the fade:
 * agent commands carry their own fadeSeconds; rules-mode updates use a short fade between ticks.
 */
export class SheepLight {
  constructor(hub, { rulesFadeSeconds = 2 } = {}) {
    this.kind = 'light';
    this.hub = hub;
    this.rulesFadeSeconds = rulesFadeSeconds;
    this.capabilities = { colorTemp: false, minK: 2700, maxK: 2700 };
  }
  get id() {
    return `sheep-${this.hub.active() ?? 'none'}`;
  }
  get label() {
    return this.hub.connectedLabel();
  }
  get simulated() {
    return this.hub.active() === 'sim';
  }
  isConnected() {
    return this.hub.active() != null;
  }
  disconnectReason() {
    return this.hub.notConnectedError().message;
  }
  async apply(cmd) {
    try {
      const fade = cmd.fadeSeconds ?? this.rulesFadeSeconds;
      const s = await this.hub.setLamp(cmd.brightness, fade / 60);
      return { ok: true, state: { brightness: s.target ?? cmd.brightness } };
    } catch (e) {
      return { ok: false, disconnected: !this.isConnected(), error: e.message };
    }
  }
  describe(now) {
    return describe(this, now);
  }
}

/** Build adapters from server config. Anything not configured stays simulated (or absent for the fan). */
export function createAdapters(config, { sheepHub } = {}) {
  const light = config.lightAdapter === 'sheep' && sheepHub
    ? new SheepLight(sheepHub)
    : config.lightAdapter === 'hue'
    ? new HueLight({ bridge: config.hueBridge, username: config.hueUsername, lightId: config.hueLightId })
    : config.lightAdapter === 'http'
      ? new HttpJsonDevice({ kind: 'light', url: config.lightUrl, colorTemp: config.lightColorTemp })
      : simulatedLight({ colorTemp: config.lightColorTemp });
  const audio = config.audioAdapter === 'simulated' ? simulatedAudio()
    : config.audioAdapter === 'http' ? new HttpJsonDevice({ kind: 'audio', url: config.audioUrl })
      : new BrowserAudio();
  const fan = config.fanAdapter === 'simulated' ? simulatedFan()
    : config.fanAdapter === 'http' ? new HttpJsonDevice({ kind: 'fan', url: config.fanUrl })
      : null;
  return { light, audio, fan };
}
