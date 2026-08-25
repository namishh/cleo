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

from flask import Flask, Response, jsonify, request
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
    "navigate": "Replace the current page's URL — the old page is gone. Use for moving the workflow to a different site, search page, or product page. Requires url.",
    "open_tab": "Open url in a NEW background tab WITHOUT leaving the current page — the current page stays open and the new tab joins this chat's tab pool. Use whenever the user says \"open a new tab\", \"in another tab\", \"alongside\", \"without leaving this page\", or when a comparison/research benefits from keeping the current page open. Requires url.",
    "switch_tab": "Switch work to another tab in this chat's pool. Requires tab (e.g. \"t2\"). The next observation will come from that tab.",
    "close_tab": "Close a pool tab when you're done with it. Optional tab (defaults to current).",
    "scroll_into_view": "Scroll a tree element into view. Requires id.",
    "hover": "Hover over a tree element by id (preferred) or coordinates. With id, x/y are optional.",
    "pdf": "Save a printable PDF of the current page to a file. Optional filename (default page.pdf).",
    "back": "Go back to the previous page (e.g. return from a detail page to the results list).",
    "forward": "Go forward one page.",
    "remember": "Store one fact you read on the current page for the final summary. Requires fact. Use repeatedly while researching.",
    "download": "Download a file directly without clicking any button. Requires id (element from the tree with src/href) or url. Optional filename.",
    "read_text": "Read the page's visible text exactly (PII masked). Optional id to read a single element. Use this for reading numbers/values instead of relying on the screenshot.",
    "wait": "Wait N milliseconds for the page to settle. Requires ms.",
    "done": "The task is complete.",
    "fail": "The task cannot be completed; include a reason.",
}

