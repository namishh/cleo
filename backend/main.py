"""Minimal Flask server: receives a redacted screenshot + compact a11y tree,
asks an OpenRouter vision model for the next browser action, returns it as JSON.

POST /ask
  multipart/form-data or JSON:
    image: file or base64 data URL (redacted screenshot)
    tree: string (compact accessibility tree)
    task: string (what the agent should do)
    history: optional JSON list of previous {action, result} steps

Response:
  {"action": {...}, "raw": "<model text>"}
"""

import base64
import json
import os

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemini-2.0-flash-001")
API_KEY = os.environ["OPENROUTER_API_KEY"]

# The complete action space the model may choose from.
ACTION_SPACE = {
    "click": "Click at viewport pixel coordinates (CSS px).",
    "double_click": "Double-click at coordinates.",
    "right_click": "Right-click at coordinates.",
    "move": "Move the mouse to coordinates (hover, open menus).",
    "scroll": "Scroll at coordinates by a number of wheel ticks (positive = down).",
    "type": "Type text into the currently focused element.",
    "key": "Press a key or combo, e.g. Enter, Tab, Control+a.",
    "drag": "Drag from one coordinate to another.",
    "select": "Select an <option> by visible text inside a <select> at coordinates.",
    "navigate": "Open a URL in the pinned tab.",
    "wait": "Wait N milliseconds for the page to settle.",
    "done": "The task is complete.",
    "fail": "The task cannot be completed; include a reason.",
}

SYSTEM_PROMPT = f"""You are a browser automation agent. You receive:
1. A redacted screenshot of the current viewport (some areas are black-boxed; those contain private data — you may still interact with them, you just cannot read them).
2. A compact accessibility tree listing actionable elements with [id], role, name, position (x,y,w,h) and state.

Decide the single next action to progress the user's task.

Available actions (return exactly one JSON object, no prose):
{json.dumps(ACTION_SPACE, indent=2)}

Rules:
- Coordinates are in CSS pixels relative to the screenshot's top-left corner.
- Prefer clicking elements from the tree by their position; use the screenshot for anything not in the tree.
- One action per response. After each of your actions you will receive a fresh screenshot.
- Return {{"type": "done"}} only when the task is fully complete.
- Return {{"type": "fail", "reason": "..."}} if the task is impossible or you are stuck.
- Output ONLY the JSON object.
"""


def _image_to_data_url(file_storage=None, b64=None) -> str:
    if file_storage and file_storage.filename:
        return (
            "data:"
            + (file_storage.mimetype or "image/png")
            + ";base64,"
            + base64.b64encode(file_storage.read()).decode()
        )
    if b64:
        return b64 if b64.startswith("data:") else "data:image/png;base64," + b64
    raise ValueError("no image provided (send 'image' file or 'image_b64' field)")


def _ask_openrouter(image_url: str, tree: str, task: str, history) -> dict:
    user_content = [
        {"type": "text", "text": f"Task: {task}\n\nAccessibility tree:\n{tree}"},
        {"type": "image_url", "image_url": {"url": image_url}},
    ]
    if history:
        user_content[0]["text"] += "\n\nPrevious actions:\n" + json.dumps(history, indent=2)

    response = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": 300,
            "temperature": 0,
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


def _parse_action(raw: str) -> dict:
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start : end + 1]
    action = json.loads(text)
    if not isinstance(action, dict) or "type" not in action:
        raise ValueError("model response missing 'type'")
    if action["type"] not in ACTION_SPACE:
        raise ValueError(f"unknown action type: {action['type']}")
    return action


@app.post("/ask")
def ask():
    try:
        if request.is_json:
            body = request.get_json(force=True)
            image_url = _image_to_data_url(b64=body.get("image_b64"))
            tree = body.get("tree", "")
            task = body.get("task", "")
            history = body.get("history", [])
        else:
            image_url = _image_to_data_url(
                file_storage=request.files.get("image"),
                b64=request.form.get("image_b64"),
            )
            tree = request.form.get("tree", "")
            task = request.form.get("task", "")
            history = json.loads(request.form.get("history", "[]"))

        if not tree and not image_url:
            return jsonify({"error": "tree or image required"}), 400

        raw = _ask_openrouter(image_url, tree, task, history)
        return jsonify({"action": _parse_action(raw), "raw": raw})
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e)}), 400
    except requests.RequestException as e:
        return jsonify({"error": f"OpenRouter request failed: {e}"}), 502


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
