import { executeActions } from "./actions.js";

const BACKEND_BASE = "http://127.0.0.1:5001";
const MAX_STEPS = 50;
// Internal browser pages (new tab, chrome://, extension pages, devtools) can't be
// debugged or have a content script injected — never try to start a task on one.
const RESTRICTED_URL_RE = /^(chrome|chrome-extension|edge|about|devtools):/i;
const CHATS_KEY = "cleo_chats";
const ACTIVE_CHAT_KEY = "cleo_activeChat";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Cleo installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("Failed to set side panel behavior:", error);
});

// One independent automation state per chat — parallel chats never share
// context, history, or findings.
const taskStates = new Map(); // chatId -> state

// ---------- chat store (chrome.storage.local, unlimitedStorage) ----------

function normalizeChat(chat) {
  if (!chat || typeof chat !== "object") return false;
  let changed = false;
  if (!Array.isArray(chat.entries)) { chat.entries = []; changed = true; }
  if (!Array.isArray(chat.taskHistory)) { chat.taskHistory = []; changed = true; }
  if (!Array.isArray(chat.findings)) { chat.findings = []; changed = true; }
  if (!chat.lastStep) { chat.lastStep = 0; changed = true; }
  if (!chat.title) { chat.title = "untitled"; changed = true; }
  for (const entry of chat.entries) {
    if (!entry.t && entry.step !== undefined) {
      entry.t = "step";
      changed = true;
    }
  }
  return changed;
}

async function loadAllChats() {
  const store = await chrome.storage.local.get(CHATS_KEY);
  const chats = store[CHATS_KEY] || {};
  let migrated = false;

  for (const key of Object.keys(chats)) {
    const chat = chats[key];
    if (key === "undefined" || !chat?.id) {
      delete chats[key];
      migrated = true;
      if (chat && typeof chat === "object") {
        chat.id = `chat_${chat.createdAt || Date.now()}_migrated`;
        chats[chat.id] = chat;
      }
    }
    if (normalizeChat(chat)) migrated = true;
  }
  if (migrated) await chrome.storage.local.set({ [CHATS_KEY]: chats });
  return chats;
}

async function loadChat(id) {
  if (!id || id === "undefined") return null;
  const chats = await loadAllChats();
  const chat = chats[id];
  if (!chat) return null;
  normalizeChat(chat);
  return chat;
}

async function saveChat(chat) {
  if (!chat?.id) throw new Error("cannot save chat without an id");
  chat.updatedAt = Date.now();
  const chats = await loadAllChats();
  chats[chat.id] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
}

async function setActiveChatId(id) {
  if (!id) return;
  await chrome.storage.local.set({ [ACTIVE_CHAT_KEY]: id });
}

async function getActiveChatId() {
  const store = await chrome.storage.local.get(ACTIVE_CHAT_KEY);
  const id = store[ACTIVE_CHAT_KEY];
  return id && id !== "undefined" ? id : null;
}

async function newChatRecord() {
  const store = await chrome.storage.local.get("cleo_chatCounter");
  const count = (store.cleo_chatCounter || 0) + 1;
  await chrome.storage.local.set({ cleo_chatCounter: count });

  const chats = await loadAllChats();
  let title = `New Chat #${count}`;
  if (Object.values(chats).some((chat) => chat.title === title)) {
    title = `New Chat #${count}-${Math.random().toString(36).slice(2, 5)}`;
  }

  return {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    customTitle: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entries: [],
    taskHistory: [],
    findings: [],
    lastStep: 0,
  };
}

// ---------- agent events ----------

function emit(chatId, kind, payload = {}) {
  chrome.runtime.sendMessage({ action: "agentEvent", kind, chatId, ...payload }).catch(() => {});
}

function log(chatId, message) {
  console.log(`[agent:${chatId}] ${message}`);
  emit(chatId, "log", { message });
}

function status(chatId, message) {
  emit(chatId, "status", { message });
}

// ---------- debugger helpers ----------

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!String(error.message).includes("Another debugger")) throw error;
  }
}

async function forceDebuggerAttach(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, "1.3");
}

function isDebuggerDetachedError(error) {
  return String(error?.message || error).toLowerCase().includes("debugger is not attached");
}

async function captureTab(tabId) {
  // Visible tabs: surface capture is best. Background tabs are not composited,
  // so the surface is missing/stale — fall back to the renderer capture.
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Page.captureScreenshot",
      { format: "png", fromSurface: true }
    );
    if (result.data) return `data:image/png;base64,${result.data}`;
  } catch (error) {
    console.warn(`Surface capture failed for tab ${tabId}, trying renderer:`, error.message);
  }
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png", fromSurface: false }
  );
  return `data:image/png;base64,${result.data}`;
}

