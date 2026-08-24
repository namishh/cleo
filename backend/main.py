"""Minimal Flask server: receives a redacted screenshot + compact a11y tree,
asks an OpenRouter vision model for the next browser action(s), returns them.

POST /ask
  JSON or multipart/form-data:
    image / image_b64: redacted screenshot (file upload or base64 data URL)
    tree:   string  — compact accessibility tree
    task:   string  — what the agent should do
    history: optional JSON list of previous {action, result} steps

Response:
  {
    "actions": [ {..}, {..} ],   # 1..N actions, executed in order
    "note": "human-readable guidance (only when the model returns one)",
    "raw": "<model text>"
  }

Run:  uv run python main.py   (needs OPENROUTER_API_KEY in env)
"""

import base64
import json
import os

from flask import Flask, jsonify, request
from openrouter import OpenRouter
import dotenv

dotenv.load_dotenv()

app = Flask(__name__)

MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemini-2.0-flash-001")
API_KEY = os.environ["OPENROUTER_API_KEY"]
client = OpenRouter(api_key=API_KEY)

# The complete action space the model may choose from.
ACTION_SPACE = {
    "click": "Click a tree element by id (preferred) or viewport coordinates (CSS px). With id, x/y are optional.",
    "double_click": "Double-click a tree element by id (preferred) or coordinates. With id, x/y are optional.",
    "right_click": "Right-click a tree element by id (preferred) or coordinates. With id, x/y are optional.",
    "move": "Move the mouse to a tree element by id (preferred) or coordinates. With id, x/y are optional.",
    "scroll": "Scroll up/down by wheel ticks. x/y are optional; the extension defaults to the viewport center. Use amount (or ticks) (default 3).",
    "type": "Type text into the currently focused element. Requires text. Optionally provide x, y to focus first.",
    "key": "Press a key or combo, e.g. Enter, Tab, Control+a. Requires key.",
    "drag": "Drag from one coordinate to another. Requires numeric x, y, x2, y2.",
    "select": "Select an <option> by visible text inside a <select> at coordinates. Requires x, y and option.",
    "navigate": "Open a URL in the pinned tab. Requires url.",
    "wait": "Wait N milliseconds for the page to settle. Requires ms.",
    "done": "The task is complete.",
    "fail": "The task cannot be completed; include a reason.",
}

SYSTEM_PROMPT = f"""You are a browser automation agent. You receive:
1. A redacted screenshot of the current viewport (some areas are black-boxed; those contain private data — you may still interact with them, you just cannot read them).
2. A compact accessibility tree listing actionable elements with [id], role, sanitized name, position (x,y,w,h), state, and safe link href/image alt metadata.

Decide the next action(s) to progress the user's task.

Available actions (return one JSON object per action):
{json.dumps(ACTION_SPACE, indent=2)}

Respond with a JSON object of this exact shape:
{{"actions": [ <action>, <action>, ... ], "note": "<optional short instruction to the operator, e.g. what to look for next, or why you are stuck>"}}

Rules:
- "actions" is a list of 1 to 5 actions to execute in order. Use multiple steps only when they are safe without seeing intermediate results (e.g. type + key Enter). Never chain actions whose outcome you need to observe first — return one action and wait for the next screenshot instead.
- Coordinates are in CSS pixels relative to the screenshot's top-left corner. Use the numbers inside @ (x,y,w,h) from the tree, e.g. click the center of an element.
- Prefer an element id from the tree, e.g. {{"type":"click","id":"e12"}}; the extension resolves it to the current element center.
- Scroll may omit x/y. The extension supplies a safe default.
- Prefer acting on elements from the tree; use the screenshot for anything not in the tree.
- Example response: {{"actions": [{{"type": "click", "x": 120, "y": 340}}], "note": "Clicking the submit button"}}
- End the list with {{"type": "done"}} only when the task is fully complete.
- Return {{"type": "fail", "reason": "..."}} if the task is impossible or you are stuck.
- "note" is optional free text for the operator (e.g. "the submit button is disabled, waiting").
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


def _ask_openrouter(image_url: str, tree: str, task: str, history) -> tuple[list, str | None]:
    user_text = f"Task: {task}\n\nAccessibility tree:\n{tree}"
    if history:
        user_text += "\n\nPrevious actions:\n" + json.dumps(history, indent=2)
    user_text += "\n\nDecide the next action(s)."

    response = client.chat.send(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        max_tokens=800,
        temperature=0,
        response_format={"type": "json_object"},
    )
    raw = response.choices[0].message.content or ""
    actions, note = _parse_response(raw)
    return actions, note


def _parse_response(raw: str) -> tuple[list, str | None]:
    """Parse the model reply into (actions, note).

    Accepts either the full {"actions": [...], "note": ...} envelope or a bare
    single action / bare list of actions. A plain-text reply with no JSON is
    surfaced as an operator note with no actions.
    """
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            if isinstance(parsed.get("actions"), list):
                actions = parsed["actions"]
            elif "type" in parsed:
                actions = [parsed]
            else:
                actions = None
            note = parsed.get("note") if isinstance(parsed.get("note"), str) else None
            if actions is not None:
                try:
                    return _validate_actions(actions), note
                except ValueError as e:
                    return [], f"Malformed actions ({e}): {text}"

    # Bare list of actions?
    list_start, list_end = text.find("["), text.rfind("]")
    if list_start != -1 and list_end != -1:
        try:
            parsed_list = json.loads(text[list_start : list_end + 1])
        except json.JSONDecodeError:
            parsed_list = None
        if isinstance(parsed_list, list):
            try:
                return _validate_actions(parsed_list), None
            except ValueError as e:
                return [], f"Malformed actions ({e}): {text}"

    # No JSON at all — treat the whole reply as an operator note.
    return [], (raw.strip() or None)


def _validate_actions(actions) -> list:
    if len(actions) > 5:
        raise ValueError("actions must contain at most 5 steps")
    validated = []
    for action in actions:
        if not isinstance(action, dict) or "type" not in action:
            raise ValueError("each action must be an object with a 'type'")
        if action["type"] not in ACTION_SPACE:
            raise ValueError(f"unknown action type: {action['type']}")
        validated.append(action)
    return validated


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

        actions, note = _ask_openrouter(image_url, tree, task, history)
        return jsonify({"actions": actions, "note": note})
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # openrouter SDK raises its own error types
        return jsonify({"error": f"OpenRouter request failed: {e}"}), 502


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
