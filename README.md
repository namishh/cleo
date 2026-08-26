# Cleo

An AI browser agent that lives in a Chrome side panel. It sees the page through redacted screenshots, reasons with a vision LLM, and drives the browser for you — while PII (names, emails, phones, addresses, IDs) is detected and black-boxed **locally** before anything is sent anywhere. It can also run a dedicated **research mode** that opens multiple tabs, searches real sites instead of answering from memory, and reports back with a sourced, detailed answer. Web search itself runs through the **Exa search API** (`exa_search`) by default instead of navigating to a search engine tab and scrolling — real page highlights come back in one call, and it's the go-to for academic/scholarly queries too.

## Architecture

Every process, message channel, and storage boundary in the extension — side panel, service worker, content script, offscreen document, CDP, and the two ways step-decisions get made (local Flask backend vs. calling OpenRouter directly with your own key).

```mermaid
flowchart TB
    subgraph SidePanel["SIDE PANEL — sidepanel.html / .js / .css"]
        direction TB
        UI_Stream["Chat stream<br/>reasoning accordion · step screenshots<br/>note/action lines · markdown answers<br/>'displayName:' prefix · sources list"]
        UI_Input["Input bar<br/>task field · research button · send/stop"]
        UI_Chats["Chats drawer<br/>chat list · spinners · new/delete/switch"]
        UI_Settings["Settings drawer<br/>auth token · direct-mode toggle<br/>OpenRouter key + model · Exa key (optional)<br/>display name · avatar gradient"]
        UI_Scroll["stick-to-bottom scroll tracker"]
    end

    Storage[("chrome.storage.local<br/>cleo_chats · cleo_activeChat · cleo_settings")]

    subgraph Worker["SERVICE WORKER — background.js (MV3, type: module)"]
        direction TB
        W_Router["Message router<br/>startTask · stopTask · getTaskState<br/>newChat/listChats/openChat/deleteChat<br/>getActiveChat · offscreenReady · progress"]
        W_ChatStore["Chat store<br/>load/save/normalize · migration<br/>per-chat: entries, history, findings, spec"]
        W_Loop["Task loop — one per chat<br/>runTaskLoop() · MAX_STEPS = 50"]
        W_TabPool["Tab-pool manager<br/>open_tab/switch_tab/close_tab<br/>foreground-activation fix · MAX 6 tabs<br/>new-tab adoption (target=_blank)"]
        W_AntiStall["Anti-stall guards<br/>tree-hash stall · scroll-run<br/>pool-run · empty-run<br/>ungrounded-answer gate (research<br/>mode or exa_search used)"]
        W_Debug["Debugger helpers<br/>attach/detach/force-reattach<br/>restricted-URL redirect (chrome://, newtab)"]
        W_Capture["Screenshot capture<br/>surface capture then renderer fallback<br/>retry x3"]
        W_Tree["Compact a11y tree fetch<br/>content-script messaging<br/>re-inject on 'no receiver' only"]
        W_Compile["Task compiler call<br/>spec cache · re-compile on follow-ups"]
        W_Ask["askModel() router"]
        W_ExaSearch["exa_search handler<br/>runExaSearch() · type=auto (normal)<br/>/ deep (research) · no-tab, no-CDP"]
        W_Resume["Resume-after-restart<br/>resumeInterruptedTasks()"]
        W_Keepalive["Keepalive ping<br/>MV3 30s idle workaround"]
        W_Notify["Desktop notification<br/>on background-chat completion"]
    end

    subgraph Content["CONTENT SCRIPT — content.js (per tab, guarded)"]
        direction TB
        C_Guard["window.__cleoContentScriptLoaded<br/>guard vs double-injection"]
        C_Tree["Accessibility tree builder<br/>interactive/landmark/image selectors<br/>visibility · role · accessible name<br/>rects · state · scrollable regions"]
        C_Privacy["DOM privacy-region detector<br/>email/phone/date/pincode/zip regex<br/>address and location context<br/>sensitive form-control matcher"]
        C_Handlers["Message handlers<br/>getCompactAccessibilityTree<br/>getElementRect · scrollIntoView<br/>getResourceUrl · getPageText"]
    end

    CDP["chrome.debugger — CDP<br/>Page.captureScreenshot · Input.dispatch*<br/>works on background tabs"]

    subgraph Actions["ACTIONS — actions.js"]
        direction TB
        A_Exec["18 executors<br/>click/dbl/right · move · scroll · type<br/>key + combos · drag · select · navigate<br/>back/forward · hover · pdf · download<br/>read_text · scroll_into_view · wait"]
        A_Terminal["Terminal markers<br/>done · fail (no browser I/O)"]
    end

    subgraph Offscreen["OFFSCREEN DOCUMENT — offscreen.js (local ML, never leaves device)"]
        direction TB
        O_OCR["Tesseract.js OCR"]
        O_Kiji["Kiji PII model<br/>ONNX · 53 labels"]
        O_YuNet["YuNet face detector<br/>ONNX Runtime WASM"]
        O_Regex["regex / context pass"]
        O_Merge["Union-merge masks<br/>then redacted PNG"]
    end

    subgraph ModelRouting["MODEL ROUTING — settings.directMode"]
        direction TB
        subgraph Backend["LOCAL BACKEND — Flask (backend/main.py)"]
            direction TB
            B_Auth["Bearer-token auth<br/>CLEO_AUTH_TOKEN (before_request)"]
            B_Compile["/compile<br/>TASK_COMPILER_PROMPT to spec JSON<br/>COMPILATION_MODEL · reasoning_effort=low"]
            B_Ask["/ask_stream (SSE)<br/>SYSTEM_PROMPT +RESEARCH_MODE_ADDENDUM<br/>MODEL · reasoning_effort=low"]
            B_Parse["Response parsing<br/>_parse_response/_normalize_action<br/>_validate_actions — tolerant JSON"]
            B_Exa["/exa_search<br/>proxies to Exa API with<br/>server's own EXA_API_KEY"]
        end
        subgraph Direct["DIRECT MODE — openrouter-direct.js"]
            direction TB
            D_Prompts["Ported prompts<br/>ACTION_SPACE · SYSTEM_PROMPT<br/>RESEARCH_MODE_ADDENDUM<br/>TASK_COMPILER_PROMPT"]
            D_Calls["directCompile() · directAskStream()<br/>user's own OpenRouter key, no server"]
            D_Exa["direct Exa call<br/>user's own Exa key —<br/>else falls back to traditional search"]
        end
    end

    OpenRouter["OPENROUTER<br/>vision LLM — MODEL / COMPILATION_MODEL"]
    Exa["EXA SEARCH API<br/>exa.ai/search — semantic web search"]

    UI_Input -->|startTask / stopTask| W_Router
    UI_Chats -->|listChats / openChat / deleteChat| W_Router
    UI_Settings -.->|save| Storage
    W_Router --> W_ChatStore
    W_ChatStore <--> Storage
    W_Router --> W_Loop
    W_Loop --> W_Debug
    W_Loop --> W_Capture
    W_Loop --> W_Tree
    W_Loop --> W_TabPool
    W_Loop --> W_AntiStall
    W_Loop --> W_Compile
    W_Loop --> W_Ask
    W_Loop --> W_ExaSearch
    W_Resume -.->|on SW restart| W_Loop
    W_Loop -.-> W_Keepalive
    W_Loop -.-> W_Notify
    W_Notify -.-> UI_Stream

    W_Tree <-->|chrome.tabs.sendMessage| C_Handlers
    C_Handlers --> C_Tree
    C_Handlers --> C_Privacy
    C_Guard -.-> C_Tree

    W_Capture --> CDP
    W_Debug --> CDP
    A_Exec --> CDP
    W_TabPool --> CDP

    W_Loop -->|redacted-screenshot request| Offscreen
    C_Privacy -.->|DOM privacy regions| O_Merge
    O_OCR --> O_Merge
    O_Kiji --> O_Merge
    O_YuNet --> O_Merge
    O_Regex --> O_Merge
    O_Merge -->|redacted PNG| W_Loop

    W_Compile --> ModelRouting
    W_Ask --> ModelRouting
    Backend --> OpenRouter
    Direct --> OpenRouter
    B_Compile --> B_Parse
    B_Ask --> B_Parse

    W_ExaSearch -.->|no direct mode| B_Exa
    W_ExaSearch -.->|direct mode| D_Exa
    B_Exa --> Exa
    D_Exa --> Exa
    Exa -.->|highlights or error| W_ExaSearch

    W_Loop -->|actions array| A_Exec
    A_Exec -->|results| W_Loop
    W_Loop -->|answer/done/fail| UI_Stream
```

