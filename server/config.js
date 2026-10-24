// Server configuration from environment variables (optionally a .env file in the project root).
// Credentials and device addresses live only here, on the server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      const raw = m[2];
      // Quoted values are taken as-is; unquoted values drop a trailing " # comment".
      const q = /^(["'])(.*)\1$/.exec(raw);
      process.env[m[1]] = q ? q[2] : raw.replace(/\s+#.*$/, '').trim();
    }
  }
}

const posInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d);
const nonNegInt = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);

export function loadConfig(env = process.env) {
  loadDotEnv();
  const e = { ...process.env, ...env };
  return {
    port: Number(e.PORT) || 3000,
    host: e.HOST || '127.0.0.1',
    dataDir: path.resolve(ROOT, e.DATA_DIR || 'data'),
    // Live Open-Meteo by default. "scenario" (or the older "simulated") starts in an offline scenario.
    weatherMode: ['scenario', 'simulated'].includes(e.WEATHER_PROVIDER) ? 'scenario' : 'live',
    weatherScenario: e.WEATHER_SCENARIO || e.SIM_WEATHER || 'rain',
    weatherTimeoutMs: posInt(e.WEATHER_TIMEOUT_MS, 6000),
    weatherRetries: Math.min(5, nonNegInt(e.WEATHER_RETRIES, 2)),
    weatherRefreshMinutes: posInt(e.WEATHER_REFRESH_MIN, 30),
    weatherStaleAfterMinutes: posInt(e.WEATHER_STALE_AFTER_MIN, 180),
    // Engineering choice, not a provider value: when wind counts as "strong" (km/h).
    windStrongSpeedKmh: posInt(e.WIND_STRONG_SPEED_KMH, 40),
    windStrongGustKmh: posInt(e.WIND_STRONG_GUST_KMH, 60),
    // The Sleep Sheep is the default light; "simulated", "hue" and "http" remain available.
    lightAdapter: ['sheep', 'hue', 'http', 'simulated'].includes(e.LIGHT_ADAPTER) ? e.LIGHT_ADAPTER : 'sheep',
    // Sleep Sheep hardware. USB goes through hardware_integration/bridge.py (Python + pyserial).
    sheepTransport: ['auto', 'usb', 'ble', 'sim'].includes(e.SHEEP_TRANSPORT) ? e.SHEEP_TRANSPORT : 'auto',
    sheepUsb: e.SHEEP_USB !== 'off',
    sheepSimulate: e.SHEEP_SIMULATE === '1',
    sheepPython: e.SHEEP_PYTHON || 'python',
    sheepPort: e.SHEEP_PORT || '',
    demoSpeedup: Math.max(1, Number(e.DEMO_SPEEDUP) || 1),
    // LLM agent. No key -> backup rules run and the dashboard says so.
    agentApiKey: e.ANTHROPIC_API_KEY || '',
    agentEnabled: e.DRIFT_AGENT !== 'off',
    agentModel: e.DRIFT_AGENT_MODEL || 'claude-opus-5-5',
    agentEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.DRIFT_AGENT_EFFORT) ? e.DRIFT_AGENT_EFFORT : 'medium',
    agentMaxRunsPerHour: posInt(e.DRIFT_AGENT_MAX_RUNS_PER_HOUR, 20),
    lightColorTemp: e.LIGHT_COLOR_TEMP !== 'false',
    lightUrl: e.LIGHT_URL,
    hueBridge: e.HUE_BRIDGE_IP,
    hueUsername: e.HUE_USERNAME,
    hueLightId: e.HUE_LIGHT_ID || '1',
    audioAdapter: ['simulated', 'http'].includes(e.AUDIO_ADAPTER) ? e.AUDIO_ADAPTER : 'browser',
    audioUrl: e.AUDIO_URL,
    fanAdapter: ['simulated', 'http'].includes(e.FAN_ADAPTER) ? e.FAN_ADAPTER : 'none',
    fanUrl: e.FAN_URL,
    tickMs: Number(e.TICK_MS) || 2000,
    seedSamples: e.SEED_SAMPLE_USERS !== 'false',
  };
}
