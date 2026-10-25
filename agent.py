"""Interactive laptop fallback: SHEEP_FAKE=1 python3 agent.py.

ANTHROPIC_API_KEY is read only from the environment, never printed or stored.
"""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
from datetime import datetime
import sheep

SYSTEM = Path(__file__).with_name("Docs").joinpath("AGENT_PROMPT.md").read_text()


def request_message(messages):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("Set ANTHROPIC_API_KEY in your environment.")
    body = {"model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
            "max_tokens": 1024, "system": SYSTEM + "\nCurrent laptop time: " + datetime.now().astimezone().isoformat(),
            "tools": sheep.TOOLS, "messages": messages}
    request = urllib.request.Request("https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(), method="POST", headers={
            "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Claude HTTP {exc.code}; check key, model, credits, or connection.") from None


def respond(messages, text, request=request_message, dispatch=sheep.call_tool):
    messages.append({"role": "user", "content": text})
    for _ in range(12):
        response = request(messages)
        content = response["content"]
        stop = response["stop_reason"]
        if stop == "max_tokens":
            raise RuntimeError("Truncated Claude response; no tools from this response were run.")
        calls = [block for block in content if block["type"] == "tool_use"]
        if stop == "tool_use":
            if not calls or any(not isinstance(call.get("id"), str) or not isinstance(call.get("name"), str)
                                or not isinstance(call.get("input"), dict) for call in calls):
                raise RuntimeError("Malformed Claude tool call")
            messages.append({"role": "assistant", "content": content})
            results = []
            for call in calls:
                result = {"type": "tool_result", "tool_use_id": call["id"]}
                try:
                    result["content"] = json.dumps(dispatch(call["name"], call["input"]))
                except Exception as exc:
                    result.update(is_error=True, content=str(exc))
                results.append(result)
            messages.append({"role": "user", "content": results})
            continue
        if calls:
            raise RuntimeError("Unexpected tool blocks; no commands were sent.")
        messages.append({"role": "assistant", "content": content})
        answer = "\n".join(block["text"] for block in content if block["type"] == "text")
        if not answer:
            raise RuntimeError(f"Claude returned no explanation ({stop}).")
        return answer
    raise RuntimeError("Stopped after 12 tool rounds. Check sheep status before trying again.")


def main():
    print("Sleep Sheep · " + ("SIMULATED hardware" if sheep.FAKE else "USB hardware"))
    print(f"Demo speedup: {sheep.DEMO_SPEEDUP:g}×. Type /quit to exit.")
    messages = []
    try:
        while True:
            text = input("You: ").strip()
            if text == "/quit":
                break
            if not text:
                continue
            try:
                print("Sheep:", respond(messages, text))
            except Exception as exc:
                print(f"Error: {exc}. Previously sent lamp commands may still be running.")
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        sheep.close()


if __name__ == "__main__":
    main()
