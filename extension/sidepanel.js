document.addEventListener("DOMContentLoaded", () => {
  const greetBtn = document.getElementById("greet-btn");
  const statusEl = document.getElementById("status");

  greetBtn.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "greet" });
        statusEl.textContent = `Said hello to: ${response?.title ?? tab.url}`;
      } else {
        statusEl.textContent = "No active tab found.";
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
});
