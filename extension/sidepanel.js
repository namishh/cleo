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
  const actionLog = document.getElementById("action-log");
  const tX = document.getElementById("t-x");
  const tY = document.getElementById("t-y");
  const tX2 = document.getElementById("t-x2");
  const tY2 = document.getElementById("t-y2");
  const tText = document.getElementById("t-text");

  function logAction(line) {
    actionLog.textContent = `${new Date().toLocaleTimeString()} ${line}\n` + actionLog.textContent;
  }

  document.getElementById("action-buttons").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const type = button.dataset.action;
    const action = { type };
    if (button.dataset.extra) Object.assign(action, JSON.parse(button.dataset.extra));
    if (button.hasAttribute("data-needs-text")) {
      if (type === "type") action.text = tText.value;
      if (type === "select") action.option = tText.value;
      if (type === "navigate") action.url = tText.value || "example.com";
    }
    if (["click", "double_click", "right_click", "move", "scroll", "drag", "select"].includes(type)) {
      action.x = Number(tX.value);
      action.y = Number(tY.value);
    }
    if (type === "drag") {
      action.x2 = Number(tX2.value);
      action.y2 = Number(tY2.value);
    }

    button.disabled = true;
    logAction(`${type} ...`);
    try {
      const response = await chrome.runtime.sendMessage({
        action: "executeActions",
        actions: [action],
      });
      if (response?.error) {
        logAction(`${type} FAILED: ${response.error}`);
      } else {
        for (const result of response.results) {
          logAction(result.ok ? `${type} OK: ${result.detail}` : `${type} FAILED: ${result.error}`);
        }
      }
    } catch (err) {
      logAction(`${type} FAILED: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  });

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

  // ponytail: temporary click-loop test button, delete once background-input
  // behaviour is confirmed
  const clickLoopBtn = document.getElementById("click-loop-btn");
  let clickLoopRunning = false;

  clickLoopBtn.addEventListener("click", async () => {
    clickLoopBtn.disabled = true;
    try {
      if (!clickLoopRunning) {
        const response = await chrome.runtime.sendMessage({
          action: "startClickLoop",
          x: Number(tX.value),
          y: Number(tY.value),
        });
        if (response?.error) {
          logAction(`click loop FAILED to start: ${response.error}`);
        } else {
          clickLoopRunning = true;
          clickLoopBtn.textContent = "Click loop: ON";
          clickLoopBtn.classList.add("stop");
          clickLoopBtn.classList.remove("start");
          logAction(`click loop started on tab ${response.tabId}`);
        }
      } else {
        await chrome.runtime.sendMessage({ action: "stopClickLoop" });
        clickLoopRunning = false;
        clickLoopBtn.textContent = "Click loop: off";
        clickLoopBtn.classList.add("start");
        clickLoopBtn.classList.remove("stop");
        logAction("click loop stopped");
      }
    } catch (err) {
      logAction(`click loop error: ${err.message}`);
    } finally {
      clickLoopBtn.disabled = false;
    }
  });

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "clickLoopTick") {
      logAction(request.message);
    } else if (request.action === "clickLoopStopped") {
      clickLoopRunning = false;
      clickLoopBtn.textContent = "Click loop: off";
      clickLoopBtn.classList.add("start");
      clickLoopBtn.classList.remove("stop");
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
