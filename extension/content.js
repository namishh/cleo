const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[role=menuitem]",
  "[role=option]",
  "[role=tab]",
  "[contenteditable=true]",
].join(",");

const LANDMARK_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "nav",
  "main",
  "header",
  "form",
  "dialog",
  "[role=heading]",
  "[role=alert]",
  "[role=dialog]",
  "[role=main]",
  "[role=navigation]",
].join(",");

const EMAIL_RE = /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d() .-]{6,}\d)/;
const DATE_RE = /\b(?:\d{1,4}[-/.]){2}\d{1,4}\b/;
const PINCODE_RE = /\b[1-9]\d{5}\b/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const LOCATION_CONTEXT_RE = /\b(?:deliver(?:y)?|ship(?:ping)?|address|location|postal|pincode|pin code|zip code|postcode|city|state)\b/i;
const ADDRESS_CONTEXT_RE = /\b(?:deliver(?:y)?\s+to|ship(?:ping)?\s+to|delivery\s+address|shipping\s+address|home\s+address|billing\s+address)\b/i;
const SENSITIVE_CONTROL_RE = /\b(?:password|email|e-?mail|phone|mobile|tel|address|street|city|state|postal|pincode|pin[- ]?code|postcode|zip|first[- ]?name|last[- ]?name|full[- ]?name|ssn|tax[- ]?id)\b/i;

let elementRefs = new Map();

function normalize(value, maxLength = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeText(value) {
  let text = normalize(value);
  if (!text) return "";

  // A location label plus a postal code commonly contains the city as well.
  if (
    ADDRESS_CONTEXT_RE.test(text) ||
    (LOCATION_CONTEXT_RE.test(text) && (PINCODE_RE.test(text) || ZIP_RE.test(text)))
  ) {
    return "[REDACTED LOCATION]";
  }

  text = text.replace(EMAIL_RE, "[REDACTED EMAIL]");
  text = text.replace(PHONE_RE, "[REDACTED PHONE]");
  text = text.replace(DATE_RE, "[REDACTED DATE]");
  return text;
}

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
}

function rectFor(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(0, Math.round(Math.min(rect.width, innerWidth - Math.max(0, rect.left)))),
    height: Math.max(0, Math.round(Math.min(rect.height, innerHeight - Math.max(0, rect.top)))),
  };
}

function directText(element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.nodeValue)
    .join(" ");
}

function accessibleName(element) {
  const aria = element.getAttribute("aria-label");
  if (aria) return sanitizeText(aria);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ");
    if (text) return sanitizeText(text);
  }

  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label?.innerText) return sanitizeText(label.innerText);
  }

  const parentLabel = element.closest("label");
  if (parentLabel?.innerText) return sanitizeText(parentLabel.innerText);

  const alt = element.getAttribute("alt");
  if (alt) return sanitizeText(alt);

  const title = element.getAttribute("title");
  if (title) return sanitizeText(title);

  const text = normalize(element.innerText || directText(element));
  return sanitizeText(text);
}

function roleFor(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;

  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "dialog") return "dialog";
  return "generic";
}

function stateFor(element) {
  const state = [];
  if (element.disabled || element.getAttribute("aria-disabled") === "true") state.push("disabled");
  if (element.checked || element.getAttribute("aria-checked") === "true") state.push("checked");
  if (element.selected || element.getAttribute("aria-selected") === "true") state.push("selected");
  if (element.getAttribute("aria-expanded") === "true") state.push("expanded");
  if (document.activeElement === element) state.push("focused");
  return state;
}

function textLooksSensitive(text) {
  return (
    EMAIL_RE.test(text) ||
    PHONE_RE.test(text) ||
    DATE_RE.test(text) ||
    ADDRESS_CONTEXT_RE.test(text) ||
    ((LOCATION_CONTEXT_RE.test(text)) && (PINCODE_RE.test(text) || ZIP_RE.test(text))) ||
    /(?:pincode|pin code|postal code|postcode|zip code)\D{0,24}\d{5,6}/i.test(text)
  );
}