SYSTEM_PROMPT = f"""You are a browser automation agent executing a compiled task spec. You receive:
1. The task spec: goal, task_type, success_criteria, constraints, ambiguities.
2. A redacted screenshot of the current viewport (some areas are black-boxed; those contain private data — you may still interact with them, you just cannot read them).
3. A compact accessibility tree listing actionable elements with [id], role, sanitized name, position (x,y,w,h), state, and safe link href/image alt metadata.

Decide the next action(s) to progress toward the success criteria.

Available actions (return one JSON object per action):
{json.dumps(ACTION_SPACE, indent=2)}

Respond with a JSON object of this exact shape:
{{"actions": [ <action>, <action>, ... ], "note": "<optional short instruction to the operator>", "answer": "<optional direct answer to the user>"}}

Rules:
- If the user's request is a question or informational (summarize, sum numbers, read a value, describe something), return {{"answer": "<the answer>", "actions": []}}. The answer is shown directly to the user and the run ends.
- "actions" is a list of 1 to 5 actions to execute in order. The ONLY case where "actions" may be empty is together with an "answer" (or a fail). If you cannot decide, return {{type: "fail", reason: "..."}} instead of an empty list.
- Use multiple steps only when they are safe without seeing intermediate results (e.g. type + key Enter). Never chain actions whose outcome you need to observe first — return one action and wait for the next screenshot instead.
- Coordinates are in CSS pixels relative to the screenshot's top-left corner. Use the numbers inside @ (x,y,w,h) from the tree, e.g. click the center of an element.
- Prefer an element id from the tree, e.g. {{"type":"click","id":"e12"}}; the extension resolves it to the current element center.
- For tasks that need exact values (totals, percentages, prices), call read_text first and compute from the exact text — the screenshot may be inaccurate.
- For downloading images/audio/files, use download with the element id (images expose src, links expose href) instead of looking for a download button.
- Scroll may omit x/y. The extension supplies a safe default.
- Prefer acting on elements from the tree; use the screenshot for anything not in the tree.
- Example response (by coordinates): {{"actions": [{{"type": "click", "x": 120, "y": 340}}], "note": "Clicking the submit button"}}
- Example response (by element id): {{"actions": [{{"type": "click", "id": "e62"}}], "note": "Clicking the image"}}
- Example response (search): {{"actions": [{{"type": "click", "id": "e5"}}, {{"type": "type", "text": "query"}}, {{"type": "key", "key": "Enter"}}], "note": "Searching"}}
- NEVER nest action objects like {{"click": {{"id": "e62"}}}}. Always use the flat {{"type": "..."}} form.
- To move to a different site or jump straight to a known page, use navigate with a full URL — it is faster than clicking through menus.
- The tree's first line lists this chat's tab pool. Use open_tab to research in parallel (e.g. open each product page in its own tab), switch_tab to move between them, and read_text after switching to read a tab's content. Actions apply to the current tab.
- End the list with {{"type": "done"}} only when the task is fully complete.
- Completion check: compare the screen against the spec's success_criteria. Every criterion met → return done (or the answer). If yes, return done immediately instead of continuing to act.
- The spec's constraints (brand, feature, budget, quantity...) are hard requirements. Do not drift from them mid-task, and do not forget filters you already applied.
- Reporting rule: if the task asks you to find, read, extract, calculate, or compare ANY information (totals, percentages, prices, names, counts), you MUST finish with an answer containing the result — e.g. {{"answer": "Total lectures: 40, attended: 32 (80%)"}} with empty actions. Do the math yourself from the values you read. NEVER return done for such tasks without an answer; a bare done means the user gets nothing.
- Once you have READ the needed value (use remember immediately), any remaining cleanup (close_tab etc.) can go in the SAME response as later work — but as soon as the remembered facts satisfy the success criteria, your VERY NEXT response must be the final answer with empty actions. Do not re-open pages you already read; the remembered facts are still available to you.
- {{"type": "done"}} is only for tasks where nothing needs to be reported back (e.g. pure navigation, clicking a button). If useful context remains, include it as a summary field: {{"type": "done", "summary": "..."}}.
- Research-style tasks (find, look for, compare, list, cheapest/best X, summarize top N): once the sorted/filtered results are on screen, open each relevant item (click its link), read its details, store the key facts with a remember action, then use back to return to the list and open the next item. After collecting all items, return an answer summarizing the findings — e.g. the top N items with names, prices, and any requested details — with an empty actions list. Do not keep scrolling after the requested results are visible.
- Use remember for every fact you may need later (names, prices, specs, totals); remembered facts survive page changes and are shown back to you in later steps.
- Do not scroll endlessly. After roughly 2–3 screens of scrolling without finding new relevant content, summarize what you have found in an answer, or return fail if nothing matches.
- If the history shows an action produced no visible change, do NOT repeat it. Change approach or return done/fail.
- The tree may contain a "Page scroll" line and [rN] scrollable regions (filter panels, sidebars, lists). Content often exists below the fold or inside those regions: scroll the page or scroll inside a region (use its center coordinates) to reveal more options before concluding something is missing.
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


def _ask_openrouter(image_url: str, tree: str, task: str, history, hint: str = "", findings=None, spec=None, stream: bool = False):
    user_text = f"Task: {task}\n\nAccessibility tree:\n{tree}"
    if spec:
        user_text = "Task spec:\n" + json.dumps(spec, indent=2) + "\n\n" + user_text
    if findings:
        user_text += "\n\nFacts remembered from earlier pages:\n" + json.dumps(findings, indent=2)
    if history:
        user_text += "\n\nPrevious actions:\n" + json.dumps(history, indent=2)
    if hint:
        user_text += f"\n\nOperator hint: {hint}"
    user_text += "\n\nDecide the next action(s)."

    return client.chat.send(
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
        stream=stream,
    )


def _extract_text(chunk) -> str:
    """Pull incremental text out of an OpenRouter stream chunk."""
    try:
        delta = chunk.choices[0].delta
        return delta.content or ""
    except (AttributeError, IndexError, TypeError):
        return ""


def _finish_stream(raw: str) -> dict:
    actions, note, answer = _parse_response(raw)
    return {"type": "result", "actions": actions, "note": note, "answer": answer, "raw": raw}


def _normalize_action(action):
    """Accept flat actions and the common nested LLM mistake."""
    if not isinstance(action, dict):
        return None
    if "type" in action:
        return action
    # {"click": {"id": "e62"}} -> {"type": "click", "id": "e62"}
    if len(action) == 1:
        key, value = next(iter(action.items()))
        if key in ACTION_SPACE and isinstance(value, dict):
            return {"type": key, **value}
    return None


def _parse_response(raw: str) -> tuple[list, str | None, str | None]:
    """Parse the model reply into (actions, note, answer).

    Accepts either the full {"actions": [...], "note": ..., "answer": ...}
    envelope or a bare single action / bare list of actions. A plain-text reply
    with no JSON is surfaced as an operator note with no actions.
    """
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            raw_actions = parsed.get("actions")
            if isinstance(raw_actions, list):
                actions = raw_actions
            elif isinstance(raw_actions, dict):
                actions = [raw_actions]
            elif "type" in parsed:
                actions = [parsed]
            elif isinstance(parsed.get("answer"), str):
                # Answer-only reply: no browser actions, just text for the user.
                actions = []
            else:
                actions = None
            note = parsed.get("note") if isinstance(parsed.get("note"), str) else None
            answer = parsed.get("answer") if isinstance(parsed.get("answer"), str) else None
            if actions is not None:
                normalized = [_normalize_action(a) for a in actions]
                try:
                    return _validate_actions(normalized), note, answer
                except ValueError as e:
                    return [], f"Malformed actions ({e}): {text}", answer

    # Bare list of actions?
    list_start, list_end = text.find("["), text.rfind("]")
    if list_start != -1 and list_end != -1:
        try:
            parsed_list = json.loads(text[list_start : list_end + 1])
        except json.JSONDecodeError:
            parsed_list = None
        if isinstance(parsed_list, list):
            normalized = [_normalize_action(a) for a in parsed_list]
            try:
                return _validate_actions(normalized), None, None
            except ValueError as e:
                return [], f"Malformed actions ({e}): {text}", None

    # No JSON at all — treat the whole reply as an operator note.
    return [], (raw.strip() or None), None


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
            hint = body.get("hint", "")
            findings = body.get("findings", [])
            spec = body.get("spec")
        else:
            image_url = _image_to_data_url(
                file_storage=request.files.get("image"),
                b64=request.form.get("image_b64"),
            )
            tree = request.form.get("tree", "")
            task = request.form.get("task", "")
            history = json.loads(request.form.get("history", "[]"))
            hint = request.form.get("hint", "")
            findings = json.loads(request.form.get("findings", "[]"))
            spec = json.loads(request.form.get("spec", "null"))

        if not tree and not image_url:
            return jsonify({"error": "tree or image required"}), 400

        actions, note, answer = _ask_openrouter(image_url, tree, task, history, hint, findings, spec)
        return jsonify({"actions": actions, "note": note, "answer": answer})
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # openrouter SDK raises its own error types
        return jsonify({"error": f"OpenRouter request failed: {e}"}), 502


@app.post("/ask_stream")
def ask_stream():
    try:
        body = request.get_json(force=True)
        image_url = _image_to_data_url(b64=body.get("image_b64"))
        tree = body.get("tree", "")
        task = body.get("task", "")
        history = body.get("history", [])
        hint = body.get("hint", "")
        findings = body.get("findings", [])
        spec = body.get("spec")
    except (ValueError, KeyError) as e:
        return jsonify({"error": str(e)}), 400

    def generate():
        accumulated = []
        try:
            stream = _ask_openrouter(image_url, tree, task, history, hint, findings, spec, stream=True)
            for chunk in stream:
                text = _extract_text(chunk)
                if text:
                    accumulated.append(text)
                    yield f"data: {json.dumps({'type': 'delta', 'text': text})}\n\n"
        except Exception as e:  # stream errors must still reach the client
            yield f"data: {json.dumps({'type': 'result', 'actions': [], 'note': f'OpenRouter request failed: {e}', 'answer': None})}\n\n"
            return

        raw = "".join(accumulated)
        actions, note, answer = _parse_response(raw)
        yield "data: " + json.dumps(
            {"type": "result", "actions": actions, "note": note, "answer": answer}
        ) + "\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


TASK_COMPILER_PROMPT = """You are a task compiler for a browser automation agent. Convert the user's raw request into an execution spec. Do not write prose. Do not add features the user didn't ask for. Infer reasonable defaults but list them under "ambiguities".

