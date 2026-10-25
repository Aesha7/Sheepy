"""Phone web fallback. This process alone imports sheep and owns the USB port."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading
from urllib.parse import urlsplit

import agent
import sheep

TOKEN = secrets.token_urlsafe(24)
MESSAGES = []
CHAT_LOCK = threading.Lock()
PAGE = Path(__file__).with_name("Fallback").joinpath("index.html").read_bytes()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not record the access token or conversations in access logs.

    def reply(self, code, value, content_type="application/json"):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not secrets.compare_digest(self.headers.get("X-Sheep-Token", ""), TOKEN):
            self.reply(403, {"error": "Open the full access link printed by the laptop server."})
            return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            self.reply(200, PAGE, "text/html; charset=utf-8")
        elif path == "/status" and self.authorized():
            try:
                self.reply(200, {"status": sheep.get_status(), "pats": sheep.read_pat_log(10),
                                 "speedup": sheep.DEMO_SPEEDUP})
            except Exception as exc:
                self.reply(503, {"error": str(exc)})
        elif path != "/status":
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authorized():
            return
        if urlsplit(self.path).path != "/chat":
            self.reply(404, {"error": "Not found"}); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Message is empty or too long")
            body = json.loads(self.rfile.read(length))
            text = body.get("message") if isinstance(body, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                raise ValueError("Enter a message of 1–4000 characters")
        except (ValueError, UnicodeDecodeError) as exc:
            self.reply(400, {"error": str(exc)}); return
        if not CHAT_LOCK.acquire(blocking=False):
            self.reply(409, {"error": "Sheep is already handling a request. Wait for it to finish."}); return
        try:
            answer = agent.respond(MESSAGES, text)
            self.reply(200, {"answer": answer})
        except Exception as exc:
            self.reply(503, {"error": str(exc) + ". Previously sent lamp commands may still be running."})
        finally:
            CHAT_LOCK.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Open http://localhost:{args.port}/#token={TOKEN}")
    if args.host == "0.0.0.0":
        print("On your phone, replace localhost with the laptop's Wi-Fi IP; keep the #token fragment.")
    print("SIMULATED hardware" if sheep.FAKE else "USB hardware · close Arduino Serial Monitor")
    print(f"Demo timing: {sheep.DEMO_SPEEDUP:g}× speedup")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        sheep.close()


if __name__ == "__main__":
    main()