## Task-loop control flow

Every decision branch the per-chat loop actually makes — restricted-page redirect, the four anti-stall guards, the research-mode "must actually browse before answering" gate, tab-pool handling, and every terminal path.

```mermaid
flowchart TD
    Start(["User submits task<br/>send or research button"]) --> Restricted{"Active tab is<br/>chrome:// / newtab / edge: / about:?"}
    Restricted -->|yes| Navigate["chrome.tabs.update to https://www.google.com<br/>wait for load"]
    Restricted -->|no| Attach
    Navigate --> Attach["attach chrome.debugger to tab"]
    Attach --> Compile["Compile task spec<br/>goal · task_type · success_criteria ·<br/>constraints · ambiguities<br/>backend /compile or directCompile()"]
    Compile --> LoopTop{{"runTaskLoop() — while running"}}

    LoopTop --> StepCheck{"step over MAX_STEPS (50)?"}
    StepCheck -->|yes| StopLimit(["Stop: step-limit reached"])
    StepCheck -->|no| TabAlive{"tab still open?"}
    TabAlive -->|no| StopClosed(["Stop: task tab was closed"])
    TabAlive -->|yes| Observe

    subgraph ObserveBlock["OBSERVE"]
        Observe["Fetch compact a11y tree<br/>content script"] --> Snapshot["Capture CDP screenshot<br/>surface then renderer fallback, retry x3"]
    end

    Snapshot --> HashCheck{"tree hash same as last step,<br/>2+ times running?"}
    HashCheck -->|yes| HintStall["hint: page hasn't changed,<br/>try a different approach"]
    HashCheck -->|no| ScrollCheck{"4+ scrolls in a row?"}
    ScrollCheck -->|yes| HintScroll["hint: stop scrolling,<br/>summarize or conclude"]
    ScrollCheck -->|no| PoolCheck{"2+ tab-pool-only steps?"}
    PoolCheck -->|yes| HintPool["hint: stop juggling tabs,<br/>act or answer"]
    PoolCheck -->|no| EmptyCheck{"prior step: 0 actions,<br/>no answer/done/fail?"}
    EmptyCheck -->|yes| HintEmpty["hint: must return an action<br/>or a terminal answer/fail"]
    EmptyCheck -->|no| ResearchCheck{"research mode OR exa_search used,<br/>0 sources read, blocked before?"}
    ResearchCheck -->|yes| HintResearch["hint: open_tab and read a real<br/>source (not just exa snippets)<br/>before answering"]
    ResearchCheck -->|no| Redact

    HintStall --> Redact
    HintScroll --> Redact
    HintPool --> Redact
    HintEmpty --> Redact
    HintResearch --> Redact

    subgraph RedactBlock["REDACT — offscreen document, on-device"]
        Redact["Send screenshot and DOM privacy<br/>regions to offscreen doc"] --> RedactRun["OCR + Kiji PII ONNX + YuNet faces<br/>+ regex/context, union-merged"]
    end

    RedactRun --> Ask["Ask model: askModel()<br/>image + tree + spec + findings + history + hint"]
    Ask --> Route{"settings.directMode?"}
    Route -->|no| BackendCall["Flask backend /ask_stream (SSE)<br/>Authorization: Bearer token<br/>+RESEARCH_MODE_ADDENDUM if research"]
    Route -->|yes| DirectCall["directAskStream()<br/>straight to OpenRouter,<br/>user's own key"]
    BackendCall --> Decision
    DirectCall --> Decision

    Decision["Decision: actions, note, answer"] --> PoolActions{"actions include<br/>open_tab/switch_tab/close_tab?"}
    PoolActions -->|yes, only those| RunPool["Execute tab-pool ops<br/>bring tab to foreground"] --> LoopTop
    PoolActions -->|yes plus more| RunPoolMixed["Execute tab-pool ops,<br/>continue with rest"] --> Remember
    PoolActions -->|no| Remember

    Remember{"actions include<br/>remember?"}
    Remember -->|yes, only| StoreFact["Store fact plus source URL/title<br/>for research citations"] --> LoopTop
    Remember -->|yes plus more| StoreFactMixed["Store fact,<br/>continue with rest"] --> ExaCheck
    Remember -->|no| ExaCheck

    ExaCheck{"actions include<br/>exa_search?"}
    ExaCheck -->|yes, only| RunExa["Call Exa API — backend proxy or direct,<br/>type=auto (normal) / deep (research);<br/>no key or request error: fallback text<br/>telling the model to open_tab a Google search"] --> LoopTop
    ExaCheck -->|yes plus more| RunExaMixed["Call Exa API,<br/>continue with rest"] --> ResearchGate
    ExaCheck -->|no| ResearchGate

    ResearchGate{"research mode OR exa_search used,<br/>0 sources read, tries to answer/done?"}
    ResearchGate -->|yes, 3 or fewer attempts| Block["Block — loop back,<br/>force open_tab + remember<br/>(not exa_search snippets alone)"] --> LoopTop
    ResearchGate -->|no, or attempts exhausted| Terminal

    Terminal{"answer? done? fail?"}
    Terminal -->|answer| Answer["Show 'displayName: ...'<br/>plus sources list in research mode"] --> StopAnswered(["Stop: Answered"])
    Terminal -->|done plus summary| DoneSummary["Show summary<br/>plus sources list in research mode"] --> StopDone(["Stop: Completed"])
    Terminal -->|done, no summary| StopBare(["Stop: Completed, no summary"])
    Terminal -->|fail| Fail["Show 'Task ended because ...'"] --> StopFail(["Stop: Failed"])
    Terminal -->|none| ActCheck{"actions.length == 0?"}

    ActCheck -->|yes| LoopTop
    ActCheck -->|no| Execute

    subgraph ActBlock["ACT — actions.js via CDP"]
        Execute["Resolve element ids to coordinates"] --> RunActions["Execute in order, stop on first failure<br/>click/type/key/scroll/drag/select/<br/>navigate/back/forward/hover/pdf/<br/>download/read_text/scroll_into_view/wait"]
        RunActions --> Reattach{"debugger detached error?"}
        Reattach -->|yes| ForceReattach["force re-attach, retry once"] --> RunActions
        Reattach -->|no| Settle
    end

    Settle{"navigation action?"}
    Settle -->|yes| WaitLoad["wait for tab load complete"] --> LoopTop
    Settle -->|no| Sleep["short settle delay"] --> LoopTop
```

