document.addEventListener("DOMContentLoaded", () => {
  const taskInput = document.getElementById("task-input");
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");
  const statusEl = document.getElementById("status");
  const activityLog = document.getElementById("activity-log");
  const screenshots = document.getElementById("screenshots");

  let running = false;
  let screenshotCount = 0;

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    activityLog.textContent = activityLog.textContent === "(no activity yet)"
      ? line
      : `${activityLog.textContent}\n${line}`;
    activityLog.scrollTop = activityLog.scrollHeight;
  }

  function setRunning(value) {
    running = value;
    startBtn.disabled = value;
    stopBtn.disabled = !value;
    taskInput.disabled = value;
  }

  function addScreenshot(dataUrl, step) {
    if (!dataUrl) return;
    if (screenshotCount === 0) screenshots.textContent = "";
    screenshotCount += 1;

    const card = document.createElement("div");
    card.className = "screenshot-card";
    const label = document.createElement("p");
    label.textContent = `Step ${step}`;
    const image = document.createElement("img");
    image.src = dataUrl;
    image.alt = `Redacted screenshot from step ${step}`;
    card.append(label, image);
    screenshots.prepend(card);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "agentEvent") {
      if (message.kind === "log") log(message.message);
      if (message.kind === "screenshot") addScreenshot(message.image, message.step);
      if (message.kind === "status") statusEl.textContent = message.message;
    }

    if (message.action === "taskStopped") {
      setRunning(false);
      if (message.reason) statusEl.textContent = message.reason;
    }
  });

  chrome.runtime.sendMessage({ action: "getTaskState" }, (state) => {
    if (state?.running) {
      setRunning(true);
      statusEl.textContent = `Running on tab ${state.tabId}`;
    }
  });

  startBtn.addEventListener("click", async () => {
    const task = taskInput.value.trim();
    if (!task) {
      statusEl.textContent = "Enter a task first.";
      taskInput.focus();
      return;
    }

    startBtn.disabled = true;
    statusEl.textContent = "Starting...";
    try {
      const response = await chrome.runtime.sendMessage({ action: "startTask", task });
      if (response?.error) {
        statusEl.textContent = `Error: ${response.error}`;
        startBtn.disabled = false;
        return;
      }
      setRunning(true);
      statusEl.textContent = `Running on tab ${response.tabId}`;
    } catch (error) {
      statusEl.textContent = `Error: ${error.message}`;
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "stopTask" });
    setRunning(false);
    statusEl.textContent = "Stopped";
  });
});
