import { executeActions } from "./actions.js";

const BACKEND_BASE = "http://127.0.0.1:5001";
const MAX_STEPS = 50;
const CHATS_KEY = "cleo_chats";
const ACTIVE_CHAT_KEY = "cleo_activeChat";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Cleo installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("Failed to set side panel behavior:", error);
});

let offscreenReadyPromise = null;
let offscreenResolve = null;
let currentChatId = null;
let taskState = {
  running: false,
  tabId: null,
  windowId: null,
  task: "",
  step: 0,
  history: [],
  lastTreeHash: null,
  stallCount: 0,
};

// ---------- chat store (chrome.storage.local, unlimitedStorage) ----------

async function loadAllChats() {
  const store = await chrome.storage.local.get(CHATS_KEY);
  return store[CHATS_KEY] || {};
}

async function loadChat(id) {
  const chats = await loadAllChats();
  return chats[id] || null;
}

async function saveChat(chat) {
  chat.updatedAt = Date.now();
  const store = await chrome.storage.local.get(CHATS_KEY);
  const chats = store[CHATS_KEY] || {};
  chats[chat.id] = chat;
  await chrome.storage.local.set({ [CHATS_KEY]: chats });
}

async function setActiveChatId(id) {
  currentChatId = id;
  await chrome.storage.local.set({ [ACTIVE_CHAT_KEY]: id });
}

async function getActiveChatId() {
  if (currentChatId) return currentChatId;
  const store = await chrome.storage.local.get(ACTIVE_CHAT_KEY);
  currentChatId = store[ACTIVE_CHAT_KEY] || null;
  return currentChatId;
}

async function newChatRecord() {
  const count = Object.keys(await loadAllChats()).length + 1;
  return {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: `New Chat #${count}`,
    customTitle: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entries: [],
    taskHistory: [],
    findings: [],
    lastStep: 0,
  };
}

async function appendEntry(chatId, entry) {
  const chat = await loadChat(chatId);
  if (!chat) return;
  chat.entries.push({ ts: Date.now(), ...entry });
  await saveChat(chat);
}

