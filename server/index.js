// Drift HTTP server: JSON API + static dashboard.
// Flow: preferences + calendar + weather -> buildPlan() (backup rules) ─┐
//       events -> AgentController -> Claude agent + tools (agent mode) ─┴-> Executor -> sheep light + speaker

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { Store } from './store.js';
import { normalizeProfile, defaultProfile, DAY_CATEGORIES, DAY_CATEGORY_LABELS } from './profile.js';
import { buildPlan, PlanInputError } from './policy/buildPlan.js';
import { previewFrames } from './policy/timeline.js';
import { feedbackSuggestions, validateFeedback, applySuggestion } from './policy/feedback.js';
import { normalizeEvent, EVENT_CATEGORIES, EVENT_CATEGORY_LABELS } from './calendar/events.js';
import { calendarContextFor, validateIcsUrl, maskUrl } from './calendar/provider.js';
import { createWeatherService } from './weather/providers.js';
import { createAdapters } from './devices/adapters.js';
import { Executor } from './devices/executor.js';
import { SCENARIOS, SAMPLE_USERS, scenarioInputs } from './scenarios.js';
import { isDate } from './time.js';
import { SheepHub } from './sheep/hub.js';
import { AgentController } from './agent/controller.js';
import { createClient } from './agent/agent.js';

const config = loadConfig();
const store = new Store(config.dataDir);
const sheep = new SheepHub({
  bridgeScript: config.sheepUsb ? path.join(ROOT, 'hardware_integration', 'bridge.py') : null,
  python: config.sheepPython,
  port: config.sheepPort,
  speedup: config.demoSpeedup,
  simulate: config.sheepSimulate,
  preferred: config.sheepTransport,
  patFile: path.join(config.dataDir, 'pats.jsonl'),
});
const adapters = createAdapters(config, { sheepHub: sheep });
const executor = new Executor({ adapters, minIntervalMs: config.tickMs });
const weather = createWeatherService(config);

if (config.seedSamples && store.list().length === 0) {
  const presets = { alex: 'exam', sam: 'early', jordan: 'empty' };
  for (const [id, profile] of Object.entries(SAMPLE_USERS)) {
    store.create(profile, { sample: true, calendar: { mode: 'simulated', simPreset: presets[id], icsUrl: null, events: [], annotations: {}, dayLabels: {} } });
  }
}
let activeUserId = store.meta().activeUserId ?? store.list()[0]?.id ?? null;

// The agent sees the active person's normalized preferences and the backup rules' plan.
const agentCtx = () => {
  const rec = activeUserId ? store.get(activeUserId) : null;
  const entry = activeUserId ? planCache.get(activeUserId) : null;
  if (!rec || !entry) return null;
  return { profile: normalizeProfile(rec.profile).profile, plan: entry.plan };
};
const agent = new AgentController({
  client: createClient(config),
  enabled: config.agentEnabled,
  model: config.agentModel,
  effort: config.agentEffort,
  maxRunsPerHour: config.agentMaxRunsPerHour,
  executor,
  hub: sheep,
  ctx: agentCtx,
  prepare: () => activeUserId && planFor(activeUserId),
});

// ---------- planning ----------

const planCache = new Map();
const PLAN_TTL_MS = 30_000;

const locationOf = (profile) => ({ ...profile.location, timezone: profile.timezone });
const weatherSourceTag = () => (weather.mode === 'live' ? 'live' : `scenario:${weather.scenario}`);

