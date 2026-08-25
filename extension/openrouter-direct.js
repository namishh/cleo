// Standalone client for calling OpenRouter directly from the extension,
// bypassing the Flask backend entirely (the sidepanel's "bypass server"
// setting). Ported from backend/main.py — there is no shared runtime between
// the Python backend and this module, so ACTION_SPACE / SYSTEM_PROMPT /
// RESEARCH_MODE_ADDENDUM / TASK_COMPILER_PROMPT / the response-parsing rules
// must be kept in sync with that file by hand if either changes.

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const ACTION_SPACE = {
  click: "Click a tree element by id (preferred) or viewport coordinates (CSS px). With id, x/y are optional.",
  double_click: "Double-click a tree element by id (preferred) or coordinates. With id, x/y are optional.",
  right_click: "Right-click a tree element by id (preferred) or coordinates. With id, x/y are optional.",
  move: "Move the mouse to a tree element by id (preferred) or coordinates. With id, x/y are optional.",
  scroll: "Scroll up/down by wheel ticks. x/y are optional; the extension defaults to the viewport center. Use amount (or ticks) (default 3).",
  type: "Type text into the currently focused element. Requires text. Optionally provide x, y to focus first.",
  key: "Press a key or combo, e.g. Enter, Tab, Control+a. Requires key.",
  drag: "Drag from one coordinate to another. Requires numeric x, y, x2, y2.",
  select: "Select an <option> by visible text inside a <select> at coordinates. Requires x, y and option.",
  navigate: "Replace the current page's URL — the old page is gone. Use for moving the workflow to a different site, search page, or product page. Requires url.",
  open_tab: 'Open url in a NEW background tab WITHOUT leaving the current page — the current page stays open and the new tab joins this chat\'s tab pool. Use whenever the user says "open a new tab", "in another tab", "alongside", "without leaving this page", or when a comparison/research benefits from keeping the current page open. Requires url.',
  switch_tab: 'Switch work to another tab in this chat\'s pool. Requires tab (e.g. "t2"). The next observation will come from that tab.',
  close_tab: "Close a pool tab when you're done with it. Optional tab (defaults to current).",
  scroll_into_view: "Scroll a tree element into view. Requires id.",
  hover: "Hover over a tree element by id (preferred) or coordinates. With id, x/y are optional.",
  pdf: "Save a printable PDF of the current page to a file. Optional filename (default page.pdf).",
  back: "Go back to the previous page (e.g. return from a detail page to the results list).",
  forward: "Go forward one page.",
  remember: "Store one fact you read on the current page for the final summary. Requires fact. Use repeatedly while researching.",
  download: "Download a file directly without clicking any button. Requires id (element from the tree with src/href) or url. Optional filename.",
  read_text: "Read the page's visible text exactly (PII masked). Optional id to read a single element. Use this for reading numbers/values instead of relying on the screenshot.",
  wait: "Wait N milliseconds for the page to settle. Requires ms.",
  done: "The task is complete.",
  fail: "The task cannot be completed; include a reason.",
};

