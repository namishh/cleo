const FACE_MODEL_URL = chrome.runtime.getURL("models/yunet_fact_detection_may_2026.onnx");
const KIJI_MODEL_URL = chrome.runtime.getURL("models/kiji-pii-model.onnx");
const FACE_INPUT_W = 640;
const FACE_INPUT_H = 480;
const FACE_SCORE_THRESH = 0.3;
const FACE_NMS_THRESH = 0.3;

const EMAIL_RE = /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d() .-]{6,}\d)/;
const DATE_RE = /\b(?:\d{1,4}[-/.]){2}\d{1,4}\b/;
const PINCODE_RE = /\b[1-9]\d{5}\b/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const LOCATION_CONTEXT_RE = /\b(?:deliver(?:y)?|ship(?:ping)?|address|location|postal|pincode|pin code|zip code|postcode|city|state)\b/i;
const ADDRESS_CONTEXT_RE = /\b(?:deliver(?:y)?\s+to|ship(?:ping)?\s+to|delivery\s+address|shipping\s+address|home\s+address|billing\s+address)\b/i;

const SENSITIVE_LABELS = new Set([
  "name",
  "mobile number",
  "email",
  "date of birth",
  "application no",
  "application number",
  "roll number",
  "whatsapp number",
  "contact email",
]);

const STOP_LABELS = new Set([
  "application", "no", "program", "specialization", "batch", "school", "campus",
  "allotment", "roll", "number", "gender", "blood", "group", "mother", "tongue",
  "state", "religion", "nationality", "contact", "home", "profile", "academic",
  "details", "personal", "information",
]);

let faceSession = null;
let kijiSession = null;
let kijiTokenizer = null;
let kijiLabels = null;
let kijiVocab = null;
let tesseractWorker = null;

// Tell onnxruntime-web (v1.27) where to find its .mjs loader and .wasm binary.
ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
// Single-threaded WASM: no cross-origin worker isolation needed in offscreen docs.
ort.env.wasm.numThreads = 1;

let currentJobChatId = null;

function reportProgress(percent, message) {
  chrome.runtime
    .sendMessage({ action: "progress", percent, message, chatId: currentJobChatId })
    .catch(() => {});
}

async function getFaceSession() {
  if (!faceSession) {
    reportProgress(25, "Loading face detection model...");
    faceSession = await ort.InferenceSession.create(FACE_MODEL_URL, {
      executionProviders: ["wasm"],
    });
  }
  return faceSession;
}

async function getKijiSession() {
  if (!kijiSession) {
    reportProgress(77, "Loading Kiji PII model...");
    kijiSession = await ort.InferenceSession.create(KIJI_MODEL_URL, {
      executionProviders: ["wasm"],
    });
  }
  return kijiSession;
}

async function loadKijiVocab() {
  if (!kijiVocab) {
    reportProgress(76, "Loading Kiji tokenizer...");
    const response = await fetch(chrome.runtime.getURL("models/kiji-tokenizer/vocab.txt"));
    if (!response.ok) throw new Error(`Could not load Kiji vocab: ${response.status}`);
    const text = await response.text();
    const vocab = new Map();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const token = lines[i].trim();
      if (token !== "") vocab.set(token, i);
    }
    kijiVocab = vocab;
  }
  return kijiVocab;
}

function wordPieceTokenize(word, vocab, unkId) {
  if (vocab.has(word)) return [vocab.get(word)];
  if (word.length > 100) return [unkId];
  const ids = [];
  let remaining = word;
  let isFirst = true;
  while (remaining.length > 0) {
    let longest = "";
    let longestId = -1;
    for (let i = remaining.length; i > 0; i--) {
      const sub = isFirst ? remaining.slice(0, i) : `##${remaining.slice(0, i)}`;
      const id = vocab.get(sub);
      if (id !== undefined) {
        longest = sub;
        longestId = id;
        break;
      }
    }
    if (!longest) return [unkId];
    ids.push(longestId);
    const matchedText = longest.startsWith("##") ? longest.slice(2) : longest;
    remaining = remaining.slice(matchedText.length);
    isFirst = false;
  }
  return ids;
}