function privacyElementForTextNode(textNode) {
  const rawText = normalize(textNode.nodeValue, 500);
  if (!rawText) return null;

  let element = textNode.parentElement;
  for (let depth = 0; element && depth < 5; depth++, element = element.parentElement) {
    if (!isVisible(element)) continue;
    const combinedText = normalize(element.innerText || element.textContent, 500);
    const directMatch = textLooksSensitive(rawText);
    const contextualMatch = textLooksSensitive(combinedText);

    if ((directMatch || contextualMatch) && combinedText.length <= 500) {
      const rect = rectFor(element);
      if (rect.width > 0 && rect.height > 0) return rect;
    }
  }
  return null;
}

function collectPrivacyRegions() {
  const regions = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const region = privacyElementForTextNode(node);
    if (region) regions.push(region);
  }

  // Include visible input controls without ever reading their values.
  for (const element of document.querySelectorAll("input, textarea, select")) {
    if (!isVisible(element)) continue;
    const metadata = normalize(
      `${element.getAttribute("aria-label") || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""}`,
      300
    );
    if (
      element.type === "password" ||
      SENSITIVE_CONTROL_RE.test(metadata) ||
      textLooksSensitive(metadata)
    ) {
      regions.push(rectFor(element));
    }
  }

  return mergeRegions(regions);
}

function mergeRegions(regions) {
  const result = [];
  for (const region of regions) {
    const duplicate = result.some((existing) => {
      const overlapX = Math.max(0, Math.min(existing.x + existing.width, region.x + region.width) - Math.max(existing.x, region.x));
      const overlapY = Math.max(0, Math.min(existing.y + existing.height, region.y + region.height) - Math.max(existing.y, region.y));
      return overlapX * overlapY > 0.6 * Math.min(existing.width * existing.height, region.width * region.height);
    });
    if (!duplicate) result.push(region);
  }
  return result.slice(0, 200);
}

function regionsOverlap(a, b) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) >
    0
  );
}

function collectElements(privacyRegions = []) {
  const all = new Set([
    ...document.querySelectorAll(INTERACTIVE_SELECTOR),
    ...document.querySelectorAll(LANDMARK_SELECTOR),
  ]);
  const elements = [];

  for (const element of all) {
    if (!isVisible(element)) continue;

    const role = roleFor(element);
    const rect = rectFor(element);
    const isRedacted = privacyRegions.some((region) => regionsOverlap(rect, region));
    const name = isRedacted ? "[REDACTED]" : accessibleName(element);
    if (!name && role === "generic") continue;

    const id = `e${elements.length + 1}`;
    elementRefs.set(id, element);
    elements.push({
      id,
      role,
      name: name || `[${role}]`,
      rect,
      state: stateFor(element),
    });

    if (elements.length >= 300) break;
  }

  return elements;
}

function formatTree(elements) {
  const lines = elements.slice(0, 250).map((element) => {
    const { x, y, width, height } = element.rect;
    const state = element.state.length ? ` {${element.state.join(", ")}}` : "";
    return `[${element.id}] ${element.role} "${element.name.slice(0, 120)}" @ (${x},${y},${width}x${height})${state}`;
  });
  if (elements.length > 250) lines.push(`... (${elements.length - 250} elements omitted)`);
  return lines.join("\n") || "(no visible actionable elements)";
}

function getCompactAccessibilityTree() {
  elementRefs = new Map();
  const privacyRegions = collectPrivacyRegions();
  const elements = collectElements(privacyRegions);
  return {
    tree: formatTree(elements),
    elements,
    privacyRegions,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    url: location.href,
    title: document.title,
  };
}

console.log("Browser Agent content script loaded on:", window.location.href);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "greet") {
    sendResponse({ url: window.location.href, title: document.title });
    return false;
  }

  if (request.action === "getCompactAccessibilityTree") {
    try {
      sendResponse(getCompactAccessibilityTree());
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return false;
  }
});