const SYSTEM_PROMPT = `You are a browser automation agent executing a compiled task spec. You receive:
1. The task spec: goal, task_type, success_criteria, constraints, ambiguities.
2. A compact accessibility tree listing actionable elements with [id], role, sanitized name, position (x,y,w,h), state, and safe link href/image alt metadata. This is your PRIMARY source — it is exact text, unlike pixels.
3. A redacted screenshot of the current viewport (some areas are black-boxed; those contain private data — you may still interact with them, you just cannot read them). Use it only for visual context and for elements that have no tree id — never to read exact numbers/text, and never in place of an id that is already available.

Decide the next action(s) to progress toward the success criteria.

Available actions (return one JSON object per action):
${JSON.stringify(ACTION_SPACE, null, 2)}

Respond with a JSON object of this exact shape:
{"actions": [ <action>, <action>, ... ], "note": "<optional short instruction to the operator>", "answer": "<optional direct answer to the user>"}

Rules:
- If the request is a question or informational (summarize, sum numbers, read a value, describe something), return {"answer": "<the answer>", "actions": []} and stop.
- "actions" holds 1-5 steps executed in order. It may be empty only together with an "answer" or a "fail" action — never return an empty list alone; use {"type": "fail", "reason": "..."} if you cannot decide.
- Ground actions in the tree, not the screenshot: prefer {"type":"click","id":"e12"}; the extension resolves the id to the element's current center. Only fall back to numeric x/y (CSS px, screenshot top-left origin) for something visible but absent from the tree.
- Chain multiple actions in one response only when you don't need to see the intermediate result first (e.g. type + key Enter). Otherwise return one action and wait for the next observation.
- For exact values (totals, percentages, prices) call read_text and compute from that text — the screenshot may misread numbers.
- For downloading images/audio/files, use download with the element id (images expose src, links expose href) rather than hunting for a UI download button.
- Scroll may omit x/y; the extension defaults to the viewport center.
- NEVER nest action objects like {"click": {"id": "e62"}}. Always use the flat {"type": "..."} form.
- Example (by element id): {"actions": [{"type": "click", "id": "e62"}], "note": "Clicking the image"}
- Example (search): {"actions": [{"type": "click", "id": "e5"}, {"type": "type", "text": "query"}, {"type": "key", "key": "Enter"}], "note": "Searching"}
- To jump to a known page or a different site, use navigate with a full URL instead of clicking through menus.
- The tree's first line lists this chat's tab pool. Use open_tab to research in parallel, switch_tab to move between tabs, and read_text after switching to read a tab's content. Actions apply to the current tab.
- After each step, compare the screen against the spec's success_criteria; the moment every criterion is met, return done (or the answer) instead of continuing to act. The spec's constraints (brand, feature, budget, quantity...) are hard requirements — do not drift from them or forget filters already applied.
- If the task asks you to find, read, extract, calculate, or compare information, you MUST finish with an answer containing the result (do the math yourself from values you read) — never return a bare done for these tasks. {"type": "done"} alone is only for tasks with nothing to report (pure navigation, clicking a button); otherwise add a summary field: {"type": "done", "summary": "..."}.
- Remember a needed value as soon as you read it. Once remembered facts satisfy the success criteria, your VERY NEXT response must be the final answer with empty actions — do not re-open pages already read.
- Research-style tasks (find, compare, list, cheapest/best X, summarize top N): once results are on screen, open each relevant item, read its details, remember the key facts, then back to the list for the next item. After collecting all items, answer with the findings (e.g. top N with name/price/details) and empty actions. Stop scrolling once the requested results are visible.
- Use remember for every fact you may need later; remembered facts survive page changes and reappear in later steps.
- Do not scroll endlessly — after roughly 2-3 screens without new relevant content, answer with what you found or return fail.
- If the history shows an action produced no visible change, do NOT repeat it — change approach or return done/fail.
- The tree may list a "Page scroll" line and [rN] scrollable regions (filters, sidebars, lists); content often lives below the fold or inside those regions — scroll the page or a region before concluding something is missing.
- Return {"type": "fail", "reason": "..."} if the task is impossible, the thing being
  looked for genuinely does not exist / cannot be found after a real effort (e.g. no result
  matches the constraints, a site/section doesn't exist), or you are stuck with no more
  approaches to try. Do not loop indefinitely or invent an answer when nothing was found —
  conclude instead. "reason" is shown to the user as "Task ended because <reason>.", so
  phrase it as a short clause that reads naturally there (e.g. "no wireless mouse under $5
  exists on the sites checked", not "I failed").
- "note" is optional short free text for the operator about what you're doing right now (e.g. "the submit button is disabled, waiting"). It is never shown to the user as the reply. The actual findings/result always go in "answer" (or a "done" summary) — never leave them only in "note".
- Output ONLY the JSON object.
`;

const RESEARCH_MODE_ADDENDUM = `

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
- If a site above blocks you (CAPTCHA/verification page — Google Scholar does this
  aggressively) or turns up no usable results, don't get stuck retrying it: fall back to a
  plain Google search (https://www.google.com/search?q=<query>) for the same query and
  continue from there.
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
`;

const TASK_COMPILER_PROMPT = `You are a task compiler for a browser automation agent. Convert the user's raw request into an execution spec. Do not write prose. Do not add features the user didn't ask for. Infer reasonable defaults but list them under "ambiguities".

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
`;

// ---------- response parsing (ported from backend/main.py) ----------

function normalizeAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  if ("type" in action) return action;
  const keys = Object.keys(action);
  if (keys.length === 1) {
    const key = keys[0];
    const value = action[key];
    if (key in ACTION_SPACE && value && typeof value === "object") {
      return { type: key, ...value };
    }
  }
  return null;
}