async function getKijiTokenizer() {
  if (!kijiTokenizer) {
    const vocab = await loadKijiVocab();
    const unkId = vocab.get("[UNK]");
    if (unkId === undefined) throw new Error("Kiji vocab missing [UNK]");
    kijiTokenizer = (text) => {
      const trimmed = String(text ?? "").trim();
      if (trimmed === "") return { input_ids: { data: [] } };
      // Whole-word/special-token fast path.
      if (vocab.has(trimmed)) return { input_ids: { data: [vocab.get(trimmed)] } };
      const ids = [];
      for (const whitespacePiece of trimmed.split(/\s+/)) {
        if (!whitespacePiece) continue;
        // Split on non-word characters, keeping delimiters, so "example.com"
        // becomes ["example", ".", "com"] like BERT's BertPreTokenizer.
        const pieces = whitespacePiece.split(/(\W+)/).filter(Boolean);
        for (const piece of pieces) {
          ids.push(...wordPieceTokenize(piece, vocab, unkId));
        }
      }
      return { input_ids: { data: ids } };
    };
  }
  return kijiTokenizer;
}

async function getKijiLabels() {
  if (!kijiLabels) {
    const response = await fetch(chrome.runtime.getURL("models/kiji-tokenizer/label_mappings.json"));
    if (!response.ok) throw new Error(`Could not load Kiji labels: ${response.status}`);
    kijiLabels = await response.json();
  }
  return kijiLabels.pii.id2label;
}

async function getTesseractWorker() {
  if (!tesseractWorker) {
    reportProgress(45, "Loading OCR engine...");
    tesseractWorker = await Tesseract.createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
      workerBlobURL: false,
      corePath: chrome.runtime.getURL("lib/tesseract-core-simd.wasm.js"),
      langPath: chrome.runtime.getURL("tessdata"),
      gzip: false,
      logger: (m) => console.log("tesseract:", m),
    });
  }
  return tesseractWorker;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function imageDataToBgrFloatTensor(imageData, width, height) {
  const tensor = new Float32Array(1 * 3 * height * width);
  const data = imageData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * width + x);
      // R -> channel 2, G -> channel 1, B -> channel 0 (BGR, no normalization)
      tensor[dstIdx] = data[srcIdx + 2];
      tensor[height * width + dstIdx] = data[srcIdx + 1];
      tensor[2 * height * width + dstIdx] = data[srcIdx];
    }
  }
  return new ort.Tensor("float32", tensor, [1, 3, height, width]);
}

async function detectFaces(imageUrl, origW, origH) {
  reportProgress(30, "Preparing image for face detection...");
  const img = await loadImage(imageUrl);

  // Resize to model input size (letterbox is not used; simple resize like Python script)
  const canvas = document.createElement("canvas");
  canvas.width = FACE_INPUT_W;
  canvas.height = FACE_INPUT_H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, FACE_INPUT_W, FACE_INPUT_H);

  const imageData = ctx.getImageData(0, 0, FACE_INPUT_W, FACE_INPUT_H);
  const inputTensor = imageDataToBgrFloatTensor(imageData, FACE_INPUT_W, FACE_INPUT_H);

  const session = await getFaceSession();
  reportProgress(35, "Detecting faces...");
  const outputs = await session.run({ input: inputTensor });

  const strides = [8, 16, 32];
  const boxes = [];
  const scores = [];

  for (let idx = 0; idx < strides.length; idx++) {
    const stride = strides[idx];
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const fh = FACE_INPUT_H / stride;
    const fw = FACE_INPUT_W / stride;
    const anchors = fh * fw;

    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const anchorIdx = y * fw + x;
        const score = cls[anchorIdx] * obj[anchorIdx];
        if (score < FACE_SCORE_THRESH) continue;

        const b0 = bbox[anchorIdx * 4 + 0];
        const b1 = bbox[anchorIdx * 4 + 1];
        const b2 = bbox[anchorIdx * 4 + 2];
        const b3 = bbox[anchorIdx * 4 + 3];

        const cx = (x + b0) * stride;
        const cy = (y + b1) * stride;
        const w = stride * Math.exp(b2);
        const h = stride * Math.exp(b3);

        boxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
        scores.push(score);
      }
    }
  }

  if (boxes.length === 0) return [];

  const keep = nms(boxes, scores, FACE_NMS_THRESH);
  const scaleX = origW / FACE_INPUT_W;
  const scaleY = origH / FACE_INPUT_H;

  return keep.map((i) => {
    const [x1, y1, x2, y2] = boxes[i];
    return [x1 * scaleX, y1 * scaleY, x2 * scaleX, y2 * scaleY];
  });
}

