// Dashboard panels for the LLM agent and the Sleep Sheep hardware.
// Re-rendered on every poll; markup is diffed so buttons don't flicker or lose focus.

const TOOL_LABELS = {
  set_lamp: 'Light', get_status: 'Read sheep', read_pat_log: 'Read pats', play_sound: 'Sound', get_sound_status: 'Read speaker',
  get_preferences: 'Read preferences', get_tonight: 'Read tonight', get_weather: 'Read weather',
  schedule_action: 'Schedule', list_scheduled: 'List schedule', cancel_scheduled: 'Cancel scheduled',
};

function setHtml(el, html) {
  if (el.dataset.html === html) return false;
  el.innerHTML = html;
  el.dataset.html = html;
  return true;
}

const compact = (v) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
};

export function renderAgent(root, a, { esc, fmt, tz, api, toast, refresh }) {
  if (!a) {
    setHtml(root, '<h2>Agent</h2><p class="muted small">The agent runs for the person whose preferences drive the device. Choose them in the user menu.</p>');
    return;
  }
  const inControl = a.mode === 'agent';
  const badge = !a.enabled ? '<span class="badge warn">off</span>' : inControl ? '<span class="badge ok">Claude in control</span>' : '<span class="badge warn">backup rules in control</span>';
  const run = a.running ?? a.log[0];
  const step = (s) => `<li><strong>${esc(TOOL_LABELS[s.tool] ?? s.tool)}</strong> <span class="mono faint">${esc(compact(s.input))}</span>${s.error ? `<div class="small" style="color:var(--bad)">${esc(s.error)}</div>` : s.result ? `<div class="mono faint small">→ ${esc(compact(s.result))}</div>` : ''}</li>`;
  const runHtml = (r) => `
    <div class="small muted">${esc(fmt(r.startedAt, tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))} · ${esc(r.events.join('; '))}
      · <span class="badge ${r.status === 'ok' ? 'ok' : r.status === 'running' ? '' : 'bad'}">${esc(r.status)}</span>
      ${r.usage ? `<span class="faint">· ${r.usage.input_tokens + r.usage.cache_read_input_tokens} in / ${r.usage.output_tokens} out tokens</span>` : ''}</div>
    ${r.text ? `<p class="agent-note">${esc(r.text)}</p>` : ''}
    ${r.error ? `<p class="small" style="color:var(--bad)">${esc(r.error)}</p>` : ''}
    ${r.steps?.length ? `<ol class="agent-steps">${r.steps.map(step).join('')}</ol>` : ''}`;
  const html = `
    <div class="card-head"><h2>Agent${a.enabled ? ` <span class="faint small mono">${esc(a.model)}</span>` : ''}</h2>${badge}</div>
    <p class="small ${inControl ? 'muted' : ''}" style="margin-top:0">${esc(a.reason ?? '')}</p>
    ${!a.enabled ? `<p class="small">To turn the agent on, add <code>ANTHROPIC_API_KEY=…</code> to <code>.env</code> in the project folder and restart the server. Until then the backup rules run the sheep and speaker.</p>` : `
      <div class="row small">
        <button class="small primary" id="ag-run" ${a.running ? 'disabled' : ''}>${a.running ? 'Agent is thinking…' : 'Run agent now'}</button>
        <span class="faint">${a.runsLastHour}/${a.maxRunsPerHour} runs this hour · runs on events (phase changes, weather, edits, overrides, pats)${a.queued.length ? ` · queued: ${esc(a.queued.join(', '))}` : ''}</span>
      </div>`}
    ${run ? `<h3 style="margin-top:14px">${a.running ? 'Running now' : 'Latest decision'}</h3>${runHtml(run)}` : a.enabled ? '<p class="muted small">No runs yet.</p>' : ''}
    ${a.scheduled.length ? `<h3 style="margin-top:14px">Scheduled by the agent</h3><ul class="event-list small">${a.scheduled.map((s) => `
      <li><span class="event-when">${esc(fmt(s.at, tz))}</span><span>${esc(s.action === 'set_lamp' ? `Light → ${s.args.brightness}% over ${s.args.minutes} min` : `Sound → ${s.args.sound} ${s.args.level}%`)}</span><span class="faint">${esc(s.note ?? '')}</span><span class="spacer"></span><button class="small ghost" data-cancel="${esc(s.id)}">Cancel</button></li>`).join('')}</ul>` : ''}
    ${a.log.length > 1 ? `<details style="margin-top:10px"><summary class="small">Earlier runs (${a.log.length - 1})</summary>${a.log.slice(a.running ? 0 : 1).map((r) => `<div style="margin-top:10px">${runHtml(r)}</div>`).join('')}</details>` : ''}`;
  if (!setHtml(root, html)) return;
  root.querySelector('#ag-run')?.addEventListener('click', async () => {
    try {
      await api('POST', '/api/agent/run', {});
      toast('Agent run started.');
      refresh();
    } catch (e) {
      toast(e.message, true);
    }
  });
  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    await api('DELETE', `/api/agent/scheduled/${b.dataset.cancel}`);
    toast('Scheduled action cancelled.');
    refresh();
  }));
}