function validateActions(actions) {
  if (actions.length > 5) throw new Error("actions must contain at most 5 steps");
  const validated = [];
  for (const action of actions) {
    if (!action || typeof action !== "object" || !("type" in action)) {
      throw new Error("each action must be an object with a 'type'");
    }
    if (!(action.type in ACTION_SPACE)) {
      throw new Error(`unknown action type: ${action.type}`);
    }
    validated.push(action);
  }
  return validated;
}

function parseResponse(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    let parsed = null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rawActions = parsed.actions;
      let actions;
      if (Array.isArray(rawActions)) actions = rawActions;
      else if (rawActions && typeof rawActions === "object") actions = [rawActions];
      else if ("type" in parsed) actions = [parsed];
      else if (typeof parsed.answer === "string") actions = [];
      else actions = null;

      const note = typeof parsed.note === "string" ? parsed.note : null;
      const answer = typeof parsed.answer === "string" ? parsed.answer : null;

      if (actions !== null) {
        const normalized = actions.map(normalizeAction);
        try {
          return { actions: validateActions(normalized), note, answer };
        } catch (e) {
          return { actions: [], note: `Malformed actions (${e.message}): ${text}`, answer };
        }
      }
    }
  }

  const listStart = text.indexOf("[");
  const listEnd = text.lastIndexOf("]");
  if (listStart !== -1 && listEnd !== -1) {
    let parsedList = null;
    try {
      parsedList = JSON.parse(text.slice(listStart, listEnd + 1));
    } catch {
      parsedList = null;
    }
    if (Array.isArray(parsedList)) {
      const normalized = parsedList.map(normalizeAction);
      try {
        return { actions: validateActions(normalized), note: null, answer: null };
      } catch (e) {
        return { actions: [], note: `Malformed actions (${e.message}): ${text}`, answer: null };
      }
    }
  }

  return { actions: [], note: text || null, answer: null };
}

// ---------- OpenRouter calls ----------

function authHeaders(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

async function orFetch(apiKey, body) {
  let response;
  try {
    response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Cannot reach OpenRouter directly: ${error.message}`);
  }
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `OpenRouter returned HTTP ${response.status}`);
  }
  return response;
}

async function directCompile(text, existingSpec, settings) {
  let userContent = text;
  if (existingSpec) {
    userContent = `Current spec:\n${JSON.stringify(existingSpec, null, 2)}\n\nUser follow-up: ${text}\n\nReturn the updated spec.`;
  }
  const response = await orFetch(settings.apiKey, {
    model: settings.model,
    messages: [
      { role: "system", content: TASK_COMPILER_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 900,
    temperature: 0,
    response_format: { type: "json_object" },
    reasoning_effort: "low",
  });
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("spec compilation failed: no JSON in response");
  try {
    return { spec: JSON.parse(raw.slice(start, end + 1)) };
  } catch (e) {
    throw new Error(`spec compilation failed: ${e.message}`);
  }
}

async function directAskStream(payload, onDelta, settings) {
  let userText = `Task: ${payload.task}\n\nAccessibility tree:\n${payload.tree}`;
  if (payload.spec) userText = `Task spec:\n${JSON.stringify(payload.spec, null, 2)}\n\n${userText}`;
  if (payload.findings?.length) {
    userText += `\n\nFacts remembered from earlier pages:\n${JSON.stringify(payload.findings, null, 2)}`;
  }
  if (payload.history?.length) {
    userText += `\n\nPrevious actions:\n${JSON.stringify(payload.history, null, 2)}`;
  }
  if (payload.hint) userText += `\n\nOperator hint: ${payload.hint}`;
  userText += "\n\nDecide the next action(s).";

  const research = payload.mode === "research";
  const systemPrompt = research ? SYSTEM_PROMPT + RESEARCH_MODE_ADDENDUM : SYSTEM_PROMPT;

  const response = await orFetch(settings.apiKey, {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: payload.image } },
        ],
      },
    ],
    max_tokens: research ? 2200 : 800,
    temperature: 0,
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    stream: true,
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const accumulated = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const line = event.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (delta) {
        accumulated.push(delta);
        onDelta(delta);
      }
    }
  }

  return parseResponse(accumulated.join(""));
}

export { directCompile, directAskStream };
