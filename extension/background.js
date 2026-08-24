import { executeActions } from "./actions.js";

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

  if (request.action === "startClickLoop") {
    startClickLoop(Number(request.x), Number(request.y))
      .then((state) => sendResponse({ tabId: state.tabId }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === "stopClickLoop") {
    stopClickLoop();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "executeActions") {
    executeActionBatch(request.tabId, request.actions)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
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
  // Don't yank the debugger out from under the click loop.
  const clickLoopNeedsIt = clickLoop.running && clickLoop.tabId === loopState.tabId;
  if (loopState.debuggerAttached && loopState.tabId != null && !clickLoopNeedsIt) {
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

async function getCompactPageSnapshot(tabId) {
  try {
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      action: "getCompactAccessibilityTree",
    });
    if (snapshot?.error) throw new Error(snapshot.error);
    return snapshot;
  } catch (firstError) {
    // Content scripts are not re-injected into tabs that were already open
    // when the extension was reloaded. Inject it once and retry.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      action: "getCompactAccessibilityTree",
    });
    if (snapshot?.error) throw new Error(snapshot.error);
    return snapshot;
  }
}

async function ensureDebuggerAttached(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const attached = targets.some((t) => t.tabId === tabId && t.attached);
    if (!attached) {
      await chrome.debugger.attach({ tabId }, "1.3");
    }
    if (tabId === loopState.tabId) loopState.debuggerAttached = true;
  } catch (err) {
    // Already attached (e.g. from a previous run) is fine.
    if (!String(err.message).includes("Another debugger")) throw err;
  }
}

async function forceDebuggerAttach(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await chrome.debugger.attach({ tabId }, "1.3");
  if (tabId === loopState.tabId) loopState.debuggerAttached = true;
}

function isDebuggerDetachedError(error) {
  return String(error?.message || error).toLowerCase().includes("debugger is not attached");
}

// Execute a batch of backend actions on the given tab. Attaches the debugger
// if the loop isn't running so test buttons work standalone.
async function executeActionBatch(tabId, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("actions must be a non-empty array");
  }
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    tabId = tab.id;
  }
  await ensureDebuggerAttached(tabId);
  let results = await executeActions(tabId, actions);
  if (results.some((result) => !result.ok && isDebuggerDetachedError(result.error))) {
    await forceDebuggerAttach(tabId);
    results = await executeActions(tabId, actions);
  }
  // Leave the debugger attached briefly so follow-up test actions stay fast;
  // detach when idle so the infobar goes away.
  scheduleDebuggerDetach(tabId);
  return results;
}

let detachTimer = null;
function scheduleDebuggerDetach(tabId) {
  if (loopState.running || clickLoop.running) return; // an active loop owns the attachment
  if (detachTimer) clearTimeout(detachTimer);
  detachTimer = setTimeout(() => {
    chrome.debugger.detach({ tabId }).catch(() => {});
    detachTimer = null;
  }, 15000);
}

// ponytail: temporary 1s click loop for verifying background-tab input;
// delete alongside the side-panel test button once confirmed
let clickLoop = { running: false, tabId: null, timer: null };

function reportClickLoop(message) {
  chrome.runtime.sendMessage({ action: "clickLoopTick", message }).catch(() => {});
}

function stopClickLoop() {
  if (clickLoop.timer) clearInterval(clickLoop.timer);
  clickLoop = { running: false, tabId: null, timer: null };
  chrome.runtime.sendMessage({ action: "clickLoopStopped" }).catch(() => {});
}

async function startClickLoop(x, y) {
  if (clickLoop.running) return clickLoop;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  clickLoop = { running: true, tabId: tab.id, timer: null };
  await ensureDebuggerAttached(tab.id);
  if (detachTimer) {
    // Cancel any pending auto-detach from earlier manual test actions.
    clearTimeout(detachTimer);
    detachTimer = null;
  }

  const tick = async () => {
    if (!clickLoop.running) return;
    const clickAction = [{ type: "click", x, y }];
    try {
      await ensureDebuggerAttached(clickLoop.tabId);
      const results = await executeActions(clickLoop.tabId, clickAction);
      const result = results[0];
      if (result.ok) {
        reportClickLoop(`click OK (${x}, ${y})`);
      } else if (String(result.error).includes("not attached")) {
        reportClickLoop("click loop: debugger dropped, re-attaching...");
        // Per-action errors never reach the catch below, so handle them here:
        // drop any stale session, attach fresh, and retry once.
        await forceDebuggerAttach(clickLoop.tabId);
        const retry = await executeActions(clickLoop.tabId, clickAction);
        const retryResult = retry[0];
        reportClickLoop(retryResult.ok ? `click OK after re-attach (${x}, ${y})` : `click FAILED after re-attach: ${retryResult.error}`);
      } else {
        reportClickLoop(`click FAILED: ${result.error}`);
      }
    } catch (error) {
      const message = String(error.message);
      reportClickLoop(`click loop error: ${message}`);
      if (message.includes("No tab with id")) {
        stopClickLoop();
      }
    }
  };

  await tick();
  clickLoop.timer = setInterval(tick, 1000);
  return clickLoop;
}

async function runOnce() {
  if (!loopState.running) return;

  try {
    const tab = await chrome.tabs.get(loopState.tabId);
    reportLoopStatus(`Capturing tab ${loopState.tabId}...`);

    let pageSnapshot;
    try {
      pageSnapshot = await getCompactPageSnapshot(tab.id);
      console.log(
        `[a11y] compact snapshot: ${pageSnapshot.elements?.length || 0} elements, ${pageSnapshot.privacyRegions?.length || 0} privacy regions`
      );
    } catch (error) {
      // Restricted browser pages can reject content-script access. Still save
      // the screenshot, but do not claim that the page has been inspected.
      console.warn("Compact page snapshot unavailable:", error);
      pageSnapshot = {
        tree: `(page DOM unavailable: ${error.message})`,
        elements: [],
        privacyRegions: [],
        viewportWidth: 0,
        viewportHeight: 0,
      };
    }

    const dataUrl = await captureTab(tab.id);

    await ensureOffscreenDocument();

    reportProgress(20, "Redacting...");
    const result = await chrome.runtime.sendMessage({
      action: "processScreenshot",
      imageUrl: dataUrl,
      targetName: `redacted_tab${loopState.tabId}_${Date.now()}.png`,
      domPrivacyRegions: pageSnapshot.privacyRegions,
      viewportWidth: pageSnapshot.viewportWidth,
      viewportHeight: pageSnapshot.viewportHeight,
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

    // Display the compact, locally sanitized accessibility tree for this
    // exact capture. Raw DOM and input values never leave the extension.
    chrome.runtime
      .sendMessage({ action: "a11yTree", tree: pageSnapshot.tree })
      .catch(() => {});
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
