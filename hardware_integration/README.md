# Sheepy hardware reference

These three files are preserved from `drift-agent` commit `e716ab1`.

- `firmware.cpp`: ArduinoBLE firmware for the sheep, supporting Bluetooth and USB.
- `sheep.py`: original USB hardware client.
- `bridge.py`: original JSON-lines bridge for the earlier Node application.

The iPhone app uses `Services/BluetoothSheep.swift` directly over Bluetooth. It does
not need Python, Node, or Wi-Fi. For the maintained laptop fallback, use the root
`sheep.py`, `agent.py`, and `server.py`; do not run two clients on the same serial port.

## Wiring and demo

The reference firmware uses touch input D2, light input A0, and LED outputs D9 and
D10. The physical prototype has five wired LEDs: verify the uploaded firmware and
actual pin assignments before reflashing. This reference does not establish that
all five outputs are configured. Select the correct board and ArduinoBLE library
in the Arduino IDE when preparing a sketch from this source.

Disconnect nRF Connect before connecting from Sheepy. In Lamp & chat, turn off
Simulated sheep and connect. Start morning light demo fades toward 80% over 12
seconds; a new pat commands immediate light-off. Keep the app open and connected.
The app logs observed pats but does not reconstruct touches missed offline or
schedule future wake alarms. The firmware runs a fade after receiving its command.
