document.addEventListener("DOMContentLoaded", () => {
  const runBtn = document.getElementById("run-btn");
  const statusEl = document.getElementById("status");
  const progressContainer = document.getElementById("progress-container");
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");

  function setProgress(percent, message) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    progressBar.style.width = `${clamped}%`;
    progressText.textContent = `${clamped}%`;
    if (message) statusEl.textContent = message;
  }

  function showProgress() {
    progressContainer.classList.remove("hidden");
    progressText.classList.remove("hidden");
    setProgress(0, "Starting...");
  }

  function hideProgress() {
    progressContainer.classList.add("hidden");
    progressText.classList.add("hidden");
  }

  // Listen for progress updates from the service worker.
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "progress") {
      setProgress(request.percent, request.message);
    }
  });

  runBtn.addEventListener("click", async () => {
    showProgress();
    runBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "redactScreenshot" });
      if (response?.error) {
        statusEl.textContent = `Error: ${response.error}`;
      } else {
        setProgress(100, `Saved: ${response.filename}`);
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      runBtn.disabled = false;
      setTimeout(hideProgress, 2000);
    }
  });
});