export function renderSheep(root, sh, { esc, fmt, tz, api, toast, refresh, ble }) {
  if (!sh) return;
  const s = sh.status;
  const age = sh.statusAgeMs == null ? null : Math.round(sh.statusAgeMs / 1000);
  const badge = !sh.active ? '<span class="badge bad">not connected</span>'
    : sh.simulated ? '<span class="badge sim">simulated</span>'
      : `<span class="badge ok">${sh.active === 'usb' ? 'USB' : 'Bluetooth'}</span>`;
  const bleText = !ble.supported
    ? '<span class="faint small">This browser has no Web Bluetooth. Use Chrome or Edge, or Bluefy on iPhone.</span>'
    : ble.connected ? '<button class="small" id="sh-ble-off">Disconnect Bluetooth</button>'
      : '<button class="small primary" id="sh-ble">Connect sheep (Bluetooth)</button>';
  const html = `
    <div class="card-head"><h2>Sleep Sheep</h2>${badge}</div>
    ${s ? `<dl class="state-grid">
      <dt>Light</dt><dd>${s.level ?? '—'}% <span class="faint">→ target ${s.target ?? '—'}%</span></dd>
      <dt>Room light</dt><dd>${s.light ?? '—'} <span class="faint">(relative 0–1023, not lux)</span></dd>
      <dt>Head pats</dt><dd>${s.pats ?? '—'} <span class="faint">since the sheep powered on</span></dd>
      <dt>Updated</dt><dd>${age == null ? '—' : `${age}s ago`} via ${esc(s.transport ?? '—')}</dd>
    </dl>` : '<p class="muted small">No status yet.</p>'}
    ${sh.transports.usb.error && !sh.transports.usb.ready ? `<p class="small" style="color:var(--warn)">USB: ${esc(sh.transports.usb.error)}</p>` : ''}
    <div class="row small" style="margin-top:10px">
      ${bleText}
      <label for="sh-pref" class="faint">Send commands via</label>
      <select id="sh-pref" class="small">${['auto', 'usb', 'ble', 'sim'].map((t) => `<option value="${t}" ${sh.preferred === t ? 'selected' : ''}>${{ auto: 'Auto (USB, then Bluetooth)', usb: 'USB', ble: 'Bluetooth', sim: 'Simulated' }[t]}</option>`).join('')}</select>
      ${sh.transports.sim.enabled ? '<button class="small ghost" id="sh-pat">Simulate a pat</button>' : ''}
    </div>
    ${sh.demoSpeedup > 1 ? `<p class="small" style="color:var(--warn)">Demo speedup ×${sh.demoSpeedup}: fades play ${sh.demoSpeedup}× faster than planned.</p>` : ''}
    ${sh.pats.length ? `<details style="margin-top:8px"><summary class="small">Recent pats (rough bedtime/wake proxy, not sleep tracking)</summary><ul class="event-list small">${sh.pats.slice().reverse().map((p) => `<li><span class="event-when">${esc(fmt(Date.parse(p.ts), tz, { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span><span class="faint">#${p.count_since_boot} via ${esc(p.transport ?? 'usb')}</span></li>`).join('')}</ul></details>` : ''}`;
  if (!setHtml(root, html)) return;
  root.querySelector('#sh-ble')?.addEventListener('click', async () => {
    try {
      await ble.connect(sh.ble);
      toast('Sheep connected over Bluetooth.');
      refresh();
    } catch (e) {
      if (e.name !== 'NotFoundError') toast(`Bluetooth: ${e.message}`, true); // NotFoundError = picker cancelled
    }
  });
  root.querySelector('#sh-ble-off')?.addEventListener('click', () => {
    ble.disconnect();
    refresh();
  });
  root.querySelector('#sh-pref')?.addEventListener('change', async (e) => {
    try {
      await api('POST', '/api/sheep/transport', { preferred: e.target.value });
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
  root.querySelector('#sh-pat')?.addEventListener('click', async () => {
    await api('POST', '/api/sheep/sim/pat', {});
    refresh();
  });
}
