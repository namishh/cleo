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
# Task compilation (raw request -> structured spec) runs once per task/follow-up,
# not once per step, so it can afford a stronger model even when MODEL is a cheap
# one for the per-step action loop. Falls back to MODEL if unset.
COMPILATION_MODEL = os.environ.get("OPENROUTER_COMPILATION_MODEL", MODEL)
API_KEY = os.environ["OPENROUTER_API_KEY"]
client = OpenRouter(api_key=API_KEY)

# Demo auth: the extension sends this as "Authorization: Bearer <token>" on every
# request. Not real security (it's a shared static token over localhost), just
# enough friction to make this look/behave like a real backend service.
AUTH_TOKEN = os.environ.get("CLEO_AUTH_TOKEN", "9876543210")


@app.before_request
def _require_auth():
    if request.path == "/health":
        return None
    supplied = request.headers.get("Authorization", "")
    if supplied.removeprefix("Bearer ").strip() != AUTH_TOKEN:
        return jsonify({"error": "unauthorized"}), 401

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
2. A compact accessibility tree listing actionable elements with [id], role, sanitized name, position (x,y,w,h), state, and safe link href/image alt metadata. This is your PRIMARY source — it is exact text, unlike pixels.
3. A redacted screenshot of the current viewport (some areas are black-boxed; those contain private data — you may still interact with them, you just cannot read them). Use it only for visual context and for elements that have no tree id — never to read exact numbers/text, and never in place of an id that is already available.

Decide the next action(s) to progress toward the success criteria.

Available actions (return one JSON object per action):
{json.dumps(ACTION_SPACE, indent=2)}

Respond with a JSON object of this exact shape:
{{"actions": [ <action>, <action>, ... ], "note": "<optional short instruction to the operator>", "answer": "<optional direct answer to the user>"}}

