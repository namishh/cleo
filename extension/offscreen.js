const FACE_MODEL_URL = chrome.runtime.getURL("models/yunet_fact_detection_may_2026.onnx");
const FACE_INPUT_W = 640;
const FACE_INPUT_H = 480;
const FACE_SCORE_THRESH = 0.3;
const FACE_NMS_THRESH = 0.3;

const EMAIL_RE = /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\b\d{10,}\b/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

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
let tesseractWorker = null;

// Tell onnxruntime-web where to find the WASM binaries.
ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
// Use single-threaded WASM so onnxruntime loads .wasm directly instead of
// dynamically importing .mjs worker modules (which MV3 extension pages cannot
// load reliably).
ort.env.wasm.numThreads = 1;

function reportProgress(percent, message) {
  chrome.runtime
    .sendMessage({ action: "progress", percent, message })
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

async function getTesseractWorker() {
  if (!tesseractWorker) {
    reportProgress(45, "Loading OCR engine...");
    tesseractWorker = await Tesseract.createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
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

async function findPiiRegions(imageUrl, origW, origH) {
  const worker = await getTesseractWorker();
  reportProgress(55, "Reading text from screenshot...");
  const result = await worker.recognize(imageUrl);
  const words = result.data.words || [];

  reportProgress(75, "Finding sensitive information...");
  const regions = [];
  const groups = groupRowLabels(words);

  for (const group of groups) {
    const phraseText = group.map((w) => w.text.trim()).join(" ");
    const normalized = phraseText.toLowerCase().replace(/[:]+$/g, "");

    // Regex-based redaction on individual words.
    for (const w of group) {
      const text = w.text.trim();
      if (EMAIL_RE.test(text) || PHONE_RE.test(text) || DATE_RE.test(text)) {
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

async function redactImage(imageUrl, targetName) {
  reportProgress(20, "Loading screenshot...");
  const img = await loadImage(imageUrl);
  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  console.log(`Screenshot loaded: ${origW}x${origH}`);

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
  ctx.fillStyle = "black";
  for (const [x1, y1, x2, y2] of [...faceBoxes, ...piiRegions]) {
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }

  reportProgress(92, "Encoding redacted image...");
  const redactedImageUrl = canvas.toDataURL("image/png");
  if (!redactedImageUrl) throw new Error("Canvas produced empty data URL");

  return {
    redactedImageUrl,
    targetName,
    faceCount: faceBoxes.length,
    piiCount: piiRegions.length,
  };
}

// Register message listener immediately.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "processScreenshot") {
    console.log("Offscreen received processScreenshot request");
    redactImage(request.imageUrl, request.targetName)
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

// Signal that the offscreen document is loaded and listening.
(async function signalReady() {
  while (typeof ort === "undefined" || typeof Tesseract === "undefined") {
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log("Offscreen libraries loaded, sending ready signal");
  chrome.runtime.sendMessage({ action: "offscreenReady" }).catch(() => {});
})();
