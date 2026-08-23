chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Browser Agent Sidebar installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("Failed to set side panel behavior:", err);
});

let offscreenReadyPromise = null;
let offscreenResolve = null;

// Loop state
let loopState = {
  running: false,
  tabId: null,
  windowId: null,
  timer: null,
  debuggerAttached: false,
};

function reportProgress(percent, message) {
  chrome.runtime
    .sendMessage({ action: "progress", percent, message })
    .catch(() => {});
}

function reportLoopStatus(message, skipped = false) {
  chrome.runtime
    .sendMessage({ action: "loopStatus", message, skipped })
    .catch(() => {});
}

// If the debugger detaches (e.g. user dismisses the infobar or closes the
// tab), stop the loop cleanly instead of erroring every tick.
chrome.debugger.onDetach.addListener((source) => {
  if (loopState.running && source.tabId === loopState.tabId) {
    console.warn("Debugger detached from pinned tab, stopping loop");
    loopState.debuggerAttached = false;
    stopLoop();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startLoop") {
    startLoop()
      .then((state) => sendResponse({ tabId: state.tabId }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === "stopLoop") {
    stopLoop();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "getLoopState") {
    sendResponse({ running: loopState.running, tabId: loopState.tabId });
    return false;
  }

  if (request.action === "offscreenReady") {
    if (offscreenResolve) offscreenResolve();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "progress") {
    chrome.runtime.sendMessage(request).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
});

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    if (!offscreenReadyPromise) {
      offscreenReadyPromise = Promise.resolve();
    }
    return offscreenReadyPromise;
  }

  if (offscreenReadyPromise) {
    return offscreenReadyPromise;
  }

  offscreenReadyPromise = new Promise((resolve, reject) => {
    offscreenResolve = resolve;
    setTimeout(() => reject(new Error("Offscreen document failed to become ready")), 10000);
  });

  console.log("Creating offscreen document...");
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS", "DOM_PARSER"],
    justification: "Run ONNX face detection and OCR redaction on screenshots",
  });

  await offscreenReadyPromise;
  console.log("Offscreen document ready");
  offscreenResolve = null;
}

async function hasOffscreenDocument() {
  try {
    const matchedClients = await self.clients.matchAll();
    return matchedClients.some((client) =>
      client.url.includes(chrome.runtime.getURL("offscreen.html"))
    );
  } catch (e) {
    return false;
  }
}

async function startLoop() {
  if (loopState.running) return loopState;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  loopState = {
    running: true,
    tabId: tab.id,
    windowId: tab.windowId,
    timer: null,
    debuggerAttached: false,
  };

  // Attach the debugger so we can capture the tab even when it's in the
  // background. Chrome shows a "debugging" infobar while attached.
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    loopState.debuggerAttached = true;
  } catch (err) {
    // Already attached (e.g. from a previous run) is fine.
    if (!String(err.message).includes("Another debugger")) throw err;
    loopState.debuggerAttached = true;
  }

  // Run once immediately, then every 5 seconds.
  runOnce();
  loopState.timer = setInterval(runOnce, 5000);

  return loopState;
}

function stopLoop() {
  if (loopState.timer) {
    clearInterval(loopState.timer);
  }
  if (loopState.debuggerAttached && loopState.tabId != null) {
    chrome.debugger.detach({ tabId: loopState.tabId }).catch(() => {});
  }
  loopState = {
    running: false,
    tabId: null,
    windowId: null,
    timer: null,
    debuggerAttached: false,
  };
  chrome.runtime.sendMessage({ action: "loopStopped" }).catch(() => {});
}

async function captureTab(tabId) {
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png", fromSurface: true }
  );
  return `data:image/png;base64,${result.data}`;
}