async function getCompactPageSnapshot(tabId) {
  try {
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      action: "getCompactAccessibilityTree",
    });
    if (snapshot?.error) throw new Error(snapshot.error);
    return snapshot;
  } catch (firstError) {
    // Only inject when the content script genuinely isn't there. Blindly
    // re-injecting on every error re-runs content.js in the same isolated
    // world and redeclares its top-level consts (SyntaxError).
    const msg = String(firstError?.message || firstError);
    const noReceiver = /receiving end does not exist|could not establish connection|message port closed/i.test(msg);
    if (!noReceiver) throw firstError;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      action: "getCompactAccessibilityTree",
    });
    if (snapshot?.error) throw new Error(snapshot.error);
    return snapshot;
  }
}

// ---------- offscreen document ----------

let offscreenReadyPromise = null;
let offscreenResolve = null;

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    if (!offscreenReadyPromise) offscreenReadyPromise = Promise.resolve();
    return offscreenReadyPromise;
  }
  if (offscreenReadyPromise) return offscreenReadyPromise;

  // Retry once with a fresh document if the first one stalls.
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    offscreenReadyPromise = new Promise((resolve, reject) => {
      offscreenResolve = resolve;
      setTimeout(() => reject(new Error("Offscreen document failed to become ready")), 10000);
    });
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "DOM_PARSER"],
        justification: "Run local screenshot redaction models",
      });
      await offscreenReadyPromise;
      offscreenResolve = null;
      return;
    } catch (error) {
      lastError = error;
      await chrome.offscreen.closeDocument().catch(() => {});
      offscreenReadyPromise = null;
      offscreenResolve = null;
    }
  }
  throw lastError;
}

async function hasOffscreenDocument() {
  try {
    const clients = await self.clients.matchAll();
    return clients.some((client) => client.url.includes(chrome.runtime.getURL("offscreen.html")));
  } catch {
    return false;
  }
}

// ---------- task loop (one per chat) ----------