## PII redaction pipeline

Four independent local detectors, union-merged, before a single pixel leaves the machine.

```mermaid
flowchart LR
    Screenshot["CDP screenshot<br/>PNG, full viewport"] --> Offscreen
    DOMRegions["DOM privacy regions<br/>content.js, from live page state"] --> Offscreen

    subgraph Offscreen["Offscreen document — 100% on-device"]
        direction TB
        OCR["Tesseract.js OCR<br/>read on-screen text"] --> Detect
        Kiji["Kiji PII model<br/>ONNX · 53 entity labels<br/>names, IDs, addresses, ..."] --> Detect
        YuNet["YuNet face detector<br/>ONNX Runtime, WASM"] --> Detect
        Regex["Regex/context pass<br/>email · phone · date ·<br/>pincode/zip · address phrases"] --> Detect
        Detect["Union-merge all mask regions<br/>overlap-dedupe, capped at 200"]
    end

    Detect --> Blackbox["Draw black boxes over<br/>every masked region"]
    Blackbox --> Redacted["Redacted PNG<br/>sent to the model"]

    Note["Nothing above this line<br/>ever leaves the device"] -.-> Offscreen
```

## Compact overviews

Slide-sized versions of the above — one component at a time.

**Backend**

```mermaid
flowchart LR
    Ext["Extension<br/>service worker"] -->|Bearer token| Auth["Flask backend<br/>auth check"]
    Auth --> Compile["/compile<br/>spec JSON"]
    Auth --> Ask["/ask_stream<br/>SSE actions"]
    Auth --> ExaEP["/exa_search<br/>Exa API proxy"]
    Compile --> OR["OpenRouter<br/>vision LLM"]
    Ask --> OR
    ExaEP --> ExaAPI["Exa API"]
    OR --> Parse["parse + validate<br/>JSON actions"]
    Parse --> Ext
    ExaAPI --> Ext
```

