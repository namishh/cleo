const streamEl = document.getElementById("stream");
const form = document.getElementById("input-form");
const input = document.getElementById("task-input");
const sendBtn = document.getElementById("send-btn");
const researchBtn = document.getElementById("research-btn");
const statusEl = document.getElementById("status");
const chatsSidebar = document.getElementById("chats-sidebar");

let running = false;
let stepElements = new Map();
let currentStepsBlock = null;
let activeChatId = null;
const runningChats = new Set();

// ---------- settings (auth token, direct-OpenRouter mode, display name, avatar) ----------

const SETTINGS_KEY = "cleo_settings";
const DEFAULT_SETTINGS = {
  authToken: "9876543210",
  directMode: false,
  openrouterApiKey: "",
  exaApiKey: "",
  openrouterModel: "google/gemini-2.0-flash-001",
  displayName: "cleo",
  avatarGradient: ["#2980B9", "#6dd5fa"],
};

let currentSettings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  currentSettings = { ...DEFAULT_SETTINGS, ...(store[SETTINGS_KEY] || {}) };
  return currentSettings;
}

function applyAvatarGradientCSS() {
  const [c1, c2] = currentSettings.avatarGradient;
  document.documentElement.style.setProperty(
    "--user-avatar-gradient",
    `linear-gradient(135deg, ${c1 || "#2980B9"}, ${c2 || "#6dd5fa"})`
  );
}

// Settings must be loaded before the first render so the display name / avatar
// gradient are correct from the start instead of flashing in after a beat.
const settingsReady = loadSettings().then(applyAvatarGradientCSS);

const SPIN_FRAMES = ["[/]", "[-]", "[\\]", "[_]"];
let spinIndex = 0;

function setRunning(value) {
  running = value;
  sendBtn.textContent = value ? "stop" : "send";
  researchBtn.disabled = value;
}

// "Stick to bottom" like a normal chat app: auto-scroll follows new content
// only while the user is already at (or returns to) the bottom. Scrolling up
// to read earlier steps disables it until they scroll back down themselves.
const STICK_THRESHOLD = 32;
let stickToBottom = true;

function isNearBottom() {
  return streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight <= STICK_THRESHOLD;
}

streamEl.addEventListener("scroll", () => {
  stickToBottom = isNearBottom();
});

function scrollToEnd() {
  if (!stickToBottom) return;
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

function addUserMessage(text, mode) {
  const div = document.createElement("div");
  div.className = "msg user";
  const avatarEl = document.createElement("div");
  avatarEl.className = "avatar user";
  const body = document.createElement("div");
  body.className = "msg-body";
  if (mode === "research") {
    const badge = document.createElement("span");
    badge.className = "research-badge";
    badge.textContent = "research";
    body.appendChild(badge);
  }
  body.appendChild(document.createTextNode(text));
  div.append(avatarEl, body);
  streamEl.appendChild(div);
  scrollToEnd();
}

function sanitizeMarkdownHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value))) {
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
  const prefix = document.createElement("span");
  prefix.className = "answer-prefix";
  prefix.textContent = `${currentSettings.displayName}: `;
  body.appendChild(prefix);
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
    case "remember":
      return `REMEMBER "${action.fact ?? ""}"`;
    case "exa_search":
      return `EXA SEARCH "${action.query ?? ""}"`;
    case "done":
      return "DONE";
    case "fail":
      return `FAIL: ${action.reason ?? ""}`;
    default:
      return action.type.toUpperCase();
  }
}

// Each user message starts a fresh reasoning accordion.
function startNewStepsBlock() {
  const wrapper = document.createElement("details");
  wrapper.className = "steps";
  wrapper.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "reasoning · 0 steps";
  const list = document.createElement("div");
  list.className = "steps-list";
  wrapper.append(summary, list);
  streamEl.appendChild(wrapper);
  currentStepsBlock = { summary, list, count: 0 };
  scrollToEnd();
}