function nms(boxes, scores, threshold) {
  const indices = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);

  const keep = [];
  const suppressed = new Set();

  for (const idx of indices) {
    if (suppressed.has(idx)) continue;
    keep.push(idx);

    const a = boxes[idx];
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);

    for (const other of indices) {
      if (other === idx || suppressed.has(other)) continue;
      const b = boxes[other];
      const x1 = Math.max(a[0], b[0]);
      const y1 = Math.max(a[1], b[1]);
      const x2 = Math.min(a[2], b[2]);
      const y2 = Math.min(a[3], b[3]);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const areaB = (b[2] - b[0]) * (b[3] - b[1]);
      const iou = inter / (areaA + areaB - inter);
      if (iou > threshold) suppressed.add(other);
    }
  }
  return keep;
}

function tokenizerIds(result) {
  const data = result?.input_ids?.data;
  if (!data) throw new Error("PII tokenizer returned no input IDs");
  return Array.from(data, Number);
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

async function detectKijiPii(words) {
  if (!words.length) return [];

  const tokenizer = await getKijiTokenizer();
  const session = await getKijiSession();
  const idToLabel = await getKijiLabels();
  const clsId = tokenizerIds(tokenizer("[CLS]", { add_special_tokens: false }))[0];
  const sepId = tokenizerIds(tokenizer("[SEP]", { add_special_tokens: false }))[0];

  const inputIds = [clsId];
  const wordTokenRanges = [];
  const usableWords = [];

  for (const word of words) {
    const ids = tokenizerIds(tokenizer(word.text, { add_special_tokens: false }));
    if (inputIds.length + ids.length + 1 > 512) break;
    const start = inputIds.length;
    inputIds.push(...ids);
    wordTokenRanges.push({ start, end: inputIds.length });
    usableWords.push(word);
  }
  inputIds.push(sepId);

  const length = inputIds.length;
  const output = await session.run({
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(inputIds, BigInt),
      [1, length]
    ),
    attention_mask: new ort.Tensor(
      "int64",
      BigInt64Array.from({ length }, () => 1n),
      [1, length]
    ),
  });

  const logits = output.pii_logits;
  const dims = logits.dims;
  const data = logits.data;
  if (!dims || dims.length !== 3 || dims[0] !== 1 || dims[2] !== 53) {
    throw new Error(`Unexpected Kiji PII output shape: ${dims}`);
  }

  const classCount = dims[2];
  const threshold = 0.5;
  const predictions = [];

  // Collapse WordPiece predictions to one BIO label per OCR word. Prefer the
  // strongest non-O subtoken so CITY, ZIP, EMAIL, etc. survive tokenization.
  for (const range of wordTokenRanges) {
    let best = { label: "O", score: 0 };
    for (let token = range.start; token < range.end; token++) {
      const row = [];
      for (let cls = 0; cls < classCount; cls++) {
        row.push(data[token * classCount + cls]);
      }
      const probabilities = softmax(row);
      for (let cls = 1; cls < classCount; cls++) {
        if (probabilities[cls] > best.score) {
          best = {
            label: idToLabel[String(cls)] || "O",
            score: probabilities[cls],
          };
        }
      }
    }
    predictions.push(best.score >= threshold ? best : { label: "O", score: best.score });
  }

  const regions = [];
  let active = null;
  const flush = () => {
    if (!active) return;
    const selectedWords = usableWords.slice(active.start, active.end + 1);
    regions.push([
      Math.min(...selectedWords.map((w) => w.bbox.x0)),
      Math.min(...selectedWords.map((w) => w.bbox.y0)),
      Math.max(...selectedWords.map((w) => w.bbox.x1)),
      Math.max(...selectedWords.map((w) => w.bbox.y1)),
    ]);
    active = null;
  };

  for (let index = 0; index < predictions.length; index++) {
    const prediction = predictions[index];
    const match = /^(B|I)-(.+)$/.exec(prediction.label);
    if (!match) {
      flush();
      continue;
    }

    const [, prefix, type] = match;
    if (
      prefix === "B" ||
      !active ||
      active.type !== type ||
      index !== active.end + 1
    ) {
      flush();
      active = { start: index, end: index, type };
    } else {
      active.end = index;
    }
  }
  flush();
  return regions;
}

