// Drift dashboard. Plain ES modules, no build step.
import { SoundEngine } from './sound.js';
import { SheepBluetooth } from './sheep-ble.js';
import { renderAgent, renderSheep } from './agent-panel.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { status: null, viewing: null, dashboard: null, record: null, tab: 'tonight', planSig: null, frames: null, editing: null };
const engine = new SoundEngine(); // device output (driven by the server)
const previewEngine = new SoundEngine(); // onboarding previews only
const sheepBle = new SheepBluetooth(); // this tab can hold the Bluetooth link to the sheep

const SOUND_NAMES = { white: 'White noise', pink: 'Pink noise', brown: 'Brown noise', rain: 'Rain ambience', pads: 'Warm pads', chimes: 'Soft chimes', silence: 'Silence' };
const SOUND_COLORS = { white: '#d5dbe8', pink: '#f2a6c2', brown: '#b9875c', rain: '#6fa8dc', pads: '#c3a5f0', chimes: '#9fdcc6' };
const NOISES = ['white', 'pink', 'brown', 'rain'];
const PLAYABLE = [...NOISES, 'pads', 'chimes'];
const CATEGORY_ICON = { clear: '☀️', cloudy: '☁️', rain: '🌧️', snow: '❄️', fog: '🌫️', thunderstorm: '⛈️', unknown: '❔' };
const STATUS_CLASS = { fresh: 'ok', simulated: 'sim', stale: 'warn', unavailable: 'bad' };
const unknownOr = (v, unit = '', digits = 0) => (v == null ? '<span class="faint">unknown</span>' : `${Number(v).toFixed(digits)}${unit}`);
const PHASE_NAMES = { before: 'Before plan', awake: 'Awake', winddown: 'Wind-down', bedtime: 'Bedtime', overnight: 'Overnight', wake: 'Wake routine', morning: 'Morning', after: 'After plan' };

// ---------- utilities ----------

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || res.statusText);
    err.details = json.details;
    throw err;
  }
  return json;
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

const fmtCache = new Map();
function fmt(ms, tz, opts = { hour: 'numeric', minute: '2-digit' }) {
  if (ms == null) return '—';
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }));
  return fmtCache.get(key).format(ms);
}
const fmtDate = (date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.parse(`${date}T12:00:00Z`));
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function kelvinRgb(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return [c(r), c(g), c(b)];
}

function paintLamp(el, light) {
  if (!el) return;
  const b = light?.brightness ?? 0;
  if (b <= 0.5) {
    el.style.background = '#090c18';
    el.style.boxShadow = 'none';
    return;
  }
  const [r, g, bl] = kelvinRgb(light.colorTempK ?? 2700);
  const a = 0.15 + 0.85 * Math.min(1, b / 100);
  el.style.background = `radial-gradient(circle at 50% 45%, rgba(${r},${g},${bl},${a}) 0%, rgba(${r},${g},${bl},${a * 0.55}) 45%, rgba(${r},${g},${bl},${a * 0.12}) 75%, #090c18 100%)`;
  el.style.boxShadow = `0 0 ${Math.round(10 + b * 0.5)}px rgba(${r},${g},${bl},${a * 0.6})`;
}

const lightText = (l) => (l ? `${Math.round(l.brightness)}%${l.colorTempK ? ` · ${Math.round(l.colorTempK)}K` : ''}` : '—');
function audioText(a) {
  if (!a) return '—';
  const entries = Object.entries(a.channels ?? {}).filter(([, v]) => v >= 0.5);
  return entries.length ? entries.map(([k, v]) => `${SOUND_NAMES[k] ?? k} ${Math.round(v)}%`).join(' + ') : 'Silent';
}
const fanText = (f) => (f ? (f.level ? `Level ${f.level}` : 'Off') : '—');
const outputText = (o, v) => (o === 'light' ? lightText(v) : o === 'audio' ? audioText(v) : fanText(v));

function swatch(output, target) {
  if (output === 'light') {
    if (target.brightness <= 0) return '<span class="swatch" style="background:#090c18"></span>';
    const [r, g, b] = kelvinRgb(target.colorTempK ?? 2700);
    return `<span class="swatch" style="background:rgba(${r},${g},${b},${0.2 + 0.8 * target.brightness / 100})"></span>`;
  }
  if (output === 'audio') {
    const keys = Object.keys(target.channels);
    return `<span class="swatch" style="background:${keys.length ? SOUND_COLORS[keys[0]] : 'transparent'}"></span>`;
  }
  return '';
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

// ---------- boot ----------

async function loadStatus() {
  state.status = await api('GET', '/api/status');
  const sel = $('#user-select');
  sel.innerHTML = state.status.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}${u.sample ? ' (sample)' : ''}</option>`).join('');
  if (!state.viewing || !state.status.users.some((u) => u.id === state.viewing)) state.viewing = state.status.activeUserId ?? state.status.users[0]?.id ?? null;
  if (state.viewing) sel.value = state.viewing;
}

async function loadRecord() {
  state.record = state.viewing ? await api('GET', `/api/users/${state.viewing}`) : null;
}

function openTab(tab) {
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  $('#controlbar').hidden = tab === 'demo';
  if (tab === 'prefs') renderPrefs(state.editing === 'new' ? null : state.record?.profile ?? null);
  if (tab === 'calendar') renderCalendar();
  if (tab === 'demo') renderDemo();
  if (tab === 'tonight') refreshDashboard(true);
}

async function init() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { state.editing = null; openTab(b.dataset.tab); }));
  $('#user-select').addEventListener('change', async (e) => {
    state.viewing = e.target.value;
    state.planSig = null;
    try {
      await api('POST', '/api/active', { userId: state.viewing });
      await loadRecord();
      toast(`${state.record.profile.name}'s preferences now drive the bedroom device.`);
      openTab(state.tab);
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#new-user').addEventListener('click', () => {
    state.editing = 'new';
    openTab('prefs');
  });
  $('#btn-pause').addEventListener('click', async () => {
    const paused = state.dashboard?.executor?.paused;
    await api('POST', paused ? '/api/control/resume' : '/api/control/pause');
    toast(paused ? 'Automation resumed. Changes will fade in gradually.' : 'Automation paused. Outputs hold their current state.');
    refreshDashboard(true);
  });
  $('#btn-stop').addEventListener('click', async () => {
    engine.stopAll();
    await api('POST', '/api/control/stop');
    toast('Stopped: pending changes cancelled, sound off, lights held. Press Resume to restart.');
    refreshDashboard(true);
  });

  await loadStatus();
  if (!state.status.users.length) {
    state.editing = 'new';
    openTab('prefs');
  } else {
    await loadRecord();
    openTab('tonight');
  }
  setInterval(() => { if (state.tab === 'tonight' || state.tab === 'calendar') refreshDashboard(); }, 3000);
  setInterval(audioSync, 2000);
}

// ---------- browser audio device ----------

let lastSeq = null;
let playing = null;
async function audioSync() {
  try {
    const r = await api('POST', '/api/audio/sync', { enabled: engine.enabled, ackSeq: lastSeq, playing, error: engine.error });
    const c = r.command;
    // Same command as last time: nothing to do (loops keep playing, nothing restarts).
    if (c && engine.enabled && c.seq !== lastSeq && engine.set(c.cmd.channels, 2)) {
      lastSeq = c.seq;
      playing = c.cmd;
    }
  } catch {
    // server unreachable: the dashboard shows it as disconnected
  }
}

// ---------- control bar & banner ----------

function renderChrome(d) {
  const integ = d.integrations;
  const p = d.plan;
  const ex = d.executor;
  const sims = [];
  if (integ.weather.simulated) sims.push(`weather (offline scenario “${integ.weather.scenario}”)`);
  if (p.calendar.simulated) sims.push('calendar');
  for (const [k, dev] of Object.entries(integ.devices)) if (dev?.simulated) sims.push(k === 'light' ? 'lamp' : k);
  const banner = $('#sim-banner');
  banner.hidden = !sims.length;
  if (sims.length) {
    const html = `<strong>SIMULATION MODE</strong>: simulated ${esc(sims.join(', '))}. These are not live data or real hardware.`;
    if (banner.dataset.html !== html) {
      banner.innerHTML = html;
      banner.dataset.html = html;
    }
  }

  const chip = (label, cls, sim) => `<span class="chip ${cls}${sim ? ' sim' : ''}"><span class="dot"></span>${label}</span>`;
  const wx = p.weather;
  const wxCls = wx.status === 'fresh' || wx.status === 'simulated' ? 'ok' : wx.status === 'stale' ? 'warn' : 'bad';
  const chips = [
    chip(`Weather: ${wx.simulated ? `offline “${esc(wx.scenario)}”` : 'Open-Meteo'} · ${wx.status}${wx.fetchedAt ? ` · ${fmt(wx.fetchedAt, p.timezone)}` : ''}`, wxCls, wx.simulated),
    chip(`Calendar: ${p.calendar.simulated ? 'simulated' : esc(p.calendar.status.replace('_', ' '))}`, p.calendar.status === 'error' ? 'bad' : p.calendar.status === 'not_connected' ? 'warn' : 'ok', p.calendar.simulated),
  ];
  for (const o of ['light', 'audio', 'fan']) {
    const out = ex?.outputs?.[o];
    if (!out?.device) {
      if (o === 'fan') chips.push(chip('Fan: not configured', '', false));
      continue;
    }
    const cls = ['applied', 'playing', 'silent'].includes(out.status) ? 'ok' : ['pending', 'idle', 'blocked'].includes(out.status) ? 'warn' : 'bad';
    chips.push(chip(`${esc(out.device.label)}: ${out.status}`, cls, out.device.simulated));
  }
  $('#integration-chips').innerHTML = chips.join('');
  const autoState = !ex ? 'This profile is not driving the device' : ex.stopped ? 'Stopped' : ex.paused ? 'Automation paused' : 'Automation running';
  $('#automation-state').textContent = autoState;
  $('#btn-pause').textContent = ex?.paused ? 'Resume automation' : 'Pause automation';
  $('#btn-pause').disabled = !ex;
  $('#btn-stop').disabled = !ex || ex.stopped;
}

