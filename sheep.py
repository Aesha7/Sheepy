"""The only USB hardware owner. Import this module in the agent process.

115200 baud, newline-delimited commands and JSON replies. SHEEP_FAKE=1 uses
an explicitly simulated lamp. Polling begins on the first public API call.
"""
import json
import math
import os
import threading
import time
from datetime import datetime
from pathlib import Path

PORT = os.environ.get("SHEEP_PORT") or None
BAUD = 115200
DEMO_SPEEDUP = float(os.environ.get("DEMO_SPEEDUP", "1"))
MAX_BRIGHTNESS = 100
MAX_MINUTES = 30
POLL_SECONDS = 0.5
FAKE = os.environ.get("SHEEP_FAKE") == "1"
LOG_FILE = Path(os.environ.get("SHEEP_LOG_FILE", str(Path(__file__).with_name(
    "simulated-pats.jsonl" if FAKE else "pats.jsonl"))))
TOOLS = json.loads(Path(__file__).with_name("Resources").joinpath("tools.json").read_text())

_ser = None
_lock = threading.Lock()
_connect_lock = threading.Lock()
_stop = threading.Event()
_thread = None
_last_pat = None
_log_error = None
_fake = {"ok": True, "pats": 0, "light": 400, "level": 0.0, "target": 0.0, "simulated": True}
_fade = (0.0, 0.0, 0.0)  # start monotonic time, initial level, duration


def _find_port():
    from serial.tools import list_ports
    ports = list(list_ports.comports())
    for port in ports:
        text = f"{port.device} {port.description} {port.manufacturer}".lower()
        if port.vid == 0x2341 or "arduino" in text or "usbmodem" in text:
            return port.device
    names = ", ".join(port.device for port in ports) or "none"
    raise RuntimeError(f"No Arduino found. Ports seen: {names}. Set SHEEP_PORT.")


def connect():
    """Open serial once and start one background pat logger, including in fake mode."""
    global _ser, _thread, _last_pat
    with _connect_lock:
        if _thread is not None and _thread.is_alive():
            return
        if not FAKE:
            try:
                import serial
            except ImportError as exc:
                raise RuntimeError("Install requirements.txt for USB, or use SHEEP_FAKE=1.") from exc
            port = PORT or _find_port()
            try:
                _ser = serial.Serial(port, BAUD, timeout=1, write_timeout=1)
            except serial.SerialException as exc:
                raise RuntimeError(f"Can't open {port}. Close Arduino Serial Monitor and other port owners. ({exc})") from exc
            time.sleep(2)
            _ser.reset_input_buffer()
        _last_pat = None
        _stop.clear()
        _thread = threading.Thread(target=_poll_loop, daemon=True, name="sheep-pats")
        _thread.start()


def close():
    global _ser, _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=5)
    with _connect_lock, _lock:
        if _ser is not None:
            _ser.close()
        _ser = None
        _thread = None


def _record_pats(count):
    global _last_pat, _log_error
    if _last_pat is None or count < _last_pat:
        _last_pat = count
        return
    if count > _last_pat:
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            with LOG_FILE.open("a") as stream:
                for value in range(_last_pat + 1, count + 1):
                    stream.write(json.dumps({"ts": now, "count_since_boot": value}) + "\n")
            _log_error = None
        except OSError as exc:
            _log_error = str(exc)
        _last_pat = count


def _advance_fake():
    start, initial, duration = _fade
    progress = 1 if duration <= 0 else min(1, max(0, (time.monotonic() - start) / duration))
    _fake["level"] = initial + (_fake["target"] - initial) * progress


def _send(cmd):
    global _fade
    connect()
    with _lock:
        if FAKE:
            _advance_fake()
            if cmd.startswith("L,"):
                _, brightness, seconds = cmd.split(",")
                _fade = (time.monotonic(), _fake["level"], float(seconds))
                _fake["target"] = float(brightness)
                _advance_fake()
            status = dict(_fake)
        else:
            # Discard replies that arrived after a previous request timed out.
            _ser.reset_input_buffer()
            _ser.write((cmd + "\n").encode("utf-8"))
            status = None
            for _ in range(3):
                line = _ser.readline().decode(errors="replace").strip()
                if line.startswith("{"):
                    try:
                        status = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    break
            if status is None:
                raise RuntimeError(f"No reply to {cmd!r}. Check USB and firmware. A lamp command may already be running; read status before retrying.")
        if not isinstance(status, dict) or status.get("ok") is not True:
            raise RuntimeError(f"Sheep rejected the request: {status}")
        for key, upper in (("pats", None), ("light", 1023), ("level", 100), ("target", 100)):
            value = status.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (upper is not None and value > upper):
                raise RuntimeError(f"Invalid sheep status field: {key}")
        if not isinstance(status["pats"], int):
            raise RuntimeError("Invalid pat count")
        _record_pats(status["pats"])
        return status


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Expected a finite number")
    return float(value)


def lamp_command(brightness, minutes):
    b = int(max(0, min(MAX_BRIGHTNESS, round(_number(brightness)))))
    m = max(0.0, min(MAX_MINUTES, _number(minutes)))
    if not math.isfinite(DEMO_SPEEDUP) or DEMO_SPEEDUP < 1:
        raise ValueError("DEMO_SPEEDUP must be finite and at least 1")
    seconds = m * 60 / DEMO_SPEEDUP
    return f"L,{b},{seconds:.1f}", {"brightness": b, "minutes": m, "real_seconds": round(seconds, 1)}


def set_lamp(brightness, minutes):
    """Start an Arduino-managed fade; minutes are always real intent minutes."""
    command, requested = lamp_command(brightness, minutes)
    status = _send(command)
    status["requested"] = requested
    return status


def get_status():
    return _send("S")


def read_pat_log(limit=50):
    connect()
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ValueError("limit must be an integer")
    limit = max(1, min(200, limit))
    with _lock:
        if _log_error:
            raise RuntimeError(f"Pat log could not be saved: {_log_error}")
        if not LOG_FILE.exists():
            return []
        lines = [line for line in LOG_FILE.read_text().splitlines() if line.strip()]
        return [json.loads(line) for line in lines[-limit:]]


def simulate_pat():
    """Test input only; never offered as an agent hardware tool."""
    if not FAKE:
        raise RuntimeError("simulate_pat requires SHEEP_FAKE=1")
    get_status()  # establish baseline before incrementing
    with _lock:
        _fake["pats"] += 1
    return get_status()


def _poll_loop():
    while not _stop.is_set():
        try:
            _send("S")
        except Exception as exc:
            print(f"[sheep] poll error: {exc}")
            if _stop.wait(2):
                return
        _stop.wait(POLL_SECONDS)


def call_tool(name, args):
    if name == "set_lamp":
        return set_lamp(args["brightness"], args["minutes"])
    if name == "get_status":
        return get_status()
    if name == "read_pat_log":
        result = {"pats": read_pat_log(args.get("limit", 50))}
        if FAKE:
            result["simulated"] = True
        return result
    raise ValueError(f"Unknown tool: {name}")


if __name__ == "__main__":
    try:
        print("Connected:", get_status())
        print("Sunrise test: 12-second fade. Tap the sheep's head.")
        print(set_lamp(100, 0.2 * DEMO_SPEEDUP))
        for _ in range(7):
            time.sleep(2)
            print(get_status())
        print("Fading off over 6 seconds…")
        set_lamp(0, 0.1 * DEMO_SPEEDUP)
        time.sleep(7)
        print("Last logged pats:", read_pat_log(5))
    finally:
        close()