async function findPiiRegions(imageUrl, origW, origH) {
  const worker = await getTesseractWorker();
  reportProgress(55, "Reading text from screenshot...");
  const result = await worker.recognize(imageUrl);
  const words = result.data.words || [];

  reportProgress(75, "Running Kiji PII model...");
  let regions = [];
  try {
    regions = await detectKijiPii(words);
    console.log(`Kiji PII regions found: ${regions.length}`);
  } catch (error) {
    // Regex/label checks below remain the fallback if the model assets or
    // tokenizer are unavailable.
    console.warn("Kiji PII inference unavailable:", error);
  }

  // Second pass: deterministic regex and contextual label checks.
  reportProgress(82, "Checking regex and address patterns...");
  const groups = groupRowLabels(words);

  for (const group of groups) {
    const phraseText = group.map((w) => w.text.trim()).join(" ");
    const normalized = phraseText.toLowerCase().replace(/[:]+$/g, "");

    // Redact address/location lines as a unit. This catches patterns such as
    // Amazon's "Deliver to CITYNAME 123456" where the city is not itself a
    // recognizable PII token.
    if (
      ADDRESS_CONTEXT_RE.test(normalized) ||
      (LOCATION_CONTEXT_RE.test(normalized) &&
        (PINCODE_RE.test(normalized) || ZIP_RE.test(normalized)))
    ) {
      regions.push([
        Math.min(...group.map((w) => w.bbox.x0)),
        Math.min(...group.map((w) => w.bbox.y0)),
        Math.max(...group.map((w) => w.bbox.x1)),
        Math.max(...group.map((w) => w.bbox.y1)),
      ]);
    }

    // Regex-based redaction on individual words.
    for (const w of group) {
      const text = w.text.trim();
      if (
        EMAIL_RE.test(text) ||
        PHONE_RE.test(text) ||
        DATE_RE.test(text)
      ) {
        regions.push([w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]);
      }
    }

    if (SENSITIVE_LABELS.has(normalized)) {
      const labelBox = {
        x0: Math.min(...group.map((w) => w.bbox.x0)),
        y0: Math.min(...group.map((w) => w.bbox.y0)),
        x1: Math.max(...group.map((w) => w.bbox.x1)),
        y1: Math.max(...group.map((w) => w.bbox.y1)),
      };
      const value = findValueToRightOfBox(labelBox, words);
      if (value) {
        regions.push([value.x0, value.y0, value.x1, value.y1]);
      }
    }
  }

  return regions;
}

function groupRowLabels(words, rowTol = 20, maxGap = 40) {
  const sorted = [...words].sort((a, b) => {
    const acy = (a.bbox.y0 + a.bbox.y1) / 2;
    const bcy = (b.bbox.y0 + b.bbox.y1) / 2;
    if (Math.abs(acy - bcy) > rowTol) return acy - bcy;
    return a.bbox.x0 - b.bbox.x0;
  });

  const groups = [];
  const used = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const group = [sorted[i]];
    used.add(i);
    let rightEdge = sorted[i].bbox.x1;

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const other = sorted[j];
      const otherCy = (other.bbox.y0 + other.bbox.y1) / 2;
      const firstCy = (sorted[i].bbox.y0 + sorted[i].bbox.y1) / 2;
      if (Math.abs(otherCy - firstCy) > rowTol) break;
      const gap = other.bbox.x0 - rightEdge;
      if (gap < 0 || gap > maxGap) break;
      group.push(other);
      used.add(j);
      rightEdge = Math.max(rightEdge, other.bbox.x1);
    }
    groups.push(group);
  }
  return groups;
}

