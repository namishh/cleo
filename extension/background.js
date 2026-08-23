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
