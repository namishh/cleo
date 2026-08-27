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

// ---------- spinning ascii-art cleo (shown while a chat has no messages) ----------
// Cleo is a procedural 3D blob (not a sampled image — a flat PNG has no depth to
// spin): a sphere with organic sum-of-sines radius wobble, rotated, lit, and
// z-buffered into a character grid each tick. Eye "expression" (blink / wide) is
// driven by wall-clock time independently of the spin, so frames are computed live
// rather than pre-baked.

const ASCII_COLS = 50;
const ASCII_ROWS = 26;
const ASCII_GRADIENT = " .:-=+*#%@";
const ASCII_LIGHT = normalize3(0.4, 0.5, 1.0);
const ASCII_AMBIENT = 0.22;
const ASCII_BASE_EYE_R = 0.17;
const ASCII_THETA_STEPS = 140;
const ASCII_PHI_STEPS = 70;

function normalize3(x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z);
  return [x / len, y / len, z / len];
}

function cross3([ax, ay, az], [bx, by, bz]) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function dot3([ax, ay, az], [bx, by, bz]) {
  return ax * bx + ay * by + az * bz;
}

// Per-eye local basis (dir = center, right/up = tangent axes on the sphere) so an
// eye can be rendered as an ellipse that flattens independently for a blink.
function makeEyeBasis(dir) {
  let right = cross3([0, 1, 0], dir);
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0];
  right = normalize3(...right);
  const up = normalize3(...cross3(dir, right));
  return { dir, up, right };
}

const ASCII_EYES = [makeEyeBasis(normalize3(-0.35, 0.12, 0.85)), makeEyeBasis(normalize3(0.35, 0.12, 0.85))];

// Deterministic, wall-clock-driven "expression": open normally, blink briefly
// every ~4s, and widen (surprised) briefly every ~9s. Pure function of time, so
// no scheduler/state to drift or clean up.
function getExpression(now) {
  let blink = 1;
  const bt = now % 4000;
  if (bt > 3750) {
    const p = (bt - 3750) / 250;
    blink = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2;
  }
  let wide = 1;
  const wt = now % 9000;
  if (wt > 8500 && wt < 8900) {
    wide = 1 + 0.35 * Math.sin(((wt - 8500) / 400) * Math.PI);
  }
  return { blink, wide };
}

// Organic radius wobble (sum of a few low-frequency sines over the object's own
// theta/phi) so the blob reads as squishy, not a mathematically perfect sphere.
function blobRadius(theta, phi) {
  return (
    1 +
    0.1 * Math.sin(3 * theta + 1.3) * Math.sin(2 * phi) +
    0.07 * Math.cos(5 * theta - 0.4) * Math.sin(phi * 3 + 0.6) +
    0.06 * Math.sin(2 * theta + 2.1) * Math.cos(phi * 2 - 1)
  );
}

let asciiAspect = null;
let asciiTimer = null;

// Measure the real rendered glyph cell (width/height) of the ascii-cleo class so
// the sphere projection compensates for the actual font instead of an assumed
// monospace aspect — a wrong guess here is exactly what made earlier versions
// look stretched.
function measureCharAspect() {
  const probe = document.createElement("pre");
  probe.className = "ascii-cleo";
  probe.style.cssText = "position:fixed; visibility:hidden; left:-9999px; top:-9999px; margin:0;";
  probe.textContent = "#".repeat(20) + "\n" + "#".repeat(20);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return rect.width > 0 && rect.height > 0 ? rect.height / 2 / (rect.width / 20) : 1.7;
}

function buildSphereFrame(angle, expression) {
  if (asciiAspect == null) asciiAspect = measureCharAspect();
  const cols = ASCII_COLS;
  const rows = ASCII_ROWS;
  const sx = cols * 0.34;
  const sy = sx / asciiAspect;
  const rx = ASCII_BASE_EYE_R * expression.wide;
  const ry = ASCII_BASE_EYE_R * expression.blink * expression.wide;
  const zbuf = new Float32Array(cols * rows).fill(-Infinity);
  const chars = new Array(cols * rows).fill(" ");
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let ti = 0; ti < ASCII_THETA_STEPS; ti++) {
    const theta = (ti / ASCII_THETA_STEPS) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let pi = 0; pi <= ASCII_PHI_STEPS; pi++) {
      const phi = (pi / ASCII_PHI_STEPS) * Math.PI;
      const sinP = Math.sin(phi);
      const dirX = sinP * cosT;
      const dirY = Math.cos(phi);
      const dirZ = sinP * sinT;

      let isEye = false;
      if (ry > 1e-3) {
        for (const eye of ASCII_EYES) {
          if (dot3([dirX, dirY, dirZ], eye.dir) <= 0.3) continue;
          const u = dot3([dirX, dirY, dirZ], eye.right);
          const v = dot3([dirX, dirY, dirZ], eye.up);
          if ((u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1) {
            isEye = true;
            break;
          }
        }
      }

      const r = blobRadius(theta, phi);
      const x = dirX * r;
      const y = dirY * r;
      const z = dirZ * r;
      const xr = x * ca + z * sa;
      const zr = -x * sa + z * ca;
      const col = Math.round(cols / 2 + xr * sx);
      const row = Math.round(rows / 2 - y * sy);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const idx = row * cols + col;
      if (zr <= zbuf[idx]) continue;
      zbuf[idx] = zr;
      if (isEye) {
        chars[idx] = " ";
      } else {
        const lum = Math.max(ASCII_AMBIENT, dirX * ASCII_LIGHT[0] + dirY * ASCII_LIGHT[1] + dirZ * ASCII_LIGHT[2]);
        chars[idx] = ASCII_GRADIENT[Math.min(ASCII_GRADIENT.length - 1, Math.floor(lum * ASCII_GRADIENT.length))];
      }
    }
  }
  let out = "";
  for (let row = 0; row < rows; row++) {
    out += chars.slice(row * cols, (row + 1) * cols).join("") + "\n";
  }
  return out;
}

function stopAsciiSpin() {
  if (asciiTimer) clearInterval(asciiTimer);
  asciiTimer = null;
}

function showEmptyState() {
  const wrap = document.createElement("div");
  wrap.className = "empty ascii-empty";
  const pre = document.createElement("pre");
  pre.className = "ascii-cleo";
  const hint = document.createElement("div");
  hint.className = "empty-hint";
  hint.textContent = "send a task to begin";
  wrap.append(pre, hint);
  streamEl.appendChild(wrap);

  const spinPeriodMs = 6000;
  const render = () => {
    const now = Date.now();
    const angle = ((now % spinPeriodMs) / spinPeriodMs) * Math.PI * 2;
    pre.textContent = buildSphereFrame(angle, getExpression(now));
  };
  render();
  asciiTimer = setInterval(render, 80);
}

function removeEmptyState() {
  stopAsciiSpin();
  streamEl.querySelector(".empty")?.remove();
}

function avatar(className) {
  const img = document.createElement("img");
  img.className = `avatar ${className}`;
  img.src = CLEO_ICON;
  img.alt = "";
  return img;
}

function addUserMessage(text, mode) {
  removeEmptyState();
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
  stopAsciiSpin();
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
  if (!chat || !chat.entries?.length) {
    showEmptyState();
    return;
  }
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
  showEmptyState();
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
