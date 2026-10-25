# Sheepy

Sheepy is an iPhone sleep-planning app with a Bluetooth sheep companion. It combines
calendar commitments, a recent HealthKit sleep summary, and user preferences into
four recommendations: stop caffeine, start winding down, wake up, and get morning
light. Plan explanations are generated entirely on-device from the displayed result.

Built with SwiftUI, EventKit, HealthKit, and CoreBluetooth for iOS 17+. The Arduino
handles light fades and reports touch events and relative room brightness. The
optional Claude chat controls hardware; it is separate from offline plan explanations.

## Presentation and integration guides

- [Presentation handout PDF](output/handout/Sheepy_Presentation_Handout.pdf)
- [Editable handout HTML](output/handout/Sheepy_Presentation_Handout.html)
- [Dashboard and demo guide](Views/README.md)
- [Planner integration](Docs/PLANNER_INTEGRATION.md)
- [Offline explanations](Docs/OFFLINE_EXPLANATION_INTEGRATION.md)
- [Calendar integration](Docs/CALENDAR_INTEGRATION.md)
- [HealthKit integration](Docs/HEALTHKIT_INTEGRATION.md)
- [Arduino firmware and USB references](hardware_integration/README.md)

The handout records the tested implementation at `0b01cec`; the main-branch
consolidation adds documentation and hardware references without changing app behavior.

## Run the iPhone app

1. Open `SleepSheep.xcodeproj` in Xcode. If starting from a fresh checkout, first run
   `python3 scripts/generate_project.py` to sync source membership while preserving the checked-in project configuration. It does not create or read credential files.
2. In **Signing & Capabilities**, select your development team and choose a unique
   bundle identifier if needed. Select your real iPhone as the run destination.
3. For optional Claude chat, create your local `Resources/Secrets.plist` from
   `Resources/Secrets.example.plist`, then set `ANTHROPIC_API_KEY` and
   `ANTHROPIC_MODEL`. Keep the local resource present for Xcode builds even if
   you leave chat unconfigured.
   This file is ignored by Git. It is bundled into the private demo app: do not
   distribute that build, and revoke the key after the hackathon. Never put the key
   in the example file. Planning, offline explanations, and manual light controls work without a key.
4. Run the app, allow Bluetooth, power on the sheep without touching its head, and
   open **Lamp & chat**, turn **Simulated sheep** off, and tap **Connect**.
   Disconnect nRF Connect first. Scanning filters by service UUID. Keep the phone nearby.
5. Tap **Start morning light demo**: the lamp fades toward 80% over 12 seconds.
   Pat Sheepy to turn it off. Keep the app open and connected. Manual controls
   and chat end the demo’s pat-to-off mode. This demo does not schedule an alarm.
6. Ask “Start a gentle sunrise now.” Claude can inspect status/pats, start a fade,
   and explain its choice. This starter does not schedule tomorrow's wake-up.

In the iOS Simulator, **Simulated sheep** defaults on because Bluetooth is not
available there. Connect and use **Simulate a head pat** to test the flow. Simulated
and real pat logs are stored separately. Claude still needs a real API key; the
simulation replaces hardware only.

For optional chat, choose a model available to your Anthropic account. The client
uses the Messages API with tool calls; no live Claude call is required for the
planning or hardware demonstration.

## USB fallback and prompt iteration

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
export ANTHROPIC_API_KEY='your-private-demo-key'
export ANTHROPIC_MODEL='claude-sonnet-5-5'
SHEEP_FAKE=1 DEMO_SPEEDUP=60 python3 agent.py
```

For the real sheep, omit `SHEEP_FAKE=1`, close the Arduino Serial Monitor, and
connect USB. Set `SHEEP_PORT=/dev/cu.usbmodem…` if autodetection picks the wrong
port. Only one running program may own serial: stop the CLI before starting the
web fallback. `python3 sheep.py` is a hardware self-test that changes the light.

For the phone browser fallback, run:

```sh
DEMO_SPEEDUP=60 python3 server.py --host 0.0.0.0 --port 8000
```

Put the phone and laptop on the same Wi-Fi. Open the printed access link on the
phone, replacing `localhost` with the laptop's Wi-Fi IP and preserving its token
fragment. Allow local incoming connections if macOS asks. The API key stays on
the laptop. The server imports `sheep` in the same process and serializes chat
requests; it never launches a second serial owner. Use `SHEEP_FAKE=1` to run it
without hardware. Default binding without `--host` is laptop-only. This small
HTTP server is for the local hackathon demo, not public hosting.

## Hardware behavior

- Service: `A06E5F31-0600-46ED-8657-17C3712FB50F`.
- Write: `C8C9C213-A1FB-4AF2-A0D6-BED87FCEAD6C`.
- Read/notify: `5781D30D-37B4-4463-A8D8-8019495468C1`.
- BLE sends plain UTF-8 `L,<brightness>,<seconds>` without a newline, at most
  40 bytes. USB sends the same command plus a newline at 115200 baud.
- Brightness rounds with ties-to-even and clamps to 0–100. Minutes clamp to
  0–30. Seconds are minutes × 60 / speedup, formatted to one decimal place.
  The Arduino owns the fade; the app does not stream brightness values.
- BLE status is `pats,light,level,target`. `ERR` is a tool error. Lamp commands
  await a status notification after the write acknowledgment. `get_status` uses
  the latest snapshot and rejects data more than five seconds old.
- BLE has no command IDs, so returned status is an observation, not a uniquely
  correlated firmware receipt. A timeout does not prove the command failed.
  Check status before retrying; the Arduino can continue fading after disconnect.
- First status and reconnect establish a baseline. Increasing counts produce one
  phone timestamp per pat; decreases reset the baseline. Unobserved pats during a
  disconnect are not reconstructed. Batched increments share the observation time.
- Phone logs persist in Application Support. The app must be running to observe
  pats; background/overnight logging and scheduled alarms are not implemented.
  Python logs to `pats.jsonl`, or `simulated-pats.jsonl` in fake mode.

Pats are a sleep proxy, not clinical sleep data. Room brightness is relative
0–1023, not lux. Label stage speedup and simulated data in the pitch. Calendar and HealthKit providers are implemented with explicit authorization
flows; device permission testing remains necessary. Weather remains a placeholder.

## Files and checks

`Docs/AGENT_PROMPT.md` and `Resources/tools.json` are shared unchanged by Swift
and Python. `Services/BluetoothSheep.swift` owns BLE; `sheep.py` owns USB.
`Services/ClaudeAgent.swift` and `agent.py` implement consecutive tool rounds,
adjacent tool-result messages, errors, and a twelve-round guard. Completed tool
exchanges remain in history if a later network call fails. Conversation history
is in memory and clears on app/server restart; hardware-mode changes also clear it.

```sh
python3 -m unittest discover -s Tests -v
swiftc -module-cache-path /tmp/sleep-sheep-swift-cache \
  Models/SheepProtocol.swift Services/SheepHardware.swift Tests/ProtocolChecks.swift \
  -o /tmp/sleep-sheep-protocol-checks
/tmp/sleep-sheep-protocol-checks
xcodebuild -project SleepSheep.xcodeproj -scheme SleepSheep \
  -sdk iphonesimulator -configuration Debug -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

Automated checks cover clamping, speedup, malformed status, reset/batched pats,
simulated fades, serial framing, tool results/errors, truncated responses, and
fallback routes. Physical Bluetooth/USB behavior and live Claude calls still
require a device and API credentials. Before the demo, verify a 5-second fade,
multiple head pats, a board reset, and disconnect/error handling on a real iPhone.
