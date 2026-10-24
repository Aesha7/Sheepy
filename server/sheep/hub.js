// Sleep Sheep hardware hub: one interface over three transports.
//   usb - the Python bridge (hardware_integration/bridge.py -> sheep.py -> serial)
//   ble - a dashboard tab connected with Web Bluetooth relays commands and status notifications
//   sim - an in-process simulated sheep, always labeled "simulated" (only when enabled)
// Contract (from the hardware guide): L,<brightness 0-100>,<seconds 0-1800> fades the light;
// S reports status. Status = pats since power-on, room light 0-1023 (relative, not lux),
// current level and target (0-100). The firmware does every fade itself.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const SHEEP_BLE = {
  name: 'SleepSheep',
  service: 'a06e5f31-0600-46ed-8657-17c3712fb50f',
  command: 'c8c9c213-a1fb-4af2-a0d6-bed87fcead6c',
  status: '5781d30d-37b4-4463-a8d8-8019495468c1',
};
export const TRANSPORTS = ['usb', 'ble', 'sim'];
const MAX_BRIGHTNESS = 100;
const MAX_MINUTES = 30;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Same clamps and demo speedup as sheep.py (section 5 of the hardware guide). */
export function lampCommand(brightness, minutes, speedup = 1) {
  const b = clamp(Math.round(Number(brightness) || 0), 0, MAX_BRIGHTNESS);
  const m = clamp(Number(minutes) || 0, 0, MAX_MINUTES);
  const seconds = Math.round((m * 60 / (speedup || 1)) * 10) / 10;
  return { brightness: b, minutes: m, seconds, text: `L,${b},${seconds.toFixed(1)}` };
}

/** Bluetooth status notification "pats,light,level,target" -> object (or {error}). */
export function parseBleStatus(text) {
  const t = String(text ?? '').trim();
  if (t === 'ERR') return { error: 'The sheep rejected the last command (ERR).' };
  const parts = t.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { error: `Unreadable status "${t.slice(0, 40)}"` };
  const [pats, light, level, target] = parts;
  return { pats, light, level, target };
}

// ---------------------------------------------------------------- USB (Python bridge)

class UsbBridge {
  constructor(hub, { python, script, speedup, port }) {
    this.hub = hub;
    this.python = python;
    this.script = script;
    this.speedup = speedup;
    this.port = port;
    this.proc = null;
    this.ready = false;
    this.error = null;
    this.nextId = 1;
    this.pending = new Map();
    this.restarts = 0;
    this.pollTimer = null;
  }