Output a JSON object with exactly these fields:
{
  "goal": "one sentence, imperative, no fluff",
  "task_type": "one of [navigate_only, form_fill, research_ranked, research_single, extract_data, question, transaction]",
  "success_criteria": ["1-4 checkable statements about the END STATE of the browser, not the steps to get there"],
  "constraints": {"only explicit or strongly-implied parameters, e.g. brand, feature, budget, quantity; null if none"},
  "ambiguities": ["anything you guessed or the user left vague"],
  "expected_answer_format": "how the final answer should be presented, e.g. 'top 5 with name and price', or null if nothing needs reporting"
}

Rules:
- success_criteria describe END STATES, never actions. "Results sorted by price ascending" is good. "Click the sort button" is bad — clicking is the agent's job.
- If the request is a question (sum, compare, what is), set task_type=question and describe the expected answer format.
- Output only the JSON object.
"""


@app.post("/compile")
def compile_task():
    """Intermediate model: raw user request -> structured execution spec."""
    try:
        text = (request.get_json(force=True).get("text") or "")[:2000]
        if not text.strip():
            return jsonify({"error": "text required"}), 400
        existing = request.get_json(force=True).get("spec")
        prompt = TASK_COMPILER_PROMPT
        user_content = text
        if existing:
            user_content = f"Current spec:\n{json.dumps(existing, indent=2)}\n\nUser follow-up: {text}\n\nReturn the updated spec."
        response = client.chat.send(
            model=MODEL,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_content},
            ],
            max_tokens=400,
            temperature=0,
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content or ""
        start, end = raw.find("{"), raw.rfind("}")
        spec = json.loads(raw[start : end + 1])
        return jsonify({"spec": spec})
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        return jsonify({"error": f"spec compilation failed: {e}"}), 400
    except Exception as e:
        return jsonify({"error": f"OpenRouter request failed: {e}"}), 502


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
