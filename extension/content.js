console.log("Browser Agent content script loaded on:", window.location.href);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "greet") {
    sendResponse({
      url: window.location.href,
      title: document.title,
    });
  }
  return false;
});