  start() {
    if (this.proc) return;
    const env = { ...process.env, SHEEP_DEMO_SPEEDUP: String(this.speedup), PYTHONUNBUFFERED: '1' };
    if (this.port) env.SHEEP_PORT = this.port;
    try {
      this.proc = spawn(this.python, ['-u', path.basename(this.script)], { cwd: path.dirname(this.script), env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.error = `Could not start Python: ${e.message}`;
      return;
    }
    this.proc.on('error', (e) => {
      this.error = `Could not start Python (${this.python}): ${e.message}`;
      this.ready = false;
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.hub.log(`[usb] ${s.slice(0, 300)}`);
    });
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      clearInterval(this.pollTimer);
      for (const p of this.pending.values()) p.reject(new Error('USB bridge stopped'));
      this.pending.clear();
      this.hub.changed();
      if (!this.stopped && this.restarts < 5) {
        this.restarts += 1;
        setTimeout(() => this.start(), 3000 * this.restarts);
      } else if (!this.stopped) {
        this.error = this.error ?? `USB bridge exited (code ${code})`;
      }
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output
    }
    if (msg.event === 'ready') {
      this.ready = true;
      this.error = null;
      this.restarts = 0;
      this.hub.log(`[usb] sheep connected (port ${msg.port}${msg.fake ? ', SHEEP_FAKE' : ''})`);
      this.hub.changed();
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.call('get_status', {}).then((s) => this.hub.onStatus(s, 'usb')).catch(() => {}), 1000);
      this.pollTimer.unref?.();
      return;
    }
    if (msg.event === 'connect_failed') {
      this.ready = false;
      this.error = msg.error;
      this.hub.changed();
      this.stop();
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  call(cmd, args, timeoutMs = 4000) {
    if (!this.proc || !this.ready) return Promise.reject(new Error(this.error ?? 'USB bridge not ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No reply from the sheep over USB to ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.proc?.kill();
  }
}

// ---------------------------------------------------------------- Bluetooth (browser relay)

/** A dashboard tab holds the Web Bluetooth connection. The server pushes command text over SSE. */
class BleRelay {
  constructor(hub) {
    this.hub = hub;
    this.clients = new Set();
    this.connected = false;
    this.deviceName = null;
    this.lastStatusAt = -Infinity;
    this.nextId = 1;
    this.pending = new Map();
    this.statusWaiters = [];
  }

  attach(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    ping.unref?.();
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
      if (!this.clients.size) this.setConnected(false);
    });
  }

  setConnected(on, name) {
    this.connected = !!on;
    if (name) this.deviceName = String(name).slice(0, 40);
    this.hub.changed();
  }

  isLive(now) {
    return this.connected && this.clients.size > 0 && now - this.lastStatusAt < 5000;
  }

  onStatus(raw, now) {
    const s = parseBleStatus(raw);
    if (s.error) {
      for (const w of this.statusWaiters.splice(0)) w.reject(new Error(s.error));
      return;
    }
    this.lastStatusAt = now;
    if (!this.connected) this.setConnected(true);
    this.hub.onStatus(s, 'ble');
    for (const w of this.statusWaiters.splice(0)) w.resolve(s);
  }

  ack(id, ok, error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve();
    else p.reject(new Error(error || 'Bluetooth write failed'));
  }

  /** Write a command; resolves with the next status notification (pushed within ~1 s). */
  async send(text) {
    if (!this.clients.size) throw new Error('Sheep not connected over Bluetooth. Open the dashboard and press “Connect sheep (Bluetooth)”, then keep the phone or laptop within a few meters.');
    const id = this.nextId++;
    const acked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Bluetooth write timed out. Move closer to the sheep.'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
    });
    const payload = `data: ${JSON.stringify({ id, text })}\n\n`;
    for (const c of this.clients) c.write(payload);
    await acked;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(this.hub.latest), 2000);
      this.statusWaiters.push({ resolve: (s) => { clearTimeout(timer); resolve(s); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }
}

// ---------------------------------------------------------------- Simulated sheep

class SimSheep {
  constructor(clock) {
    this.clock = clock;
    this.pats = 0;
    this.light = 400;
    this.start = 0;
    this.from = 0;
    this.to = 0;
    this.ms = 0;
  }
  level() {
    const t = this.ms ? Math.min(1, (this.clock() - this.start) / this.ms) : 1;
    return this.from + (this.to - this.from) * t;
  }
  command(text) {
    if (text.startsWith('L,')) {
      const [, b, s] = text.split(',');
      this.from = this.level();
      this.to = clamp(Number(b), 0, 100);
      this.ms = clamp(Number(s), 0, 1800) * 1000;
      this.start = this.clock();
    }
    return this.status();
  }
  status() {
    return { pats: this.pats, light: this.light, level: Math.round(this.level()), target: Math.round(this.to) };
  }
}

// ---------------------------------------------------------------- Hub

export class SheepHub extends EventEmitter {
  /**
   * @param {{python?, bridgeScript?, speedup?, port?, simulate?, patFile?, clock?, preferred?, startUsb?}} opts
   */
  constructor(opts = {}) {
    super();
    this.clock = opts.clock ?? (() => Date.now());
    this.speedup = opts.speedup ?? 1;
    this.preferred = TRANSPORTS.includes(opts.preferred) ? opts.preferred : 'auto';
    this.patFile = opts.patFile ?? null;
    this.latest = null;
    this.latestAt = null;
    this.latestTransport = null;
    this.lastPats = null;
    this.patLog = this.loadPats();
    this.logLines = [];
    this.ble = new BleRelay(this);
    this.sim = opts.simulate ? new SimSheep(this.clock) : null;
    this.usb = opts.bridgeScript ? new UsbBridge(this, { python: opts.python ?? 'python', script: opts.bridgeScript, speedup: this.speedup, port: opts.port }) : null;
    if (this.usb && opts.startUsb !== false) this.usb.start();
    if (this.sim) {
      this.simTimer = setInterval(() => this.onStatus(this.sim.status(), 'sim'), 1000);
      this.simTimer.unref?.();
    }
  }

  log(line) {
    this.logLines.unshift(`${new Date(this.clock()).toISOString().slice(11, 19)} ${line}`);
    this.logLines.length = Math.min(this.logLines.length, 30);
  }

  changed() {
    this.emit('changed', this.describe());
  }

  available() {
    const now = this.clock();
    return {
      usb: !!this.usb?.ready,
      ble: this.ble.isLive(now) || (this.ble.connected && this.ble.clients.size > 0),
      sim: !!this.sim,
    };
  }

  /** Which transport commands go to: the preferred one if available, else USB > Bluetooth > simulated. */
  active() {
    const a = this.available();
    if (this.preferred !== 'auto' && a[this.preferred]) return this.preferred;
    return ['usb', 'ble', 'sim'].find((t) => a[t]) ?? null;
  }

  setPreferred(t) {
    if (t !== 'auto' && !TRANSPORTS.includes(t)) throw new Error(`transport must be auto, ${TRANSPORTS.join(', ')}`);
    this.preferred = t;
    this.changed();
  }

  connectedLabel(t = this.active()) {
    if (t === 'usb') return 'Sleep Sheep (USB)';
    if (t === 'ble') return `Sleep Sheep (Bluetooth${this.ble.deviceName ? `: ${this.ble.deviceName}` : ''})`;
    if (t === 'sim') return 'Sleep Sheep (simulated)';
    return 'Sleep Sheep (not connected)';
  }

  notConnectedError() {
    const why = this.usb?.error ? ` USB: ${this.usb.error}.` : '';
    return new Error(`Sheep not connected.${why} Plug it in by USB or connect it over Bluetooth from the dashboard, and keep it within a few meters.`);
  }

  /** Fade the light. Agent thinks in real minutes; the demo speedup is applied below it. */
  async setLamp(brightness, minutes) {
    const t = this.active();
    if (!t) throw this.notConnectedError();
    const cmd = lampCommand(brightness, minutes, this.speedup);
    let status;
    if (t === 'usb') status = await this.usb.call('set_lamp', { brightness: cmd.brightness, minutes: cmd.minutes });
    else if (t === 'ble') status = await this.ble.send(cmd.text);
    else status = this.sim.command(cmd.text);
    const clean = this.onStatus(status, t);
    this.log(`${t} <- ${cmd.text}`);
    return { ...clean, requested: { brightness: cmd.brightness, minutes: cmd.minutes, sent: cmd.text, demoSpeedup: this.speedup } };
  }

  async getStatus() {
    const t = this.active();
    if (!t) throw this.notConnectedError();
    if (t === 'usb') return this.onStatus(await this.usb.call('get_status', {}), 'usb');
    if (t === 'ble') {
      if (this.latest && this.latestTransport === 'ble' && this.clock() - this.latestAt < 3000) return this.statusOut();
      return this.onStatus(await this.ble.send('S'), 'ble');
    }
    return this.onStatus(this.sim.status(), 'sim');
  }

  statusOut() {
    return { ...this.latest, transport: this.latestTransport, simulated: this.latestTransport === 'sim', at: this.latestAt };
  }

  /** Every status update from any transport. Timestamps new pats (the Arduino has no clock). */
  onStatus(raw, transport) {
    if (!raw || typeof raw !== 'object') return this.statusOut();
    // With USB and Bluetooth both up, only the active transport feeds status and the pat log,
    // so the two streams can't interleave and miss or double-count pats.
    const act = this.active();
    if (act && transport !== act) return this.latest ? this.statusOut() : { ...raw, transport };
    const s = {
      pats: Number.isFinite(raw.pats) ? raw.pats : null,
      light: Number.isFinite(raw.light) ? raw.light : null,
      level: Number.isFinite(raw.level) ? Math.round(raw.level * 10) / 10 : null,
      target: Number.isFinite(raw.target) ? Math.round(raw.target * 10) / 10 : null,
    };
    const now = this.clock();
    if (s.pats != null) {
      const sameSource = this.latestTransport === transport;
      if (this.lastPats == null || !sameSource || s.pats < this.lastPats) {
        // First reading, a different transport (its own counter view), or the Arduino restarted.
        this.lastPats = s.pats;
      } else if (s.pats > this.lastPats) {
        const added = [];
        for (let n = this.lastPats + 1; n <= s.pats; n++) added.push({ ts: new Date(now).toISOString(), count_since_boot: n, transport });
        this.patLog.push(...added);
        this.patLog = this.patLog.slice(-500);
        this.persistPats(added);
        this.lastPats = s.pats;
        this.emit('pat', { count: added.length, at: now });
      }
    }
    this.latest = s;
    this.latestAt = now;
    this.latestTransport = transport;
    return this.statusOut();
  }

  readPatLog(limit = 50) {
    const n = clamp(Math.round(Number(limit) || 50), 1, 200);
    return this.patLog.slice(-n);
  }

  loadPats() {
    if (!this.patFile || !fs.existsSync(this.patFile)) return [];
    return fs.readFileSync(this.patFile, 'utf8').split('\n').filter(Boolean).slice(-500).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  persistPats(rows) {
    if (!this.patFile) return;
    fs.mkdirSync(path.dirname(this.patFile), { recursive: true });
    fs.appendFileSync(this.patFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  /** Simulated pat (only on the simulated sheep). */
  simulatePat() {
    if (!this.sim) throw new Error('Pats can only be simulated on the simulated sheep');
    this.sim.pats += 1;
    this.onStatus(this.sim.status(), 'sim');
  }

  describe() {
    const now = this.clock();
    const active = this.active();
    return {
      active,
      label: this.connectedLabel(active),
      simulated: active === 'sim',
      preferred: this.preferred,
      demoSpeedup: this.speedup,
      transports: {
        usb: this.usb ? { ready: this.usb.ready, error: this.usb.error } : { ready: false, error: 'USB bridge not configured' },
        ble: { connected: this.ble.connected, tabs: this.ble.clients.size, live: this.ble.isLive(now), device: this.ble.deviceName },
        sim: { enabled: !!this.sim },
      },
      status: this.latest ? this.statusOut() : null,
      statusAgeMs: this.latestAt == null ? null : now - this.latestAt,
      pats: this.patLog.slice(-10),
      log: this.logLines.slice(0, 12),
      ble: SHEEP_BLE,
    };
  }

  close() {
    this.usb?.stop();
    clearInterval(this.simTimer);
  }
}