// ---------- tonight ----------

async function refreshDashboard(force = false) {
  if (!state.viewing) return;
  try {
    const d = await api('GET', `/api/users/${state.viewing}/dashboard`);
    state.dashboard = d;
    renderChrome(d);
    if (state.tab === 'tonight') renderTonight(d, force);
  } catch (err) {
    if (force) toast(err.message, true);
  }
}

function planSignature(p) {
  return JSON.stringify([p.outputs, p.day, p.proposals, p.weather, p.audio, p.overrides, p.explanations, p.schedule, p.routine, p.currentPhase]);
}

function renderTonight(d, force) {
  const root = $('#tab-tonight');
  if (!root.dataset.built) {
    root.innerHTML = `
      <div id="tn-notice"></div>
      <div class="grid two" style="margin-bottom:16px"><div class="card" id="tn-agent"></div><div class="card" id="tn-sheep"></div></div>
      <div class="hero">
        <div class="card" id="tn-summary"></div>
        <div class="card" id="tn-weather"></div>
      </div>
      <h3 class="section-title">Weather-aware sound</h3>
      <div class="card" id="tn-sound"></div>
      <h3 class="section-title">Why tonight looks like this</h3>
      <div class="card"><ul class="explain" id="tn-explain"></ul><p class="faint small" id="tn-disclaimer"></p></div>
      <h3 class="section-title">Tonight's timeline</h3>
      <div class="card timeline" id="tn-timeline"></div>
      <h3 class="section-title">Live outputs</h3>
      <div class="grid three" id="tn-live"></div>
      <h3 class="section-title">Planned outputs</h3>
      <div class="card" id="tn-segments"></div>
      <h3 class="section-title">Morning check-in (optional)</h3>
      <div class="grid two"><div class="card" id="tn-feedback"></div><div class="card" id="tn-suggestions"></div></div>`;
    root.dataset.built = '1';
  }
  const p = d.plan;
  $('#tn-notice').innerHTML = d.active ? '' : `<div class="card" style="margin-bottom:16px">This profile is not driving the bedroom device right now. Choose it in the user menu to make it active.</div>`;
  const sig = planSignature(p);
  if (force || sig !== state.planSig) {
    state.planSig = sig;
    renderSummary(p);
    renderWeather(p);
    renderSound(p);
    $('#tn-explain').innerHTML = p.explanations.map((e) => `<li data-kind="${esc(e.kind)}">${esc(e.text)}</li>`).join('');
    $('#tn-disclaimer').textContent = p.disclaimer;
    renderSegments(p);
    loadTimeline();
  }
  const helpers = { esc, fmt, tz: p.timezone, api, toast, refresh: () => refreshDashboard(true), ble: sheepBle };
  renderAgent($('#tn-agent'), d.agent, helpers);
  renderSheep($('#tn-sheep'), d.integrations.sheep, helpers);
  renderLive(d);
  renderFeedback(d);
}