function getStepsList() {
  if (!currentStepsBlock) startNewStepsBlock();
  return currentStepsBlock.list;
}

function incrementStepCount() {
  currentStepsBlock.count += 1;
  currentStepsBlock.summary.textContent = `reasoning · ${currentStepsBlock.count} steps`;
}

function getStepElement(step) {
  if (stepElements.has(step)) return stepElements.get(step);

  const list = getStepsList();
  incrementStepCount();
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

function addStepActions(step, actions, results) {
  const element = getStepElement(step);
  const list = document.createElement("ul");
  list.className = "step-actions";
  for (const action of actions) {
    const item = document.createElement("li");
    item.textContent = formatAction(action);
    if (results) {
      const result = results.find(
        (r) => r.action && JSON.stringify(r.action) === JSON.stringify(action)
      );
      if (result && !result.ok) item.classList.add("failed");
    }
    list.appendChild(item);
  }
  element.body.appendChild(list);
  if (actions.length > 0) {
    element.summary.textContent = `step ${step} · ${formatAction(actions[0])}${actions.length > 1 ? ` +${actions.length - 1}` : ""}`;
  }
  scrollToEnd();
}

function clearStream() {
  stepElements = new Map();
  currentStepsBlock = null;
  streamEl.textContent = "";
  stickToBottom = true;
}

// ---------- chat sidebar ----------

document.getElementById("sidebar-toggle-btn").addEventListener("click", () => {
  chatsSidebar.classList.toggle("open");
  if (chatsSidebar.classList.contains("open")) refreshChatList();
});

document.getElementById("close-sidebar-btn").addEventListener("click", () => {
  chatsSidebar.classList.remove("open");
});

// ---------- settings panel ----------

const settingsSidebar = document.getElementById("settings-sidebar");
const authTokenInput = document.getElementById("settings-auth-token");
const directModeInput = document.getElementById("settings-direct-mode");
const directFieldsEl = document.getElementById("settings-direct-fields");
const openrouterKeyInput = document.getElementById("settings-openrouter-key");
const openrouterModelInput = document.getElementById("settings-openrouter-model");
const exaKeyInput = document.getElementById("settings-exa-key");
const displayNameInput = document.getElementById("settings-display-name");
const avatarColor1Input = document.getElementById("settings-avatar-color1");
const avatarColor2Input = document.getElementById("settings-avatar-color2");
const avatarPreviewEl = document.getElementById("settings-avatar-preview");
const settingsStatusEl = document.getElementById("settings-status");

function updateDirectFieldsVisibility() {
  directFieldsEl.classList.toggle("hidden", !directModeInput.checked);
}

function updateAvatarPreview() {
  avatarPreviewEl.style.background = `linear-gradient(135deg, ${avatarColor1Input.value}, ${avatarColor2Input.value})`;
}

function fillSettingsForm() {
  authTokenInput.value = currentSettings.authToken;
  directModeInput.checked = currentSettings.directMode;
  openrouterKeyInput.value = currentSettings.openrouterApiKey;
  openrouterModelInput.value = currentSettings.openrouterModel;
  exaKeyInput.value = currentSettings.exaApiKey;
  displayNameInput.value = currentSettings.displayName;
  avatarColor1Input.value = currentSettings.avatarGradient[0] || "#2980B9";
  avatarColor2Input.value = currentSettings.avatarGradient[1] || "#6dd5fa";
  updateDirectFieldsVisibility();
  updateAvatarPreview();
}

document.getElementById("settings-toggle-btn").addEventListener("click", async () => {
  await settingsReady;
  fillSettingsForm();
  settingsSidebar.classList.toggle("open");
});

document.getElementById("close-settings-btn").addEventListener("click", () => {
  settingsSidebar.classList.remove("open");
});

directModeInput.addEventListener("change", updateDirectFieldsVisibility);
avatarColor1Input.addEventListener("input", updateAvatarPreview);
avatarColor2Input.addEventListener("input", updateAvatarPreview);

document.getElementById("settings-save-btn").addEventListener("click", async () => {
  currentSettings = {
    authToken: authTokenInput.value.trim() || DEFAULT_SETTINGS.authToken,
    directMode: directModeInput.checked,
    openrouterApiKey: openrouterKeyInput.value.trim(),
    exaApiKey: exaKeyInput.value.trim(),
    openrouterModel: openrouterModelInput.value.trim() || DEFAULT_SETTINGS.openrouterModel,
    displayName: displayNameInput.value.trim() || DEFAULT_SETTINGS.displayName,
    avatarGradient: [avatarColor1Input.value, avatarColor2Input.value],
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings });
  applyAvatarGradientCSS();
  settingsStatusEl.textContent = "saved";
  setTimeout(() => {
    settingsStatusEl.textContent = "";
  }, 1500);
});