**Client + ONNX**

```mermaid
flowchart LR
    Panel["Side panel<br/>chat UI"] --> Worker["Service worker<br/>task loop"]
    Worker -->|screenshot| Offscreen2["Offscreen doc<br/>ONNX models"]
    Offscreen2 -->|redacted image| Worker
    Worker -->|image + tree| Model["Backend / OpenRouter"]
    Model -->|actions| Worker
    Worker -->|CDP| Page["Browser tab"]
```

**ONNX redaction**

```mermaid
flowchart LR
    Img["Screenshot"] --> Kiji2["Kiji PII model<br/>ONNX · 53 labels"]
    Img --> YuNet2["YuNet<br/>ONNX face detector"]
    Kiji2 --> Boxes["PII boxes"]
    YuNet2 --> Faces["Face boxes"]
    Boxes --> Merge2["Merge + dedupe"]
    Faces --> Merge2
    Merge2 --> Redacted2["Redacted image"]
```

- **Task compiler** — an intermediate model turns vague requests into a structured spec (goal, task type, success criteria, constraints, ambiguities) once per task; follow-ups re-compile against the existing spec. It can run a stronger/pricier model than the per-step loop (`OPENROUTER_COMPILATION_MODEL`), since it runs once per task instead of once per step. The vision model checks every screen against the success criteria, which makes "done" a checkable condition instead of a feeling.
- **Research mode** — a dedicated button that forces real browsing over answering from the model's own training knowledge: it must open and read at least one real source (found via `exa_search`, or a site-specific destination like YouTube/Reddit/a marketplace/Wikipedia when that fits the question better) before it's allowed to answer, enforced deterministically in code, not just requested in the prompt. Ends with a detailed, source-attributed report and an automatically-compiled sources list.
- **Web search (`exa_search`)** — the default way the agent looks things up, in both normal and research mode: one Exa API call returns real page titles/URLs/highlights, replacing "navigate to a search engine, then scroll the results." Normal mode uses `type: "auto"`; research mode uses `type: "deep"`. Routes through the backend's own `EXA_API_KEY` by default; in direct mode it uses the user's own Exa key from settings (optional), or falls back to a traditional `open_tab` Google search if no key is set or the Exa call errors. It's a discovery step, not a source: the same deterministic gate that guards research mode also blocks an answer/done coming right off exa_search's snippets in *any* mode, until the agent has actually `open_tab`'d a result and `remember`'d something from the page itself.
- **Per-chat isolation** — each chat has its own state (tab, tab pool, history, findings, step counter, spec, mode); multiple chats run in parallel on different tabs.
- **Resumable** — steps persist immediately; if the service worker is recycled, interrupted tasks auto-resume.
- **Self-healing** — debugger re-attach, new-tab adoption, tab-foreground activation, restricted-page redirect, screenshot fallbacks, backend watchdog, offscreen retry.
- **Notified** — desktop notification when a background chat finishes.
- **Fail-safe redaction** — OCR + ONNX PII model + ONNX face detector + regex/DOM regions are union-merged; PII never leaves the machine unmasked.
- **Two ways to reach the model** — a local Flask backend behind a demo Bearer-token auth, or bypass it entirely and call OpenRouter directly with your own key (mirrors the backend's prompts exactly; both paths kept in sync).

## What is Cleo?

A privacy-first browser automation agent. You give it a task in plain English ("find the cheapest Sony headset, filter by hybrid, give me the top 5"); it observes pages through **redacted screenshots**, reasons with a vision LLM, and executes real browser actions. Anything that looks like PII — names, emails, phone numbers, addresses, IDs — is detected by an **on-device ONNX model** and black-boxed before the screenshot ever leaves your machine. Cleo can still *use* redacted fields (type into them, click them) — it just can't *read* them.

**Quick features**

- Task compiler: an intermediate model turns vague requests into a structured spec — goal, task type, success criteria, constraints, ambiguities — so "done" is checkable, not a feeling
- Research mode: a dedicated button that searches via Exa and opens tabs across the right sites for the question (YouTube/Reddit/marketplaces/Wikipedia when that fits better than a general search), is deterministically blocked from answering until it has actually read a real source, and finishes with a detailed, sourced report
- Exa-powered web search (`exa_search`) as the default lookup in both modes — real highlights in one API call instead of opening a search tab and scrolling; falls back to a traditional Google search if no key/an error occurs
- Chrome side-panel chat interface with streaming responses, stick-to-bottom scrolling
- Collapsible per-message reasoning: screenshot + note + commands for every step
- Settings panel: swap the backend for a direct OpenRouter connection with your own key (optionally your own Exa key too), set the auth token, customize Cleo's display name and your avatar gradient
- Multiple chats, running in parallel, persisted locally (`unlimitedStorage`)
- Auto-titled chats, desktop notifications on completion
- 20+ browser actions: click, type, key combos, scroll, drag, hover, select, navigate, back/forward, download, PDF export, clipboard, read_text, scroll_into_view, remember
- Works on background tabs (CDP input + renderer screenshots); auto-redirects off new-tab/chrome:// pages before starting
- Research workflow: open items → remember facts (with source URL) → return to list → summarize top N
- Anti-stall: no-progress detection, scroll-run detection, tab-pool-loop detection, empty-response detection, ungrounded-answer gate (research mode or exa_search use), backend watchdog, auto-resume

## How Cleo compares

| | Cleo | Cloud agents (OpenAI Operator, Anthropic Computer Use) | Privacy proxies (Kiji Privacy Proxy) | Forked browsers (BrowserOS, Nanobrowser) | Orchestrator extensions (browser-use style) |
|---|---|---|---|---|---|
| Where it runs | Chrome extension (side panel) | Cloud VM / sandboxed browser | Local proxy between app & API | Separate Chromium fork | Extension or script harness |
| PII handling | On-device ONNX redaction of screenshots + DOM before sending | None — full page goes to the model | Masks text in API payloads | Depends on config | Usually none |
| Works in your real Chrome (sessions, logins, cookies) | Yes | No — separate sandbox session | N/A (proxy, not driver) | No — separate browser | Yes, but often script-driven |
| Vision-driven (works on canvas/complex UIs) | Yes | Yes | No (text payloads only) | Varies | Often DOM-only |
| Setup | Load unpacked + local Flask backend (or skip it — connect straight to OpenRouter with your own key) | Account + cloud | Desktop app install | Build/install a fork | pip/CLI + config |
| Model | Any vision model via OpenRouter (one key) | Vendor-locked | Vendor model (DistilBERT detector) | BYO key | BYO key |

**The short version:** cloud agents see everything and live outside your browser; privacy proxies protect API text but can't see or drive pages; forked browsers isolate you from your daily profile. Cleo is the middle path — a real extension in your real Chrome, where a local model scrubs the pixels and the DOM before a vision model decides what to do next.