async function startTask(task, requestedChatId, mode = "normal") {
  if (!String(task || "").trim()) throw new Error("Task cannot be empty");

  const activeChatId = await getActiveChatId();
  const chatId = requestedChatId || activeChatId;
  const chat = chatId ? await loadChat(chatId) : null;

  let targetChat = chat;
  if (!targetChat) {
    targetChat = await newChatRecord();
  }
  await setActiveChatId(targetChat.id);

  const existing = taskStates.get(targetChat.id);
  if (existing?.running) throw new Error("This chat is already running a task");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  // New-tab and chrome://... pages can't be debugged or have a content script
  // injected (both are blocked by Chrome for internal pages), so a task
  // started on one would fail every step. Start somewhere real instead.
  if (!tab.url || RESTRICTED_URL_RE.test(tab.url)) {
    await chrome.tabs.update(tab.id, { url: "https://www.google.com" });
    await waitForTabLoad(tab.id, 10000);
  }

  // One debugger session per tab — a second chat cannot drive the same tab.
  for (const state of taskStates.values()) {
    if (state.running && state.tabId === tab.id) {
      throw new Error("Another running chat is already using this tab");
    }
  }

  await attachDebugger(tab.id);

  const state = {
    running: true,
    chatId: targetChat.id,
    tabId: tab.id,
    windowId: tab.windowId,
    task: String(task).trim(),
    mode: mode === "research" ? "research" : "normal",
    step: targetChat.lastStep || 0,
    history: targetChat.taskHistory || [],
    findings: targetChat.findings || [],
    spec: targetChat.spec || null,
    tabs: [tab.id],
    currentTab: tab.id,
    lastTreeHash: null,
    stallCount: 0,
    scrollRun: 0,
  };
  taskStates.set(targetChat.id, state);
  updateKeepalive();

  targetChat.entries.push({ t: "user", text: state.task, mode: state.mode, ts: Date.now() });
  targetChat.mode = state.mode;
  targetChat.lastTask = state.task;

  // Compile the task spec with the intermediate model (also re-compiles on
  // follow-up messages, diffing against the existing spec). Non-fatal: the
  // loop runs fine on the raw task if compilation fails.
  status(state.chatId, "Compiling task...");
  try {
    const response = await fetch(`${BACKEND_BASE}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: state.task, spec: targetChat.spec || null }),
    });
    const body = await response.json();
    if (body.spec) {
      state.spec = body.spec;
      targetChat.spec = body.spec;
      log(state.chatId, `Task compiled (${body.spec.task_type}): ${body.spec.goal}`);
      if (body.spec.ambiguities?.length) {
        log(state.chatId, `Assumptions: ${body.spec.ambiguities.join("; ")}`);
      }
    }
  } catch (error) {
    log(state.chatId, `Task compilation skipped: ${error.message}`);
  }

  if (!targetChat.customTitle) {
    targetChat.title = titleFromMessage(state.task);
    emit(targetChat.id, "title", { title: targetChat.title });
  }
  await saveChat(targetChat);

  emit(targetChat.id, "user", { text: state.task, mode: state.mode });
  status(targetChat.id, state.mode === "research" ? `Researching on tab ${tab.id}` : `Running on tab ${tab.id}`);
  runTaskLoop(targetChat.id).catch((error) => {
    console.error(`Task loop failed for ${targetChat.id}:`, error);
    log(targetChat.id, `Fatal error: ${error.message}`);
    stopTask(targetChat.id, `Stopped: ${error.message}`);
  });
  return { chatId: targetChat.id, tabId: tab.id };
}

// ---------- keepalive (tasks outlive the side panel) ----------
// The loop lives in this service worker, so closing the sidebar is fine. But
// MV3 kills idle workers after ~30s; long backend waits can trigger that.
// Poke an extension API periodically while any chat is running.
let keepaliveTimer = null;

function updateKeepalive() {
  const anyRunning = [...taskStates.values()].some((s) => s.running);
  if (anyRunning && !keepaliveTimer) {
    keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  } else if (!anyRunning && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function stopTask(chatId, reason = "Stopped") {
  const state = taskStates.get(chatId);
  if (!state?.running) return;
  state.running = false;
  taskStates.delete(chatId);
  updateKeepalive();

  chrome.debugger.detach({ tabId: state.tabId }).catch(() => {});
  // Detach from any remaining pool tabs.
  for (const tabId of state.tabs || []) {
    if (tabId !== state.tabId) chrome.debugger.detach({ tabId }).catch(() => {});
  }
  log(chatId, reason);
  notifyDone(state.tabId, reason);
  // Clear the running flag so interrupted chats aren't resumed as zombies.
  loadChat(chatId).then((chat) => {
    if (chat) {
      chat.running = false;
      saveChat(chat);
    }
  }).catch(() => {});
  chrome.runtime.sendMessage({ action: "taskStopped", chatId, reason }).catch(() => {});
}

// Notify when a background chat finishes — the user may be on another tab.
async function notifyDone(tabId, message) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return; // user is watching this tab; no notification needed
  } catch {
    // Tab is gone; still notify.
  }
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Cleo",
    message,
  });
}

function stopAllTasks(reason = "Stopped") {
  for (const chatId of [...taskStates.keys()]) stopTask(chatId, reason);
}

async function runTaskLoop(chatId) {
  const state = taskStates.get(chatId);
  if (!state) return;

  while (state.running) {
    if (state.step >= MAX_STEPS) {
      stopTask(chatId, `Stopped: reached ${MAX_STEPS}-step limit`);
      return;
    }

    const step = ++state.step;
    const tabId = state.tabId;
    status(chatId, `Step ${step}: observing tab ${tabId}...`);

    try {
      await chrome.tabs.get(tabId);
    } catch (error) {
      stopTask(chatId, "Stopped: task tab was closed");
      return;
    }

    let snapshot;
    try {
      snapshot = await getCompactPageSnapshot(tabId);
      log(chatId, `Step ${step}: collected ${snapshot.elements?.length || 0} actionable elements`);
    } catch (error) {
      snapshot = {
        tree: `(page snapshot unavailable: ${error.message})`,
        privacyRegions: [],
        viewportWidth: 0,
        viewportHeight: 0,
      };
      log(chatId, `Step ${step}: DOM snapshot unavailable; continuing with screenshot`);
    }

    // Stall detection: identical page state across steps means the previous
    // action did nothing. Nudge the model instead of looping forever.
    const treeHash = hashString(snapshot.tree || "");
    if (treeHash === state.lastTreeHash) {
      state.stallCount += 1;
    } else {
      state.stallCount = 0;
      state.lastTreeHash = treeHash;
    }
    let hint = "";
    if (state.mode === "research" && state.findings.length === 0 && (state.researchBlocked || 0) >= 1) {
      hint =
        "You just tried to answer/done without reading any real source — that was blocked. This " +
        "is research mode: you must open_tab (or navigate) to a real page relevant to the " +
        "question, then read_text and remember at least one fact from it, before you're allowed " +
        "to answer. Return actions now (typically open_tab), not an answer.";
      log(chatId, `Step ${step}: nudging model to actually research before answering`);
    } else if (state.stallCount >= 2) {
      hint =
        `The page has not changed for ${state.stallCount} consecutive steps. ` +
        "Do NOT repeat the same action. If the task is already complete, return done. " +
        "Otherwise try a different approach — e.g. scroll (the tree lists scrollable regions), " +
        "click a different element, or navigate elsewhere.";
      log(chatId, `Step ${step}: no progress detected for ${state.stallCount} steps; nudging model`);
    } else if (state.scrollRun >= 4) {
      hint =
        `You have scrolled ${state.scrollRun} times in a row without taking any other action. ` +
        "If the requested items are now visible, return an answer summarizing the findings " +
        "(e.g. the top 5 with names and prices) with an empty actions list, or return done. Avoid further scrolling.";
      log(chatId, `Step ${step}: ${state.scrollRun} consecutive scrolls; nudging model to conclude`);
    } else if ((state.poolRun || 0) >= 2) {
      // open/close/switch flip-flops never trip the tree-hash stall detector
      // (the page alternates between two different states), so guard it separately.
      hint =
        `You have spent ${state.poolRun} consecutive steps only opening/closing/switching tabs. ` +
        `Remembered facts so far: ${state.findings.length ? JSON.stringify(state.findings) : "(none)"}. ` +
        "If they satisfy the success criteria, return the final answer NOW with empty actions. " +
        "Otherwise act on the current tab — do not reopen tabs you already read.";
      log(chatId, `Step ${step}: ${state.poolRun} consecutive tab-pool steps; nudging model to conclude`);
    } else if ((state.emptyRun || 0) >= 1) {
      // A step that returns actions:[] with no answer/done/fail is invalid per the
      // system prompt's own rules. Don't wait for the tree-hash stall detector (which
      // needs a second identical step) — nudge on the very next attempt.
      hint =
        "Your previous response returned no actions and no answer/done/fail, which is invalid. " +
        "You MUST return at least one action this step, or conclude with an answer (if you " +
        'already have enough information) or {"type":"fail","reason":"..."} (if truly stuck).';
      log(chatId, `Step ${step}: nudging model after an empty-actions response`);
    }

    const screenshot = await captureTabWithRetry(tabId);
    if (!screenshot) {
      stopTask(chatId, "Stopped: screenshot capture kept failing");
      return;
    }
    await ensureOffscreenDocument();
    status(chatId, `Step ${step}: redacting screenshot...`);

    const { piiStrict } = await chrome.storage.local.get("piiStrict");
    const redacted = await chrome.runtime.sendMessage({
      action: "processScreenshot",
      imageUrl: screenshot,
      targetName: `agent_chat${chatId}_step_${step}.png`,
      domPrivacyRegions: snapshot.privacyRegions || [],
      viewportWidth: snapshot.viewportWidth || 0,
      viewportHeight: snapshot.viewportHeight || 0,
      chatId,
      piiStrict: !!piiStrict,
    });

    if (!state.running) return;
    if (redacted?.error) throw new Error(redacted.error);
    if (!redacted?.redactedImageUrl) throw new Error("Redaction returned no image");

    emit(chatId, "step-screenshot", { step, image: redacted.redactedImageUrl });
    log(chatId, `Step ${step}: redacted screenshot ready (faces: ${redacted.faceCount}, PII: ${redacted.piiCount})`);

    let tree = snapshot.tree || "(no accessibility data)";
    const poolLine = state.tabs
      .map((t, i) => `[t${i + 1}]${t === state.currentTab ? " (current)" : ""} tab ${t}`)
      .join(", ");
    tree = `Tabs: ${poolLine}\n\n${tree}`;
    status(chatId, `Step ${step}: asking AI server...`);

    const stepStreamText = [];
    // Watchdog: a hung backend stream must never freeze the chat at
    // "running". Time out, then retry once before failing the step.
    let decision;
    try {
      decision = await withTimeout(
        askBackendStream(
          {
            image: redacted.redactedImageUrl,
            tree,
            task: state.task,
            mode: state.mode,
            history: state.history.slice(-20),
            hint,
            findings: state.findings,
            spec: state.spec,
          },
          (delta) => {
            stepStreamText.push(delta);
            emit(chatId, "step-delta", { step, text: delta });
          }
        ),
        120000,
        "AI server did not respond in time"
      );
    } catch (error) {
      log(chatId, `Step ${step}: ${error.message}; retrying once...`);
      decision = await withTimeout(
        askBackendStream(
          {
            image: redacted.redactedImageUrl,
            tree,
            task: state.task,
            mode: state.mode,
            history: state.history.slice(-20),
            hint: (hint ? hint + " " : "") + "Previous attempt timed out; respond concisely.",
            findings: state.findings,
            spec: state.spec,
          },
          (delta) => {
            stepStreamText.push(delta);
            emit(chatId, "step-delta", { step, text: delta });
          }
        ),
        120000,
        "AI server timed out twice"
      );
    }

    if (!state.running) return;
    if (decision.note) emit(chatId, "step-note", { step, note: decision.note });

    let actions = Array.isArray(decision.actions) ? decision.actions : [];
    emit(chatId, "step-actions", { step, actions });
    log(chatId, `Step ${step}: server returned ${actions.length} action(s)`);

    // Tab pool actions (open_tab / switch_tab / close_tab) change which tab
    // the chat works in. Run them, then let the next observation step capture
    // the (possibly new) current tab.
    const poolActions = actions.filter((a) =>
      ["open_tab", "switch_tab", "close_tab"].includes(a.type)
    );
    const poolOutcomes = [];
    if (poolActions.length) {
      for (const action of poolActions) {
        try {
          const detail = await handleTabPoolAction(state, action);
          poolOutcomes.push(`${action.type} OK — ${detail}`);
          log(chatId, `Step ${step}: ${action.type} OK — ${detail}`);
        } catch (error) {
          poolOutcomes.push(`${action.type} FAILED — ${error.message}`);
          log(chatId, `Step ${step}: ${action.type} FAILED — ${error.message}`);
        }
      }
      const rest = actions.filter((a) => !poolActions.includes(a));
      if (rest.length === 0) {
        state.poolRun = (state.poolRun || 0) + 1;
        state.emptyRun = 0;
        await sleep(400);
        continue;
      }
      actions = rest;
      emit(chatId, "step-actions", { step, actions });
    }

    // Persist the step (reasoning, screenshot, actions) immediately so it
    // survives even if this step takes an early exit.
    state.history.push({
      step,
      actions,
      note: [decision.note || null, ...poolOutcomes].filter(Boolean).join(" | ") || null,
    });
    const stepChat = await loadChat(chatId);
    if (stepChat) {
      stepChat.entries.push({
        t: "step",
        step,
        actions,
        note: decision.note || null,
        screenshot: redacted.redactedImageUrl,
        streamText: stepStreamText.join(""),
        ts: Date.now(),
      });
      stepChat.taskHistory = state.history;
      stepChat.findings = state.findings;
      stepChat.lastStep = state.step;
      await saveChat(stepChat);
    }

    // remember actions record facts for the final summary; they never touch
    // the browser. If a step only remembers, nothing else executes. Tag each
    // fact with the current tab's URL/title (read from the tab, not trusted
    // from the model) so the final answer can list real sources.
    if (actions.some((action) => action.type === "remember")) {
      const sourceTab = await chrome.tabs.get(tabId).catch(() => null);
      for (const action of actions.filter((action) => action.type === "remember")) {
        if (action.fact) {
          state.findings.push({ fact: action.fact, url: sourceTab?.url || null, title: sourceTab?.title || null });
          log(chatId, `Step ${step}: remembered — ${action.fact}`);
        }
      }
      actions = actions.filter((action) => action.type !== "remember");
      if (actions.length === 0) {
        state.emptyRun = 0;
        await sleep(200);
        continue;
      }
      emit(chatId, "step-actions", { step, actions });
    }

    // Research mode must not answer straight from the model's own knowledge — the prompt
    // asks for this, but LLM compliance with a buried instruction is unreliable, so enforce
    // it deterministically too: block a would-be terminal answer/done until at least one
    // remember has actually happened (i.e. a real page was read), up to a few attempts so a
    // truly stubborn model can't deadlock the chat forever.
    const wantsToTerminate = !!decision.answer || actions.some((action) => action.type === "done");
    if (state.mode === "research" && state.findings.length === 0 && wantsToTerminate) {
      state.researchBlocked = (state.researchBlocked || 0) + 1;
      if (state.researchBlocked <= 3) {
        log(
          chatId,
          `Step ${step}: blocked an answer with no sources read yet (research mode, attempt ${state.researchBlocked}/3)`
        );
        await sleep(500);
        continue;
      }
      log(chatId, `Step ${step}: allowing an unresearched answer after ${state.researchBlocked} blocked attempts`);
    }

    if (decision.answer) {
      const finalText =
        state.mode === "research" ? decision.answer + formatSourcesSection(state.findings) : decision.answer;
      emit(chatId, "answer", { text: finalText });
      const chat = await loadChat(chatId);
      if (chat) {
        chat.entries.push({ t: "answer", text: finalText, ts: Date.now() });
        await saveChat(chat);
      }
      stopTask(chatId, "Answered");
      return;
    }

    if (actions.some((action) => action.type === "fail")) {
      const failure = actions.find((action) => action.type === "fail");
      const endedText = `Task ended because ${failure.reason || "the server returned fail with no reason"}.`;
      emit(chatId, "answer", { text: endedText });
      const chat = await loadChat(chatId);
      if (chat) {
        chat.entries.push({ t: "answer", text: endedText, ts: Date.now() });
        await saveChat(chat);
      }
      stopTask(chatId, endedText);
      return;
    }
    if (actions.some((action) => action.type === "done")) {
      const done = actions.find((action) => action.type === "done");
      let summary = done.summary || done.answer || done.text;
      if (summary && state.mode === "research") summary += formatSourcesSection(state.findings);
      if (summary) {
        emit(chatId, "answer", { text: summary });
        const chat = await loadChat(chatId);
        if (chat) chat.entries.push({ t: "answer", text: summary, ts: Date.now() });
      }
      const chat = await loadChat(chatId);
      if (chat) await saveChat(chat);
      stopTask(chatId, summary ? "Completed" : "Completed (no summary returned)");
      return;
    }

    if (actions.length === 0) {
      state.emptyRun = (state.emptyRun || 0) + 1;
      log(chatId, `Step ${step}: 0 actions and no answer/done/fail (${state.emptyRun})`);
      await sleep(1000);
      continue;
    }

    status(chatId, `Step ${step}: executing ${actions.length} action(s)...`);
    state.poolRun = 0;
    state.emptyRun = 0;
    const executableActions = await resolveActionTargets(tabId, actions, snapshot);
    let results = await executeActions(tabId, executableActions);
    if (results.some((result) => !result.ok && isDebuggerDetachedError(result.error))) {
      log(chatId, `Step ${step}: debugger detached; re-attaching and retrying actions`);
      await forceDebuggerAttach(tabId);
      results = await executeActions(tabId, executableActions);
    }

    for (const result of results) {
      if (result.ok) {
        const detail = String(result.detail || "");
        log(chatId, `Step ${step}: ${result.action.type} OK — ${detail.length > 300 ? detail.slice(0, 300) + "… (" + detail.length + " chars)" : detail}`);
      } else log(chatId, `Step ${step}: ${result.action.type} FAILED — ${result.error}`);
    }
    state.lastActionTs = Date.now();

    const historyEntry = state.history[state.history.length - 1];
    historyEntry.actions = executableActions;
    historyEntry.results = results.map((result) => ({ ok: result.ok, detail: result.detail, error: result.error }));

    const chat = await loadChat(chatId);
    if (chat) {
      for (let i = chat.entries.length - 1; i >= 0; i--) {
        if (chat.entries[i].t === "step" && chat.entries[i].step === step) {
          chat.entries[i].actions = executableActions;
          chat.entries[i].results = historyEntry.results;
          break;
        }
      }
      chat.taskHistory = state.history;
      chat.lastStep = state.step;
      chat.lastTabId = state.tabId;
      await saveChat(chat);
    }

    if (!state.running) return;
    // Navigation actions trigger page loads; wait for them to finish before
    // the next screenshot, otherwise we capture the old page.
    const navigates = executableActions.some((action) =>
      ["navigate", "back", "forward"].includes(action.type)
    );
    if (navigates) {
      await waitForTabLoad(tabId, 10000);
      await sleep(300);
    } else {
      await sleep(700);
    }
  }
}

async function resolveActionTargets(tabId, actions, snapshot) {
  const viewportWidth = snapshot.viewportWidth || 0;
  const viewportHeight = snapshot.viewportHeight || 0;

  return Promise.all(actions.map(async (original) => {
    const action = { ...original };
    const elementId = action.id || action.element_id || action.target_id;

    if (elementId && (action.x === undefined || action.y === undefined)) {
      const target = await chrome.tabs.sendMessage(tabId, {
        action: "getElementRect",
        id: elementId,
      });
      if (target?.error) throw new Error(target.error);
      const rect = target.rect;
      action.x = rect.x + rect.width / 2;
      action.y = rect.y + rect.height / 2;
      delete action.id;
      delete action.element_id;
      delete action.target_id;
    }

    if (action.type === "scroll") {
      if (action.x === undefined) action.x = viewportWidth ? viewportWidth / 2 : 1;
      if (action.y === undefined) action.y = viewportHeight ? viewportHeight / 2 : 1;
      if (action.amount === undefined && Number.isFinite(action.ticks)) {
        action.amount = action.ticks;
      }
    }
    return action;
  }));
}

async function askBackendStream(payload, onDelta) {
  let response;
  try {
    response = await fetch(`${BACKEND_BASE}/ask_stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: payload.image,
        tree: payload.tree,
        task: payload.task,
        mode: payload.mode || "normal",
        history: payload.history,
        hint: payload.hint || "",
        findings: payload.findings || [],
      }),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach backend at ${BACKEND_BASE}; start it with 'cd backend && uv run python main.py' (${error.message})`
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Backend returned HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = { actions: [], note: null, answer: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const line = event.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      const parsed = JSON.parse(line.slice(6));
      if (parsed.type === "delta") onDelta(parsed.text);
      else if (parsed.type === "result") {
        result = {
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          note: parsed.note || null,
          answer: parsed.answer || null,
        };
      }
    }
  }
  return result;
}

async function captureTabWithRetry(tabId, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await captureTab(tabId);
    } catch (error) {
      lastError = error;
      console.warn(`Screenshot attempt ${attempt}/${attempts} failed for tab ${tabId}:`, error.message);
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// ---------- resume interrupted tasks after service worker restarts ----------

// MV3 can terminate the worker (sidebar toggles, tab focus churn, long
// backend waits). The loop lives in memory, so on restart we pick running
// chats back up: the loop is observation-driven, so resuming is just running
// another step with the persisted history/findings.
async function resumeInterruptedTasks() {
  const chats = await loadAllChats();
  for (const chat of Object.values(chats)) {
    if (!chat.running) continue;
    if (!chat.lastTabId) {
      chat.running = false;
      await saveChat(chat);
      continue;
    }
    console.log(`Resuming interrupted task for ${chat.id}`);
    taskStates.set(chat.id, {
      running: true,
      chatId: chat.id,
      tabId: chat.lastTabId,
      windowId: null,
      task: chat.lastTask || "",
      mode: chat.mode === "research" ? "research" : "normal",
      step: chat.lastStep || 0,
      history: chat.taskHistory || [],
      findings: chat.findings || [],
      spec: chat.spec || null,
      tabs: [chat.lastTabId],
      currentTab: chat.lastTabId,
      lastTreeHash: null,
      stallCount: 0,
      scrollRun: 0,
    });
    updateKeepalive();
    runTaskLoop(chat.id).catch((error) => {
      console.error(`Resumed task loop failed for ${chat.id}:`, error);
      stopTask(chat.id, `Stopped: ${error.message}`);
    });
  }
}

resumeInterruptedTasks();

function hashString(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}

// Chat title = first 4 words of the first message.
function titleFromMessage(text) {
  const words = String(text).trim().replace(/\s+/g, " ").split(" ");
  return words.slice(0, 4).join(" ");
}

// Deterministic "Sources" appendix for research-mode answers — built from the
// URLs actually visited (captured server-side on each remember, not trusted
// from the model), not from whatever the model claims it looked at.
function formatSourcesSection(findings) {
  const seen = new Set();
  const lines = [];
  for (const finding of findings || []) {
    const url = finding && typeof finding === "object" ? finding.url : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const label = (finding.title && finding.title.trim()) || url;
    lines.push(`- [${label.replace(/[[\]]/g, "")}](${url})`);
  }
  return lines.length ? `\n\n## Sources\n${lines.join("\n")}` : "";
}