async function planFor(id, { force = false, attempt = 0 } = {}) {
  const now = Date.now();
  const cached = planCache.get(id);
  if (!force && cached && now - cached.builtAt < PLAN_TTL_MS) return cached;
  const rec = store.get(id);
  if (!rec) return null;
  const [calendar, wx] = await Promise.all([
    calendarContextFor(rec, now),
    weather.getForUser(id, locationOf(rec.profile), now),
  ]);
  // The location or weather source changed while this request was in flight: never let the late
  // response replace the current location's forecast.
  if (wx?.superseded) return attempt < 2 ? planFor(id, { force: true, attempt: attempt + 1 }) : planCache.get(id) ?? null;
  const latest = store.get(id);
  if (!latest || JSON.stringify(locationOf(latest.profile)) !== JSON.stringify(locationOf(rec.profile))) {
    return attempt < 2 ? planFor(id, { force: true, attempt: attempt + 1 }) : planCache.get(id) ?? null;
  }
  const controls = {
    decisions: rec.decisions,
    overrides: id === activeUserId ? executor.activeOverrides() : {},
    previousWindows: rec.weatherWindows,
    // A lock only holds for the weather source it was made with; switching source is an explicit edit.
    audioLock: rec.audioLock?.source === weatherSourceTag() ? rec.audioLock : null,
    stopped: id === activeUserId && executor.stopped,
  };
  const plan = buildPlan(rec.profile, calendar, wx, now, controls);
  const windows = plan.weather.windows.map(({ kind, start, end, committed, released, peak }) => ({ kind, start, end, committed, released, peak }));
  if (JSON.stringify(windows) !== JSON.stringify(rec.weatherWindows)) store.update(id, (r) => ({ ...r, weatherWindows: windows }));
  // Once the night has started, lock the overnight sound so later forecast changes (or the
  // forecast going stale) don't switch it mid-sleep. Only the opt-in allows overnight changes.
  const sl = plan.audio.sleep;
  const s = plan.schedule;
  const tag = weatherSourceTag();
  if (now >= s.bedtime && now < s.wakeEnd && !rec.profile.sound.weatherTransitions && (rec.audioLock?.night !== s.eveningDate || rec.audioLock?.source !== tag)) {
    store.update(id, (r) => ({ ...r, audioLock: { night: s.eveningDate, source: tag, selection: { soundId: sl.soundId, rule: sl.rule, reason: sl.reason } } }));
  }
  const entry = { plan, builtAt: now, weather: wx, calendarWarnings: calendar.warnings ?? [] };
  planCache.set(id, entry);
  if (id === activeUserId) applyPlan(entry);
  return entry;
}

/** In agent mode the rules' light and sound plan is withheld: the agent drives them directly. */
function applyPlan(entry) {
  const rec = store.get(activeUserId);
  if (!rec || !entry) return;
  const maxVolume = normalizeProfile(rec.profile).profile.sound.maxVolume;
  const plan = agent.mode === 'agent' ? { ...entry.plan, outputs: { ...entry.plan.outputs, light: [], audio: [] } } : entry.plan;
  executor.setPlan(plan, { maxVolume });
}
agent.on('mode', () => applyPlan(planCache.get(activeUserId)));

/** Mark a plan for rebuild; for the active person, also tell the agent something changed. */
const invalidate = (id, event = 'settings_changed', detail = '') => {
  const e = planCache.get(id);
  if (e) e.builtAt = -Infinity;
  if (id === activeUserId && event) agent.trigger(event, detail);
};

let looping = false;
let started = false;
setInterval(async () => {
  if (looping) return;
  looping = true;
  try {
    if (activeUserId && store.get(activeUserId)) await planFor(activeUserId);
    executor.tick();
    await agent.tick();
    if (!started && planCache.get(activeUserId)) {
      started = true;
      agent.trigger('startup', 'Drift just started');
    }
  } catch (e) {
    console.error('[loop]', e.message);
  } finally {
    looping = false;
  }
}, config.tickMs);

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function userOr404(id) {
  const rec = store.get(id);
  if (!rec) throw new HttpError(404, 'user not found');
  return rec;
}

function publicCalendar(cal) {
  return {
    mode: cal.mode,
    simPreset: cal.simPreset ?? null,
    icsUrl: maskUrl(cal.icsUrl),
    storeTitles: cal.storeTitles !== false,
    events: cal.events,
    annotations: cal.annotations,
    dayLabels: cal.dayLabels,
  };
}

