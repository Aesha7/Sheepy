# Drift + Sleep Sheep

Drift is the brain of our hackathon sleep device, the **Sleep Sheep**: a small sheep with a warm light, a head-pat
sensor and a room-light sensor. A **Claude agent** decides what the sheep's light and the paired speaker do around
bedtime, overnight and at wake-up. It uses your saved preferences, tomorrow's calendar, the local weather and
sunrise/sunset, and explains every decision in plain language.

The same weather and schedule produce different nights for different people. Nothing changes your bedtime, wake
time or alarms without your OK, and Drift never claims to improve sleep or performance. Heart rate is deferred.

## How it works

```
 events (phase change, weather, edits,      ┌──────────────── Claude agent ─────────────────┐
 overrides, head pats, Run now) ──────────▶ │ reads: get_tonight, get_weather, get_preferences│
                                            │ acts:  set_lamp, play_sound, schedule_action   │
                                            └──────────────────────┬────────────────────────┘
                                                                   │ every command passes the safety floor
 backup rules (buildPlan) ── used when the agent can't run ──▶  Executor ──▶ Sleep Sheep light (USB / Bluetooth)
                                                                          └─▶ speaker (dashboard tab)
```

- **Agent mode:** with an `ANTHROPIC_API_KEY`, Claude (`claude-opus-5-5` by default) runs on events and drives the
  sheep's light and the sound directly through tools. The sheep fades on its own, so one `set_lamp` is enough.
- **Backup rules:** without a key, or when the API is unreachable, refuses or misbehaves, the deterministic rules
  engine runs the devices. The dashboard always says which one is in control and why.
