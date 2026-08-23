chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Browser Agent Sidebar installed. Reason: ${reason}`);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.error("Failed to set side panel behavior:", err);
});
