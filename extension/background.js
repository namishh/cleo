chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Browser Agent Sidebar installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("Failed to set side panel behavior:", err);
});

let offscreenReadyPromise = null;
let offscreenResolve = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "redactScreenshot") {
    handleRedaction().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === "offscreenReady") {
    if (offscreenResolve) offscreenResolve();
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === "progress") {
    // Forward progress updates from the offscreen document to the side panel.
    chrome.runtime.sendMessage(request).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
});

function reportProgress(percent, message) {
  chrome.runtime
    .sendMessage({ action: "progress", percent, message })
    .catch(() => {});
}

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
  reportProgress(5, "Preparing redaction engine...");
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

async function handleRedaction() {
  reportProgress(10, "Capturing screenshot...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  await ensureOffscreenDocument();

  reportProgress(20, "Running redaction models...");
  const result = await chrome.runtime.sendMessage({
    action: "processScreenshot",
    imageUrl: dataUrl,
    targetName: `redacted_${Date.now()}.png`,
  });

  if (result?.error) throw new Error(result.error);

  reportProgress(95, "Downloading redacted image...");
  await chrome.downloads.download({
    url: result.redactedImageUrl,
    filename: result.targetName,
    saveAs: false,
  });

  reportProgress(100, "Done");
  return { filename: result.targetName };
}