Rules:
- If the request is a question or informational (summarize, sum numbers, read a value, describe something), return {{"answer": "<the answer>", "actions": []}} and stop.
- "actions" holds 1-5 steps executed in order. It may be empty only together with an "answer" or a "fail" action — never return an empty list alone; use {{"type": "fail", "reason": "..."}} if you cannot decide.
- Ground actions in the tree, not the screenshot: prefer {{"type":"click","id":"e12"}}; the extension resolves the id to the element's current center. Only fall back to numeric x/y (CSS px, screenshot top-left origin) for something visible but absent from the tree.
- Chain multiple actions in one response only when you don't need to see the intermediate result first (e.g. type + key Enter). Otherwise return one action and wait for the next observation.
- For exact values (totals, percentages, prices) call read_text and compute from that text — the screenshot may misread numbers.
- For downloading images/audio/files, use download with the element id (images expose src, links expose href) rather than hunting for a UI download button.
- Scroll may omit x/y; the extension defaults to the viewport center.
- NEVER nest action objects like {{"click": {{"id": "e62"}}}}. Always use the flat {{"type": "..."}} form.
- Example (by element id): {{"actions": [{{"type": "click", "id": "e62"}}], "note": "Clicking the image"}}
- Example (search): {{"actions": [{{"type": "click", "id": "e5"}}, {{"type": "type", "text": "query"}}, {{"type": "key", "key": "Enter"}}], "note": "Searching"}}
- To jump to a known page or a different site, use navigate with a full URL instead of clicking through menus.
- The tree's first line lists this chat's tab pool. Use open_tab to research in parallel, switch_tab to move between tabs, and read_text after switching to read a tab's content. Actions apply to the current tab.
- After each step, compare the screen against the spec's success_criteria; the moment every criterion is met, return done (or the answer) instead of continuing to act. The spec's constraints (brand, feature, budget, quantity...) are hard requirements — do not drift from them or forget filters already applied.
- If the task asks you to find, read, extract, calculate, or compare information, you MUST finish with an answer containing the result (do the math yourself from values you read) — never return a bare done for these tasks. {{"type": "done"}} alone is only for tasks with nothing to report (pure navigation, clicking a button); otherwise add a summary field: {{"type": "done", "summary": "..."}}.
- Remember a needed value as soon as you read it. Once remembered facts satisfy the success criteria, your VERY NEXT response must be the final answer with empty actions — do not re-open pages already read.
- Research-style tasks (find, compare, list, cheapest/best X, summarize top N): once results are on screen, open each relevant item, read its details, remember the key facts, then back to the list for the next item. After collecting all items, answer with the findings (e.g. top N with name/price/details) and empty actions. Stop scrolling once the requested results are visible.
- Use remember for every fact you may need later; remembered facts survive page changes and reappear in later steps.
- Do not scroll endlessly — after roughly 2-3 screens without new relevant content, answer with what you found or return fail.
- If the history shows an action produced no visible change, do NOT repeat it — change approach or return done/fail.
- The tree may list a "Page scroll" line and [rN] scrollable regions (filters, sidebars, lists); content often lives below the fold or inside those regions — scroll the page or a region before concluding something is missing.
- Return {{"type": "fail", "reason": "..."}} if the task is impossible, the thing being
  looked for genuinely does not exist / cannot be found after a real effort (e.g. no result
  matches the constraints, a site/section doesn't exist), or you are stuck with no more
  approaches to try. Do not loop indefinitely or invent an answer when nothing was found —
  conclude instead. "reason" is shown to the user as "Task ended because <reason>.", so
  phrase it as a short clause that reads naturally there (e.g. "no wireless mouse under $5
  exists on the sites checked", not "I failed").
- "note" is optional short free text for the operator about what you're doing right now (e.g. "the submit button is disabled, waiting"). It is never shown to the user as the reply. The actual findings/result always go in "answer" (or a "done" summary) — never leave them only in "note".
- Output ONLY the JSON object.
"""

# Appended to SYSTEM_PROMPT when the operator starts a task in research mode
# (the sidepanel's "research" button). Pushes the model to actually use the
# tab pool instead of answering off a single page, and to report back with a
# structured, sourced answer rather than a one-line summary.
RESEARCH_MODE_ADDENDUM = """

RESEARCH MODE is active for this task. This OVERRIDES the base rule above that says to
answer a question immediately with empty actions — that rule does NOT apply here, even for
questions you already "know" the answer to (e.g. "what are quadratic curves", "best books
for optimization theory for the GATE exam"). You must NEVER answer from your own training
knowledge alone. Go find and read real, current pages first, and answer only from what you
actually read there this task. On any step where you have not yet opened and read at least
one real source in this chat's tab pool, you MUST return actions — not an answer, and not an
empty actions list.

Where to look — pick the site that fits the question, don't default to a plain web search
for everything (all query params below are illustrative; URL-encode the real query):
- No clearly better option / general or current-events question:
  https://www.google.com/search?q=<query>. Treat Google's own AI-generated summary box as
  unreliable and NOT a source — scroll past it and open the actual result links beneath it.
- Academic, technical, or research-paper topics (papers, theorems, algorithms, syllabus/exam
  topics like GATE): https://arxiv.org/abs/... or arxiv.org search, and Google Scholar at
  https://scholar.google.com/scholar?q=<query>.
- Videos, tutorials, walkthroughs: https://www.youtube.com/results?search_query=<query>.
- Images, mood boards, visual/design references: https://unsplash.com/s/photos/<query> and
  https://www.pinterest.com/search/pins/?q=<query>.
- Product prices, specs, reviews: the retailer/marketplace itself (Amazon, etc.) or a search
  scoped to it.
- Opinions, lived experience, recommendations (e.g. "best books for X", "is Y worth it"):
  https://www.reddit.com/search/?q=<query> and relevant subject subreddits/forums — treat
  people's real experience as a legitimate source here, alongside official pages.
- Code, library, or API questions: the project's official docs site or its GitHub repo.
- Wikipedia (https://en.wikipedia.org/wiki/<Topic>) or an official docs page for general
  concept definitions.
Use judgment for anything not listed above — the point is to go to the site suited to the
question, not to reflexively search Google for everything.
- A search results page is a launching point, not a source: read the snippets, then open_tab
  the actual pages that look relevant and read THOSE. Do not treat the search results page
  itself as something you've "read" for the purposes of answering.
- Use 1 tab for a narrow, single-answer question; use several for anything that benefits from
  comparing options or corroborating a claim (aim for 2-3+ independent sources when
  available — a single source is only acceptable when no other exists).
- After open_tab, use switch_tab to move between pool tabs, read_text and remember to
  capture exact facts from each, and close_tab once a tab is fully read and no longer
  needed. Do not re-read a tab you already captured facts from.
- If sources disagree on a fact, note the disagreement in the final answer rather than
  silently picking one.

Reporting the result:
- The findings MUST be returned in the "answer" field (this is what the user sees as the
  agent's reply) — never leave them only in "note"; "note" is only for short transient status
  like "opening search results" and is never shown to the user as the final response.
- The final answer MUST be detailed: use markdown with short headers or bullet points,
  attribute key facts to the source they came from inline (e.g. "According to Wikipedia,
  ..."), and cover the different angles of the question. Do not return a single-sentence
  answer for a research task.
- Do NOT write your own "Sources"/"References" list at the end — the app appends one
  automatically from the pages you actually opened. Just cite sources inline in the prose
  as above.
- If, after checking a few genuinely relevant sources (not just one), what's being asked for
  simply does not exist or cannot be found, use {"type": "fail", "reason": "..."} instead of
  fabricating an answer or continuing to search indefinitely — say specifically what you
  checked and why it came up empty.
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


def _ask_openrouter(image_url: str, tree: str, task: str, history, hint: str = "", findings=None, spec=None, mode: str = "normal", stream: bool = False):
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

    research = mode == "research"
    system_prompt = SYSTEM_PROMPT + RESEARCH_MODE_ADDENDUM if research else SYSTEM_PROMPT

    return client.chat.send(
        model=MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        max_tokens=2200 if research else 800,
        temperature=0,
        response_format={"type": "json_object"},
        # Reasoning-capable models bill "thinking" tokens out of the same max_tokens
        # budget, which can silently eat the whole response and leave nothing for the
        # actual JSON (empty/truncated output, or the provider erroring out entirely).
        # This is a mechanical action-selection task — keep reasoning light so the
        # budget goes to the answer.
        reasoning_effort="low",
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
            mode = body.get("mode", "normal")
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
            mode = request.form.get("mode", "normal")

        if not tree and not image_url:
            return jsonify({"error": "tree or image required"}), 400

        response = _ask_openrouter(image_url, tree, task, history, hint, findings, spec, mode)
        raw = response.choices[0].message.content or ""
        actions, note, answer = _parse_response(raw)
        return jsonify({"actions": actions, "note": note, "answer": answer, "raw": raw})
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
        mode = body.get("mode", "normal")
    except (ValueError, KeyError) as e:
        return jsonify({"error": str(e)}), 400

    def generate():
        accumulated = []
        try:
            stream = _ask_openrouter(image_url, tree, task, history, hint, findings, spec, mode, stream=True)
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
            model=COMPILATION_MODEL,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_content},
            ],
            max_tokens=900,
            temperature=0,
            response_format={"type": "json_object"},
            reasoning_effort="low",
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
    return jsonify({"ok": True, "model": MODEL, "compilation_model": COMPILATION_MODEL})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001)