// ---------- message routing ----------

chrome.debugger.onDetach.addListener((source) => {
  // If the user dismisses the debugging infobar or closes the tab, Chrome
  // detaches the session. Stop that chat cleanly instead of erroring forever.
  const chatId = source?.tabId;
  if (chatId && taskStates.get(chatId)?.running) {
    stopTask(chatId, "Stopped: debugger detached");
  }
});

// When a page opens a new tab in response to one of our clicks
// (target="_blank" links, window.open), adopt it as the task's tab so the
// loop follows the content instead of screenshotting the stale page.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.openerTabId || !tab.id) return;
  for (const state of taskStates.values()) {
    if (!state.running || state.tabId !== tab.openerTabId) continue;
    // Only adopt if one of our actions ran very recently — a tab the user
    // opened manually from that page should not hijack the task.
    if (Date.now() - (state.lastActionTs || 0) > 5000) continue;
    adoptNewTab(state, tab.id);
    break;
  }
});

// open_tab / switch_tab / close_tab mutate the chat's tab pool and always
// change which tab the next observation step captures, so the caller lets
// the loop continue instead of executing further actions.
function parsePoolRef(state, ref) {
  const index = parseInt(String(ref ?? "").replace(/^t/i, ""), 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= state.tabs.length) {
    throw new Error(
      `unknown tab "${ref ?? ""}". Pool: ${state.tabs.map((_, i) => `t${i + 1}`).join(", ")}`
    );
  }
  return index;
}

