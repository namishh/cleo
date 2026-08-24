import { executeActions } from "./actions.js";

const BACKEND_URL = "http://127.0.0.1:5001/ask";
const MAX_STEPS = 50;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Browser Agent Sidebar installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("Failed to set side panel behavior:", error);
});

let offscreenReadyPromise = null;
let offscreenResolve = null;
let taskState = {
  running: false,
  tabId: null,
  windowId: null,
  task: "",
  step: 0,
  history: [],
};

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
  taskState = {
    running: true,
    tabId: tab.id,
    windowId: tab.windowId,
    task: String(task).trim(),
    step: 0,
    history: [],
  };

  log(`Started task on tab ${tab.id}: ${taskState.task}`);
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
  };

  if (wasRunning && tabId != null) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  if (wasRunning) {
    log(reason);
    chrome.runtime.sendMessage({ action: "taskStopped", reason }).catch(() => {});
  }
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

    agentEvent("screenshot", {
      image: redacted.redactedImageUrl,
      step,
    });
    log(`Step ${step}: redacted screenshot ready (faces: ${redacted.faceCount}, PII: ${redacted.piiCount})`);

    const tree = snapshot.tree || "(no accessibility data)";
    agentEvent("tree", { tree, step });
    status(`Step ${step}: asking AI server...`);

    const decision = await askBackend({
      image: redacted.redactedImageUrl,
      tree,
      task,
      history: taskState.history.slice(-20),
    });

    if (!taskState.running) return;
    if (decision.note) log(`Step ${step}: server note: ${decision.note}`);
    const actions = Array.isArray(decision.actions) ? decision.actions : [];
    log(`Step ${step}: server returned ${actions.length} action(s)`);

    if (actions.some((action) => action.type === "fail")) {
      const failure = actions.find((action) => action.type === "fail");
      stopTask(`Failed: ${failure.reason || "server returned fail"}`);
      return;
    }
    if (actions.some((action) => action.type === "done")) {
      stopTask("Completed");
      return;
    }

    if (actions.length === 0) {
      taskState.history.push({ step, actions: [], note: decision.note || "no action" });
      await sleep(1000);
      continue;
    }

    status(`Step ${step}: executing ${actions.length} action(s)...`);
    let results = await executeActions(tabId, actions);
    if (results.some((result) => !result.ok && isDebuggerDetachedError(result.error))) {
      log(`Step ${step}: debugger detached; re-attaching and retrying actions`);
      await forceDebuggerAttach(tabId);
      results = await executeActions(tabId, actions);
    }

    for (const result of results) {
      if (result.ok) log(`Step ${step}: ${result.action.type} OK — ${result.detail}`);
      else log(`Step ${step}: ${result.action.type} FAILED — ${result.error}`);
    }

    taskState.history.push({ step, actions, results, note: decision.note || null });
    await sleep(700);
  }
}

async function askBackend(payload) {
  const response = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_b64: payload.image,
      tree: payload.tree,
      task: payload.task,
      history: payload.history,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Backend returned HTTP ${response.status}`);
  if (!Array.isArray(body.actions)) throw new Error("Backend response has no actions array");
  return body;
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
