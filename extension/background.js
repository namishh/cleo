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
  };

  // Run once immediately, then every 5 seconds.
  runOnce();
  loopState.timer = setInterval(runOnce, 5000);

  return loopState;
}

function stopLoop() {
  if (loopState.timer) {
    clearInterval(loopState.timer);
  }
  loopState = { running: false, tabId: null, windowId: null, timer: null };
  chrome.runtime.sendMessage({ action: "loopStopped" }).catch(() => {});
}

async function runOnce() {
  if (!loopState.running) return;

  try {
    // Only capture when the pinned tab is the visible/active tab in its window.
    const tab = await chrome.tabs.get(loopState.tabId);
    if (!tab.active) {
      reportLoopStatus(`Skipped (tab ${loopState.tabId} not visible)`, true);
      return;
    }

    reportLoopStatus(`Capturing tab ${loopState.tabId}...`);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

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
  }
}