let refreshSeq = 0;
let chatListCache = { chats: [], activeId: null };

function renderChatList() {
  const list = document.getElementById("chat-list");
  list.textContent = "";
  const { chats, activeId } = chatListCache;

  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "chat-item";
    empty.textContent = "no chats yet";
    list.appendChild(empty);
    return;
  }

  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === activeId ? " active" : ""}`;
    item.dataset.id = chat.id;

    const spinner = document.createElement("span");
    spinner.className = "chat-spinner";
    spinner.textContent = chat.running ? SPIN_FRAMES[0] : "";
    if (!chat.running) spinner.style.display = "none";
    item.appendChild(spinner);

    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title;
    item.appendChild(title);

    const del = document.createElement("button");
    del.className = "chat-delete";
    del.textContent = "x";
    del.title = "delete chat";
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      await chrome.runtime.sendMessage({ action: "deleteChat", id: chat.id });
      chatListCache.chats = chatListCache.chats.filter((c) => c.id !== chat.id);
      if (chat.id === activeChatId) clearStream();
      renderChatList();
      refreshChatList();
    });
    item.appendChild(del);

    item.addEventListener("click", () => openChat(chat.id));
    list.appendChild(item);
  }
}

async function refreshChatList() {
  const seq = ++refreshSeq;
  const response = await chrome.runtime.sendMessage({ action: "listChats" });
  if (seq !== refreshSeq || !response) return;
  chatListCache = { chats: response.chats || [], activeId: response.activeId || null };

  runningChats.clear();
  for (const chat of chatListCache.chats) {
    if (chat.running) runningChats.add(chat.id);
  }

  renderChatList();
}

// Animate spinners for running chats.
setInterval(() => {
  if (runningChats.size === 0) return;
  spinIndex = (spinIndex + 1) % SPIN_FRAMES.length;
  const frame = SPIN_FRAMES[spinIndex];
  document.querySelectorAll("#chat-list .chat-item").forEach((item) => {
    const spinner = item.querySelector(".chat-spinner");
    if (!spinner) return;
    const id = item.dataset.id;
    if (runningChats.has(id)) {
      spinner.style.display = "";
      spinner.textContent = frame;
    } else {
      spinner.style.display = "none";
    }
  });
}, 250);

async function openChat(id) {
  const response = await chrome.runtime.sendMessage({ action: "openChat", id });
  if (response?.error) {
    statusEl.textContent = `error: ${response.error}`;
    return;
  }
  chatsSidebar.classList.remove("open");
  activeChatId = id;
  running = response.running || false;
  renderChat(response.chat);
  chatListCache.activeId = id;
  renderChatList();
  refreshChatList();
  setRunning(running);
  statusEl.textContent = running ? "running…" : "idle";
}

function renderChat(chat) {
  clearStream();
  if (!chat) return;
  for (const entry of chat.entries || []) {
    if (entry.t === "user") {
      addUserMessage(entry.text, entry.mode);
      startNewStepsBlock();
    } else if (entry.t === "answer") {
      addAnswerMessage(entry.text);
    } else if (entry.t === "step") {
      renderStepEntry(entry);
    }
  }
  scrollToEnd();
}

function renderStepEntry(entry) {
  const element = getStepElement(entry.step);
  element.streamText.textContent = entry.streamText || "";
  if (entry.screenshot) {
    element.screenshot = true;
    const img = document.createElement("img");
    img.className = "step-screenshot";
    img.src = entry.screenshot;
    img.alt = `redacted screenshot, step ${entry.step}`;
    element.body.appendChild(img);
  }
  if (entry.note) {
    const note = document.createElement("div");
    note.className = "step-note";
    note.textContent = entry.note;
    element.body.appendChild(note);
  }
  if (entry.actions?.length) {
    addStepActions(entry.step, entry.actions, entry.results);
  }
}

function updateChatTitle() {
  refreshChatList();
}

document.getElementById("new-chat-btn").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ action: "newChat" });
  if (response?.error) {
    statusEl.textContent = `error: ${response.error}`;
    return;
  }
  activeChatId = response.chat.id;
  running = false;
  clearStream();
  chatListCache.chats = [
    { id: response.chat.id, title: response.chat.title, updatedAt: Date.now(), running: false },
    ...chatListCache.chats,
  ];
  chatListCache.activeId = response.chat.id;
  renderChatList();
  refreshChatList();
  input.focus();
});

chrome.runtime.onMessage.addListener((message) => {
  // Only render live events that belong to the chat currently on screen.
  if (message.action === "agentEvent") {
    if (message.chatId && message.chatId !== activeChatId) {
      if (message.kind === "answer") refreshChatList();
      return;
    }
    switch (message.kind) {
      case "user":
        addUserMessage(message.text, message.mode);
        startNewStepsBlock();
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
        refreshChatList();
        break;
      case "title":
        updateChatTitle();
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
    if (message.chatId && message.chatId !== activeChatId) {
      refreshChatList();
      return;
    }
    setRunning(false);
    statusEl.textContent = message.reason || "stopped";
    refreshChatList();
  }
});

chrome.runtime.sendMessage({ action: "getTaskState" }, (state) => {
  (state?.runningChatIds || []).forEach((id) => runningChats.add(id));
  if (state?.running) {
    setRunning(true);
    statusEl.textContent = `running on tab ${state.tabId}`;
  }
});

// Restore the active chat transcript on open.
chrome.runtime.sendMessage({ action: "getActiveChat" }, async (response) => {
  await settingsReady;
  if (response?.chat) {
    activeChatId = response.chat.id;
    renderChat(response.chat);
    setRunning(response.running || false);
    statusEl.textContent = response.running ? "running…" : "idle";
  }
  refreshChatList();
});

async function beginTask(mode) {
  const task = input.value.trim();
  if (!task) {
    statusEl.textContent = "type a task first";
    input.focus();
    return;
  }

  stickToBottom = true;
  sendBtn.disabled = true;
  researchBtn.disabled = true;
  statusEl.textContent = mode === "research" ? "starting research..." : "starting...";
  try {
    const response = await chrome.runtime.sendMessage({
      action: "startTask",
      task,
      chatId: activeChatId,
      mode,
    });
    if (response?.error) {
      statusEl.textContent = `error: ${response.error}`;
    } else {
      activeChatId = response.chatId;
      setRunning(true);
      statusEl.textContent =
        mode === "research" ? `researching on tab ${response.tabId}` : `running on tab ${response.tabId}`;
      refreshChatList();
      input.value = "";
    }
  } catch (error) {
    statusEl.textContent = `error: ${error.message}`;
  } finally {
    sendBtn.disabled = false;
    researchBtn.disabled = running;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (running) {
    await chrome.runtime.sendMessage({ action: "stopTask", chatId: activeChatId });
    setRunning(false);
    statusEl.textContent = "stopped";
    return;
  }

  await beginTask("normal");
});

researchBtn.addEventListener("click", async () => {
  if (running) return;
  await beginTask("research");
});
