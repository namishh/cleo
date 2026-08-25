// Guards against double injection: the manifest auto-injects this on every
// page load, and background.js also injects it manually as a messaging
// fallback. A second run in the same isolated world would otherwise throw
// "Identifier ... has already been declared" on the top-level consts below.
if (!window.__cleoContentScriptLoaded) {
  window.__cleoContentScriptLoaded = true;
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

  const IMAGE_SELECTOR = [
    "img[alt]:not([alt=''])",
    "img[aria-label]",
    "[role=img][aria-label]",
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
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "form") return "form";
    if (tag === "dialog") return "dialog";
    return "generic";
  }

  function propertiesFor(element) {
    const props = {};
    const rawHref = element.href || element.getAttribute("href");
    if (rawHref) {
      props.href = safeUrlForDisplay(rawHref);
    }

    // Expose image sources so the model can download images directly instead of
    // hunting for download buttons.
    const src = element.currentSrc || element.src || element.getAttribute("src");
    if (src) props.src = safeUrlForDisplay(src);

    const alt = element.getAttribute("alt");
    if (alt) props.alt = sanitizeText(alt);
    return props;
  }

  function safeUrlForDisplay(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return textLooksSensitive(url.pathname) ? "[REDACTED URL]" : url.toString();
    } catch {
      return "[REDACTED URL]";
    }
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
      ((LOCATION_CONTEXT_RE.test(text) || ADDRESS_CONTEXT_RE.test(text)) &&
        (PINCODE_RE.test(text) || ZIP_RE.test(text))) ||
      /(?:pincode|pin code|postal code|postcode|zip code)\D{0,24}\d{5,6}/i.test(text)
    );
  }

  function privacyElementForTextNode(textNode) {
    const rawText = normalize(textNode.nodeValue, 500);
    if (!rawText) return null;

    // Only the text node itself (plus a tiny ancestor window) may be masked.
    // Walking far up the tree made any page containing one sensitive word
    // (e.g. "address" in a nav link) redact its entire header.
    const directMatch = textLooksSensitive(rawText);

    // Amazon-style widgets split text across sibling nodes:
    //   <span>Deliver to</span> <span>Namish</span> <span>CITY 123456</span>
    // so a single node may only hold "CITY" or "123456". If the node sits in
    // a location-labelled control, treat its own text as sensitive too.
    const inLocationControl = !!textNode.parentElement?.closest(
      '[id*=location],[id*=deliver],[class*=glow],[class*=deliver],[class*=address],[aria-label*=location i],[aria-label*=deliver i],[aria-label*=address i]'
    );

    if (!directMatch && !inLocationControl) return null;

    let element = textNode.parentElement;
    for (let depth = 0; element && depth < 2; depth++, element = element.parentElement) {
      if (!isVisible(element)) continue;
      const combinedText = normalize(element.innerText || element.textContent, 500);
      if (!textLooksSensitive(combinedText) || combinedText.length > 300) continue;

      const rect = rectFor(element);
      if (rect.width > 0 && rect.height > 0) return rect;
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

    // Whole location widgets (Amazon "Deliver to CITY 123456"). Matched by id,
    // class, or aria-label so split text nodes are covered by one mask.
    for (const element of document.querySelectorAll(
      '[id*=location i],[id*=deliver i],[id*=glow i],[class*=glow i],[class*=deliver i],[aria-label*=deliver i],[aria-label*=location i]'
    )) {
      if (!isVisible(element)) continue;
      const rect = rectFor(element);
      if (rect.width > 0 && rect.height > 0) regions.push(rect);
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
      ...document.querySelectorAll(IMAGE_SELECTOR),
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
        properties: propertiesFor(element),
      });

      if (elements.length >= 300) break;
    }

    return elements;
  }

  function formatTree(elements, scroll) {
    const lines = [`Viewport: ${innerWidth}x${innerHeight} CSS px`];
    if (scroll) {
      lines.push(
        `Page scroll: ${scroll.pageScrollY}px of ${scroll.pageScrollHeight}px ` +
        `(can scroll ${scroll.pageCanScrollDown ? "down" : ""}${
          scroll.pageCanScrollDown && scroll.pageCanScrollUp ? " and " : ""
        }${scroll.pageCanScrollUp ? "up" : ""}${!scroll.pageCanScrollDown && !scroll.pageCanScrollUp ? "none" : ""})`
      );
      for (const region of scroll.regions) {
        const { x, y, width, height } = region.rect;
        lines.push(
          `[${region.id}] scrollable ${region.direction} "${region.name}" @ (${x},${y},${width}x${height}) — scroll inside this region to reveal more content`
        );
      }
    }
    lines.push(...elements.slice(0, 250).map((element) => {
      const { x, y, width, height } = element.rect;
      const state = element.state.length ? ` {${element.state.join(", ")}}` : "";
      const props = Object.entries(element.properties || {})
        .map(([key, value]) => ` ${key}=${String(value).slice(0, 120)}`)
        .join("");
      return `[${element.id}] ${element.role} "${element.name.slice(0, 120)}" @ (${x},${y},${width}x${height})${state}${props}`;
    }));
    if (elements.length > 250) lines.push(`... (${elements.length - 250} elements omitted)`);
    if (elements.length === 0) lines.push("(no visible actionable elements)");
    return lines.join("\n");
  }

  // Find independently-scrollable sub-containers (filter panels, sidebars,
  // lists) so the model knows where it can scroll to reveal more content.
  function collectScrollInfo() {
    const doc = document.scrollingElement || document.documentElement;
    const info = {
      pageScrollY: Math.round(scrollY),
      pageScrollHeight: Math.round(doc.scrollHeight),
      pageCanScrollDown: scrollY + innerHeight < doc.scrollHeight - 4,
      pageCanScrollUp: scrollY > 4,
      regions: [],
    };

    const candidates = document.querySelectorAll("div, nav, aside, ul, ol, section, main");
    for (const element of candidates) {
      if (info.regions.length >= 5) break;
      if (!isVisible(element)) continue;
      const style = getComputedStyle(element);
      const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40;
      const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 40;
      if (!scrollsY && !scrollsX) continue;

      const rect = rectFor(element);
      if (rect.width < 40 || rect.height < 40) continue;

      info.regions.push({
        id: `r${info.regions.length + 1}`,
        name: sanitizeText(accessibleName(element)) || element.tagName.toLowerCase(),
        direction: scrollsY && scrollsX ? "vertical+horizontal" : scrollsY ? "vertical" : "horizontal",
        rect,
      });
    }
    return info;
  }

  function getCompactAccessibilityTree() {
    elementRefs = new Map();
    const privacyRegions = collectPrivacyRegions();
    const elements = collectElements(privacyRegions);
    const scroll = collectScrollInfo();
    return {
      tree: formatTree(elements, scroll),
      elements,
      privacyRegions,
      scroll,
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

    if (request.action === "getElementRect") {
      const element = elementRefs.get(request.id);
      if (!element || !isVisible(element)) {
        sendResponse({ error: `element ${request.id} is unavailable` });
        return false;
      }
      sendResponse({ rect: rectFor(element) });
      return false;
    }

    if (request.action === "scrollIntoView") {
      const element = elementRefs.get(request.id);
      if (!element) {
        sendResponse({ error: `element ${request.id} is unavailable` });
        return false;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      // Give smooth scrolling a beat, then report the new position.
      setTimeout(() => {
        if (!isVisible(element)) {
          sendResponse({ error: `element ${request.id} still not visible after scrolling` });
          return;
        }
        sendResponse({ rect: rectFor(element) });
      }, 400);
      return true;
    }

    if (request.action === "getResourceUrl") {
      const element = elementRefs.get(request.id);
      if (!element) {
        sendResponse({ error: `element ${request.id} is unavailable` });
        return false;
      }
      const url = element.currentSrc || element.src || element.href || element.getAttribute("href");
      if (!url) {
        sendResponse({ error: `element ${request.id} has no downloadable resource` });
        return false;
      }
      sendResponse({ url: new URL(url, location.href).toString() });
      return false;
    }

    if (request.action === "getPageText") {
      const element = request.id ? elementRefs.get(request.id) : document.body;
      if (!element) {
        sendResponse({ error: `element ${request.id} is unavailable` });
        return false;
      }
      // Privacy-consistent with the screenshot: PII is masked, structure kept.
      const text = sanitizeText(normalize(element.innerText, 8000));
      sendResponse({ text: text.slice(0, 8000) });
      return false;
    }
  });

}