// ponytail: naive title generation, one call after the first user message
async function autoTitle(chatId, text) {
  try {
    const response = await fetch(`${BACKEND_BASE}/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await response.json();
    const chat = await loadChat(chatId);
    if (chat && body.title) {
      chat.title = body.title;
      chat.customTitle = true;
      await saveChat(chat);
      agentEvent("title", { chatId, title: body.title });
    }
  } catch (error) {
    console.warn("Auto-title failed:", error);
  }
}

function agentEvent(kind, payload = {}) {
  chrome.runtime.sendMessage({ action: "agentEvent", kind, ...payload }).catch(() => {});
}

function log(message) {
  console.log(`[agent] ${message}`);
  agentEvent("log", { message });
}

function status(message) {
  agentEvent("status", { message });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (taskState.running && source.tabId === taskState.tabId) {
    console.warn("Debugger detached from task tab:", reason);
    stopTask(`Stopped: debugger detached (${reason || "unknown reason"})`);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "newChat") {
    if (taskState.running) {
      sendResponse({ error: "stop the agent first" });
    } else {
      currentChatId = null;
      chrome.storage.local.remove(ACTIVE_CHAT_KEY);
      sendResponse({ ok: true });
    }
    return false;
  }

  if (request.action === "listChats") {
    loadAllChats().then((chats) => {
      const list = Object.values(chats)
        .map(({ id, title, updatedAt }) => ({ id, title: title || "untitled", updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      sendResponse({ chats: list });
    });
    return true;
  }

  if (request.action === "openChat") {
    if (taskState.running) {
      sendResponse({ error: "stop the agent first" });
      return false;
    }
    loadChat(request.id).then(async (chat) => {
      if (!chat) {
        sendResponse({ error: "chat not found" });
        return;
      }
      await setActiveChatId(chat.id);
      sendResponse({ chat });
    });
    return true;
  }

  if (request.action === "deleteChat") {
    loadAllChats().then(async (chats) => {
      delete chats[request.id];
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
      if (currentChatId === request.id) {
        currentChatId = null;
        await chrome.storage.local.remove(ACTIVE_CHAT_KEY);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === "getActiveChat") {
    getActiveChatId().then((id) => {
      if (!id) return sendResponse({ chat: null });
      loadChat(id).then((chat) => sendResponse({ chat }));
    });
    return true;
  }

  if (request.action === "startTask") {
    startTask(request.task)
      .then((state) => sendResponse({ tabId: state.tabId }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (request.action === "startTask") {
    startTask(request.task)
      .then((state) => sendResponse({ tabId: state.tabId }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "stopTask") {
    stopTask("Stopped");
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "getTaskState") {
    sendResponse({
      running: taskState.running,
      tabId: taskState.tabId,
      step: taskState.step,
    });
    return false;
  }

  if (request.action === "offscreenReady") {
    if (offscreenResolve) offscreenResolve();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "progress") {
    status(request.message || `${request.percent || 0}%`);
    sendResponse({ ok: true });
    return false;
  }
});

async function startTask(task) {
  if (taskState.running) return taskState;
  if (!String(task || "").trim()) throw new Error("Task cannot be empty");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  await attachDebugger(tab.id);

  // Continue the active chat if one exists; otherwise start a new one.
  const chatId = await getActiveChatId();
  let chat = chatId ? await loadChat(chatId) : null;
  if (!chat) {
    chat = newChatRecord();
    await setActiveChatId(chat.id);
  }
  currentChatId = chat.id;

  chat.entries.push({ t: "user", text: String(task).trim(), ts: Date.now() });
  await saveChat(chat);
  if (!chat.customTitle) autoTitle(chat.id, task);

  taskState = {
    running: true,
    tabId: tab.id,
    windowId: tab.windowId,
    task: String(task).trim(),
    step: chat.lastStep || 0,
    history: chat.taskHistory || [],
    findings: chat.findings || [],
    lastTreeHash: null,
    stallCount: 0,
    scrollRun: 0,
    chatId: chat.id,
  };

  agentEvent("user", { text: taskState.task });
  status(`Running on tab ${tab.id}`);
  runTaskLoop().catch((error) => {
    console.error("Task loop failed:", error);
    log(`Fatal error: ${error.message}`);
    stopTask(`Stopped: ${error.message}`);
  });
  return taskState;
}

function stopTask(reason = "Stopped") {
  const tabId = taskState.tabId;
  const wasRunning = taskState.running;
  taskState = {
    running: false,
    tabId: null,
    windowId: null,
    task: "",
    step: 0,
    history: [],
    findings: [],
    lastTreeHash: null,
    stallCount: 0,
    scrollRun: 0,
  };

  if (wasRunning && tabId != null) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  if (wasRunning) {
    log(reason);
    chrome.runtime.sendMessage({ action: "taskStopped", reason }).catch(() => {});
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

async function runTaskLoop() {
  while (taskState.running) {
    if (taskState.step >= MAX_STEPS) {
      stopTask(`Stopped: reached ${MAX_STEPS}-step limit`);
      return;
    }

    const step = ++taskState.step;
    const tabId = taskState.tabId;
    const task = taskState.task;
    agentEvent("step-start", { step });
    status(`Step ${step}: observing tab ${tabId}...`);

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      stopTask("Stopped: task tab was closed");
      return;
    }

    let snapshot;
    try {
      snapshot = await getCompactPageSnapshot(tabId);
      log(`Step ${step}: collected ${snapshot.elements?.length || 0} actionable elements`);
    } catch (error) {
      snapshot = {
        tree: `(page snapshot unavailable: ${error.message})`,
        privacyRegions: [],
        viewportWidth: 0,
        viewportHeight: 0,
      };
      log(`Step ${step}: DOM snapshot unavailable; continuing with screenshot`);
    }

    // Stall detection: identical page state across steps means the previous
    // action did nothing. Nudge the model instead of looping forever.
    const treeHash = hashString(snapshot.tree || "");
    if (treeHash === taskState.lastTreeHash) {
      taskState.stallCount += 1;
    } else {
      taskState.stallCount = 0;
      taskState.lastTreeHash = treeHash;
    }
    let hint = "";
    if (taskState.stallCount >= 2) {
      hint =
        `The page has not changed for ${taskState.stallCount} consecutive steps. ` +
        "Do NOT repeat the same action. If the task is already complete, return done. " +
        "Otherwise try a different approach — e.g. scroll (the tree lists scrollable regions), " +
        "click a different element, or navigate elsewhere.";
      log(`Step ${step}: no progress detected for ${taskState.stallCount} steps; nudging model`);
    } else if (taskState.scrollRun >= 4) {
      hint =
        `You have scrolled ${taskState.scrollRun} times in a row without taking any other action. ` +
        "If the requested items are now visible, return an answer summarizing the findings " +
        "(e.g. the top 5 with names and prices) with an empty actions list, or return done. Avoid further scrolling.";
      log(`Step ${step}: ${taskState.scrollRun} consecutive scrolls; nudging model to conclude`);
    }

    const screenshot = await captureTab(tabId);
    await ensureOffscreenDocument();
    status(`Step ${step}: redacting screenshot...`);

    const redacted = await chrome.runtime.sendMessage({
      action: "processScreenshot",
      imageUrl: screenshot,
      targetName: `agent_step_${step}.png`,
      domPrivacyRegions: snapshot.privacyRegions || [],
      viewportWidth: snapshot.viewportWidth || 0,
      viewportHeight: snapshot.viewportHeight || 0,
    });

    if (!taskState.running) return;
    if (redacted?.error) throw new Error(redacted.error);
    if (!redacted?.redactedImageUrl) throw new Error("Redaction returned no image");

    agentEvent("step-screenshot", { step, image: redacted.redactedImageUrl });
    log(`Step ${step}: redacted screenshot ready (faces: ${redacted.faceCount}, PII: ${redacted.piiCount})`);

    const tree = snapshot.tree || "(no accessibility data)";
    status(`Step ${step}: asking AI server...`);

    const stepStreamText = [];
    const decision = await askBackendStream(
      {
        image: redacted.redactedImageUrl,
        tree,
        task,
        history: taskState.history.slice(-20),
        hint,
        findings: taskState.findings,
      },
      (delta) => {
        stepStreamText.push(delta);
        agentEvent("step-delta", { step, text: delta });
      }
    );

    if (!taskState.running) return;
    if (decision.note) agentEvent("step-note", { step, note: decision.note });

    let actions = Array.isArray(decision.actions) ? decision.actions : [];
    agentEvent("step-actions", { step, actions });
    log(`Step ${step}: server returned ${actions.length} action(s)`);

    // remember actions record facts for the final summary; they never touch
    // the browser. If a step only remembers, nothing else executes.
    if (actions.some((action) => action.type === "remember")) {
      for (const action of actions.filter((action) => action.type === "remember")) {
        if (action.fact) {
          taskState.findings.push(action.fact);
          log(`Step ${step}: remembered — ${action.fact}`);
        }
      }
      actions = actions.filter((action) => action.type !== "remember");
      if (actions.length === 0) {
        taskState.history.push({ step, actions: [], results: [{ ok: true, detail: "remembered" }] });
        await sleep(200);
        continue;
      }
      agentEvent("step-actions", { step, actions });
    }

    if (decision.answer) {
      // Informational reply: show it in the chat and end the run.
      agentEvent("answer", { text: decision.answer });
      const chat = await loadChat(taskState.chatId);
      if (chat) {
        chat.entries.push({ t: "answer", text: decision.answer, ts: Date.now() });
        chat.taskHistory = taskState.history;
        chat.findings = taskState.findings;
        chat.lastStep = taskState.step;
        await saveChat(chat);
      }
      stopTask("Answered");
      return;
    }

    if (actions.some((action) => action.type === "fail")) {
      const failure = actions.find((action) => action.type === "fail");
      stopTask(`Failed: ${failure.reason || "server returned fail"}`);
      return;
    }
    if (actions.some((action) => action.type === "done")) {
      const done = actions.find((action) => action.type === "done");
      const summary = done.summary || done.answer || done.text;
      if (summary) {
        agentEvent("answer", { text: summary });
        const chat = await loadChat(taskState.chatId);
        if (chat) {
          chat.entries.push({ t: "answer", text: summary, ts: Date.now() });
        }
      }
      if (taskState.chatId) {
        const chat = await loadChat(taskState.chatId);
        if (chat) {
          chat.taskHistory = taskState.history;
          chat.findings = taskState.findings;
          chat.lastStep = taskState.step;
          await saveChat(chat);
        }
      }
      stopTask(summary ? "Completed" : "Completed (no summary returned)");
      return;
    }

    if (actions.length === 0) {
      taskState.history.push({ step, actions: [], note: decision.note || "no action" });
      await sleep(1000);
      continue;
    }

    status(`Step ${step}: executing ${actions.length} action(s)...`);
    const executableActions = await resolveActionTargets(tabId, actions, snapshot);
    let results = await executeActions(tabId, executableActions);
    if (results.some((result) => !result.ok && isDebuggerDetachedError(result.error))) {
      log(`Step ${step}: debugger detached; re-attaching and retrying actions`);
      await forceDebuggerAttach(tabId);
      results = await executeActions(tabId, executableActions);
    }

    for (const result of results) {
      if (result.ok) {
        // read_text results can be long; keep the log readable.
        const detail = String(result.detail || "");
        log(`Step ${step}: ${result.action.type} OK — ${detail.length > 300 ? detail.slice(0, 300) + "… (" + detail.length + " chars)" : detail}`);
      } else log(`Step ${step}: ${result.action.type} FAILED — ${result.error}`);
    }

    taskState.history.push({
      step,
      actions: executableActions,
      results: results.map((result) => ({ ok: result.ok, detail: result.detail, error: result.error })),
      note: decision.note || null,
    });

    // Persist the step into the chat transcript.
    const chat = await loadChat(taskState.chatId);
    if (chat) {
      chat.entries.push({
        t: "step",
        step,
        actions: executableActions,
        note: decision.note || null,
        screenshot: redacted.redactedImageUrl,
        streamText: stepStreamText.join(""),
        ts: Date.now(),
      });
      chat.taskHistory = taskState.history;
      chat.findings = taskState.findings;
      chat.lastStep = taskState.step;
      await saveChat(chat);
    }

    // Track scroll-only runs so endless browsing can be interrupted.
    const scrollCount = executableActions.filter((action) => action.type === "scroll").length;
    taskState.scrollRun = scrollCount === executableActions.length && scrollCount > 0
      ? taskState.scrollRun + scrollCount
      : 0;

    if (!taskState.running) return;
    // Navigation actions trigger page loads; give them time to settle before
    // the next screenshot, otherwise we capture the old page.
    const navigates = executableActions.some((action) =>
      ["navigate", "back", "forward"].includes(action.type)
    );
    await sleep(navigates ? 1500 : 700);
  }
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
        history: payload.history,
        hint: payload.hint || "",
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
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png", fromSurface: true }
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      action: "getCompactAccessibilityTree",
    });
    if (snapshot?.error) throw new Error(snapshot.error);
    return snapshot;
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    if (!offscreenReadyPromise) offscreenReadyPromise = Promise.resolve();
    return offscreenReadyPromise;
  }
  if (offscreenReadyPromise) return offscreenReadyPromise;

  offscreenReadyPromise = new Promise((resolve, reject) => {
    offscreenResolve = resolve;
    setTimeout(() => reject(new Error("Offscreen document failed to become ready")), 10000);
  });

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS", "DOM_PARSER"],
    justification: "Run local screenshot redaction models",
  });
  await offscreenReadyPromise;
  offscreenResolve = null;
}

async function hasOffscreenDocument() {
  try {
    const clients = await self.clients.matchAll();
    return clients.some((client) => client.url.includes(chrome.runtime.getURL("offscreen.html")));
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}
