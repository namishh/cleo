document.addEventListener("DOMContentLoaded", () => {
  const toggleBtn = document.getElementById("toggle-btn");
  const statusEl = document.getElementById("status");
  const progressContainer = document.getElementById("progress-container");
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");

  let running = false;

  function setProgress(percent, message) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    progressBar.style.width = `${clamped}%`;
    progressText.textContent = `${clamped}%`;
    if (message) statusEl.textContent = message;
  }

  function showProgress() {
    progressContainer.classList.remove("hidden");
    progressText.classList.remove("hidden");
  }

  function hideProgress() {
    progressContainer.classList.add("hidden");
    progressText.classList.add("hidden");
  }

  function setRunning(state) {
    running = state;
    toggleBtn.textContent = running ? "Stop" : "Start";
    toggleBtn.classList.toggle("start", !running);
    toggleBtn.classList.toggle("stop", running);
    if (!running) {
      hideProgress();
      statusEl.textContent = "Stopped";
    }
  }

  const a11yTreeEl = document.getElementById("a11y-tree");

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "progress") {
      showProgress();
      setProgress(request.percent, request.message);
    } else if (request.action === "loopStatus") {
      statusEl.textContent = request.message;
      if (request.skipped) hideProgress();
    } else if (request.action === "loopStopped") {
      setRunning(false);
    } else if (request.action === "a11yTree") {
      a11yTreeEl.textContent = request.tree;
    }
  });

  // Restore running state when the panel (re)opens.
  chrome.runtime.sendMessage({ action: "getLoopState" }, (response) => {
    if (response?.running) {
      setRunning(true);
      statusEl.textContent = `Running on tab ${response.tabId}`;
    }
  });

  toggleBtn.addEventListener("click", async () => {
    toggleBtn.disabled = true;
    try {
      if (!running) {
        const response = await chrome.runtime.sendMessage({ action: "startLoop" });
        if (response?.error) {
          statusEl.textContent = `Error: ${response.error}`;
        } else {
          setRunning(true);
          statusEl.textContent = `Running on tab ${response.tabId}`;
        }
      } else {
        await chrome.runtime.sendMessage({ action: "stopLoop" });
        setRunning(false);
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      toggleBtn.disabled = false;
    }
  });
});
