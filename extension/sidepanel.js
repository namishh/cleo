document.addEventListener("DOMContentLoaded", () => {
  const runBtn = document.getElementById("run-btn");
  const statusEl = document.getElementById("status");

  runBtn.addEventListener("click", async () => {
    statusEl.textContent = "Capturing and redacting...";
    runBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "redactScreenshot" });
      if (response?.error) {
        statusEl.textContent = `Error: ${response.error}`;
      } else {
        statusEl.textContent = `Saved: ${response.filename}`;
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      runBtn.disabled = false;
    }
  });
});
