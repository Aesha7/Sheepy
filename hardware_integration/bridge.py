"""
bridge.py - lets the Node server use sheep.py over USB.

The Node server starts this as a child process and talks to it with one JSON
object per line:

  -> {"id": 1, "cmd": "set_lamp", "args": {"brightness": 80, "minutes": 30}}
  <- {"id": 1, "ok": true, "result": {...status...}}
  -> {"id": 2, "cmd": "get_status", "args": {}}
  <- {"id": 2, "ok": false, "error": "No Arduino found ..."}

sheep.py stays the only code that touches the serial port (and its pat logger
keeps running). Demo speedup comes from the SHEEP_DEMO_SPEEDUP env var.
"""
import json
import os
import sys

import sheep

sheep.DEMO_SPEEDUP = float(os.environ.get("SHEEP_DEMO_SPEEDUP", "1") or 1)
if os.environ.get("SHEEP_PORT"):
    sheep.PORT = os.environ["SHEEP_PORT"]


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        sheep.connect()
        reply({"id": 0, "ok": True, "event": "ready", "port": sheep.PORT or "auto",
               "fake": sheep.FAKE, "speedup": sheep.DEMO_SPEEDUP})
    except Exception as e:  # keep running: the server shows the error and can retry
        reply({"id": 0, "ok": False, "event": "connect_failed", "error": str(e)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            reply({"id": None, "ok": False, "error": "bad JSON"})
            continue
        mid = msg.get("id")
        try:
            result = sheep.call_tool(msg.get("cmd"), msg.get("args") or {})
            if isinstance(result, dict) and "error" in result and len(result) == 1:
                reply({"id": mid, "ok": False, "error": result["error"]})
            else:
                reply({"id": mid, "ok": True, "result": result})
        except Exception as e:
            reply({"id": mid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