function renderSummary(p) {
  const tz = p.timezone;
  const s = p.schedule;
  const day = p.day;
  const cats = state.status.dayCategories;
  const locked = new Set(s.locked);
  const evDesc = (e) => {
    const when = e.allDay ? 'All day' : `${fmt(e.start, tz)}–${fmt(e.end, tz)}`;
    const imp = e.importance === 'important' ? '<span class="badge accent">important</span>' : '';
    const cat = e.category ? `<span class="badge">${esc(e.category)}${e.categoryInferred ? ' · inferred' : ''}</span>` : '';
    const lead = e.prepMinutes || e.travelMinutes ? `<span class="faint small">prep ${e.prepMinutes ?? 0} + travel ${e.travelMinutes ?? 0} min</span>` : '';
    return `<li><span class="event-when">${when}</span> <span>${esc(e.title)}</span> ${imp} ${cat} ${lead}</li>`;
  };
  const proposals = p.proposals.map((x) => `
    <div class="proposal ${x.status}">
      <p>${esc(x.text)}</p>
      ${x.status === 'pending'
        ? `<button class="primary small" data-proposal="${x.id}" data-action="accept">Accept for tonight</button><button class="small" data-proposal="${x.id}" data-action="decline">Keep my usual</button>`
        : `<span class="badge ${x.status === 'accepted' ? 'ok' : ''}">${x.status}</span><button class="link small" data-action="reset">Undo</button>`}
    </div>`).join('');
  const choice = day.needsChoice ? `
    <div class="proposal"><p>Tomorrow has mixed signals (${day.candidates.map((c) => cats.find((x) => x.key === c)?.label).join(' and ')}). Which fits better? Your standard routine is used until you choose.</p>
    ${day.candidates.map((c) => `<button class="small" data-daylabel="${c}">${esc(cats.find((x) => x.key === c)?.label)}</button>`).join('')}
    <button class="small" data-daylabel="normal">Normal day</button></div>` : '';

  $('#tn-summary').innerHTML = `
    <div class="card-head"><h2>Tonight · ${fmtDate(s.eveningDate)} → ${fmtDate(s.wakeDate)}</h2><span class="badge accent">Now: ${esc(PHASE_NAMES[p.currentPhase] ?? p.currentPhase)} · ${esc(p.nowLabel)}</span></div>
    <div class="big-times">
      <div><span class="label">Wind-down</span><span class="value ${locked.has('windDownMinutes') ? 'locked' : ''}">${esc(s.labels.windDownStart)}</span></div>
      <div><span class="label">Bedtime</span><span class="value ${locked.has('bedtime') ? 'locked' : ''}">${esc(s.labels.bedtime)}</span></div>
      <div><span class="label">Wake</span><span class="value ${locked.has('wakeTime') ? 'locked' : ''}">${esc(s.labels.wakeEnd)}</span></div>
    </div>
    <p class="muted small">Routine: <strong>${esc(p.routine.label)}</strong> (${esc(p.routine.status)}). ${locked.size ? '🔒 = accepted for tonight; stays fixed unless you edit it.' : ''}</p>
    <div class="stack">
      <div class="row">
        <label for="day-cat"><strong>Tomorrow, ${fmtDate(day.date)}</strong></label>
        <select id="day-cat" class="day-select">
          <option value="">Let Drift infer${day.source !== 'user' ? ` (currently: ${esc(day.label)})` : ''}</option>
          ${cats.map((c) => `<option value="${c.key}" ${day.source === 'user' && day.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
        <span class="badge ${day.source === 'user' ? 'ok' : day.category === 'unknown' ? 'warn' : ''}">${day.source === 'user' ? 'your label' : day.source === 'inferred' ? 'inferred: please check' : 'unknown'}</span>
      </div>
      <p class="small muted" style="margin:0">${esc(day.reasons.join(' '))}</p>
      ${day.events.length ? `<ul class="event-list small">${day.events.map(evDesc).join('')}</ul>` : ''}
      ${choice}
      ${proposals}
    </div>`;

  $('#day-cat').addEventListener('change', (e) => setDayLabel(day.date, e.target.value || null));
  $$('[data-daylabel]', $('#tn-summary')).forEach((b) => b.addEventListener('click', () => setDayLabel(day.date, b.dataset.daylabel)));
  $$('[data-action]', $('#tn-summary')).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/users/${state.viewing}/proposals`, { id: b.dataset.proposal, action: b.dataset.action });
      toast(b.dataset.action === 'accept' ? 'Accepted for tonight. It stays locked unless you edit it.' : b.dataset.action === 'decline' ? 'Kept your usual timing.' : 'Decisions for tonight cleared.');
      refreshDashboard(true);
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

async function setDayLabel(date, category) {
  try {
    await api('PUT', `/api/users/${state.viewing}/day-label`, { date, category });
    toast(category ? 'Tomorrow labeled. Your label overrides automatic classification.' : 'Drift will infer tomorrow from your calendar.');
    refreshDashboard(true);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderWeather(p) {
  const w = p.weather;
  const tz = p.timezone;
  const src = state.dashboard.integrations.weather;
  const loc = w.location?.label || state.record?.profile?.location?.label || '';
  const cur = w.current
    ? `${CATEGORY_ICON[w.current.category] ?? ''} ${esc(w.current.label)} · cloud ${unknownOr(w.current.cloudCover, '%')} · wind ${unknownOr(w.current.windSpeed, ' km/h')}, gusts ${unknownOr(w.current.windGusts, ' km/h')}<div class="faint small">Model estimate for outdoors at ${fmt(w.current.time, tz)} (${esc(w.currentStatus)}), not a bedroom measurement.</div>`
    : '<span class="muted">No current conditions</span>';
  const windows = [...w.night.storm.map((x) => `⛈️ Thunderstorms possible ${x}`), ...w.night.rain.map((x) => `🌧️ Rain likely ${x}`), ...w.night.wind.map((x) => `💨 Strong wind ${x}`)];
  const strip = w.tonight?.length ? `
    <div class="forecast-strip" role="table" aria-label="Hourly forecast for tonight">
      ${w.tonight.map((h) => `<div class="fc-hour${h.strongWind ? ' windy' : ''}" role="row" title="${esc(h.label)}">
        <span class="fc-time">${esc(h.hourLabel.replace(':00', ''))}</span>
        <span class="fc-icon" aria-label="${esc(h.category)}">${CATEGORY_ICON[h.category] ?? '❔'}</span>
        <span>${unknownOr(h.precipProbability, '%')}</span>
        <span>${h.rain == null && h.showers == null ? '<span class="faint">unknown</span>' : `${((h.rain ?? 0) + (h.showers ?? 0)).toFixed(1)} mm`}</span>
        <span>${unknownOr(h.windGusts)}${h.strongWind ? ' 💨' : ''}</span>
      </div>`).join('')}
    </div>
    <div class="faint small">Per hour: chance of precipitation, rain + showers (mm), wind gusts (km/h). 💨 = strong wind (sustained ≥ ${w.thresholds?.strongWindSpeed ?? 40} or gusts ≥ ${w.thresholds?.strongWindGust ?? 60} km/h, an engineering threshold set on the server).</div>` : '';
  const scenarioOpts = src.scenarios.map((x) => `<option value="scenario:${x.id}" ${src.mode === 'scenario' && src.scenario === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  $('#tn-weather').innerHTML = `
    <div class="card-head"><h2>Weather & sun${loc ? ` · ${esc(loc)}` : ''}</h2><span>${w.simulated ? '<span class="badge sim">offline scenario</span> ' : ''}<span class="badge ${STATUS_CLASS[w.status] ?? ''}">${esc(w.status)}</span></span></div>
    <div class="row small" style="margin-bottom:10px">
      <label for="wx-source">Source</label>
      <select id="wx-source" class="small">
        <option value="live" ${src.mode === 'live' ? 'selected' : ''}>Live: Open-Meteo</option>
        <optgroup label="Offline scenarios (simulated)">${scenarioOpts}</optgroup>
      </select>
      <span class="faint">Refreshes every ${src.refreshMinutes} min; stale after ${Math.round(src.staleAfterMinutes / 60)} h.</span>
    </div>
    <dl class="state-grid">
      <dt>Now</dt><dd>${cur}</dd>
      <dt>Tonight</dt><dd>${!w.usable ? `<span class="muted">Not used tonight: weather is ${esc(w.status)}. Your normal routine applies.</span>` : windows.join('<br>') || 'No rain, storms or strong wind forecast for tonight'}</dd>
      <dt>Updated</dt><dd>${w.fetchedAt ? fmt(w.fetchedAt, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'}${w.validUntil ? ` · valid until ${fmt(w.validUntil, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</dd>
      ${p.sun.map((s) => `<dt>${fmtDate(s.date)}</dt><dd>${s.polar ? `polar ${s.polar}` : `🌅 ${s.sunriseLabel ?? '—'} · 🌇 ${s.sunsetLabel ?? '—'}`} <span class="faint">(${esc(s.source)})</span></dd>`).join('') || '<dt>Sun</dt><dd>Set a location to use sunrise/sunset</dd>'}
    </dl>
    ${strip}
    ${w.notes.length ? `<p class="small muted">${esc(w.notes.join(' '))}</p>` : ''}
    <p class="faint small">${w.attribution ? `<a href="${esc(w.attribution.url)}" target="_blank" rel="noopener">${esc(w.attribution.text)}</a> (<a href="${esc(w.attribution.licenseUrl)}" target="_blank" rel="noopener">${esc(w.attribution.license)}</a>). ` : ''}Forecasts give hourly chances for outdoors. They can’t tell how loud your bedroom will be or when a thunderclap will happen.</p>`;
  $('#wx-source').addEventListener('change', async (e) => {
    const v = e.target.value;
    const body = v === 'live' ? { mode: 'live' } : { mode: 'scenario', scenario: v.split(':')[1] };
    try {
      await api('POST', '/api/weather/source', body);
      toast(v === 'live' ? 'Using live Open-Meteo weather.' : 'Using an offline scenario. It is labeled simulated everywhere.');
      refreshDashboard(true);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderSound(p) {
  const a = p.audio;
  const tz = p.timezone;
  const row = (title, when, sel, extra = '') => `
    <div class="sound-row">
      <div><strong>${title}</strong><div class="faint small">${when}</div></div>
      <div><span class="swatch" style="background:${SOUND_COLORS[sel.soundId] ?? 'transparent'}"></span><strong>${esc(SOUND_NAMES[sel.soundId] ?? sel.soundId)}</strong>${sel.soundId !== 'silence' ? ` <span class="faint">· saved level ${Math.round(sel.volume)}%</span>` : ''} ${sel.locked ? '<span class="badge">kept steady</span>' : ''} ${extra}
        <div class="small muted">${esc(sel.reason)}</div></div>
    </div>`;
  const nightWhen = `${fmt(a.sleep.start, tz)}–${fmt(a.sleep.end, tz)}${a.overnight ? '' : ` (playback timer ${a.timerMinutes} min)`}`;
  $('#tn-sound').innerHTML = `
    <div class="card-head"><h2>Planned sound</h2><span class="badge accent">${esc(a.modeLabel)}</span></div>
    <div class="stack">
      ${row('Now', esc(PHASE_NAMES[p.currentPhase] ?? p.currentPhase), a.now, a.now.rule === 'override' ? '<span class="badge bad">override</span>' : a.now.rule === 'stop' ? '<span class="badge bad">stopped</span>' : '')}
      ${row('Wind-down', `${fmt(a.winddown.start, tz)}–${fmt(a.winddown.end, tz)}`, a.winddown)}
      ${row('Night', nightWhen, a.sleep)}
      ${a.switched.map((x) => row('Weather window', `${fmt(x.start, tz)}–${fmt(x.end, tz)}`, x, '<span class="badge">opt-in</span>')).join('')}
    </div>
    <div class="row" style="margin-top:12px">
      <button class="small" data-pv-plan="winddown">▶ Preview wind-down sound</button>
      <button class="small" data-pv-plan="sleep">▶ Preview night sound</button>
      <button class="small ghost" data-pv-plan="stop">■ Stop preview</button>
      <span class="faint small">10-second preview in this tab. Use the sound override below, or Stop at the top, to change what’s playing.</span>
    </div>
    <p class="faint small">${a.transitionsAllowed ? 'You allowed weather to change the sound overnight: switches use 20-minute crossfades.' : 'Overnight weather changes are off: the night’s sound is chosen at bedtime and stays steady.'} Choices follow your preferences; no sound is presented as best for any weather. Levels are output settings, not decibels.</p>`;
  $$('[data-pv-plan]', $('#tn-sound')).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.pvPlan === 'stop') return previewEngine.enabled && previewEngine.set({}, 0.5);
    const sel = a[b.dataset.pvPlan];
    if (!Object.keys(sel.channels).length) return toast('Nothing to preview: this part of the night is silent.');
    try {
      await previewEngine.enable();
      previewEngine.set(sel.channels, 1.5);
      setTimeout(() => previewEngine.set({}, 1.5), 10000);
    } catch (err) {
      toast(`Preview could not play: ${err.message}`, true);
    }
  }));
}

function renderSegments(p) {
  const rows = [];
  for (const output of ['light', 'audio', 'fan']) {
    const segs = p.outputs[output];
    if (!segs.length) continue;
    rows.push(`<tr><th colspan="5" style="padding-top:14px;color:var(--text)">${output === 'light' ? '💡 Lighting' : output === 'audio' ? '🔊 Sound' : '🌀 Fan'}</th></tr>`);
    for (const s of segs) {
      rows.push(`<tr class="${s.overridden ? 'overridden' : ''} ${s.weather ? 'weather' : ''}">
        <td><strong>${esc(PHASE_NAMES[s.phase] ?? s.phase)}</strong><div class="faint small">${esc(s.startLabel)}–${esc(s.endLabel)}</div></td>
        <td class="target">${swatch(output, s.target)}${esc(outputText(output, s.target))}</td>
        <td class="small">${s.transitionMinutes ? `${Math.round(s.transitionMinutes)} min fade` : 'hold'}</td>
        <td class="reason">${esc(s.reason)}<div class="inputs">${s.inputs.map((i) => `<span class="input-chip" data-kind="${esc(i.kind)}">${esc(i.text)}</span>`).join('')}</div></td>
        <td>${s.overridden ? `<span class="badge bad">overridden</span><div class="faint small">${s.override.expiresAt ? `until ${fmt(s.override.expiresAt, p.timezone)}` : 'until cleared'}</div>` : '<span class="faint small">—</span>'}</td>
      </tr>`);
    }
  }
  $('#tn-segments').innerHTML = `<div class="table-scroll"><table class="segments">
    <thead><tr><th>When</th><th>Target</th><th>Transition</th><th>Reason & inputs used</th><th>Override</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>
    <p class="faint small">Sound levels are digital output levels, not measured loudness. Brightness and color temperature are controlled separately.</p>`;
}

async function loadTimeline() {
  try {
    const { frames } = await api('GET', `/api/users/${state.viewing}/preview`);
    state.frames = frames;
    const p = state.dashboard.plan;
    const el = $('#tn-timeline');
    el.innerHTML = `${timelineSvg(p, frames, 'tl-main')}${legend()}${playerHtml('main')}`;
    bindPlayer('main', p, frames, el);
  } catch (err) {
    $('#tn-timeline').textContent = `Timeline unavailable: ${err.message}`;
  }
}

function legend() {
  return `<div class="legend"><span><i style="background:linear-gradient(90deg,#ffb46b,#fff3e0)"></i>Light (color = warmth, opacity = brightness)</span>
    ${PLAYABLE.map((k) => `<span><i style="background:${SOUND_COLORS[k]}"></i>${SOUND_NAMES[k]}</span>`).join('')}
    <span><i style="background:#3d5f8f"></i>Rain window</span><span><i style="background:#7a4fb8"></i>Storm window</span><span><i style="background:#ef7f7f"></i>Manual override</span></div>`;
}

function timelineSvg(p, frames, id) {
  if (!frames?.length) return '';
  const W = 1000;
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const step = frames.length > 1 ? x(frames[1].t) - x(frames[0].t) : W;
  const tz = p.timezone;
  const cap = Math.max(1, ...frames.map((f) => Object.values(f.audio?.channels ?? {}).reduce((a, b) => a + b, 0)), 10);
  const parts = [];
  // phases
  p.phases.forEach((ph, i) => {
    const a = Math.max(0, x(ph.start));
    const b = Math.min(W, x(ph.end));
    if (b <= a) return;
    parts.push(`<rect x="${a}" y="0" width="${b - a}" height="20" fill="${i % 2 ? '#1b2139' : '#20284a'}"/>`);
    if (b - a > 60) parts.push(`<text x="${(a + b) / 2}" y="14" text-anchor="middle" font-size="11" fill="#9aa1bd">${esc(PHASE_NAMES[ph.key])}</text>`);
  });
  // light row
  parts.push('<rect x="0" y="26" width="1000" height="40" fill="#090c18"/>');
  for (const f of frames) {
    if (!f.light || f.light.brightness <= 0.5) continue;
    const [r, g, b] = kelvinRgb(f.light.colorTempK ?? 2700);
    parts.push(`<rect x="${x(f.t)}" y="26" width="${step + 0.5}" height="40" fill="rgb(${r},${g},${b})" opacity="${(0.1 + 0.9 * f.light.brightness / 100).toFixed(2)}"/>`);
    if (f.lightSource === 'override' || f.lightSource === 'resuming') parts.push(`<rect x="${x(f.t)}" y="22" width="${step + 0.5}" height="3" fill="#ef7f7f" opacity="${f.lightSource === 'resuming' ? 0.5 : 1}"/>`);
  }
  parts.push('<text x="4" y="40" font-size="10" fill="#6c7393">LIGHT</text>');
  // audio row (stacked)
  const ay = 72;
  const ah = 56;
  parts.push(`<rect x="0" y="${ay}" width="1000" height="${ah}" fill="#0f1326"/>`);
  for (const f of frames) {
    let base = ay + ah;
    for (const k of PLAYABLE) {
      const v = f.audio?.channels?.[k];
      if (!v) continue;
      const h = (v / cap) * (ah - 4);
      base -= h;
      parts.push(`<rect x="${x(f.t)}" y="${base}" width="${step + 0.5}" height="${h}" fill="${SOUND_COLORS[k]}" opacity=".85"/>`);
    }
  }
  parts.push(`<text x="4" y="${ay + 12}" font-size="10" fill="#6c7393">SOUND (output level)</text>`);
  // weather windows
  const wy = ay + ah + 6;
  for (const w of p.weather.windows ?? []) {
    const a = Math.max(0, x(w.start));
    const b = Math.min(W, x(w.end));
    if (b <= a) continue;
    const isStorm = w.kind === 'storm';
    parts.push(`<rect x="${a}" y="${wy + (isStorm ? 8 : 0)}" width="${b - a}" height="7" rx="2" fill="${isStorm ? '#7a4fb8' : '#3d5f8f'}"><title>${isStorm ? 'Storm' : 'Rain'} ${esc(w.label)}</title></rect>`);
  }
  // sun markers
  for (const s of p.sun ?? []) {
    for (const [t, label] of [[s.sunrise, 'sunrise'], [s.sunset, 'sunset']]) {
      if (t == null || t < t0 || t > t1) continue;
      parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="22" y2="${wy + 16}" stroke="#f2c98a" stroke-dasharray="3 3" opacity=".7"/><text x="${x(t) + 3}" y="${wy + 26}" font-size="10" fill="#f2c98a">${label} ${fmt(t, tz)}</text>`);
    }
  }
  // axis
  const ty = wy + 40;
  const firstHour = Math.ceil(t0 / 3600000) * 3600000;
  for (let t = firstHour; t <= t1; t += 3600000) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${ty - 6}" y2="${ty - 2}" stroke="#3d4670"/><text x="${x(t)}" y="${ty + 8}" font-size="10" text-anchor="middle" fill="#6c7393">${fmt(t, tz, { hour: 'numeric' })}</text>`);
  }
  if (p.now >= t0 && p.now <= t1) parts.push(`<line x1="${x(p.now)}" x2="${x(p.now)}" y1="0" y2="${ty - 2}" stroke="#7fd1a8" stroke-width="2"/><text x="${x(p.now) + 4}" y="${ty - 8}" font-size="10" fill="#7fd1a8">now</text>`);
  parts.push(`<line id="${id}-cursor" x1="-10" x2="-10" y1="0" y2="${ty - 2}" stroke="#fff" stroke-width="1.5" opacity=".9"/>`);
  return `<svg id="${id}" viewBox="0 0 ${W} ${ty + 14}" role="img" aria-label="Timeline of planned light and sound">${parts.join('')}</svg>`;
}

function playerHtml(key) {
  return `<div class="player" style="margin-top:12px">
    <div class="lamp" id="pv-lamp-${key}"><span class="lamp-label">preview</span></div>
    <div class="stack" style="flex:1;min-width:220px">
      <div class="row"><button class="small" id="pv-play-${key}">▶ Play accelerated night preview</button><span class="badge sim">simulated preview</span></div>
      <div class="player-readout" id="pv-read-${key}">A whole night in about 20 seconds.</div>
      <div class="faint small">Preview only: it uses a virtual lamp and never touches real devices or their safety timers.</div>
    </div></div>`;
}

function bindPlayer(key, p, frames, root) {
  let timer = null;
  const btn = $(`#pv-play-${key}`, root);
  const lamp = $(`#pv-lamp-${key}`, root);
  const read = $(`#pv-read-${key}`, root);
  const svg = root.querySelector('svg');
  const cursor = svg?.querySelector('line[id$="-cursor"]');
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const stop = () => {
    clearInterval(timer);
    timer = null;
    btn.textContent = '▶ Play accelerated night preview';
  };
  btn.addEventListener('click', () => {
    if (timer) return stop();
    let i = 0;
    btn.textContent = '❚❚ Pause';
    timer = setInterval(() => {
      const f = frames[i];
      paintLamp(lamp, f.light);
      const pos = ((f.t - t0) / (t1 - t0)) * 1000;
      cursor?.setAttribute('x1', pos);
      cursor?.setAttribute('x2', pos);
      read.textContent = `${fmt(f.t, p.timezone)} · ${PHASE_NAMES[f.phase] ?? ''} · light ${lightText(f.light)}${f.lightSource !== 'plan' ? ` (${f.lightSource})` : ''} · ${audioText(f.audio)}${f.fan ? ` · fan ${fanText(f.fan)}` : ''}`;
      i += 1;
      if (i >= frames.length) stop();
    }, Math.max(60, Math.round(20000 / frames.length)));
  });
}

// ---------- live outputs ----------

const DURATIONS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], ['', 'Until I clear it']];

