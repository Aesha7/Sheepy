import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["SHEEP_FAKE"] = "1"
import sheep
import agent
import server
import io


class SheepTests(unittest.TestCase):
    def setUp(self):
        sheep.close()
        self.directory = tempfile.TemporaryDirectory()
        sheep.LOG_FILE = Path(self.directory.name) / "pats.jsonl"
        sheep._last_pat = None
        sheep._log_error = None
        sheep._fake.update(pats=0, level=0.0, target=0.0)
        sheep._fade = (0, 0, 0)
        sheep.DEMO_SPEEDUP = 1

    def tearDown(self):
        sheep.close()
        self.directory.cleanup()

    def test_clamps_rounding_and_speedup(self):
        self.assertEqual(sheep.lamp_command(500, 9999)[0], "L,100,1800.0")
        self.assertEqual(sheep.lamp_command(-1, -1)[0], "L,0,0.0")
        self.assertEqual(sheep.lamp_command(80.5, 0)[0], "L,80,0.0")
        self.assertEqual(sheep.lamp_command(81.5, 0)[0], "L,82,0.0")
        sheep.DEMO_SPEEDUP = 60
        self.assertEqual(sheep.lamp_command(80, 30)[0], "L,80,30.0")
        for value in [float("nan"), float("inf"), True, "80"]:
            with self.assertRaises(ValueError):
                sheep.lamp_command(value, 10)
        sheep.DEMO_SPEEDUP = 0
        with self.assertRaises(ValueError):
            sheep.lamp_command(80, 30)

    def test_fake_fades_instead_of_jumping(self):
        with patch("sheep.time.monotonic", return_value=100):
            start = sheep.set_lamp(100, 1)
        self.assertEqual(start["target"], 100)
        self.assertEqual(start["level"], 0)
        with patch("sheep.time.monotonic", return_value=130):
            self.assertAlmostEqual(sheep.get_status()["level"], 50)
        with patch("sheep.time.monotonic", return_value=160):
            self.assertEqual(sheep.get_status()["level"], 100)
        self.assertTrue(start["simulated"])

    def test_pat_baseline_increments_reboot_and_limits(self):
        # Deterministic logger exercise, without the background poller.
        sheep._record_pats(4)
        self.assertFalse(sheep.LOG_FILE.exists())
        sheep._record_pats(7)
        sheep._record_pats(7)
        sheep._record_pats(0)
        sheep._record_pats(1)
        records = [json.loads(line) for line in sheep.LOG_FILE.read_text().splitlines()]
        self.assertEqual([record["count_since_boot"] for record in records], [5, 6, 7, 1])
        self.assertTrue(all("+" in r["ts"] or "-" in r["ts"][19:] for r in records))
        with patch("sheep.connect"):
            self.assertEqual(sheep.read_pat_log(2), records[-2:])
            self.assertEqual(sheep.read_pat_log(0), records[-1:])

    def test_fake_starts_one_logger_and_logs_pats(self):
        sheep.get_status()
        thread = sheep._thread
        sheep.get_status()
        self.assertIs(sheep._thread, thread)
        sheep.simulate_pat()
        self.assertEqual(len(sheep.read_pat_log()), 1)
        self.assertTrue(sheep.call_tool("read_pat_log", {})["simulated"])

    def test_usb_newline_and_status_errors(self):
        class Serial:
            def reset_input_buffer(self): pass
            def write(self, value): self.written = value
            def readline(self): return b'{"ok":true,"pats":4,"light":412,"level":35,"target":80}\n'
        serial = Serial()
        with patch("sheep.FAKE", False), patch("sheep._ser", serial), patch("sheep.connect"):
            self.assertEqual(sheep.get_status()["pats"], 4)
            self.assertEqual(serial.written, b"S\n")
            sheep.set_lamp(80, 30)
            self.assertEqual(serial.written, b"L,80,1800.0\n")
            with patch.object(serial, "readline", return_value=b'{"ok":false}\n'):
                with self.assertRaises(RuntimeError): sheep.get_status()
            with patch.object(serial, "readline", return_value=b"booting\n"):
                with self.assertRaisesRegex(RuntimeError, "may already be running"): sheep.get_status()