function formatA11yTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const MAX_LINES = 400;
  const SKIP_ROLES = new Set(["none", "InlineTextBox", "LineBreak", "generic"]);

  function walk(node, depth) {
    if (lines.length >= MAX_LINES) return;

    const role = node.role?.value ?? "generic";
    const name = String(node.name?.value ?? "").trim();
    const value = node.value?.value;

    // Ignored wrappers: don't print, but keep walking their children —
    // the real content lives underneath them.
    if (node.ignored) {
      for (const childId of node.childIds || []) {
        const child = byId.get(childId);
        if (child) walk(child, depth);
      }
      return;
    }

    // Skip empty containers to keep the output compact.
    const skip = SKIP_ROLES.has(role) && !name && (value === undefined || value === null || !String(value).trim());

    if (!skip) {
      let line = `${"\u00a0 ".repeat(depth)}[${role}]`;
      if (name) line += ` "${name.slice(0, 80)}"`;
      if (value !== undefined && value !== null && String(value).trim()) {
        line += ` = ${String(value).slice(0, 80)}`;
      }
      lines.push(line);
    }

    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (child) walk(child, skip ? depth : depth + 1);
    }
  }

  const childSet = new Set();
  for (const n of nodes) for (const c of n.childIds || []) childSet.add(c);
  const roots = nodes.filter((n) => !childSet.has(n.nodeId));
  for (const root of roots) walk(root, 0);

  if (lines.length >= MAX_LINES) lines.push("... (truncated)");
  return lines.join("\n");
}

async function ensureDebuggerAttached(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const attached = targets.some((t) => t.tabId === tabId && t.attached);
    if (!attached) {
      await chrome.debugger.attach({ tabId }, "1.3");
      loopState.debuggerAttached = true;
    } else {
      loopState.debuggerAttached = true;
    }
  } catch (err) {
    // Already attached (e.g. from a previous run) is fine.
    if (!String(err.message).includes("Another debugger")) throw err;
    loopState.debuggerAttached = true;
  }
}

async function captureA11yTree(tabId) {
  try {
    await ensureDebuggerAttached(tabId);
    // Chrome only computes the full AX tree once the Accessibility domain
    // is enabled on the session.
    await chrome.debugger
      .sendCommand({ tabId }, "Accessibility.enable", {})
      .catch(() => {});
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Accessibility.getFullAXTree",
      {}
    );
    const treeText = formatA11yTree(result.nodes || []);
    chrome.runtime.sendMessage({ action: "a11yTree", tree: treeText }).catch(() => {});
  } catch (err) {
    console.error("A11y tree extraction failed:", err);
  }
}

async function runOnce() {
  if (!loopState.running) return;

  try {
    const tab = await chrome.tabs.get(loopState.tabId);
    reportLoopStatus(`Capturing tab ${loopState.tabId}...`);

    const dataUrl = await captureTab(tab.id);

    await ensureOffscreenDocument();

    reportProgress(20, "Redacting...");
    const result = await chrome.runtime.sendMessage({
      action: "processScreenshot",
      imageUrl: dataUrl,
      targetName: `redacted_tab${loopState.tabId}_${Date.now()}.png`,
    });

    console.log("Offscreen result:", result);
    if (result?.error) throw new Error(result.error);
    if (!result?.redactedImageUrl) {
      throw new Error("Offscreen did not return a redacted image URL");
    }

    await chrome.downloads.download({
      url: result.redactedImageUrl,
      filename: result.targetName,
      saveAs: false,
    });

    reportLoopStatus(
      `Saved ${result.targetName} (faces: ${result.faceCount}, PII: ${result.piiCount})`
    );

    // Extract and display the accessibility tree for this page state.
    await captureA11yTree(tab.id);
  } catch (err) {
    console.error("Loop iteration failed:", err);
    reportLoopStatus(`Error: ${err.message}`);
    // If the tab was closed or the debugger detached, stop the loop.
    if (
      String(err.message).includes("No tab with id") ||
      String(err.message).includes("Inspector is not attached") ||
      String(err.message).includes("tab was closed")
    ) {
      stopLoop();
    }
  }
}