function renderLive(d) {
  const ex = d.executor;
  const root = $('#tn-live');
  if (!ex) {
    root.innerHTML = '<div class="card muted">Live outputs show here for the profile that drives the device.</div>';
    root.dataset.built = '';
    return;
  }
  if (!root.dataset.built) {
    root.dataset.built = '1';
    const durSel = (id) => `<select id="${id}">${DURATIONS.map(([v, l]) => `<option value="${v}" ${v === 30 ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    root.innerHTML = `
      <div class="card"><div class="card-head"><h3>💡 Light</h3><span id="lv-light-badge"></span></div>
        <div class="device"><div class="lamp" id="lv-lamp"><span class="lamp-label" id="lv-lamp-label"></span></div><dl class="state-grid" id="lv-light"></dl></div>
        <div class="override-box stack">
          <label>Brightness <output id="ov-b-out">50%</output></label><input type="range" id="ov-b" min="0" max="100" value="50">
          <div id="ov-k-wrap"><label>Warmth <output id="ov-k-out">2700K</output></label><input type="range" id="ov-k" min="1800" max="6500" step="100" value="2700"></div>
          <div class="row"><label>For</label>${durSel('ov-l-dur')}<button class="small primary" id="ov-l-apply">Override light</button><button class="small" id="ov-l-clear">Clear</button></div>
        </div></div>
      <div class="card"><div class="card-head"><h3>🔊 Sound</h3><span id="lv-audio-badge"></span></div>
        <div id="lv-enable"></div>
        <dl class="state-grid" id="lv-audio"></dl>
        <div class="bars" id="lv-bars" style="margin-top:8px"></div>
        <div class="override-box stack">
          <div class="row"><select id="ov-s">${PLAYABLE.map((k) => `<option value="${k}">${SOUND_NAMES[k]}</option>`).join('')}<option value="off">Off</option></select>
          <label>Level <output id="ov-v-out">20%</output></label></div>
          <input type="range" id="ov-v" min="0" max="100" value="20">
          <div class="row"><label>For</label>${durSel('ov-a-dur')}<button class="small primary" id="ov-a-apply">Override sound</button><button class="small" id="ov-a-clear">Clear</button></div>
          <div class="level-note">Levels are digital output settings, not measured loudness. Never above your cap.</div>
        </div></div>
      <div class="card"><div class="card-head"><h3>🌀 Fan</h3><span id="lv-fan-badge"></span></div>
        <dl class="state-grid" id="lv-fan"></dl>
        <div class="override-box stack" id="ov-fan-box">
          <div class="row"><select id="ov-f"><option value="0">Off</option><option value="1">Level 1</option><option value="2">Level 2</option><option value="3">Level 3</option></select>
          ${durSel('ov-f-dur')}<button class="small primary" id="ov-f-apply">Override fan</button><button class="small" id="ov-f-clear">Clear</button></div>
        </div>
        <p class="faint small">Command log (latest first)</p><div class="mono small faint" id="lv-log" style="max-height:140px;overflow:auto"></div></div>`;
    $('#ov-b').addEventListener('input', (e) => { $('#ov-b-out').textContent = `${e.target.value}%`; });
    $('#ov-k').addEventListener('input', (e) => { $('#ov-k-out').textContent = `${e.target.value}K`; });
    $('#ov-v').addEventListener('input', (e) => { $('#ov-v-out').textContent = `${e.target.value}%`; });
    const minutes = (id) => ($(id).value === '' ? null : Number($(id).value));
    const override = async (output, target, dur) => {
      try {
        await api('POST', '/api/control/override', { output, target, minutes: dur });
        toast(`Manual ${output} override applied. It takes priority over the plan${dur ? ` for ${dur} min` : ' until you clear it'}.`);
        refreshDashboard(true);
      } catch (err) {
        toast(err.message, true);
      }
    };
    const clear = async (output) => {
      await api('DELETE', `/api/control/override/${output}`);
      toast(`${output} override cleared; gliding back to the plan.`);
      refreshDashboard(true);
    };
    $('#ov-l-apply').addEventListener('click', () => {
      const t = { brightness: Number($('#ov-b').value) };
      if (!$('#ov-k-wrap').hidden) t.colorTempK = Number($('#ov-k').value);
      override('light', t, minutes('#ov-l-dur'));
    });
    $('#ov-a-apply').addEventListener('click', () => {
      const s = $('#ov-s').value;
      override('audio', { channels: s === 'off' ? {} : { [s]: Number($('#ov-v').value) } }, minutes('#ov-a-dur'));
    });
    $('#ov-f-apply').addEventListener('click', () => override('fan', { level: Number($('#ov-f').value) }, minutes('#ov-f-dur')));
    $('#ov-l-clear').addEventListener('click', () => clear('light'));
    $('#ov-a-clear').addEventListener('click', () => clear('audio'));
    $('#ov-f-clear').addEventListener('click', () => clear('fan'));
  }

  const tz = d.plan.timezone;
  const devBadge = (o) => (o.device ? (o.device.simulated ? '<span class="badge sim">simulated</span>' : '<span class="badge ok">real device</span>') : '<span class="badge">not configured</span>');
  const stateRows = (output, o) => `
    <dt>Device</dt><dd>${esc(o.device?.label ?? 'none')}</dd>
    <dt>Status</dt><dd><span class="status ${esc(o.status)}">${esc(o.status.replace('_', ' '))}</span>${o.detail ? `<div class="faint">${esc(o.detail)}</div>` : ''}</dd>
    <dt>Driven by</dt><dd>${esc(o.source ?? '—')}${o.override ? ` <span class="badge bad">override${o.override.expiresAt ? ` → ${fmt(o.override.expiresAt, tz)}` : ''}</span>` : ''}</dd>
    <dt>Desired</dt><dd>${esc(outputText(output, o.desired))}</dd>
    <dt>Sent</dt><dd>${esc(outputText(output, o.sent))}</dd>
    <dt>Confirmed</dt><dd>${esc(outputText(output, o.confirmed))}${o.confirmedAt ? ` <span class="faint">@ ${fmt(o.confirmedAt, tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>` : ''}</dd>`;

  const L = ex.outputs.light;
  $('#lv-light-badge').innerHTML = devBadge(L);
  $('#lv-light').innerHTML = stateRows('light', L);
  paintLamp($('#lv-lamp'), L.confirmed ?? L.sent);
  $('#lv-lamp-label').textContent = L.device?.simulated ? 'SIMULATED' : '';
  $('#ov-k-wrap').hidden = !L.device?.capabilities?.colorTemp;

  const A = ex.outputs.audio;
  const cap = state.record?.profile?.sound?.maxVolume ?? 100;
  $('#ov-v').max = cap;
  $('#lv-audio-badge').innerHTML = devBadge(A);
  $('#lv-audio').innerHTML = stateRows('audio', A);
  const isBrowser = A.device?.id === 'browser-audio';
  const enableHtml = isBrowser && !engine.enabled
    ? '<div class="proposal" style="margin-bottom:10px"><p>Browsers only play sound after you click. This tab is the speaker.</p><button class="primary small" id="btn-enable-sound">Enable Sound</button></div>'
    : isBrowser ? '<p class="small muted" style="margin-top:0">🔈 This tab is playing the bedroom sound. <button class="link small" id="btn-mute-tab">Disable</button></p>' : '';
  if ($('#lv-enable').dataset.html !== enableHtml) {
    $('#lv-enable').innerHTML = enableHtml;
    $('#lv-enable').dataset.html = enableHtml;
    $('#btn-enable-sound')?.addEventListener('click', async () => {
      try {
        await engine.enable();
        await audioSync();
        toast('Sound enabled. Levels change gradually.');
        refreshDashboard(true);
      } catch (err) {
        toast(`Sound could not start: ${err.message}`, true);
      }
    });
    $('#btn-mute-tab')?.addEventListener('click', async () => {
      engine.stopAll();
      await engine.ctx.suspend();
      lastSeq = null;
      refreshDashboard(true);
    });
  }
  const shown = A.confirmed ?? { channels: {} };
  $('#lv-bars').innerHTML = PLAYABLE.filter((k) => (shown.channels[k] ?? 0) > 0 || (A.desired?.channels?.[k] ?? 0) > 0).map((k) => `
    <div class="bar"><span>${SOUND_NAMES[k]}</span><div class="track"><div class="fill" style="width:${shown.channels[k] ?? 0}%;background:${SOUND_COLORS[k]}"></div><div class="cap" style="left:${cap}%" title="Your cap"></div></div><span class="mono">${Math.round(shown.channels[k] ?? 0)}%</span></div>`).join('')
    || '<span class="faint small">Silent (confirmed)</span>';

  const F = ex.outputs.fan;
  $('#lv-fan-badge').innerHTML = devBadge(F);
  $('#lv-fan').innerHTML = F.device ? stateRows('fan', F) : '<dt>Status</dt><dd>No fan configured. Set FAN_ADAPTER=simulated or http on the server.</dd>';
  $('#ov-fan-box').hidden = !F.device;
  $('#lv-log').innerHTML = ex.log.map((l) => `${fmt(l.at, tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' })} ${l.output} ← ${esc(outputText(l.output, l.cmd))} <span class="faint">[${l.source}${l.simulated ? ', sim' : ''}]</span>`).join('<br>') || '—';
}

// ---------- feedback ----------

function renderFeedback(d) {
  const p = d.plan;
  const night = addDays(p.schedule.eveningDate, -1);
  const fbRoot = $('#tn-feedback');
  if (fbRoot.dataset.night !== night) {
    fbRoot.dataset.night = night;
    const q = (name, label, opts) => `<div class="field"><span class="label">${label}</span><div class="row">${opts.map(([v, l]) => `<label class="small"><input type="radio" name="fb-${name}" value="${v}"> ${l}</label>`).join('')}</div></div>`;
    fbRoot.innerHTML = `<h3>How was the night of ${fmtDate(night)}?</h3>
      <div class="stack">
        ${q('light', 'Lighting', [['too_bright', 'Too bright'], ['too_dim', 'Too dim'], ['comfortable', 'Comfortable']])}
        ${q('sound', 'Sound level', [['too_loud', 'Too loud'], ['too_quiet', 'Too quiet'], ['comfortable', 'Comfortable']])}
        ${q('soundHelpful', 'Was the sound helpful?', [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']])}
        ${q('keepRoutine', 'Keep this routine next time?', [['yes', 'Yes'], ['no', 'No']])}
        <div class="row"><button class="primary small" id="fb-send">Send feedback</button><span class="faint small">Optional. Drift only suggests changes; it never applies them on its own.</span></div>
      </div>`;
    $('#fb-send').addEventListener('click', async () => {
      const body = { night, routine: p.routine.key };
      for (const k of ['light', 'sound', 'soundHelpful', 'keepRoutine']) body[k] = $(`input[name=fb-${k}]:checked`)?.value ?? null;
      try {
        await api('POST', `/api/users/${state.viewing}/feedback`, body);
        toast('Thanks. See suggestions on the right.');
        refreshDashboard(true);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
  const s = d.suggestions;
  const html = `<h3>Suggested preference updates</h3>${s.length ? `<div class="stack">${s.map((x) => `
      <div class="proposal"><p>${esc(x.text)}<br><span class="faint small">Based on ${esc(x.basis)}</span></p>${x.patch ? `<button class="small primary" data-suggest="${x.id}">Apply</button>` : ''}</div>`).join('')}</div>`
    : '<p class="muted small">No suggestions. After you answer the check-in, ideas appear here. Nothing changes until you press Apply.</p>'}`;
  const root = $('#tn-suggestions');
  if (root.dataset.html !== html) {
    root.innerHTML = html;
    root.dataset.html = html;
    $$('[data-suggest]', root).forEach((b) => b.addEventListener('click', async () => {
      try {
        await api('POST', `/api/users/${state.viewing}/suggestions/apply`, { id: b.dataset.suggest });
        await loadRecord();
        toast('Preference updated.');
        refreshDashboard(true);
      } catch (err) {
        toast(err.message, true);
      }
    }));
  }
}

// ---------- preferences / onboarding ----------

const noiseOpts = NOISES.map((k) => [k, SOUND_NAMES[k]]);
const PREF_FORM = [
  { title: 'Sleep schedule', fields: [
    { path: 'schedule.bedtime', label: 'Usual bedtime', type: 'time' },
    { path: 'schedule.wakeTime', label: 'Usual wake time', type: 'time', hint: 'Used for the wake light only. Drift never changes your phone alarm.' },
    { path: 'schedule.windDownMinutes', label: 'Wind-down length', type: 'range', min: 10, max: 120, step: 5, unit: ' min' },
  ] },
  { title: 'Lighting', preview: 'light', fields: [
    { path: 'lighting.maxBrightness', label: 'Brightness limit', type: 'range', min: 5, max: 100, step: 5, unit: '%', hint: 'Automatic changes never go above this.' },
    { path: 'lighting.eveningWarmthK', label: 'Evening warmth', type: 'range', min: 1800, max: 4000, step: 100, unit: 'K', hint: 'Lower is warmer and more amber.' },
    { path: 'lighting.dayColorTempK', label: 'Daytime color', type: 'range', min: 3000, max: 6500, step: 100, unit: 'K' },
    { path: 'lighting.mirrorDaylight', label: 'Mirror outdoor daylight while I’m awake', type: 'check', hint: 'Brighter when clear, softer when cloudy, warmer toward sunset. Never while you sleep, and never before your wake window.' },
    { path: 'lighting.cloudyResponse', label: 'On cloudy days', type: 'select', options: [['softer', 'Softer (a little dimmer and warmer)'], ['dimmer', 'Dimmer'], ['unchanged', 'No change']] },
    { path: 'lighting.wakeLight', label: 'Brighten gradually before my wake time', type: 'check' },
    { path: 'lighting.wakeRampMinutes', label: 'Wake light ramp', type: 'range', min: 5, max: 60, step: 5, unit: ' min' },
    { path: 'lighting.nightLightBrightness', label: 'Night light while asleep', type: 'range', min: 0, max: 10, step: 1, unit: '%', hint: '0 = fully off.' },
  ] },
  { title: 'Sound', preview: 'sound', fields: [
    { path: 'sound.preferred', label: 'Preferred sound', type: 'select', options: [...noiseOpts, ['silence', 'Silence']] },
    { path: 'sound.maxVolume', label: 'Maximum comfortable level (hard cap)', type: 'range', min: 0, max: 100, step: 5, unit: '%' },
    { path: 'sound.volume', label: 'Saved playback level', type: 'range', min: 0, max: 100, step: 1, unit: '%', hint: 'A digital output setting, not measured loudness. Always at or below your cap; weather never raises it.' },
    { path: 'sound.overnight', label: 'Keep sound on all night', type: 'check', hint: 'Off: your playback timer fades it out after bedtime.' },
    { path: 'sound.timerMinutes', label: 'Playback timer (when not all night)', type: 'range', min: 5, max: 240, step: 5, unit: ' min' },
    { path: 'sound.windDownTrack', label: 'Wind-down music', type: 'select', options: [['none', 'None: use my usual sound'], ['pads', 'Warm pads (generated in your browser)'], ['chimes', 'Soft chimes (generated in your browser)']], hint: 'Plays during wind-down only. Weather never changes it.' },
    { path: 'sound.rainFeeling', label: 'Rain sounds are…', type: 'select', options: [['calming', 'Enjoyable'], ['neutral', 'Neither'], ['distracting', 'Disruptive']] },
    { path: 'sound.stormsBother', label: 'Storms are disruptive for me', type: 'check' },
    { path: 'sound.windBothers', label: 'Strong wind is disruptive for me', type: 'check' },
    { path: 'sound.weatherMode', label: 'When the weather changes', type: 'radio', wide: true, options: [
      ['mirror', 'Mirror weather', 'If rain is forecast and you enjoy rain sounds, play gentle rain ambience. Never adds thunder.'],
      ['mask', 'Mask distracting weather', 'During weather you mark as disruptive (storms, rain, wind), play your saved masking sound at your saved level.'],
      ['normal', 'Keep my normal routine', 'Your usual sound plays; weather never changes it.'],
      ['silence', 'Silence', 'Drift never starts sound automatically, whatever the weather.'],
    ] },
    { path: 'sound.stormSound', label: 'Masking sound', type: 'select', options: noiseOpts },
    { path: 'sound.weatherTransitions', label: 'Allow weather to change the sound during the night', type: 'check', hint: 'Off (default): the night’s sound is chosen at bedtime and stays steady. On: it switches only inside forecast windows, with 20-minute crossfades.' },
  ] },
  { title: 'Important days and relaxed days', fields: [
    { path: 'routines.important.windDownMinutes', label: 'Exam / important day: wind-down length', type: 'range', min: 10, max: 120, step: 5, unit: ' min', hint: 'Offered the night before. You accept it each time.' },
    { path: 'routines.early.bedtimeShiftMinutes', label: 'Early start: go to bed earlier by', type: 'range', min: 0, max: 120, step: 5, unit: ' min' },
    { path: 'routines.early.earlyThresholdMinutes', label: 'Count as “early” when the first event is within', type: 'range', min: 15, max: 240, step: 15, unit: ' min of waking', hint: 'Prep and travel time are only used if you enter them.' },
    { path: 'routines.relaxed.windDownMinutes', label: 'Relaxed day: wind-down length', type: 'range', min: 10, max: 120, step: 5, unit: ' min' },
    { path: 'routines.relaxed.wakeRampMinutes', label: 'Relaxed day: gentler wake ramp', type: 'range', min: 5, max: 60, step: 5, unit: ' min' },
    { path: 'routines.relaxed.allowWakeChange', label: 'A relaxed day may change my wake routine', type: 'check', hint: 'You will still be asked to approve it each time.' },
    { path: 'routines.relaxed.relaxedWakeTime', label: 'Relaxed-day wake time', type: 'time' },
  ] },
  { title: 'Fan (optional)', fields: [
    { path: 'fan.enabled', label: 'I have a fan connected', type: 'check' },
    { path: 'fan.overnightLevel', label: 'Overnight fan level', type: 'range', min: 0, max: 3, step: 1, unit: '' },
  ] },
];

function fieldHtml(f, profile) {
  const v = getPath(profile, f.path);
  const id = `pf-${f.path.replace(/\./g, '-')}`;
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  if (f.type === 'check') return `<div class="field check"><input type="checkbox" id="${id}" data-path="${f.path}" data-type="check" ${v ? 'checked' : ''}><div><label for="${id}">${esc(f.label)}</label><br>${hint}</div></div>`;
  if (f.type === 'range') return `<div class="field"><label for="${id}">${esc(f.label)}</label><div class="range-row"><input type="range" id="${id}" data-path="${f.path}" data-type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}"><output>${v}${esc(f.unit)}</output></div>${hint}</div>`;
  if (f.type === 'select') return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-path="${f.path}" data-type="text">${f.options.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint}</div>`;
  if (f.type === 'radio') return `<div class="field" style="grid-column:1/-1"><span class="label">${esc(f.label)}</span><div class="radio-cards">${f.options.map(([k, l, d]) => `<label class="radio-card"><input type="radio" name="${id}" data-path="${f.path}" data-type="radio" value="${k}" ${k === v ? 'checked' : ''}><div><strong>${esc(l)}</strong><span>${esc(d)}</span></div></label>`).join('')}</div></div>`;
  return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="${f.type}" id="${id}" data-path="${f.path}" data-type="text" value="${esc(v)}">${hint}</div>`;
}

function readForm(root, base) {
  const profile = structuredClone(base);
  for (const el of $$('[data-path]', root)) {
    const t = el.dataset.type;
    if (t === 'radio' && !el.checked) continue;
    const value = t === 'check' ? el.checked : t === 'number' ? Number(el.value) : el.value;
    setPath(profile, el.dataset.path, value);
  }
  const lat = $('#pf-lat', root).value.trim();
  const lon = $('#pf-lon', root).value.trim();
  profile.location = { label: $('#pf-loc-label', root).value.trim(), lat: lat === '' ? null : Number(lat), lon: lon === '' ? null : Number(lon) };
  profile.name = $('#pf-name', root).value.trim();
  profile.timezone = $('#pf-tz', root).value;
  return profile;
}

function previewScenes(p) {
  const m = p.lighting.maxBrightness;
  return {
    Daytime: { brightness: m, colorTempK: p.lighting.dayColorTempK },
    Cloudy: p.lighting.cloudyResponse === 'unchanged' ? { brightness: m, colorTempK: p.lighting.dayColorTempK }
      : p.lighting.cloudyResponse === 'softer' ? { brightness: Math.round(m * 0.7), colorTempK: p.lighting.dayColorTempK - 500 } : { brightness: Math.round(m * 0.55), colorTempK: p.lighting.dayColorTempK },
    Evening: { brightness: Math.round(m * 0.6), colorTempK: p.lighting.eveningWarmthK },
    'Wind-down': { brightness: Math.max(3, Math.round(m * 0.25)), colorTempK: p.lighting.eveningWarmthK },
    'Night light': { brightness: p.lighting.nightLightBrightness, colorTempK: 2200 },
    'Wake peak': { brightness: Math.round(m * 0.8), colorTempK: Math.min(4000, p.lighting.dayColorTempK) },
  };
}

function renderPrefs(profile) {
  const root = $('#tab-prefs');
  const isNew = !profile;
  const base = profile ?? { ...state.status.defaults, name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [base.timezone];
  if (!zones.includes(base.timezone)) zones.unshift(base.timezone);
  root.innerHTML = `
    <div class="card-head"><h2>${isNew ? 'Set up your sleep space' : `Preferences for ${esc(base.name)}`}</h2>${!isNew && state.record?.sample ? '<span class="badge sim">sample profile</span>' : ''}</div>
    <p class="muted">Everything here is your choice. Drift doesn’t assume you like rain, brighter mornings, or any particular noise. Preview sounds and light before saving.</p>
    <div id="pf-errors"></div>
    <div class="card form-section"><h3>About you</h3>
      <div class="fields">
        <div class="field"><label for="pf-name">Name</label><input type="text" id="pf-name" value="${esc(base.name)}" maxlength="60" placeholder="e.g. Alex"></div>
        <div class="field"><label for="pf-tz">Timezone</label><select id="pf-tz">${zones.map((z) => `<option ${z === base.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select><span class="hint">“Tomorrow” and all times use this timezone.</span></div>
        <div class="field" style="grid-column:1/-1"><label for="pf-city">City (for weather and sunrise/sunset)</label>
          <div class="row"><input type="text" id="pf-city" placeholder="Search a city" style="flex:1"><button class="small" id="pf-city-go">Search</button><button class="small ghost" id="pf-geo" title="Uses your browser location, rounded to about 1 km">Use precise location</button></div>
          <ul class="search-results" id="pf-city-results" hidden></ul>
          <span class="hint">City-level is enough. Precise location is optional and rounded. Current: <strong id="pf-loc-show">${esc(base.location.label || (base.location.lat != null ? `${base.location.lat}, ${base.location.lon}` : 'not set'))}</strong></span>
          <details><summary class="small">Enter coordinates manually</summary>
            <div class="row" style="margin-top:6px"><input type="text" id="pf-loc-label" placeholder="Label" value="${esc(base.location.label)}"><input type="number" step="0.001" id="pf-lat" placeholder="Latitude" value="${base.location.lat ?? ''}"><input type="number" step="0.001" id="pf-lon" placeholder="Longitude" value="${base.location.lon ?? ''}"></div>
          </details>
        </div>
      </div></div>
    ${PREF_FORM.map((sec) => `<div class="card form-section"><h3>${esc(sec.title)}</h3>
      ${sec.preview === 'light' ? `<div class="preview-panel" style="margin-bottom:14px"><div class="lamp" id="pf-lamp"><span class="lamp-label">preview</span></div><div class="stack"><div class="row" id="pf-scenes"></div><button class="small" id="pf-play-winddown">▶ Play wind-down (8 s)</button><span class="faint small">On-screen preview only.</span></div></div>` : ''}
      ${sec.preview === 'sound' ? `<div class="row" style="margin-bottom:14px"><button class="small" data-preview="usual">▶ Preview my usual sound</button><button class="small" data-preview="mask">▶ Preview masking sound</button><button class="small" data-preview="rain">▶ Preview rain ambience</button><button class="small" data-preview="music">▶ Preview wind-down music</button><button class="small ghost" data-preview="stop">■ Stop</button><span class="faint small">Plays 10 s at your saved level (capped). These are your choices; no sound is best for every weather or every person.</span></div>` : ''}
      <div class="fields">${sec.fields.map((f) => fieldHtml(f, base)).join('')}</div></div>`).join('')}
    <div class="sticky-save"><button class="primary" id="pf-save">${isNew ? 'Create profile' : 'Save preferences'}</button>${!isNew && !state.record?.sample ? '' : ''}${!isNew ? '<button class="ghost" id="pf-delete">Delete profile</button>' : ''}<span class="faint small" id="pf-dirty"></span></div>`;

  // live range outputs and cap coupling
  for (const r of $$('input[type=range]', root)) {
    const f = PREF_FORM.flatMap((s) => s.fields).find((x) => x.path === r.dataset.path);
    r.addEventListener('input', () => { r.nextElementSibling.textContent = `${r.value}${f?.unit ?? ''}`; });
  }
  const capEl = $('#pf-sound-maxVolume');
  const volEl = $('#pf-sound-volume');
  const syncCap = () => {
    if (Number(volEl.value) > Number(capEl.value)) {
      volEl.value = capEl.value;
      volEl.nextElementSibling.textContent = `${volEl.value}%`;
    }
  };
  capEl.addEventListener('input', syncCap);
  volEl.addEventListener('input', syncCap);

  // light preview
  const lamp = $('#pf-lamp');
  const drawScenes = () => {
    const scenes = previewScenes(readForm(root, base));
    $('#pf-scenes').innerHTML = Object.keys(scenes).map((k) => `<button class="small" data-scene="${k}">${k}</button>`).join('');
    $$('[data-scene]', root).forEach((b) => b.addEventListener('click', () => paintLamp(lamp, scenes[b.dataset.scene])));
  };
  drawScenes();
  paintLamp(lamp, previewScenes(base).Evening);
  root.addEventListener('change', drawScenes);
  $('#pf-play-winddown').addEventListener('click', () => {
    const s = previewScenes(readForm(root, base));
    const from = s.Evening;
    const to = s['Wind-down'];
    let i = 0;
    const timer = setInterval(() => {
      const f = i / 80;
      paintLamp(lamp, { brightness: from.brightness + (to.brightness - from.brightness) * f, colorTempK: from.colorTempK + (to.colorTempK - from.colorTempK) * f });
      if (++i > 80) clearInterval(timer);
    }, 100);
  });

  // sound preview
  let previewTimer;
  $$('[data-preview]', root).forEach((b) => b.addEventListener('click', async () => {
    const p = readForm(root, base);
    clearTimeout(previewTimer);
    if (b.dataset.preview === 'stop') return previewEngine.enabled && previewEngine.set({}, 0.5);
    try {
      await previewEngine.enable();
    } catch (err) {
      return toast(err.message, true);
    }
    const vol = Math.min(p.sound.volume, p.sound.maxVolume);
    let channels = {};
    if (b.dataset.preview === 'usual') {
      if (p.sound.preferred === 'silence') return toast('Your preferred sound is silence, so there is nothing to play.');
      channels = { [p.sound.preferred]: vol };
    } else if (b.dataset.preview === 'mask') channels = { [p.sound.stormSound]: vol };
    else if (b.dataset.preview === 'rain') channels = { rain: vol };
    else {
      if (p.sound.windDownTrack === 'none') return toast('No wind-down music is selected.');
      channels = { [p.sound.windDownTrack]: vol };
    }
    if (!vol) toast('Your usual level is 0%. Raise it to hear a preview.');
    previewEngine.set(channels, 1.5);
    previewTimer = setTimeout(() => previewEngine.set({}, 1.5), 10000);
  }));

  // location
  const setLoc = (label, lat, lon, tz) => {
    $('#pf-loc-label').value = label;
    $('#pf-lat').value = lat;
    $('#pf-lon').value = lon;
    $('#pf-loc-show').textContent = label || `${lat}, ${lon}`;
    if (tz && [...$('#pf-tz').options].some((o) => o.value === tz)) $('#pf-tz').value = tz;
  };
  let searchSeq = 0;
  const search = async () => {
    const q = $('#pf-city').value.trim();
    const ul = $('#pf-city-results');
    const mine = ++searchSeq;
    try {
      const { results } = await api('GET', `/api/geocode?q=${encodeURIComponent(q)}`);
      if (mine !== searchSeq) return; // a newer search started; ignore this late response
      ul.hidden = false;
      ul.innerHTML = results.length ? results.map((r, i) => `<li><button data-i="${i}">${esc(r.label)} <span class="faint small">${esc(r.timezone)}</span></button></li>`).join('') : '<li class="small muted" style="padding:8px">No matches</li>';
      $$('button[data-i]', ul).forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault();
        const r = results[Number(b.dataset.i)];
        setLoc(r.label, r.lat, r.lon, r.timezone);
        ul.hidden = true;
      }));
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#pf-city-go').addEventListener('click', search);
  $('#pf-city').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  $('#pf-geo').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('This browser cannot share location.', true);
    navigator.geolocation.getCurrentPosition(
      (pos) => setLoc('My location', Math.round(pos.coords.latitude * 100) / 100, Math.round(pos.coords.longitude * 100) / 100, null),
      (err) => toast(`Location not shared: ${err.message}`, true),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  });

  $('#pf-save').addEventListener('click', async () => {
    const p = readForm(root, base);
    try {
      const r = isNew ? await api('POST', '/api/users', { profile: p }) : await api('PUT', `/api/users/${state.viewing}/profile`, { profile: p });
      $('#pf-errors').innerHTML = '';
      if (isNew) {
        state.viewing = r.profile.id;
        await api('POST', '/api/active', { userId: r.profile.id });
      }
      state.editing = null;
      await loadStatus();
      await loadRecord();
      toast(r.warnings?.length ? `Saved. Note: ${r.warnings.join('; ')}` : 'Preferences saved.');
      state.planSig = null;
      openTab('tonight');
    } catch (err) {
      $('#pf-errors').innerHTML = `<div class="errors"><strong>${esc(err.message)}</strong>${err.details ? `<ul>${err.details.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  $('#pf-delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete ${base.name}'s profile and stored data?`)) return;
    await api('DELETE', `/api/users/${state.viewing}`);
    state.viewing = null;
    await loadStatus();
    await loadRecord();
    state.planSig = null;
    if (!state.status.users.length) {
      state.editing = 'new';
      openTab('prefs');
    } else openTab('tonight');
  });
}

// ---------- calendar ----------

async function renderCalendar() {
  const root = $('#tab-calendar');
  if (!state.viewing) {
    root.innerHTML = '<div class="empty">Create a profile first.</div>';
    return;
  }
  await loadRecord();
  const cal = state.record.calendar;
  const tz = state.record.profile.timezone;
  const cats = state.status.eventCategories;
  const d = state.dashboard?.plan;
  const tomorrow = d?.day;
  const catSel = (id, v, allowAuto = true) => `<select id="${id}">${allowAuto ? '<option value="">Auto / none</option>' : ''}${cats.map((c) => `<option value="${c.key}" ${c.key === v ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
  const simPresets = ['exam', 'early', 'relaxed', 'normal', 'conflict', 'empty'];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(Date.now());
  const manualWhen = (e) => (e.allDay ? `${e.date}${e.endDate && e.endDate !== e.date ? ` → ${e.endDate}` : ''} · all day` : e.date ? `${e.date} ${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : fmt(Date.parse(e.start), tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

  root.innerHTML = `
    <div class="grid two">
      <div class="card stack"><h2>Calendar connection</h2>
        <p class="small muted" style="margin:0">Drift reads only event titles (or a category you choose), times, and the all-day flag. It never edits your calendar or alarms.</p>
        <div class="radio-cards">
          <label class="radio-card"><input type="radio" name="cal-mode" value="manual" ${cal.mode === 'manual' ? 'checked' : ''}><div><strong>Manual entry</strong><span>Complete fallback. Add only what matters.</span></div></label>
          <label class="radio-card"><input type="radio" name="cal-mode" value="ics" ${cal.mode === 'ics' ? 'checked' : ''}><div><strong>Private calendar feed</strong><span>Google, Outlook or Apple “secret iCal address”. Read-only.</span></div></label>
          <label class="radio-card"><input type="radio" name="cal-mode" value="simulated" ${cal.mode === 'simulated' ? 'checked' : ''}><div><strong>Simulated demo calendar</strong><span>Clearly labeled fake events for demos.</span></div></label>
        </div>
        <div id="cal-ics" class="stack" ${cal.mode === 'ics' ? '' : 'hidden'}>
          <input type="url" id="cal-url" placeholder="${cal.icsUrl ? `Saved: ${esc(cal.icsUrl)} (paste to replace)` : 'https://calendar.google.com/calendar/ical/…/basic.ics'}" style="width:100%">
          <label class="small"><input type="checkbox" id="cal-titles" ${cal.storeTitles ? 'checked' : ''}> Use event titles (uncheck to keep only times; then label events by category)</label>
          <span class="faint small">Google Calendar: Settings → your calendar → Integrate calendar → “Secret address in iCal format”. The address stays on the server and is never shown again in full.</span>
        </div>
        <div id="cal-sim" class="row" ${cal.mode === 'simulated' ? '' : 'hidden'}><label class="small">Demo preset</label><select id="cal-preset">${simPresets.map((x) => `<option ${x === (cal.simPreset ?? 'exam') ? 'selected' : ''}>${x}</option>`).join('')}</select><span class="badge sim">simulated</span></div>
        <div><button class="primary small" id="cal-save">Save connection</button> ${d ? `<span class="small muted">Status: ${esc(d.calendar.status.replace('_', ' '))}${d.calendar.error ? ` (${esc(d.calendar.error)})` : ''}</span>` : ''}</div>
        ${state.dashboard?.calendarWarnings?.length ? `<p class="small muted">${esc(state.dashboard.calendarWarnings.join(' '))}</p>` : ''}
      </div>

      <div class="card stack"><h2>Add an event manually</h2>
        <div class="fields">
          <div class="field"><label for="ev-title">Title (optional if you pick a category)</label><input type="text" id="ev-title" maxlength="120"></div>
          <div class="field"><label for="ev-cat">Category</label>${catSel('ev-cat', '')}</div>
          <div class="field"><label for="ev-date">Date</label><input type="date" id="ev-date" value="${tomorrow?.date ?? today}"></div>
          <div class="field check"><input type="checkbox" id="ev-allday"><label for="ev-allday">All day</label></div>
          <div class="field"><label for="ev-start">Start</label><input type="time" id="ev-start" value="09:00"></div>
          <div class="field"><label for="ev-end">End</label><input type="time" id="ev-end" value="10:00"></div>
          <div class="field"><label for="ev-imp">Importance</label><select id="ev-imp"><option value="">Not marked</option><option value="important">Important</option><option value="normal">Not important</option></select></div>
          <div class="field"><label for="ev-prep">Prep time (min, optional)</label><input type="number" id="ev-prep" min="0" max="600"></div>
          <div class="field"><label for="ev-travel">Travel time (min, optional)</label><input type="number" id="ev-travel" min="0" max="600"></div>
        </div>
        <div><button class="primary small" id="ev-add">Add event</button></div>
      </div>
    </div>

    <h3 class="section-title">Tomorrow (${tomorrow ? fmtDate(tomorrow.date) : '—'}): review and correct</h3>
    <div class="card">${tomorrow?.events?.length ? `<ul class="event-list">${tomorrow.events.map((e, i) => `
      <li data-eid="${esc(e.id ?? '')}">
        <span class="event-when">${e.allDay ? 'All day' : `${fmt(e.start, tz)}–${fmt(e.end, tz)}`}</span>
        <strong>${esc(e.title)}</strong> ${e.source === 'simulated' ? '<span class="badge sim">simulated</span>' : ''}
        <span class="spacer"></span>
        ${catSel(`an-cat-${i}`, e.categoryInferred ? '' : e.category)}${e.categoryInferred ? `<span class="badge">inferred: ${esc(e.category)}</span>` : ''}
        <select id="an-imp-${i}"><option value="">Importance not marked</option><option value="important" ${e.importance === 'important' ? 'selected' : ''}>Important</option><option value="normal" ${e.importance === 'normal' ? 'selected' : ''}>Not important</option></select>
        <input type="number" id="an-prep-${i}" placeholder="prep min" style="width:90px" value="${e.prepMinutes ?? ''}">
        <input type="number" id="an-travel-${i}" placeholder="travel min" style="width:95px" value="${e.travelMinutes ?? ''}">
        <button class="small" data-annotate="${i}" ${e.id ? '' : 'disabled title="This event has no stable id"'}>Save</button>
      </li>`).join('')}</ul>` : '<p class="muted">No events tomorrow. That makes tomorrow “unknown”, not a day off. Label the day on the Tonight tab if you like.</p>'}</div>

    <h3 class="section-title">Your manual events</h3>
    <div class="card">${cal.events.length ? `<ul class="event-list">${cal.events.map((e) => `
      <li><span class="event-when">${esc(manualWhen(e))}</span><strong>${esc(e.title || cats.find((c) => c.key === e.category)?.label || '')}</strong>
      ${e.importance === 'important' ? '<span class="badge accent">important</span>' : ''}${e.category ? `<span class="badge">${esc(e.category)}</span>` : ''}
      <span class="spacer"></span><button class="small ghost" data-del="${esc(e.id)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</div>`;

  $$('input[name=cal-mode]', root).forEach((r) => r.addEventListener('change', () => {
    $('#cal-ics').hidden = r.value !== 'ics' || !r.checked;
    $('#cal-sim').hidden = r.value !== 'simulated' || !r.checked;
  }));
  $('#cal-save').addEventListener('click', async () => {
    const mode = $('input[name=cal-mode]:checked').value;
    try {
      await api('PUT', `/api/users/${state.viewing}/calendar`, { mode, icsUrl: $('#cal-url').value.trim() || undefined, simPreset: $('#cal-preset').value, storeTitles: $('#cal-titles').checked });
      toast('Calendar connection saved.');
      await refreshDashboard(true);
      renderCalendar();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#ev-allday').addEventListener('change', (e) => { $('#ev-start').disabled = e.target.checked; $('#ev-end').disabled = e.target.checked; });
  $('#ev-add').addEventListener('click', async () => {
    const allDay = $('#ev-allday').checked;
    const event = {
      title: $('#ev-title').value.trim(),
      category: $('#ev-cat').value || null,
      date: $('#ev-date').value,
      allDay,
      importance: $('#ev-imp').value || null,
      prepMinutes: $('#ev-prep').value || null,
      travelMinutes: $('#ev-travel').value || null,
    };
    if (!allDay) {
      event.startTime = $('#ev-start').value;
      event.endTime = $('#ev-end').value;
    }
    try {
      await api('POST', `/api/users/${state.viewing}/events`, { event });
      toast('Event added.');
      await refreshDashboard(true);
      renderCalendar();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    await api('DELETE', `/api/users/${state.viewing}/events/${encodeURIComponent(b.dataset.del)}`);
    await refreshDashboard(true);
    renderCalendar();
  }));
  $$('[data-annotate]', root).forEach((b) => b.addEventListener('click', async () => {
    const i = b.dataset.annotate;
    const eid = b.closest('li').dataset.eid;
    try {
      await api('PUT', `/api/users/${state.viewing}/annotations/${encodeURIComponent(eid)}`, {
        category: $(`#an-cat-${i}`).value || null,
        importance: $(`#an-imp-${i}`).value || null,
        prepMinutes: $(`#an-prep-${i}`).value,
        travelMinutes: $(`#an-travel-${i}`).value,
      });
      toast('Saved. Your labels override automatic classification.');
      await refreshDashboard(true);
      renderCalendar();
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

// ---------- demo scenarios ----------

async function renderDemo(selected) {
  const root = $('#tab-demo');
  const list = await api('GET', '/api/scenarios');
  const id = selected ?? root.dataset.selected ?? list[0].id;
  root.dataset.selected = id;
  root.innerHTML = `
    <div class="sim-banner" style="border-radius:10px;margin-bottom:16px"><strong>SIMULATED SCENARIOS</strong>: fixed clock, made-up weather and calendars, virtual devices. Deterministic, so every run is identical. Nothing here touches real hardware.</div>
    <div class="grid" style="grid-template-columns:minmax(220px,300px) 1fr">
      <div class="scenario-list">${list.map((s, i) => `<button data-sc="${s.id}" class="${s.id === id ? 'active' : ''}"><strong>${i + 1}. ${esc(s.title)}</strong></button>`).join('')}</div>
      <div id="demo-body"><div class="muted">Loading…</div></div>
    </div>`;
  $$('[data-sc]', root).forEach((b) => b.addEventListener('click', () => renderDemo(b.dataset.sc)));
  const { scenario, results } = await api('GET', `/api/scenarios/${id}`);
  $('#demo-body').innerHTML = `
    <div class="card" style="margin-bottom:16px"><h2>${esc(scenario.title)} <span class="badge sim">simulated</span></h2><p style="margin:0">${esc(scenario.description)}</p></div>
    <div class="compare">${results.map((r, i) => {
      const p = r.plan;
      return `<div class="card" id="demo-run-${i}">
        <div class="card-head"><h2>${esc(p.userName)}</h2><span class="badge">${esc(p.day.label)} · ${p.day.source === 'user' ? 'labeled' : p.day.source}</span></div>
        <div class="big-times"><div><span class="label">Clock</span><span class="value">${esc(p.nowLabel)}</span></div><div><span class="label">Wind-down</span><span class="value">${esc(p.schedule.labels.windDownStart)}</span></div><div><span class="label">Bed</span><span class="value">${esc(p.schedule.labels.bedtime)}</span></div><div><span class="label">Wake</span><span class="value">${esc(p.schedule.labels.wakeEnd)}</span></div></div>
        <div class="timeline">${timelineSvg(p, r.frames, `tl-demo-${i}`)}</div>
        ${playerHtml(`demo-${i}`)}
        ${p.proposals.length ? `<div class="stack" style="margin-top:12px">${p.proposals.map((x) => `<div class="proposal ${x.status}"><p>${esc(x.text)}</p><span class="badge ${x.status === 'accepted' ? 'ok' : 'warn'}">${x.status === 'pending' ? 'awaiting your OK' : x.status}</span></div>`).join('')}</div>` : ''}
        <ul class="explain" style="margin-top:12px">${p.explanations.map((e) => `<li data-kind="${esc(e.kind)}">${esc(e.text)}</li>`).join('')}</ul>
      </div>`;
    }).join('')}</div>
    <div class="timeline">${legend()}</div>`;
  results.forEach((r, i) => bindPlayer(`demo-${i}`, r.plan, r.frames, $(`#demo-run-${i}`)));
}

init().catch((err) => {
  document.querySelector('main').innerHTML = `<div class="empty">Drift could not start: ${esc(err.message)}</div>`;
});