- **Safety floor** (code the model can't get around): **Stop** and **Pause** always win, **volume never exceeds your
  cap**, and **the light can't flash** (no rapid reversals or bursts of changes). Manual overrides also win. The
  sheep's firmware separately clamps brightness to 0–100 and fades to 30 minutes.

## Quick start

Requires Node.js 20+ (tested on 24) and, for the sheep over USB, Python 3 with `pyserial`.

```bash
npm install          # one dependency: the official Anthropic SDK
npm start            # http://127.0.0.1:3000
npm test             # 89 tests, no API key or hardware needed
```

1. **Plug the sheep in by USB**: Drift finds it automatically (via `hardware_integration/bridge.py` → `sheep.py`).
   Close the Arduino IDE Serial Monitor first, since only one program can own the port.
2. **Or connect over Bluetooth:** on the Tonight tab, press **Connect sheep (Bluetooth)** in Chrome or Edge (or the
   Bluefy browser on iPhone; Safari has no Web Bluetooth) and pick `SleepSheep`.
3. **Turn the agent on:** copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY=…`, restart. Without it, the
   backup rules run and the Agent panel says so.
4. Click **Enable Sound** on the dashboard so that tab can play the speaker's sounds.

The full list of settings, with comments, is in `.env.example`.

## The agent's tools

| Tool | Does | Notes |
|---|---|---|
| `set_lamp` | Fade the sheep's light to 0–100% over 0–30 min | Same definition as `sheep.TOOLS` (a test checks they match) |
| `get_status` | Pats since power-on, room light (relative 0–1023, not lux), level, target | |
| `read_pat_log` | Timestamped head pats (rough bedtime/wake proxy, not sleep tracking) | Timestamped by the server; the Arduino has no clock |
| `play_sound` | Noise, rain ambience or wind-down music on the dashboard tab, with a fade | Level capped at your maximum |
| `get_sound_status` | What the speaker is doing (playing, blocked, disconnected) | |
| `get_preferences` / `get_tonight` / `get_weather` | Your settings; tonight's schedule, tomorrow's day type, overrides, the backup plan; the forecast | Read-only |
| `schedule_action` / `list_scheduled` / `cancel_scheduled` | Run a light or sound change later tonight (e.g. a sunrise when the wake window opens) | Skipped if late, stopped or paused |

The system prompt is in `server/agent/prompt.js`. The request uses adaptive thinking, `effort: medium`, prompt
caching on the stable system prompt and tools, and `fallbacks: "default"` so a declined request is retried on
Anthropic's recommended fallback model. Runs are event-driven, debounced, and capped at 20 per hour (configurable).

## What's in the box

```
server/
  agent/          prompt.js (system prompt), tools.js (tools + host), safety.js (safety floor),
                  agent.js (Claude loop, official SDK), controller.js (events, mode, scheduler)
  sheep/hub.js    the sheep over USB (Python bridge), Bluetooth (browser relay) or a labeled simulator
  policy/         buildPlan.js (backup rules), weatherAudio.js, timeline.js, feedback.js
  weather/        Open-Meteo client, normalized schema, offline scenarios, freshness and windows
  calendar/       manual events, .ics feeds, day classification
  devices/        adapters (sheep, browser speaker, Hue, HTTP, simulated) and the executor
hardware_integration/
  sheep.py        the teammate's hardware layer (unchanged); bridge.py lets Node use it
  firmware.cpp    Arduino firmware (USB + Bluetooth)
public/           dashboard (agent panel, sheep panel + Web Bluetooth, weather, sound, preferences, demos)
ios/              SwiftUI app for Xcode: same agent on the phone over Bluetooth (not compiled yet; see ios/README.md)
docs/policy-rules.md  the backup rules
```

## Demo (about 3 minutes)

1. Sheep on USB (or Bluetooth), `.env` with your key, `npm start`, open the dashboard and click **Enable Sound**.
2. **Agent panel → Run agent now.** Watch Claude read tonight's context and weather, set the light and sound, and
   explain why. Its steps are listed under the note.
3. **Pat the sheep's head.** The pat shows on the sheep panel and wakes the agent.
4. **Weather → Source → Offline scenario "Thunderstorm".** The weather change triggers a new run; a person who finds
   storms disruptive gets their masking sound, someone who prefers silence gets none.
5. **Override the light** (Live outputs). The agent is told and leaves the light alone until you clear it.
6. **Stop.** Any run in flight is aborted, scheduled actions are dropped, sound stops, and the light holds.
7. Set `DEMO_SPEEDUP=60` so a 30-minute sunrise plays in 30 seconds on stage, and say so in the pitch.

## Test results

`npm test` on Node 24.18.0 (Windows 11): **89 tests, 89 passed** (~1.7 s). The agent tests use a scripted
stand-in for Claude, so they need no key or network. They cover the request shape, tool execution and result
ordering, refusal handling, the iteration cap, the safety floor (flashing, volume cap, Stop, Pause, overrides),
falling back to rules, a rejected key, Stop mid-request, scheduled actions, pat timestamps, the Bluetooth relay,
and that `set_lamp`/`get_status`/`read_pat_log` match `sheep.py` exactly.

**Checked on the real sheep (USB, COM9):** the bridge connected, status streamed (room light about 330), the
backup rules sent `L,0,2.0`, and a manual 40% override reached the sheep (`L,40,2.0`, level 40) and glided back
when cleared.

**Not verified yet:**
- A live agent run against the Claude API (no key here yet).
- Bluetooth with the real sheep: Chrome's device picker needs a person to click it.
- Building the iOS app: it needs Xcode on a Mac.

## Limits

- Only one program can own the sheep's USB port. Set `SHEEP_USB=off` if you need the Arduino IDE.
- Wi-Fi and Bluetooth can't run at the same time on the board; the sheep uses Bluetooth for the phone and USB for
  the laptop.
- Agent-scheduled actions live in server memory. A restart forgets them, and the next event re-plans.
- The server has no login. Keep `HOST=127.0.0.1` unless the phone needs it, and only on a trusted network.
- The Hue and generic HTTP adapters are written to their documented APIs but untested with real devices.