async function switchPoolTab(state, tabId) {
  if (state.tabId !== tabId) {
    await attachDebugger(tabId);
    chrome.debugger.detach({ tabId: state.tabId }).catch(() => {});
  }
  state.tabId = tabId;
  state.currentTab = tabId;
  // Background tabs are not composited and their JS (rAF, IntersectionObserver,
  // lazy-loaders) is throttled, so screenshots/DOM read while backgrounded can be
  // stale or incomplete. Bring the tab to the front of its window before observing it.
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await waitForTabLoad(tabId, 10000);
  await sleep(200);
}

// ponytail: flat pool cap — per-chat budgets only if this ever matters
const MAX_POOL_TABS = 6;

async function handleTabPoolAction(state, action) {
  if (action.type === "open_tab") {
    if (!action.url) throw new Error("open_tab requires url");
    let url = action.url;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    if (state.tabs.length >= MAX_POOL_TABS) {
      throw new Error(
        `tab pool is full (${MAX_POOL_TABS}). Use switch_tab to revisit an open tab or close_tab to free a slot.`
      );
    }

    const tab = await chrome.tabs.create({ url, active: false });
    state.tabs.push(tab.id);
    await switchPoolTab(state, tab.id);
    return `opened t${state.tabs.length} (tab ${tab.id}): ${url}`;
  }

  if (action.type === "switch_tab") {
    const index = parsePoolRef(state, action.tab);
    await switchPoolTab(state, state.tabs[index]);
    return `switched to t${index + 1} (tab ${state.tabId})`;
  }

  if (action.type === "close_tab") {
    const index = action.tab != null ? parsePoolRef(state, action.tab) : state.tabs.indexOf(state.currentTab);
    const closing = state.tabs[index];
    state.tabs.splice(index, 1);
    chrome.debugger.detach({ tabId: closing }).catch(() => {});
    await chrome.tabs.remove(closing).catch(() => {});
    if (state.tabId === closing) {
      if (!state.tabs.length) throw new Error("closed the last pool tab; task cannot continue");
      await switchPoolTab(state, state.tabs[0]);
    }
    return `closed t${index + 1} (tab ${closing})`;
  }

  throw new Error(`unknown tab pool action: ${action.type}`);
}

