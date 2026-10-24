"""
sheep.py - hardware layer for the sleep sheep.

This is the ONLY file that talks to the Arduino. The agent, the server and the
app all import it and call set_lamp(), get_status() and read_pat_log().

Arduino protocol (step 4 firmware), one line each way at 115200 baud:
  L,<brightness 0-100>,<seconds 0-1800>  -> start a fade, reply with status JSON
  S                                      -> reply with status JSON

No Arduino on your laptop? Run with SHEEP_FAKE=1 to get a simulated sheep.
"""
import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

# ---- settings ----
PORT = None              # None = auto-detect. Or set e.g. "/dev/cu.usbmodem1101" or "COM5"
BAUD = 115200
DEMO_SPEEDUP = 1         # 60 = a 30-minute sunrise plays in 30 seconds (stage demo)
MAX_BRIGHTNESS = 100     # matches the firmware cap
MAX_MINUTES = 30
LOG_FILE = Path(__file__).with_name("pats.jsonl")
POLL_SECONDS = 0.5
FAKE = os.environ.get("SHEEP_FAKE") == "1"

_ser = None
_lock = threading.Lock()
_connect_lock = threading.Lock()
_fake = {"ok": True, "pats": 0, "light": 400, "level": 0.0, "target": 0.0, "simulated": True}


def _find_port():
    from serial.tools import list_ports
    ports = list(list_ports.comports())
    for p in ports:
        text = f"{p.device} {p.description} {p.manufacturer}".lower()
        if p.vid == 0x2341 or "arduino" in text or "usbmodem" in text:
            return p.device
    names = ", ".join(p.device for p in ports) or "none"
    raise RuntimeError(f"No Arduino found. Ports seen: {names}. Set PORT in sheep.py.")


def connect():
    """Open the USB port and start the pat logger. Safe to call more than once."""
    global _ser
    with _connect_lock:
        if _ser is not None or FAKE:
            return
        import serial
        port = PORT or _find_port()
        try:
            _ser = serial.Serial(port, BAUD, timeout=1)
        except serial.SerialException as e:
            raise RuntimeError(f"Can't open {port}. Close the Arduino Serial Monitor "
                               f"and any other script using it. ({e})")
        time.sleep(2)                    # the board may restart when the port opens
        _ser.reset_input_buffer()
        threading.Thread(target=_poll_loop, daemon=True).start()


def _send(cmd):
    if FAKE:
        if cmd.startswith("L,"):
            _fake["target"] = _fake["level"] = float(cmd.split(",")[1])
        return dict(_fake)
    connect()
    with _lock:
        _ser.write((cmd + "\n").encode())
        for _ in range(3):               # skip any stray non-JSON lines
            line = _ser.readline().decode(errors="ignore").strip()
            if line.startswith("{"):
                return json.loads(line)
    raise RuntimeError(f"No reply from the Arduino to '{cmd}'. Is the step 4 firmware uploaded?")


def set_lamp(brightness, minutes):
    """Fade the light to brightness (0-100) over minutes (0-30), starting from
    its current level. Returns the sheep's status."""
    b = int(max(0, min(MAX_BRIGHTNESS, round(float(brightness)))))
    m = max(0.0, min(MAX_MINUTES, float(minutes)))
    seconds = m * 60 / DEMO_SPEEDUP
    status = _send(f"L,{b},{seconds:.1f}")
    status["requested"] = {"brightness": b, "minutes": m, "real_seconds": round(seconds, 1)}
    return status


def get_status():
    """pats: pats since the Arduino powered on. light: relative room brightness
    0-1023 (not lux, higher = brighter). level: current brightness 0-100.
    target: brightness it's fading toward."""
    return _send("S")


def read_pat_log(limit=50):
    """Most recent pats, oldest first:
    [{"ts": "2026-10-24T23:41:05", "count_since_boot": 3}, ...]"""
    if not LOG_FILE.exists():
        return []
    lines = LOG_FILE.read_text().splitlines()[-limit:]
    return [json.loads(line) for line in lines if line.strip()]


def _poll_loop():
    """Background thread: checks the pat count and timestamps each new pat."""
    last = None
    while True:
        try:
            pats = _send("S").get("pats", 0)
            if last is None or pats < last:      # first read, or the Arduino restarted
                last = pats
            elif pats > last:
                now = datetime.now().isoformat(timespec="seconds")
                with LOG_FILE.open("a") as f:
                    for n in range(last + 1, pats + 1):
                        f.write(json.dumps({"ts": now, "count_since_boot": n}) + "\n")
                last = pats
        except Exception as e:
            print(f"[sheep] poll error: {e}")
            time.sleep(2)
        time.sleep(POLL_SECONDS)


# ---- for the agent: Claude tool definitions + a dispatcher ----
TOOLS = [
    {
        "name": "set_lamp",
        "description": ("Fade the sheep's warm light to a brightness (0-100) over a number of "
                        "minutes (0-30), starting from its current level. Use long, slow fades "
                        "(20-30 minutes) for a sunrise. Brightness 0 turns it off."),
        "input_schema": {
            "type": "object",
            "properties": {
                "brightness": {"type": "integer", "minimum": 0, "maximum": 100},
                "minutes": {"type": "number", "minimum": 0, "maximum": 30},
            },
            "required": ["brightness", "minutes"],
        },
    },
    {
        "name": "get_status",
        "description": ("Read the sheep right now: pats since power-on, room light (relative "
                        "0-1023 from a light sensor, not lux; higher is brighter), and the "
                        "light's current level and target (0-100)."),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_pat_log",
        "description": ("Timestamped head pats, oldest first. The user pats the sheep at bedtime "
                        "and again on waking, so this is a rough sleep log (a proxy, not "
                        "clinical sleep data)."),
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200}},
        },
    },
]


def call_tool(name, args):
    """Run a tool Claude asked for. Returns a dict; json.dumps it into the tool_result."""
    if name == "set_lamp":
        return set_lamp(args["brightness"], args["minutes"])
    if name == "get_status":
        return get_status()
    if name == "read_pat_log":
        return {"pats": read_pat_log(args.get("limit", 50))}
    return {"error": f"unknown tool {name}"}


# ---- self-test: python sheep.py ----
if __name__ == "__main__":
    connect()
    print("Connected:", get_status())
    print("Sunrise test: fading up over 12 seconds. Tap the sheep's head a few times.")
    print(set_lamp(100, 0.2 * DEMO_SPEEDUP))
    for _ in range(7):
        time.sleep(2)
        s = get_status()
        print(f"level {s['level']:5.1f}   light {s['light']:4d}   pats {s['pats']}")
    print("Fading off over 6 seconds...")
    set_lamp(0, 0.1 * DEMO_SPEEDUP)
    time.sleep(7)
    print("Last logged pats:", read_pat_log(5))