function slugify(name) {
  return (name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'user';
}

function integrations() {
  const now = Date.now();
  return {
    weather: weather.source,
    devices: Object.fromEntries(Object.entries(adapters).map(([k, a]) => [k, a ? a.describe(now) : null])),
    sheep: sheep.describe(),
  };
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

route('GET', '/api/status', () => ({
  activeUserId,
  users: store.list(),
  integrations: integrations(),
  dayCategories: DAY_CATEGORIES.map((k) => ({ key: k, label: DAY_CATEGORY_LABELS[k] })),
  eventCategories: EVENT_CATEGORIES.map((k) => ({ key: k, label: EVENT_CATEGORY_LABELS[k] })),
  defaults: defaultProfile('new-user'),
}));

route('POST', '/api/users', (_m, body) => {
  const input = body?.profile ?? {};
  let id = slugify(input.name);
  for (let i = 2; store.get(id); i++) id = `${slugify(input.name)}-${i}`;
  const { profile, errors, warnings } = normalizeProfile({ ...input, id });
  if (errors.length) throw new HttpError(400, 'Please fix these preferences', errors);
  store.create(profile);
  if (!activeUserId) {
    activeUserId = id;
    store.setMeta({ activeUserId });
  }
  return { profile, warnings };
});

route('GET', '/api/users/([a-z0-9-]+)', ([id]) => {
  const rec = userOr404(id);
  return { profile: rec.profile, sample: !!rec.sample, calendar: publicCalendar(rec.calendar), decisions: rec.decisions, feedback: rec.feedback.slice(-10) };
});

route('PUT', '/api/users/([a-z0-9-]+)/profile', ([id], body) => {
  userOr404(id);
  const { profile, errors, warnings } = normalizeProfile({ ...body?.profile, id });
  if (errors.length) throw new HttpError(400, 'Please fix these preferences', errors);
  // New preferences release tonight's locked sound so the change takes effect.
  store.update(id, (r) => ({ ...r, profile, audioLock: null }));
  invalidate(id, 'preferences_changed', 'the person saved new preferences');
  return { profile, warnings };
});

route('DELETE', '/api/users/([a-z0-9-]+)', ([id]) => {
  userOr404(id);
  store.remove(id);
  invalidate(id);
  if (activeUserId === id) {
    activeUserId = store.list()[0]?.id ?? null;
    store.setMeta({ activeUserId });
    executor.setPlan(null, { maxVolume: 0 });
  }
  return { ok: true };
});

route('POST', '/api/active', (_m, body) => {
  userOr404(body?.userId);
  if (activeUserId !== body.userId) {
    executor.overrides = {};
    activeUserId = body.userId;
    store.setMeta({ activeUserId });
    invalidate(activeUserId);
  }
  return { activeUserId };
});

route('GET', '/api/users/([a-z0-9-]+)/dashboard', async ([id]) => {
  const rec = userOr404(id);
  const entry = await planFor(id);
  return {
    plan: entry.plan,
    calendarWarnings: entry.calendarWarnings,
    active: id === activeUserId,
    executor: id === activeUserId ? executor.snapshot() : null,
    integrations: integrations(),
    agent: id === activeUserId ? agent.status() : null,
    suggestions: feedbackSuggestions(rec.profile, rec.feedback),
    lastFeedback: rec.feedback[rec.feedback.length - 1] ?? null,
  };
});

route('GET', '/api/users/([a-z0-9-]+)/preview', async ([id]) => {
  const entry = await planFor(id);
  return { frames: previewFrames(entry.plan, { stepMinutes: 5, overrides: entry.plan.overrides }), simulated: true };
});

route('PUT', '/api/users/([a-z0-9-]+)/day-label', ([id], body) => {
  userOr404(id);
  if (!isDate(body?.date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (body.category != null && !DAY_CATEGORIES.includes(body.category)) throw new HttpError(400, 'unknown day category');
  store.update(id, (r) => {
    const dayLabels = { ...r.calendar.dayLabels };
    if (body.category == null) delete dayLabels[body.date];
    else dayLabels[body.date] = body.category;
    // A relabeled day invalidates earlier accept/decline decisions for it.
    const decisions = { ...r.decisions };
    delete decisions[body.date];
    return { ...r, calendar: { ...r.calendar, dayLabels }, decisions };
  });
  invalidate(id);
  return { ok: true };
});

route('POST', '/api/users/([a-z0-9-]+)/proposals', async ([id], body) => {
  userOr404(id);
  const { plan } = await planFor(id, { force: true });
  const date = plan.schedule.wakeDate;
  if (body?.action === 'reset') {
    store.update(id, (r) => ({ ...r, decisions: Object.fromEntries(Object.entries(r.decisions).filter(([d]) => d !== date)) }));
  } else {
    const p = plan.proposals.find((x) => x.id === body?.id);
    if (!p) throw new HttpError(404, 'That suggestion is no longer part of tonight’s plan');
    if (!['accept', 'decline'].includes(body.action)) throw new HttpError(400, 'action must be accept, decline or reset');
    store.update(id, (r) => {
      const d = { accepted: {}, declined: [], ...(r.decisions[date] ?? {}) };
      if (body.action === 'accept') {
        d.accepted = { ...d.accepted, [p.field]: p.to };
        d.declined = d.declined.filter((x) => x !== p.id);
      } else {
        const { [p.field]: _drop, ...rest } = d.accepted;
        d.accepted = rest;
        d.declined = [...new Set([...d.declined, p.id])];
      }
      return { ...r, decisions: { ...r.decisions, [date]: d } };
    });
  }
  invalidate(id);
  return { ok: true };
});

route('PUT', '/api/users/([a-z0-9-]+)/calendar', ([id], body) => {
  userOr404(id);
  const mode = body?.mode;
  if (!['manual', 'ics', 'simulated'].includes(mode)) throw new HttpError(400, 'mode must be manual, ics or simulated');
  let icsUrl;
  if (mode === 'ics' && body.icsUrl) {
    const v = validateIcsUrl(String(body.icsUrl));
    if (v.error) throw new HttpError(400, v.error);
    icsUrl = v.url;
  }
  store.update(id, (r) => {
    const cal = { ...r.calendar, mode };
    if (icsUrl) cal.icsUrl = icsUrl;
    if (mode === 'ics' && !cal.icsUrl) throw new HttpError(400, 'Paste your calendar’s private iCal (.ics) address');
    if (body.simPreset) cal.simPreset = String(body.simPreset);
    if (typeof body.storeTitles === 'boolean') cal.storeTitles = body.storeTitles;
    return { ...r, calendar: cal };
  });
  invalidate(id);
  return { calendar: publicCalendar(store.get(id).calendar) };
});

route('POST', '/api/users/([a-z0-9-]+)/events', ([id], body) => {
  const rec = userOr404(id);
  const raw = { ...body?.event, id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` };
  const r = normalizeEvent(raw, rec.profile.timezone);
  if (r.error) throw new HttpError(400, r.error);
  store.update(id, (x) => ({ ...x, calendar: { ...x.calendar, events: [...x.calendar.events, raw] } }));
  invalidate(id);
  return { event: raw };
});

route('DELETE', '/api/users/([a-z0-9-]+)/events/([^/]+)', ([id, eid]) => {
  userOr404(id);
  store.update(id, (x) => ({ ...x, calendar: { ...x.calendar, events: x.calendar.events.filter((e) => e.id !== decodeURIComponent(eid)) } }));
  invalidate(id);
  return { ok: true };
});

route('PUT', '/api/users/([a-z0-9-]+)/annotations/([^/]+)', ([id, eid], body) => {
  userOr404(id);
  const a = {};
  if (body?.importance !== undefined) {
    if (![null, 'important', 'normal'].includes(body.importance)) throw new HttpError(400, 'importance must be important, normal or null');
    a.importance = body.importance;
  }
  if (body?.category !== undefined) {
    if (body.category !== null && !EVENT_CATEGORIES.includes(body.category)) throw new HttpError(400, 'unknown category');
    a.category = body.category;
  }
  for (const k of ['prepMinutes', 'travelMinutes']) {
    if (body?.[k] === undefined) continue;
    const n = body[k] === null || body[k] === '' ? null : Number(body[k]);
    if (n !== null && !(Number.isFinite(n) && n >= 0 && n <= 600)) throw new HttpError(400, `${k} must be 0-600`);
    a[k] = n;
  }
  const key = decodeURIComponent(eid);
  store.update(id, (x) => ({ ...x, calendar: { ...x.calendar, annotations: { ...x.calendar.annotations, [key]: { ...x.calendar.annotations[key], ...a } } } }));
  invalidate(id);
  return { ok: true };
});

route('POST', '/api/users/([a-z0-9-]+)/feedback', ([id], body) => {
  userOr404(id);
  const r = validateFeedback(body);
  if (r.error) throw new HttpError(400, r.error);
  store.update(id, (x) => ({ ...x, feedback: [...x.feedback.filter((f) => f.night !== r.feedback.night), { ...r.feedback, at: Date.now() }].slice(-30) }));
  const rec = store.get(id);
  return { suggestions: feedbackSuggestions(rec.profile, rec.feedback) };
});

route('POST', '/api/users/([a-z0-9-]+)/suggestions/apply', ([id], body) => {
  const rec = userOr404(id);
  const s = feedbackSuggestions(rec.profile, rec.feedback).find((x) => x.id === body?.id);
  if (!s) throw new HttpError(404, 'suggestion not found');
  const r = applySuggestion(rec.profile, s);
  if (r.error) throw new HttpError(400, r.error);
  store.update(id, (x) => ({ ...x, profile: r.profile, feedback: x.feedback.map((f, i, all) => (i === all.length - 1 ? { ...f, applied: [...(f.applied ?? []), s.id] } : f)) }));
  invalidate(id);
  return { profile: r.profile };
});

// ---- live controls (active user) ----

route('POST', '/api/control/override', (_m, body) => {
  try {
    const o = executor.setOverride(body?.output, body?.target, body?.minutes ?? null);
    if (activeUserId) invalidate(activeUserId, 'manual_override', `the person set the ${body.output} by hand${body.minutes ? ` for ${body.minutes} min` : ''}`);
    executor.tick();
    return { override: o };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
route('DELETE', '/api/control/override/(light|audio|fan)', ([output]) => {
  executor.clearOverride(output);
  if (activeUserId) invalidate(activeUserId, 'override_cleared', `the person cleared their ${output} override`);
  return { ok: true };
});
const refreshActive = () => activeUserId && invalidate(activeUserId, null);
route('POST', '/api/control/pause', () => (executor.pause(), refreshActive(), { paused: true }));
route('POST', '/api/control/resume', () => {
  executor.resume();
  refreshActive();
  agent.trigger('resume', 'the person resumed automation after Pause or Stop', { user: true });
  return { paused: false };
});
route('POST', '/api/control/stop', () => {
  agent.stop(); // abort any run in flight and drop scheduled actions first
  executor.stop();
  refreshActive();
  return { stopped: true };
});

// ---- agent ----

route('GET', '/api/agent', () => agent.status());
// Read-only context for an agent running elsewhere (the iOS app's get_drift_context tool).
route('GET', '/api/agent/context', async () => {
  if (!activeUserId) throw new HttpError(404, 'No profile is active');
  await planFor(activeUserId);
  const t = agent.tools;
  return { preferences: await t.tool_get_preferences(), tonight: await t.tool_get_tonight(), weather: await t.tool_get_weather() };
});
route('POST', '/api/agent/run', (_m, body) => {
  if (!agent.enabled) throw new HttpError(400, agent.disabledReason ?? 'Agent is not enabled');
  if (executor.stopped) throw new HttpError(400, 'Stop is active. Press Resume first.');
  agent.trigger('person_request', String(body?.note ?? 'the person pressed “Run agent now”').slice(0, 300), { user: true });
  return { queued: true };
});
route('DELETE', '/api/agent/scheduled/([a-z0-9]+)', ([sid]) => {
  if (!agent.scheduler.cancel(sid)) throw new HttpError(404, 'No such scheduled action');
  return { ok: true };
});

// ---- sheep hardware ----

route('GET', '/api/sheep', () => sheep.describe());
route('POST', '/api/sheep/transport', (_m, body) => {
  try {
    sheep.setPreferred(body?.preferred);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  return sheep.describe();
});
route('POST', '/api/sheep/ble/status', (_m, body) => (sheep.ble.onStatus(body?.raw, Date.now()), { ok: true }));
route('POST', '/api/sheep/ble/ack', (_m, body) => (sheep.ble.ack(body?.id, !!body?.ok, body?.error), { ok: true }));
route('POST', '/api/sheep/ble/connection', (_m, body) => {
  sheep.ble.setConnected(!!body?.connected, body?.name);
  if (activeUserId) agent.trigger('sheep_connection', body?.connected ? 'the sheep connected over Bluetooth' : 'the sheep disconnected from Bluetooth');
  return sheep.describe();
});
route('POST', '/api/sheep/sim/pat', () => {
  try {
    sheep.simulatePat();
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  return { ok: true };
});

route('POST', '/api/audio/sync', (_m, body) => {
  const audio = adapters.audio;
  if (!audio?.heartbeat) return { command: null };
  const now = Date.now();
  audio.heartbeat(now, { enabled: !!body?.enabled, error: body?.error ?? null });
  if (body?.enabled && body.ackSeq != null && body.playing) executor.confirm('audio', body.ackSeq, body.playing);
  return { command: audio.command };
});

// ---- simulation controls (only affect simulated providers/devices) ----

route('GET', '/api/weather/source', () => weather.source);
// Switching between live data and an offline scenario is always explicit and labeled.
route('POST', '/api/weather/source', (_m, body) => {
  try {
    weather.setSource({ mode: body?.mode, scenario: body?.scenario });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  planCache.clear();
  return weather.source;
});
// Older demo control, kept for compatibility: selects an offline scenario.
route('POST', '/api/sim/weather', (_m, body) => {
  try {
    weather.setSource({ mode: 'scenario', scenario: body?.preset });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  planCache.clear();
  return weather.source;
});
route('GET', '/api/users/([a-z0-9-]+)/weather', async ([id]) => {
  userOr404(id);
  const entry = await planFor(id);
  return { source: weather.source, weather: entry.weather, assessed: entry.plan.weather };
});
route('POST', '/api/sim/device', (_m, body) => {
  const a = adapters[body?.output];
  if (!a?.simulated) throw new HttpError(400, 'Only simulated devices can be toggled');
  a.connected = !!body.connected;
  return { ok: true };
});

route('GET', '/api/scenarios', () => SCENARIOS.map(({ id, title, description }) => ({ id, title, description, simulated: true })));
route('GET', '/api/scenarios/([a-z-]+)', ([sid]) => {
  const sc = SCENARIOS.find((s) => s.id === sid);
  if (!sc) throw new HttpError(404, 'scenario not found');
  return {
    scenario: { id: sc.id, title: sc.title, description: sc.description, simulated: true },
    results: sc.runs.map((run) => {
      const i = scenarioInputs(sc, run);
      const plan = buildPlan(i.profile, i.calendar, i.weather, i.now, i.controls);
      return { plan, frames: previewFrames(plan, { stepMinutes: 5, overrides: i.controls.overrides }) };
    }),
  };
});

route('GET', '/api/geocode', async (_m, _b, url) => {
  const q = url.searchParams.get('q');
  if (!q || q.length < 2) throw new HttpError(400, 'type at least 2 characters');
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '6', language: 'en' })}`, { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    return { results: (j.results ?? []).map((r) => ({ label: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, timezone: r.timezone })) };
  } catch (e) {
    throw new HttpError(502, `City search is unavailable (${e.message}). Enter latitude/longitude manually or skip.`);
  }
});

// ---------- http plumbing ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = path.join(ROOT, 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  // Bluetooth relay: the dashboard tab holding the Web Bluetooth connection listens here for commands.
  if (req.method === 'GET' && url.pathname === '/api/sheep/ble/commands') return sheep.ble.attach(res);
  if (url.pathname.startsWith('/api/')) {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(404, { error: 'not found' });
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
      const out = await r.handler(r.re.exec(url.pathname).slice(1), body, url);
      return send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, details: e.details });
      if (e instanceof PlanInputError) return send(400, { error: e.message, details: e.details });
      console.error(e);
      return send(500, { error: 'internal error' });
    }
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(config.port, config.host, () => {
  const sim = [
    weather.mode !== 'live' && `weather (offline scenario “${weather.scenario}”)`,
    adapters.light.simulated && 'light',
    adapters.audio.simulated && 'audio',
    adapters.fan?.simulated && 'fan',
  ].filter(Boolean);
  console.log(`Drift running at http://${config.host}:${config.port}`);
  console.log(sim.length ? `SIMULATED: ${sim.join(', ')}` : 'All integrations live.');
  console.log(agent.enabled ? `Agent: ${config.agentModel} (event-driven; backup rules until its first run)` : `Agent off: ${agent.disabledReason} Backup rules are in control.`);
  console.log(`Sheep: USB ${config.sheepUsb ? 'bridge starting' : 'off'}, Bluetooth via the dashboard${config.sheepSimulate ? ', simulated sheep enabled' : ''}${config.demoSpeedup > 1 ? `, DEMO_SPEEDUP=${config.demoSpeedup}` : ''}`);
});

// Release the serial port (Python bridge) when the server stops.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sheep.close(); process.exit(0); });
process.on('exit', () => sheep.close());
