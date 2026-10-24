# Sleep Sheep iOS app (Xcode)

A small SwiftUI app: it connects to the sheep over Bluetooth and runs the same Drift agent (Claude + tools) on the phone.

**Status: not compiled yet.** It was written on Windows, where Xcode isn't available. Expect to fix a few compile errors on first build. The web version in the main project is the tested path.

## What's here

| File | What it does |
|---|---|
| `SleepSheep/SleepSheepApp.swift` | App entry point and the one screen: sheep status, Connect, Run agent, Stop/Resume, the agent's note and steps, scheduled actions, fallback settings |
| `SleepSheep/SheepBluetooth.swift` | CoreBluetooth link: scans by service UUID, writes `L,…`/`S`, parses status, timestamps pats on the phone, same clamps and `DEMO_SPEEDUP` as `sheep.py` |
| `SleepSheep/ClaudeAgent.swift` | Agent loop over `POST /v1/messages` (URLSession; no official Swift SDK), tool dispatch, flash guard, Stop |
| `SleepSheep/AgentResources/system-prompt.txt`, `tools.json` | Generated from the web agent by `npm run export-agent`, so the phone and web agents match. Don't edit by hand. |
| `Secrets.example.plist` | Copy to `SleepSheep/Secrets.plist` and fill in. Never commit the real file. |

## Build steps

1. Xcode → **File → New → Project → iOS App** (SwiftUI, Swift). Name it `SleepSheep`. **Deployment target iOS 17** or later (the Bluetooth code uses `MainActor.assumeIsolated`).
2. Delete the generated `ContentView.swift` and `SleepSheepApp.swift`, then drag in the three `.swift` files and the `AgentResources` folder. Check **Copy items if needed** and your app target.
3. Copy `Secrets.example.plist` to `Secrets.plist`, set `ANTHROPIC_API_KEY`, and optionally `DRIFT_SERVER_URL` (see below). Add it to the app target.
4. Target → **Info** → add `NSBluetoothAlwaysUsageDescription` = "Connects to your Sleep Sheep." **Without this the app crashes when it touches Bluetooth.**
5. Set your signing team, plug in a **real iPhone** (the Simulator has no Bluetooth), and Run.
6. Tap **Connect**, then **Run agent now**. A head pat on the sheep also wakes the agent.

## Drift context from the laptop (optional)

The phone agent's `get_drift_context` tool reads preferences, tonight's schedule and the weather from the Drift server:

- On the laptop, start Drift with `HOST=0.0.0.0` in `.env`, so other devices on the Wi-Fi can reach it, and note the laptop's IP.
- Set `DRIFT_SERVER_URL` to `http://<laptop-ip>:3000` in `Secrets.plist`. For plain `http`, also add an App Transport Security exception for that host in Info.plist.
- Drift's API has no login. Only do this on a network you trust, and only for the demo.

If the server can't be reached, the agent uses the bedtime, wake time and brightness limit set in the app.

## Limits on the phone

- **No sound tool.** Sound plays from the Drift dashboard in the browser. The phone agent says what it would play.
- **Scheduled actions** (like a sunrise at the start of the wake window) are in-app timers. iOS pauses apps in the background, so they only fire while the app is open and in front.
- **API key on the phone** is fine for a private demo build only: don't distribute the app, and revoke the key after the hackathon.
- **Pat counts reset** when the sheep restarts. The app timestamps new pats itself and resets its baseline when the count goes down.
