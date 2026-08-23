chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Browser Agent Sidebar installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("Failed to set side panel behavior:", err);
});

let creatingOffscreen;
async function setupOffscreenDocument(path) {
  if (await hasDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: ["WORKERS", "USER_MEDIA", "DOM_PARSER"],
      justification: "Run ONNX face detection and OCR redaction on screenshots",
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

async function hasDocument() {
  const matchedClients = await self.clients.matchAll();
  for (const client of matchedClients) {
    if (client.url.endsWith(chrome.runtime.getURL("offscreen.html"))) {
      return true;
    }
  }
  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "redactScreenshot") {
    handleRedaction().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleRedaction() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  await setupOffscreenDocument("offscreen.html");

  const result = await chrome.runtime.sendMessage({
    action: "processScreenshot",
    imageUrl: dataUrl,
    targetName: `redacted_${Date.now()}.png`,
  });

  if (result?.error) throw new Error(result.error);

  const blob = await fetch(result.redactedImageUrl).then((r) => r.blob());
  const arrayBuffer = await blob.arrayBuffer();

  const filename = result.targetName;
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: "image/png" }));
  await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
  });

  return { filename };
}