// Merge overlapping/nearby rectangles into clean union boxes so the same PII
// found by multiple passes (model + regex + DOM) draws as one solid block.
function mergeBoxes(boxes, gap = 6) {
  const rects = boxes
    .map(([x1, y1, x2, y2]) => ({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    }))
    .filter((r) => r.x2 > r.x1 && r.y2 > r.y1);

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      for (let j = i + 1; j < rects.length && !merged; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        // Merge when the boxes intersect, or sit on the same text line /
        // column within `gap` pixels of each other.
        if (overlapX > -gap && overlapY > -gap) {
          rects[i] = {
            x1: Math.min(a.x1, b.x1),
            y1: Math.min(a.y1, b.y1),
            x2: Math.max(a.x2, b.x2),
            y2: Math.max(a.y2, b.y2),
          };
          rects.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return rects.map((r) => [r.x1, r.y1, r.x2, r.y2]);
}

function findValueToRightOfBox(labelBox, words, rowTol = 20, maxGap = 700) {
  const labelCy = (labelBox.y0 + labelBox.y1) / 2;
  const candidates = words.filter((w) => {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    return Math.abs(cy - labelCy) <= rowTol && w.bbox.x0 > labelBox.x1;
  });

  candidates.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  if (candidates.length === 0) return null;

  const merged = [candidates[0]];
  let rightEdge = candidates[0].bbox.x1;

  for (let i = 1; i < candidates.length; i++) {
    const w = candidates[i];
    const gap = w.bbox.x0 - rightEdge;
    if (gap > maxGap || gap < 0) break;
    if (STOP_LABELS.has(w.text.trim().toLowerCase().replace(/[:]+$/g, ""))) break;
    merged.push(w);
    rightEdge = Math.max(rightEdge, w.bbox.x1);
  }

  return {
    x0: Math.min(...merged.map((w) => w.bbox.x0)),
    y0: Math.min(...merged.map((w) => w.bbox.y0)),
    x1: Math.max(...merged.map((w) => w.bbox.x1)),
    y1: Math.max(...merged.map((w) => w.bbox.y1)),
  };
}

async function redactImage(
  imageUrl,
  targetName,
  domPrivacyRegions = [],
  viewportWidth = 0,
  viewportHeight = 0
) {
  reportProgress(20, "Loading screenshot...");
  const img = await loadImage(imageUrl);
  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  console.log(`Screenshot loaded: ${origW}x${origH}`);

  // DOM rectangles are CSS viewport coordinates. CDP screenshots can be in
  // device pixels, so scale them to the actual screenshot dimensions.
  const scaleX = viewportWidth > 0 ? origW / viewportWidth : 1;
  const scaleY = viewportHeight > 0 ? origH / viewportHeight : 1;
  const domRegions = domPrivacyRegions.map((region) => [
    Math.max(0, region.x * scaleX),
    Math.max(0, region.y * scaleY),
    Math.min(origW, (region.x + region.width) * scaleX),
    Math.min(origH, (region.y + region.height) * scaleY),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = origW;
  canvas.height = origH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  reportProgress(25, "Detecting faces...");
  const faceBoxes = await detectFaces(imageUrl, origW, origH);
  console.log(`Faces found: ${faceBoxes.length}`);

  reportProgress(45, "Loading OCR engine...");
  const piiRegions = await findPiiRegions(imageUrl, origW, origH);
  console.log(`PII regions found: ${piiRegions.length}`);

  reportProgress(85, "Applying redactions...");
  const pad = 2;
  const textBoxes = mergeBoxes([...piiRegions, ...domRegions], 6).map(
    ([x1, y1, x2, y2]) => [
      Math.max(0, x1 - pad),
      Math.max(0, y1 - pad),
      Math.min(origW, x2 + pad),
      Math.min(origH, y2 + pad),
    ]
  );

  ctx.fillStyle = "black";
  for (const [x1, y1, x2, y2] of [...faceBoxes, ...textBoxes]) {
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }

  reportProgress(92, "Encoding redacted image...");
  const redactedImageUrl = canvas.toDataURL("image/png");
  if (!redactedImageUrl) throw new Error("Canvas produced empty data URL");

  return {
    redactedImageUrl,
    targetName,
    faceCount: faceBoxes.length,
    piiCount: piiRegions.length + domRegions.length,
  };
}

// Register message listener immediately.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "processScreenshot") {
    console.log("Offscreen received processScreenshot request");
    currentJobChatId = request.chatId || null;
    redactImage(
      request.imageUrl,
      request.targetName,
      request.domPrivacyRegions || [],
      request.viewportWidth || 0,
      request.viewportHeight || 0
    )
      .then((result) => {
        console.log("Offscreen sending result", result);
        sendResponse(result);
      })
      .catch((err) => {
        console.error("Offscreen processing error:", err);
        sendResponse({ error: err.message || String(err) });
      });
    return true;
  }
});

// Signal that the offscreen document is loaded and listening. Heavy
// libraries get a bounded grace period; if they fail, signal anyway so the
// document is usable and individual features fail with clear errors.
(async function signalReady() {
  const start = Date.now();
  while ((typeof ort === "undefined" || typeof Tesseract === "undefined") && Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(
    `Offscreen ready (ort: ${typeof ort !== "undefined"}, tesseract: ${typeof Tesseract !== "undefined"})`
  );
  chrome.runtime.sendMessage({ action: "offscreenReady" }).catch(() => {});
})();
