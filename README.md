# Sleep Sheep

Standalone iPhone demo for the SleepSheep Arduino, with a Python USB/phone-browser
fallback. iOS 17+, SwiftUI, CoreBluetooth, and URLSession. No Swift dependencies.

## Run the iPhone app

1. Open `SleepSheep.xcodeproj` in Xcode. If starting from a fresh checkout, first run
   `python3 scripts/generate_project.py`; it creates a local placeholder secrets file.
2. In **Signing & Capabilities**, select your development team and choose a unique
   bundle identifier if needed. Select your real iPhone as the run destination.
3. Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in `Resources/Secrets.plist`.
   This file is ignored by Git. It is bundled into the private demo app: do not
   distribute that build, and revoke the key after the hackathon. Never put the key
   in the example file. Manual light controls work without a key.
4. Run the app, allow Bluetooth, power on the sheep without touching its head, and
   tap **Connect**. Scanning filters by service UUID. Keep the phone nearby.
5. Try brightness 100, duration 5 minutes with **Stage demo · 60× faster** enabled:
   the fade takes 5 seconds. Turn the stage toggle off for real timing.
6. Ask “Start a gentle sunrise now.” Claude can inspect status/pats, start a fade,
   and explain its choice. This starter does not schedule tomorrow's wake-up.

In the iOS Simulator, **Simulated sheep** defaults on because Bluetooth is not
available there. Connect and use **Simulate a head pat** to test the flow. Simulated
and real pat logs are stored separately. Claude still needs a real API key; the
simulation replaces hardware only.

The generated secrets example uses `claude-sonnet-5-5`, verified against the
[model overview](https://platform.claude.com/docs/en/models/overview). Override it
with a model your account can access. The REST loop follows the
[Claude tool-call contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
and uses `POST /v1/messages` with `anthropic-version: 2023-06-01`.

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
0–1023, not lux. Label stage speedup and simulated data in the pitch. Weather and
calendar integrations are intentionally unavailable until real sources are wired.

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