class AgentTests(unittest.TestCase):
    def test_multiple_tools_and_error_result_order(self):
        history = []
        calls = [
            {"type": "tool_use", "id": "a", "name": "get_status", "input": {}},
            {"type": "tool_use", "id": "b", "name": "set_lamp", "input": {"brightness": 80, "minutes": 30}},
        ]
        replies = iter([
            {"stop_reason": "tool_use", "content": [{"type": "text", "text": "Checking"}] + calls},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Sheep disconnected."}]},
        ])
        def dispatch(name, args):
            if name == "set_lamp": raise RuntimeError("Disconnected")
            return {"pats": 4}
        answer = agent.respond(history, "Sunrise", lambda _: next(replies), dispatch)
        self.assertEqual(answer, "Sheep disconnected.")
        self.assertEqual([item["role"] for item in history], ["user", "assistant", "user", "assistant"])
        self.assertEqual(history[2]["content"][0]["tool_use_id"], "a")
        self.assertEqual(history[2]["content"][1]["tool_use_id"], "b")
        self.assertTrue(history[2]["content"][1]["is_error"])

    def test_truncated_tools_never_execute(self):
        def dispatch(*_): self.fail("Executed truncated tool")
        with self.assertRaisesRegex(RuntimeError, "Truncated"):
            agent.respond([], "Test", lambda _: {"stop_reason": "max_tokens", "content": [
                {"type": "tool_use", "id": "a", "name": "set_lamp", "input": {}}
            ]}, dispatch)

    def test_http_failure_keeps_completed_actions(self):
        history = []
        def request(messages):
            if len(messages) > 1: raise RuntimeError("Network failure")
            return {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "a", "name": "set_lamp", "input": {}}]}
        with self.assertRaisesRegex(RuntimeError, "Network failure"):
            agent.respond(history, "Sunrise", request, lambda *_: {"ok": True})
        self.assertEqual(history[-1]["content"][0]["content"], '{"ok": true}')


class ServerTests(unittest.TestCase):
    def handler(self, path, body=None, token=None):
        handler = object.__new__(server.Handler)
        handler.path = path
        raw = json.dumps(body).encode() if body is not None else b""
        handler.headers = {"X-Sheep-Token": token or server.TOKEN, "Content-Length": str(len(raw))}
        handler.rfile = io.BytesIO(raw)
        handler.replies = []
        handler.reply = lambda code, value, *args: handler.replies.append((code, value))
        return handler

    def test_status_requires_token(self):
        handler = self.handler("/status", token="wrong")
        handler.do_GET()
        self.assertEqual(handler.replies[0][0], 403)

    def test_status_is_explicitly_simulated(self):
        handler = self.handler("/status")
        with patch("server.sheep.get_status", return_value={"simulated": True}), patch("server.sheep.read_pat_log", return_value=[]):
            handler.do_GET()
        self.assertTrue(handler.replies[0][1]["status"]["simulated"])

    def test_chat_validation_and_success(self):
        invalid = self.handler("/chat", {"message": ""})
        invalid.do_POST()
        self.assertEqual(invalid.replies[0][0], 400)
        valid = self.handler("/chat", {"message": "Start sunrise"})
        with patch("server.agent.respond", return_value="Starting now") as respond:
            valid.do_POST()
            respond.assert_called_once_with(server.MESSAGES, "Start sunrise")
        self.assertEqual(valid.replies[0][1]["answer"], "Starting now")

    def test_busy_chat_is_not_queued_or_replayed(self):
        handler = self.handler("/chat", {"message": "Start sunrise"})
        with server.CHAT_LOCK:
            handler.do_POST()
        self.assertEqual(handler.replies[0][0], 409)


if __name__ == "__main__":
    unittest.main()
