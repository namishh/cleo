const streamEl = document.getElementById("stream");
const form = document.getElementById("input-form");
const input = document.getElementById("task-input");
const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");

let running = false;
let stepElements = new Map();

function setRunning(value) {
  running = value;
  sendBtn.textContent = value ? "stop" : "send";
  input.disabled = false;
}

function scrollToEnd() {
  streamEl.scrollTop = streamEl.scrollHeight;
}

const CLEO_ICON = chrome.runtime.getURL("icons/cleo.png");

function avatar(className) {
  const img = document.createElement("img");
  img.className = `avatar ${className}`;
  img.src = CLEO_ICON;
  img.alt = "";
  return img;
}

function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  const avatarEl = document.createElement("div");
  avatarEl.className = "avatar user";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  div.append(avatarEl, body);
  streamEl.appendChild(div);
  scrollToEnd();
}

function sanitizeMarkdownHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const dangerous = template.content.querySelectorAll("script, style, iframe, object, embed, link, meta");
  dangerous.forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  });
  return template.content;
}

function addAnswerMessage(text) {
  const div = document.createElement("div");
  div.className = "msg answer";
  const body = document.createElement("div");
  body.className = "msg-body markdown";
  body.appendChild(sanitizeMarkdownHTML(marked.parse(text)));
  div.append(avatar("answer"), body);
  streamEl.appendChild(div);
  scrollToEnd();
}

function addLogLine(text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.style.color = "#888888";
  div.textContent = text;
  streamEl.appendChild(div);
  scrollToEnd();
}

function formatAction(action) {
  switch (action.type) {
    case "click":
    case "double_click":
    case "right_click":
      return `${action.type.toUpperCase()}${action.id ? ` #${action.id}` : ""} (${action.x ?? "?"},${action.y ?? "?"})`;
    case "move":
      return `MOVE (${action.x ?? "?"},${action.y ?? "?"})`;
    case "scroll":
      return `SCROLL ${action.direction || "down"} ${action.amount ?? action.ticks ?? 3}`;
    case "type":
      return `TYPE "${action.text ?? ""}"`;
    case "key":
      return `KEY ${action.key}`;
    case "drag":
      return `DRAG (${action.x},${action.y}) -> (${action.x2},${action.y2})`;
    case "select":
      return `SELECT "${action.option ?? ""}"`;
    case "navigate":
      return `NAVIGATE ${action.url ?? ""}`;
    case "wait":
      return `WAIT ${action.ms ?? 0}ms`;
    case "done":
      return "DONE";
    case "fail":
      return `FAIL: ${action.reason ?? ""}`;
    default:
      return action.type.toUpperCase();
  }
}

function getOrCreateStepsBlock() {
  let wrapper = document.getElementById("steps-block");
  if (!wrapper) {
    wrapper = document.createElement("details");
    wrapper.id = "steps-block";
    wrapper.className = "steps";
    wrapper.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "reasoning";
    const list = document.createElement("div");
    list.id = "steps-list";
    wrapper.append(summary, list);
    streamEl.appendChild(wrapper);
  }
  const count = stepElements.size + 1;
  wrapper.querySelector("summary").textContent = `reasoning · ${count} steps`;
  return wrapper.querySelector("#steps-list");
}

function getStepElement(step) {
  if (stepElements.has(step)) return stepElements.get(step);

  const list = getOrCreateStepsBlock();
  const details = document.createElement("details");
  details.className = "step";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `step ${step}`;
  const body = document.createElement("div");
  body.className = "step-body";
  const streamText = document.createElement("div");
  streamText.className = "stream-text";
  body.appendChild(streamText);

  details.append(summary, body);
  list.appendChild(details);
  stepElements.set(step, { details, summary, body, streamText });
  scrollToEnd();
  return stepElements.get(step);
}

function appendStepDelta(step, text) {
  const element = getStepElement(step);
  element.streamText.textContent += text;
  scrollToEnd();
}

function addStepScreenshot(step, image) {
  const element = getStepElement(step);
  if (element.screenshot) return;
  element.screenshot = true;
  const img = document.createElement("img");
  img.className = "step-screenshot";
  img.src = image;
  img.alt = `redacted screenshot, step ${step}`;
  element.body.appendChild(img);
  scrollToEnd();
}

function addStepNote(step, note) {
  const element = getStepElement(step);
  const div = document.createElement("div");
  div.className = "step-note";
  div.textContent = note;
  element.body.appendChild(div);
  scrollToEnd();
}

function addStepActions(step, actions) {
  const element = getStepElement(step);
  const list = document.createElement("ul");
  list.className = "step-actions";
  for (const action of actions) {
    const item = document.createElement("li");
    item.textContent = formatAction(action);
    list.appendChild(item);
  }
  element.body.appendChild(list);
  if (actions.length > 0) {
    element.summary.textContent = `step ${step} · ${formatAction(actions[0])}${actions.length > 1 ? ` +${actions.length - 1}` : ""}`;
  }
  scrollToEnd();
}

function resetConversation() {
  stepElements = new Map();
  streamEl.textContent = "";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "agentEvent") {
    switch (message.kind) {
      case "user":
        resetConversation();
        addUserMessage(message.text);
        break;
      case "step-delta":
        appendStepDelta(message.step, message.text);
        break;
      case "step-screenshot":
        addStepScreenshot(message.step, message.image);
        break;
      case "step-note":
        addStepNote(message.step, message.note);
        break;
      case "step-actions":
        addStepActions(message.step, message.actions);
        break;
      case "answer":
        addAnswerMessage(message.text);
        break;
      case "log":
        addLogLine(message.message);
        break;
      case "status":
        statusEl.textContent = message.message;
        break;
    }
  }

  if (message.action === "taskStopped") {
    setRunning(false);
    statusEl.textContent = message.reason || "stopped";
  }
});

chrome.runtime.sendMessage({ action: "getTaskState" }, (state) => {
  if (state?.running) {
    setRunning(true);
    statusEl.textContent = `running on tab ${state.tabId}`;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = input.value.trim();

  if (running) {
    await chrome.runtime.sendMessage({ action: "stopTask" });
    setRunning(false);
    statusEl.textContent = "stopped";
    return;
  }

  if (!task) {
    statusEl.textContent = "type a task first";
    input.focus();
    return;
  }

  sendBtn.disabled = true;
  statusEl.textContent = "starting...";
  try {
    const response = await chrome.runtime.sendMessage({ action: "startTask", task });
    if (response?.error) {
      statusEl.textContent = `error: ${response.error}`;
    } else {
      setRunning(true);
      statusEl.textContent = `running on tab ${response.tabId}`;
      input.value = "";
    }
  } catch (error) {
    statusEl.textContent = `error: ${error.message}`;
  } finally {
    sendBtn.disabled = false;
  }
});
