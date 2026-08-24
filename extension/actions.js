// Browser action execution via the Chrome DevTools Protocol.
// Every action from the backend's ACTION_SPACE is implemented here and runs
// through chrome.debugger, so it works on background tabs too.

// CDP mouse buttons: "left" | "middle" | "right".
const MOUSE_BUTTONS = { click: "left", double_click: "left", right_click: "right" };

async function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function requireCoords(action) {
  action.x = Number(action.x);
  action.y = Number(action.y);
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
    throw new Error(`${action.type} requires numeric x and y`);
  }
}

async function mousePressRelease(tabId, x, y, button, clickCount) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount,
    pointerType: "mouse",
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount,
    pointerType: "mouse",
  });
}

async function actionClick(tabId, action) {
  requireCoords(action);
  const { x, y } = action;
  const button = MOUSE_BUTTONS[action.type] || "left";
  const clicks = action.type === "double_click" ? 2 : 1;
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    pointerType: "mouse",
  });
  await mousePressRelease(tabId, x, y, button, clicks);
  return `clicked (${x}, ${y})`;
}

async function actionMove(tabId, action) {
  requireCoords(action);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: action.x,
    y: action.y,
    pointerType: "mouse",
  });
  return `moved to (${action.x}, ${action.y})`;
}

async function actionScroll(tabId, action) {
  // Scrolling does not need an exact target. Default to the viewport's top-left
  // so models may return the compact form {type:"scroll", direction, amount}.
  const x = Number.isFinite(action.x) ? action.x : 1;
  const y = Number.isFinite(action.y) ? action.y : 1;
  const amount = Number.isFinite(action.amount)
    ? action.amount
    : Number.isFinite(action.ticks)
      ? action.ticks
      : 3;
  const direction = action.direction === "up" ? -1 : 1;
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: (action.deltaX || 0) * direction,
    deltaY: amount * 120 * direction,
    pointerType: "mouse",
  });
  return `scrolled ${direction === 1 ? "down" : "up"} ${amount} tick(s) at (${x}, ${y})`;
}

// Focus the element under the point first so typing goes to the right field.
async function focusAt(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    pointerType: "mouse",
  });
  await mousePressRelease(tabId, x, y, "left", 1);
}

async function actionType(tabId, action) {
  if (typeof action.text !== "string") throw new Error("type requires text");
  if (action.x !== undefined && action.y !== undefined) {
    await focusAt(tabId, action.x, action.y);
  }
  // insertText handles unicode/IME correctly; key events are for special keys.
  await send(tabId, "Input.insertText", { text: action.text });
  return `typed ${action.text.length} character(s)`;
}

const SPECIAL_KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
};

const MODIFIER_FLAGS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const MODIFIER_KEYS = {
  Alt: { code: "AltLeft", keyCode: 18 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Meta: { code: "MetaLeft", keyCode: 91 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
};

function parseKeyCombo(combo) {
  const parts = String(combo).split("+").map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  let main = "";
  for (const part of parts) {
    if (part in MODIFIER_FLAGS) {
      modifiers |= MODIFIER_FLAGS[part];
    } else {
      main = part;
    }
  }
  if (!main) throw new Error(`key action has no main key: "${combo}"`);
  return { modifiers, main };
}

async function actionKey(tabId, action) {
  if (!action.key) throw new Error("key requires a key name");
  const { modifiers, main } = parseKeyCombo(action.key);
  const modifierKeys = String(action.key)
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part in MODIFIER_FLAGS);

  for (const modifier of modifierKeys) {
    const info = MODIFIER_KEYS[modifier];
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modifier,
      code: info.code,
      modifiers: 0,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
  }

  if (main.length === 1) {
    // Printable characters work both alone and in combinations such as
    // Control+a / Meta+c.
    const keyCode = main.toUpperCase().charCodeAt(0);
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: main,
      code: /^\d$/.test(main) ? `Digit${main}` : `Key${main.toUpperCase()}`,
      modifiers,
      text: main,
      unmodifiedText: main,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: main,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  } else {
    const special = SPECIAL_KEY_CODES[main];
    if (!special) throw new Error(`unsupported key: "${main}"`);
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...special,
      modifiers,
    });
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...special,
      modifiers,
    });
  }

  for (const modifier of modifierKeys.reverse()) {
    const info = MODIFIER_KEYS[modifier];
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modifier,
      code: info.code,
      modifiers: 0,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
  }
  return `pressed ${action.key}`;
}