async function adoptNewTab(state, newTabId) {
  const oldTabId = state.tabId;
  log(state.chatId, `Page opened a new tab; switching task to tab ${newTabId}`);
  state.tabId = newTabId;
  state.currentTab = newTabId;
  if (!state.tabs.includes(newTabId)) state.tabs.push(newTabId);
  await attachDebugger(newTabId);
  chrome.debugger.detach({ tabId: oldTabId }).catch(() => {});
  await chrome.tabs.update(newTabId, { active: true }).catch(() => {});
  await waitForTabLoad(newTabId, 10000);
}

function waitForTabLoad(tabId, timeout = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Already finished loading before we started listening?
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") done();
    }).catch(done);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startTask") {
    startTask(request.task, request.chatId, request.mode)
      .then((state) => sendResponse({ chatId: state.chatId, tabId: state.tabId }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "stopTask") {
    if (request.chatId) stopTask(request.chatId, "Stopped");
    else stopAllTasks("Stopped");
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "getTaskState") {
    const chatId = request.chatId || null;
    const state = chatId ? taskStates.get(chatId) : null;
    sendResponse({
      running: state?.running || false,
      tabId: state?.tabId || null,
      step: state?.step || 0,
      runningChatIds: [...taskStates.values()].filter((s) => s.running).map((s) => s.chatId),
    });
    return false;
  }

  if (request.action === "newChat") {
    // Parallel chats are supported: creating a new chat never disturbs
    // running ones.
    (async () => {
      const chat = await newChatRecord();
      await saveChat(chat);
      await setActiveChatId(chat.id);
      sendResponse({ ok: true, chat });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "listChats") {
    loadAllChats().then(async (chats) => {
      const list = Object.values(chats)
        .map(({ id, title, updatedAt }) => ({
          id,
          title: title || "untitled",
          updatedAt,
          running: taskStates.get(id)?.running || false,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const activeId = await getActiveChatId();
      sendResponse({ chats: list, activeId });
    });
    return true;
  }

  if (request.action === "openChat") {
    loadChat(request.id).then(async (chat) => {
      if (!chat) {
        sendResponse({ error: "chat not found" });
        return;
      }
      await setActiveChatId(chat.id);
      sendResponse({ chat, running: taskStates.get(chat.id)?.running || false });
    });
    return true;
  }

  if (request.action === "deleteChat") {
    if (taskStates.get(request.id)?.running) {
      sendResponse({ error: "stop the chat before deleting it" });
      return false;
    }
    loadAllChats().then(async (chats) => {
      delete chats[request.id];
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
      const activeId = await getActiveChatId();
      if (activeId === request.id) {
        await chrome.storage.local.remove(ACTIVE_CHAT_KEY);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === "getActiveChat") {
    getActiveChatId().then(async (id) => {
      if (!id) return sendResponse({ chat: null });
      const chat = await loadChat(id);
      sendResponse({ chat, running: taskStates.get(id)?.running || false });
    });
    return true;
  }

  if (request.action === "offscreenReady") {
    if (offscreenResolve) offscreenResolve();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "progress") {
    // Offscreen progress for a specific chat's redaction job.
    if (request.chatId) status(request.chatId, request.message || `${request.percent || 0}%`);
    sendResponse({ ok: true });
    return false;
  }
});