async function actionDrag(tabId, action) {
  requireCoords(action);
  action.x2 = Number(action.x2);
  action.y2 = Number(action.y2);
  if (!Number.isFinite(action.x2) || !Number.isFinite(action.y2)) {
    throw new Error("drag requires x2 and y2");
  }
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: action.x, y: action.y, pointerType: "mouse" });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1, pointerType: "mouse" });

  const steps = Math.max(
    2,
    Math.ceil(Math.hypot(action.x2 - action.x, action.y2 - action.y) / 40)
  );
  for (let step = 1; step <= steps; step++) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: action.x + ((action.x2 - action.x) * step) / steps,
      y: action.y + ((action.y2 - action.y) * step) / steps,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
    });
  }

  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: action.x2,
    y: action.y2,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  return `dragged (${action.x}, ${action.y}) -> (${action.x2}, ${action.y2})`;
}

async function actionSelect(tabId, action) {
  requireCoords(action);
  if (!action.option) throw new Error("select requires option text");
  await focusAt(tabId, action.x, action.y);

  // Setting <select> values reliably needs page-context JS; the scripting API
  // reaches background tabs as long as the tab has a document.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (x, y, optionText) => {
      const element = document.elementFromPoint(x, y);
      if (!element || element.tagName.toLowerCase() !== "select") {
        return { error: `no <select> at (${x}, ${y})` };
      }
      const wanted = String(optionText).trim().toLowerCase();
      const option = Array.from(element.options).find(
        (opt) => opt.text.trim().toLowerCase() === wanted
      );
      if (!option) {
        return { error: `option "${optionText}" not found`, available: element.options.length };
      }
      element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: option.text };
    },
    args: [action.x, action.y, action.option],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return `selected "${result.selected}"`;
}

async function actionNavigate(tabId, action) {
  if (!action.url) throw new Error("navigate requires url");
  let url = action.url;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  await chrome.tabs.update(tabId, { url });
  return `navigating to ${url}`;
}

async function actionWait(action) {
  const ms = Math.min(Math.max(Number(action.ms) || 500, 0), 10000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return `waited ${ms}ms`;
}

const EXECUTORS = {
  click: actionClick,
  double_click: actionClick,
  right_click: actionClick,
  move: actionMove,
  scroll: actionScroll,
  type: actionType,
  key: actionKey,
  drag: actionDrag,
  select: actionSelect,
  navigate: actionNavigate,
  wait: actionWait,
};

// Terminal actions carry no runtime behaviour; they only end the loop.
const TERMINAL_ACTIONS = new Set(["done", "fail"]);

function isActionType(type) {
  return type in EXECUTORS || TERMINAL_ACTIONS.has(type);
}

async function executeAction(tabId, action) {
  if (TERMINAL_ACTIONS.has(action.type)) {
    return action.type === "done" ? "task done" : action.reason || "failed";
  }
  const executor = EXECUTORS[action.type];
  if (!executor) throw new Error(`unknown action type: ${action.type}`);
  return executor(tabId, action);
}

// Small pause between chained actions so the DOM can settle.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeActions(tabId, actions) {
  const results = [];
  for (const action of actions) {
    try {
      const detail = await executeAction(tabId, action);
      results.push({ action, ok: true, detail });
      if (TERMINAL_ACTIONS.has(action.type)) break;
      if (actions.length > 1) await sleep(300);
    } catch (error) {
      results.push({ action, ok: false, error: error.message || String(error) });
      break; // stop the batch on first failure; the caller decides what next
    }
  }
  return results;
}

export { executeActions, executeAction, isActionType };
