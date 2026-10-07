'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FULL_L = 1400;     // long side of the finished render, px
const PREVIEW_L = 520;   // long side while a slider or finger is moving
const SOURCE_MAX = 2800; // photos are downscaled to this on load

// [short side, long side, true when those numbers are real inches]
const RATIOS = {
  '5x7': [5, 7, true],
  '5.5x8.5': [5.5, 8.5, true],
  '8x10': [8, 10, true],
  '9x12': [9, 12, true],
  '11x14': [11, 14, true],
  '12x16': [12, 16, true],
  '16x20': [16, 20, true],
  '18x24': [18, 24, true],
  '24x36': [24, 36, true],
  square: [1, 1, false],
  a: [1, Math.SQRT2, false],
};

const LINE_COLORS = ['#ff2d55', '#00e5ff', '#ffffff', '#000000', '#ffd60a'];

const state = {
  mode: 'values',
  tones: 4,
  simplify: 35,
  edge: 55,
  weight: 2,
  dark: true,
  ratio: 'photo',
  customW: 8,
  customH: 10,
  landscape: false,
  zoom: 1,
  cx: 0.5,
  cy: 0.5,
  flip: false,
  grid: '0',
  // measuring
  unit: 'in',     // 'in' | 'cm' — also the unit customW/customH/freeW are typed in
  corner: 'tl',   // which corner distances are measured from
  freeW: 10,      // canvas width for shapes with no built-in size (photo, square, A-series)
  points: [],     // tagged spots, as fractions of the source photo: { u, v }
  lines: [],      // measured distances, each between two such spots: { a, b }
  face: null,     // detected face landmarks, same coordinates: { chin: { u, v }, ... }
  faceOver: false, // Face view: draw the guides over the photo instead of a blank canvas
  // trace overlay
  opacity: 0.5,
  color: 0,
  tx: 0,
  ty: 0,
  tscale: 1,
  trot: 0,
  locked: false,
};

let tool = '';       // Prep: what a tap on the picture does — '' | 'tag' | 'dist'
let pending = null;  // Distance tool: the first end, while waiting for the second
let faceTried = false, faceBusy = false, faceNote = ''; // Face view: detection status
let src = null;     // canvas holding the (downscaled) source photo
let result = null;  // last output of process()
let tab = 'prep';

const view = $('#view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const overlay = $('#overlay');
const octx = overlay.getContext('2d');

// ───────────────────────── persistence ─────────────────────────

function saveState() {
  try { localStorage.setItem('sketchtrace', JSON.stringify(state)); } catch {}
}

function loadState() {
  try { Object.assign(state, JSON.parse(localStorage.getItem('sketchtrace') || '{}')); } catch {}
}

// The photo itself goes in IndexedDB so it's still there offline (e.g. on a plane).
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sketchtrace', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// ───────────────────────── loading a photo ─────────────────────────

function decode(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
    img.src = url;
  });
}

async function loadImage(blob, fresh) {
  let img;
  try { img = await decode(blob); } catch (e) { alert(e.message); return; }
  const k = Math.min(1, SOURCE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  src = c;
  if (fresh) {
    Object.assign(state, { zoom: 1, cx: 0.5, cy: 0.5, landscape: c.width > c.height, points: [], lines: [], face: null });
    pending = null;
    faceTried = false;
    faceNote = '';
    idbSet('image', blob).catch(() => {});
  }
  $('#prepEmpty').textContent = '';
  syncControls();
  render(FULL_L);
}

// ───────────────────────── geometry ─────────────────────────

// The canvas being painted on: aspect ratio and real size in inches.
function frame() {
  const toIn = state.unit === 'cm' ? 1 / 2.54 : 1;
  const sized = (a, wIn) => ({ a, wIn, hIn: wIn / a });
  if (state.ratio === 'photo') return sized(src.width / src.height, (+state.freeW || 1) * toIn);
  let s, l, inches = true;
  if (state.ratio === 'custom') {
    const a = (+state.customW || 1) * toIn, b = (+state.customH || 1) * toIn;
    s = Math.min(a, b);
    l = Math.max(a, b);
  } else {
    [s, l, inches] = RATIOS[state.ratio];
  }
  const w = state.landscape ? l : s, h = state.landscape ? s : l;
  return inches ? { a: w / h, wIn: w, hIn: h } : sized(w / h, (+state.freeW || 1) * toIn);
}

// Which rectangle of the source photo fills that shape (also clamps the pan).
function cropRect(a) {
  const z = clamp(state.zoom, 1, 8);
  let sw, sh;
  if (src.width / src.height > a) { sh = src.height / z; sw = sh * a; }
  else { sw = src.width / z; sh = sw / a; }
  const cx = clamp(state.cx * src.width, sw / 2, src.width - sw / 2);
  const cy = clamp(state.cy * src.height, sh / 2, src.height - sh / 2);
  state.cx = cx / src.width;
  state.cy = cy / src.height;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

// ───────────────────────── image processing ─────────────────────────

function blurH(s, d, W, H, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += s[o + clamp(i, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      d[o + x] = sum / win;
      const a = x - r, b = x + r + 1;
      sum += s[o + (b < W ? b : W - 1)] - s[o + (a > 0 ? a : 0)];
    }
  }
}

function blurV(s, d, W, H, r) {
  const win = 2 * r + 1;
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += s[clamp(i, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      d[y * W + x] = sum / win;
      const a = y - r, b = y + r + 1;
      sum += s[(b < H ? b : H - 1) * W + x] - s[(a > 0 ? a : 0) * W + x];
    }
  }
}

// Three box passes ≈ a Gaussian. (ctx.filter would be simpler but isn't
// reliable on iOS Safari.)
function boxBlur(a, W, H, r) {
  if (r < 1) return;
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < 3; p++) { blurH(a, tmp, W, H, r); blurV(tmp, a, W, H, r); }
}

// Stretch 0..255 grey to 0..1 between its 1st and 99th percentiles.
function normalize(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i] | 0]++;
  const cut = g.length * 0.01;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < cut) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < cut) hi--;
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < g.length; i++) g[i] = clamp((g[i] - lo) / span, 0, 1);
}

// Sobel gradient, thinned to one-pixel ridges, soft-thresholded to 0..1.
function edgeMask(v, W, H, L) {
  const n = W * H;
  const mag = new Float32Array(n);
  const dir = new Uint8Array(n);
  const gain = L / 1000; // keeps the threshold meaning the same at preview and full size
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -v[i - W - 1] - 2 * v[i - 1] - v[i + W - 1] + v[i - W + 1] + 2 * v[i + 1] + v[i + W + 1];
      const gy = -v[i - W - 1] - 2 * v[i - W] - v[i - W + 1] + v[i + W - 1] + 2 * v[i + W] + v[i + W + 1];
      mag[i] = Math.hypot(gx, gy) * gain;
      const ax = Math.abs(gx), ay = Math.abs(gy);
      // 0: horizontal gradient, 1: vertical, 2: "\" diagonal, 3: "/" diagonal
      dir[i] = ax > 2.414 * ay ? 0 : ay > 2.414 * ax ? 1 : (gx * gy > 0 ? 2 : 3);
    }
  }
  const t = 0.5 * (1 - state.edge / 100) ** 2 + 0.015;
  const step = [1, W, W + 1, W - 1];
  const mask = new Float32Array(n);
  for (let i = W; i < n - W; i++) {
    const m = mag[i];
    if (m <= t) continue;
    const s = step[dir[i]];
    if (m >= mag[i - s] && m >= mag[i + s]) mask[i] = clamp((m - t) / (t * 0.5), 0, 1);
  }
  return mask;
}

// Outlines of the flat tone regions — the shadow and highlight shapes.
function shapeMask(v, W, H) {
  const n = W * H, tones = state.tones;
  const q = new Uint8Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(tones - 1, (v[i] * tones) | 0);
  const mask = new Float32Array(n);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (q[i] !== q[i + 1] || q[i] !== q[i + W]) mask[i] = 1;
    }
  }
  return mask;
}

function dilate(m, W, H, R) {
  if (R < 1) return m;
  const tmp = new Float32Array(m.length), out = new Float32Array(m.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = 0;
      for (let k = Math.max(0, x - R), e = Math.min(W - 1, x + R); k <= e; k++) {
        const val = m[y * W + k];
        if (val > best) best = val;
      }
      tmp[y * W + x] = best;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H - 1, y + R);
    for (let x = 0; x < W; x++) {
      let best = 0;
      for (let k = y0; k <= y1; k++) {
        const val = tmp[k * W + x];
        if (val > best) best = val;
      }
      out[y * W + x] = best;
    }
  }
  return out;
}

// Crop the source to the canvas shape at long side L and apply the current
// mode. Returns opaque RGBA, plus a 0..1 line mask for the two line modes.
function process(L) {
  const f = frame(), a = f.a;
  const W = a >= 1 ? L : Math.max(1, Math.round(L * a));
  const H = a >= 1 ? Math.max(1, Math.round(L / a)) : L;
  const c = cropRect(a);

  work.width = W;
  work.height = H;
  wctx.save();
  if (state.flip) { wctx.translate(W, 0); wctx.scale(-1, 1); }
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, 0, 0, W, H);
  wctx.restore();

  const d = wctx.getImageData(0, 0, W, H).data, n = W * H;
  const res = { W, H, rgba: d, mask: null, frame: f, crop: c };
  const mode = state.mode;
  if (mode === 'photo') return res;
  if (mode === 'landmarks') {
    // Guides are drawn afterwards as vector lines; this is just their backdrop.
    res.guides = true;
    if (!state.faceOver) {
      const bg = state.dark ? 0 : 255;
      for (let j = 0; j < d.length; j += 4) d[j] = d[j + 1] = d[j + 2] = bg;
    }
    return res;
  }

  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

  let r = Math.round(state.simplify / 100 * 0.018 * L);
  if (mode === 'edges') r = Math.max(r, Math.round(L / 700));
  if (mode !== 'gray') boxBlur(g, W, H, r);
  normalize(g);

  if (mode === 'gray' || mode === 'values') {
    const tones = state.tones;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const val = mode === 'gray'
        ? g[i] * 255
        : Math.min(tones - 1, (g[i] * tones) | 0) / (tones - 1) * 255;
      d[j] = d[j + 1] = d[j + 2] = val;
    }
    return res;
  }

  let mask = mode === 'edges' ? edgeMask(g, W, H, L) : shapeMask(g, W, H);
  mask = dilate(mask, W, H, Math.round((state.weight - 1) * 0.75 * L / FULL_L));
  const bg = state.dark ? 0 : 255, fg = 255 - bg;
  for (let i = 0, j = 0; i < n; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = bg + (fg - bg) * mask[i];
  res.mask = mask;
  return res;
}

// ───────────────────────── drawing the results ─────────────────────────

function drawGrid(ctx, W, H, f) {
  const g = state.grid;
  if (g === '0') return;
  let stepX, stepY;
  if (g[0] === 'd') {
    const n = +g.slice(1);
    stepX = W / n;
    stepY = H / n;
  } else {
    const inch = +g.slice(1);
    stepX = W / f.wIn * inch;
    stepY = H / f.hIn * inch;
  }
  const path = new Path2D();
  for (let x = stepX; x < W - 0.5; x += stepX) { path.moveTo(x, 0); path.lineTo(x, H); }
  for (let y = stepY; y < H - 0.5; y += stepY) { path.moveTo(0, y); path.lineTo(W, y); }
  const lw = Math.max(1, W / 700);
  ctx.lineWidth = lw * 3;
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.stroke(path);
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#00d8ff';
  ctx.stroke(path);
}

// ── tagged points ──
// Points are stored against the photo, so they stay on the same feature when
// the crop, zoom or canvas size changes. These convert to and from a position
// within the canvas (0..1 across, 0..1 down).
function toCanvas(p, c) {
  const x = (p.u * src.width - c.sx) / c.sw, y = (p.v * src.height - c.sy) / c.sh;
  return { x: state.flip ? 1 - x : x, y };
}

function fromCanvas(x, y, c) {
  if (state.flip) x = 1 - x;
  return { u: (c.sx + x * c.sw) / src.width, v: (c.sy + y * c.sh) / src.height };
}

// Inches as a tape-measure fraction (nearest 1/16); centimetres to one decimal.
function fmt(inches, unit = state.unit) {
  if (inches < 0) return `-${fmt(-inches, unit)}`; // off the measuring edge
  if (unit === 'cm') return (inches * 2.54).toFixed(1);
  const n = Math.round(inches * 16), whole = Math.floor(n / 16);
  let num = n % 16, den = 16;
  if (!num) return `${whole}`;
  while (num % 2 === 0) { num /= 2; den /= 2; }
  return `${whole ? `${whole} ` : ''}${num}/${den}`;
}

function measure(c, f) {
  const fromB = state.corner[0] === 'b', fromR = state.corner[1] === 'r';
  const v = fmt((fromB ? 1 - c.y : c.y) * f.hIn), h = fmt((fromR ? 1 - c.x : c.x) * f.wIn);
  const unit = state.unit;
  const vTxt = `${fromB ? '↑' : '↓'} ${v}`, hTxt = `${fromR ? '←' : '→'} ${h}`;
  return {
    vTxt,
    hTxt,
    short: `${vTxt}   ${hTxt}`,
    long: `${v} ${unit} from ${fromB ? 'bottom' : 'top'}, ${h} ${unit} from ${fromR ? 'right' : 'left'}`,
  };
}

const onCanvas = (c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1;

function drawPoints(ctx, W, H, res) {
  if (!state.points.length) return;
  const u = Math.max(W, H) / 100; // everything scales with the picture
  ctx.font = `600 ${2.6 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  state.points.forEach((p, i) => {
    const c = toCanvas(p, res.crop);
    if (!onCanvas(c)) return;
    const x = c.x * W, y = c.y * H;
    for (const [color, width] of [['rgba(0,0,0,.75)', 0.9 * u], ['#ffd60a', 0.35 * u]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(x, y, 1.2 * u, 0, 2 * Math.PI);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(x + dx * 1.2 * u, y + dy * 1.2 * u);
        ctx.lineTo(x + dx * 2.4 * u, y + dy * 2.4 * u);
      }
      ctx.stroke();
    }
    const text = `${i + 1}:  ${measure(c, res.frame).short}`;
    const pad = 0.8 * u, bw = ctx.measureText(text).width + 2 * pad, bh = 3.8 * u;
    let bx = x + 3 * u, by = y - bh - u;
    if (bx + bw > W) bx = x - 3 * u - bw;
    if (by < 0) by = y + u;
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(text, bx + pad, by + bh / 2);
  });
}

// ── measured distances ──
// Real length of a line on the canvas, in inches.
function lineLength(l, res) {
  const a = toCanvas(l.a, res.crop), b = toCanvas(l.b, res.crop);
  return Math.hypot((b.x - a.x) * res.frame.wIn, (b.y - a.y) * res.frame.hIn);
}

const lineName = (i) => String.fromCharCode(65 + (i % 26));

function drawLines(ctx, W, H, res) {
  if (!state.lines.length && !pending) return;
  const u = Math.max(W, H) / 100, green = '#30d158';
  const px = (p) => { const c = toCanvas(p, res.crop); return { x: c.x * W, y: c.y * H }; };
  const stroke = (path) => {
    for (const [color, width] of [['rgba(0,0,0,.75)', 0.9 * u], [green, 0.35 * u]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke(path);
    }
  };
  const dot = (path, p) => { path.moveTo(p.x + 0.9 * u, p.y); path.arc(p.x, p.y, 0.9 * u, 0, 2 * Math.PI); };
  ctx.font = `600 ${2.6 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'round';
  state.lines.forEach((l, i) => {
    const a = px(l.a), b = px(l.b), path = new Path2D();
    path.moveTo(a.x, a.y);
    path.lineTo(b.x, b.y);
    dot(path, a);
    dot(path, b);
    stroke(path);
    const text = `${lineName(i)}:  ${fmt(lineLength(l, res))} ${state.unit}`;
    const pad = 0.8 * u, bw = ctx.measureText(text).width + 2 * pad, bh = 3.8 * u;
    const bx = clamp((a.x + b.x) / 2 - bw / 2, 0, W - bw), by = clamp((a.y + b.y) / 2 - bh - u, 0, H - bh);
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = green;
    ctx.fillText(text, bx + pad, by + bh / 2);
  });
  if (pending) {
    const path = new Path2D();
    dot(path, px(pending));
    stroke(path);
  }
}

// ── face landmarks ──
// MediaPipe face-mesh indices for the few points the guides need. "A" is the
// side of the face on the left of the photo.
const FACE_IDX = {
  chin: 152, sideA: 234, sideB: 454,
  irisA: 468, irisB: 473,
  eyeAo: 33, eyeAi: 133, eyeBi: 362, eyeBo: 263,
  browA: 105, browB: 334,
  noseBase: 2, noseA: 129, noseB: 358,
  mouthA: 61, mouthB: 291, lips: 13,
};
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let landmarker = null;

async function findFace() {
  if (faceBusy || !src) return;
  faceBusy = faceTried = true;
  faceNote = 'Finding the face… the first time, this downloads the face finder (about 14 MB).';
  syncControls();
  try {
    if (!landmarker) {
      const vision = await import(`${MP}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
      landmarker = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
    }
    // Look in what is on the canvas first (the face fills more of it), then
    // in the whole photo.
    let found = null;
    for (const r of [cropRect(frame().a), { sx: 0, sy: 0, sw: src.width, sh: src.height }]) {
      const k = Math.min(1, 1024 / Math.max(r.sw, r.sh));
      const t = document.createElement('canvas');
      t.width = Math.round(r.sw * k);
      t.height = Math.round(r.sh * k);
      t.getContext('2d').drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, t.width, t.height);
      const lm = landmarker.detect(t).faceLandmarks[0];
      if (!lm) continue;
      found = {};
      for (const [name, i] of Object.entries(FACE_IDX)) {
        found[name] = { u: (r.sx + lm[i].x * r.sw) / src.width, v: (r.sy + lm[i].y * r.sh) / src.height };
      }
      break;
    }
    state.face = found;
    faceNote = found ? '' : 'No face found. It works best on a clear, mostly front-on face: zoom in on it and try again.';
  } catch (e) {
    console.error(e);
    faceNote = navigator.onLine
      ? 'The face finder could not be loaded. Try again in a moment.'
      : 'The face finder needs a connection the first time it is used.';
  }
  faceBusy = false;
  syncControls();
  if (result) repaint();
}

// Construction lines for a portrait: the levels of the brows, eyes, nose,
// mouth and chin, the centre line, the width of the head, and where the eye
// corners, nose wings and mouth corners fall — all following the head's tilt.
function drawFace(ctx, W, H, res, color, halo) {
  const f = state.face;
  if (!f) return;
  const P = {};
  for (const k in f) {
    const c = toCanvas(f[k], res.crop);
    P[k] = { x: c.x * W, y: c.y * H };
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const eyes = mid(P.irisA, P.irisB);

  // Unit vectors across the face (along the eye line) and down it.
  let ex = P.irisB.x - P.irisA.x, ey = P.irisB.y - P.irisA.y;
  const len = Math.hypot(ex, ey) || 1;
  ex /= len;
  ey /= len;
  if (ex < 0) { ex = -ex; ey = -ey; }
  let ax = -ey, ay = ex;
  if ((P.chin.x - eyes.x) * ax + (P.chin.y - eyes.y) * ay < 0) { ax = -ax; ay = -ay; }
  const across = (p) => (p.x - eyes.x) * ex + (p.y - eyes.y) * ey;
  const down = (p) => (p.x - eyes.x) * ax + (p.y - eyes.y) * ay;
  const at = (s, t) => ({ x: eyes.x + ex * s + ax * t, y: eyes.y + ey * s + ay * t });

  const lo = Math.min(across(P.sideA), across(P.sideB)), hi = Math.max(across(P.sideA), across(P.sideB));
  const pad = (hi - lo) * 0.08, chin = down(P.chin);
  // The face finder can't see the top of the skull, so that one line is the
  // textbook estimate (eyes halfway down the head), drawn dashed.
  const levels = [
    ['Brows', down(mid(P.browA, P.browB))],
    ['Eyes', 0],
    ['Nose', down(P.noseBase)],
    ['Mouth', down(P.lips)],
    ['Chin', chin],
  ];

  const u = Math.max(W, H) / 100;
  const solid = new Path2D(), dashed = new Path2D();
  const seg = (path, a, b) => { path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); };
  for (const [, t] of levels) seg(solid, at(lo - pad, t), at(hi + pad, t));
  seg(dashed, at(lo - pad, -chin), at(hi + pad, -chin));
  seg(solid, at(0, -chin), at(0, chin));   // centre line
  seg(solid, at(lo, -chin), at(lo, chin)); // sides of the head
  seg(solid, at(hi, -chin), at(hi, chin));
  const tick = (p, t) => { const s = across(p); seg(solid, at(s, t - 1.3 * u), at(s, t + 1.3 * u)); };
  for (const k of ['eyeAo', 'eyeAi', 'eyeBi', 'eyeBo']) tick(P[k], 0);
  for (const k of ['noseA', 'noseB']) tick(P[k], levels[2][1]);
  for (const k of ['mouthA', 'mouthB']) tick(P[k], levels[3][1]);
  for (const k of ['irisA', 'irisB']) { solid.moveTo(P[k].x + 0.8 * u, P[k].y); solid.arc(P[k].x, P[k].y, 0.8 * u, 0, 2 * Math.PI); }

  ctx.lineCap = 'round';
  for (const [stroke, width] of halo ? [['rgba(0,0,0,.6)', 0.8 * u], [color, 0.3 * u]] : [[color, 0.3 * u]]) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.stroke(solid);
    ctx.setLineDash([1.5 * u, 1.5 * u]);
    ctx.stroke(dashed);
  }
  ctx.setLineDash([]);

  // Labels: each level's distance from the top (or bottom) edge at the right
  // of the head; the sides' and centre line's distance from the side edge below.
  ctx.font = `600 ${2.3 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const m = (p) => measure({ x: p.x / W, y: p.y / H }, res.frame);
  const label = (text, x, y, alignX) => {
    const pad2 = 0.6 * u, bw = ctx.measureText(text).width + 2 * pad2, bh = 3.2 * u;
    const bx = clamp(x - bw * alignX, 0, W - bw), by = clamp(y - bh / 2, 0, H - bh);
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(text, bx + pad2, by + bh / 2);
  };
  for (const [name, t] of [['Top (est.)', -chin], ...levels]) {
    const end = at(hi + pad, t);
    label(`${name} ${m(at(0, t)).vTxt}`, end.x + u, end.y, 0);
  }
  for (const [s, alignX] of [[lo, 1], [0, 0.5], [hi, 0]]) {
    const p = at(s, chin);
    label(m(p).hTxt, p.x, p.y + 2.6 * u, alignX);
  }
}

function renderPointList() {
  const list = $('#ptList');
  list.textContent = '';
  if (!result) return;
  // One row of text with a remove button that takes entry i out of `from`.
  const row = (text, from, i) => {
    const li = document.createElement('li'), x = document.createElement('button');
    x.textContent = '×';
    x.className = 'remove';
    x.setAttribute('aria-label', 'Remove');
    x.addEventListener('click', () => { from.splice(i, 1); repaint(); });
    li.append(text, x);
    return li;
  };
  state.points.forEach((p, i) => {
    const c = toCanvas(p, result.crop);
    const li = row(onCanvas(c) ? measure(c, result.frame).long : 'outside the canvas', state.points, i);
    li.classList.toggle('off', !onCanvas(c));
    list.append(li);
  });
  // Distances are given in both units, whichever one the picture is labelled in.
  const lines = $('#lineList');
  lines.textContent = '';
  state.lines.forEach((l, i) => {
    const d = lineLength(l, result);
    lines.append(row(`${lineName(i)}: ${fmt(d, 'in')} in  (${fmt(d, 'cm')} cm)`, state.lines, i));
  });
  $('#clearRow').hidden = !state.points.length && !state.lines.length && !pending;
}

// Sized from the canvas shape alone (not the render's pixel size), so the
// picture is exactly the same size on screen in every view and at every quality.
function fitInto(el, a, boxW, boxH) {
  const w = Math.min(boxW, boxH * a);
  el.style.width = `${w}px`;
  el.style.height = `${w / a}px`;
}

function paintView() {
  if (!result) return;
  const { W, H } = result;
  view.width = W;
  view.height = H;
  vctx.putImageData(new ImageData(result.rgba, W, H), 0, 0);
  if (result.guides) {
    drawFace(vctx, W, H, result, state.faceOver ? '#00e5ff' : state.dark ? '#fff' : '#000', state.faceOver);
  }
  drawGrid(vctx, W, H, result.frame);
  drawPoints(vctx, W, H, result);
  drawLines(vctx, W, H, result);
  const stage = $('#prepStage');
  fitInto(view, result.frame.a, stage.clientWidth, stage.clientHeight);
}

// In Trace the line modes become coloured strokes on a clear background, so
// the paper stays fully visible; the tonal modes are blended by opacity.
function paintOverlay() {
  if (!result) return;
  const { W, H, mask } = result;
  overlay.width = W;
  overlay.height = H;
  const hex = LINE_COLORS[state.color % LINE_COLORS.length];
  if (mask) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const img = octx.createImageData(W, H), d = img.data;
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = mask[i] * 255;
    }
    octx.putImageData(img, 0, 0);
  } else if (!result.guides || state.faceOver) {
    octx.putImageData(new ImageData(result.rgba, W, H), 0, 0);
  }
  if (result.guides) drawFace(octx, W, H, result, hex, state.faceOver);
  drawGrid(octx, W, H, result.frame);
  drawPoints(octx, W, H, result);
  drawLines(octx, W, H, result);
  const stage = $('#traceStage');
  fitInto(overlay, result.frame.a, stage.clientWidth * 0.85, stage.clientHeight * 0.7);
  placeOverlay();
}

function placeOverlay() {
  overlay.style.transform =
    `translate(-50%,-50%) translate(${state.tx}px,${state.ty}px) rotate(${state.trot}rad) scale(${state.tscale})`;
  overlay.style.opacity = state.opacity;
}

function render(L) {
  if (!src) return;
  result = process(L);
  repaint();
  if (state.mode === 'landmarks' && !state.face && !faceTried) findFace();
}

// Redraw from the last processed image (enough when only the marks changed).
function repaint() {
  if (tab === 'prep') paintView(); else paintOverlay();
  renderPointList();
  saveState();
}

// Cheap render right away, full-quality one once things stop moving.
let raf = 0, settle = 0;
function schedule() {
  if (!src) return;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(PREVIEW_L); });
  clearTimeout(settle);
  settle = setTimeout(() => render(FULL_L), 220);
}

// ───────────────────────── controls ─────────────────────────

function syncControls() {
  for (const el of $$('[data-key]')) {
    const v = state[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  for (const out of $$('[data-out]')) {
    const v = state[out.dataset.out];
    out.textContent = out.dataset.out === 'zoom' ? `${(+v).toFixed(1)}×` : v;
  }
  for (const b of $$('#modes button')) b.classList.toggle('on', b.dataset.mode === state.mode);
  for (const el of $$('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(state.mode);

  $('#customRow').hidden = state.ratio !== 'custom';
  $('#landscapeRow').hidden = state.ratio === 'photo' || state.ratio === 'square';
  // Shapes with no built-in size need a width before anything can be measured.
  $('#freeRow').hidden = state.ratio === 'custom' || !!(RATIOS[state.ratio] && RATIOS[state.ratio][2]);
  for (const el of $$('i.unit')) el.textContent = state.unit;
  $('#tag').classList.toggle('on', tool === 'tag');
  $('#dist').classList.toggle('on', tool === 'dist');
  view.classList.toggle('tagging', !!tool);
  const toolMsg = tool === 'tag' ? 'Tap the picture to mark a point.'
    : tool === 'dist' ? (pending ? 'Now tap the second point.' : 'Tap the first point to measure from.')
    : '';
  $('#toolMsg').textContent = toolMsg;
  $('#toolMsg').hidden = !toolMsg;

  const line = ['edges', 'shapes', 'landmarks'].includes(state.mode);
  $('#faceMsg').textContent = faceNote;
  $('#faceMsg').hidden = state.mode !== 'landmarks' || !faceNote;
  $('#refind').disabled = faceBusy;
  $('#color').hidden = !line;
  $('#swatch').style.background = LINE_COLORS[state.color % LINE_COLORS.length];
  $('#opacity').value = state.opacity;
  $('#lock').classList.toggle('on', state.locked);
  $('#lock').textContent = state.locked ? 'Locked' : 'Lock';
}

for (const el of $$('[data-key]')) {
  const discrete = el.tagName === 'SELECT' || el.type === 'checkbox';
  el.addEventListener(discrete ? 'change' : 'input', () => {
    const numeric = el.type === 'range' || el.type === 'number';
    if (el.dataset.key === 'unit' && el.value !== state.unit) {
      // Typed sizes keep their real length when the unit changes.
      const k = el.value === 'cm' ? 2.54 : 1 / 2.54;
      for (const f of ['customW', 'customH', 'freeW']) state[f] = +(state[f] * k).toFixed(2);
    }
    state[el.dataset.key] = el.type === 'checkbox' ? el.checked : numeric ? +el.value : el.value;
    syncControls();
    schedule();
  });
}

for (const b of $$('#modes button')) {
  b.addEventListener('click', () => { state.mode = b.dataset.mode; syncControls(); schedule(); });
}

$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadImage(f, true);
  e.target.value = '';
});

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) loadImage(f, true);
});
addEventListener('paste', (e) => {
  const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
  if (f) loadImage(f, true);
});

$('#save').addEventListener('click', () => {
  if (!src) return;
  clearTimeout(settle);
  result = process(FULL_L);
  paintView();
  view.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sketch-${state.mode}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

for (const name of ['tag', 'dist']) {
  $(`#${name}`).addEventListener('click', () => {
    tool = tool === name ? '' : name;
    pending = null;
    syncControls();
    if (result) repaint();
  });
}
$('#clearPts').addEventListener('click', () => {
  state.points = [];
  state.lines = [];
  pending = null;
  syncControls();
  repaint();
});
$('#refind').addEventListener('click', () => { state.face = null; findFace(); });

const prepStage = $('#prepStage');
if (!prepStage.requestFullscreen) $('#full').hidden = true;
$('#full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else prepStage.requestFullscreen();
});

addEventListener('resize', repaint);

// ───────────────────────── gestures ─────────────────────────

// One finger drags; two fingers pinch, twist and carry. A press that barely
// moves is a tap.
function gestures(el, { down, drag, pinch, tap }) {
  const pts = new Map();
  let travel = 0, multi = false;
  const measure = () => {
    const [a, b] = [...pts.values()];
    return {
      d: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  };
  el.addEventListener('pointerdown', (e) => {
    try { el.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 0) { travel = 0; multi = false; } else multi = true;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1 && down) down(e);
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      travel += Math.hypot(dx, dy);
      p.x = e.clientX;
      p.y = e.clientY;
      if (travel > 6) drag(dx, dy, e);
    } else if (pts.size === 2) {
      const before = measure();
      p.x = e.clientX;
      p.y = e.clientY;
      const after = measure();
      pinch({ k: after.d / before.d, da: after.ang - before.ang, from: before, to: after });
    }
  });
  el.addEventListener('pointerup', (e) => {
    if (pts.delete(e.pointerId) && pts.size === 0 && !multi && travel <= 6 && tap) tap(e);
  });
  el.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
}

// Where a pointer event falls within the picture, 0..1 each way.
function viewPos(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
}

// The mark under the pointer that the active tool can act on: a tagged point
// ({ i }) or one end of a measured line ({ i, end }). Null if none.
function markAt(e) {
  if (!result) return null;
  const { x, y, r } = viewPos(e);
  let best = null, reach = 22; // screen px
  const test = (p, ref) => {
    const c = toCanvas(p, result.crop);
    const d = Math.hypot((c.x - x) * r.width, (c.y - y) * r.height);
    if (d < reach) { reach = d; best = ref; }
  };
  if (tool === 'tag') state.points.forEach((p, i) => test(p, { i }));
  if (tool === 'dist') state.lines.forEach((l, i) => { test(l.a, { i, end: 'a' }); test(l.b, { i, end: 'b' }); });
  return best;
}

let held = null; // mark being dragged

// Prep: move/zoom the photo inside the canvas shape; tag and move marks.
gestures(view, {
  down(e) {
    held = tool ? markAt(e) : null;
  },
  tap(e) {
    if (!tool || !result) return;
    const hit = markAt(e), { x, y } = viewPos(e), here = fromCanvas(x, y, result.crop);
    if (tool === 'tag') {
      if (hit) state.points.splice(hit.i, 1); else state.points.push(here);
    } else {
      // Tapping an existing line's end starts (or finishes) exactly there, so
      // several distances can be taken from the same spot.
      const p = hit ? { ...state.lines[hit.i][hit.end] } : here;
      if (pending) {
        state.lines.push({ a: pending, b: p });
        pending = null;
      } else {
        pending = p;
      }
    }
    syncControls();
    repaint();
  },
  drag(dx, dy, e) {
    if (!result) return;
    if (held) {
      const { x, y } = viewPos(e), p = fromCanvas(clamp(x, 0, 1), clamp(y, 0, 1), result.crop);
      if (held.end) state.lines[held.i][held.end] = p; else state.points[held.i] = p;
      repaint();
      return;
    }
    const { crop } = result, w = view.clientWidth, h = view.clientHeight;
    state.cx -= (state.flip ? -1 : 1) * dx / w * crop.sw / src.width;
    state.cy -= dy / h * crop.sh / src.height;
    schedule();
  },
  pinch({ k }) {
    state.zoom = clamp(state.zoom * k, 1, 8);
    syncControls();
    schedule();
  },
});

view.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 1, 8);
  syncControls();
  schedule();
}, { passive: false });

// Trace: move/scale/rotate the overlay over the camera picture.
const traceStage = $('#traceStage');
gestures(traceStage, {
  drag(dx, dy) {
    if (state.locked) return;
    state.tx += dx;
    state.ty += dy;
    placeOverlay();
    saveState();
  },
  pinch({ k, da, from, to }) {
    if (state.locked) return;
    // Keep the point under the fingers fixed: rotate/scale the overlay's
    // centre about the old midpoint, then carry it to the new one.
    const r = traceStage.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const vx = ox + state.tx - from.mx, vy = oy + state.ty - from.my;
    const cos = Math.cos(da) * k, sin = Math.sin(da) * k;
    state.tx = to.mx + vx * cos - vy * sin - ox;
    state.ty = to.my + vx * sin + vy * cos - oy;
    state.tscale = clamp(state.tscale * k, 0.1, 12);
    state.trot += da;
    placeOverlay();
    saveState();
  },
});

// ───────────────────────── trace: camera ─────────────────────────

const cam = $('#cam');
let stream = null, track = null, torchOn = false, wakeLock = null;

async function startCam() {
  const msg = $('#traceMsg');
  msg.textContent = src ? '' : 'Open a photo first — the Prep tab is where you choose how it looks.';
  if (stream) return;
  if (!navigator.mediaDevices || !isSecureContext) {
    if (src) msg.textContent = 'The camera only works over https (or on localhost).';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch {
    if (src) msg.textContent = 'No camera available — check that this page is allowed to use it.';
    return;
  }
  if (tab !== 'trace') { stopCam(); return; } // tab changed while the permission prompt was up
  cam.srcObject = stream;
  cam.play().catch(() => {});
  track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $('#torch').hidden = !caps.torch;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function stopCam() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = track = null;
  torchOn = false;
  cam.srcObject = null;
  $('#torch').classList.remove('on');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCam();
  else if (tab === 'trace') startCam();
});

$('#torch').addEventListener('click', async () => {
  if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
  $('#torch').classList.toggle('on', torchOn);
});

$('#opacity').addEventListener('input', (e) => {
  state.opacity = +e.target.value;
  placeOverlay();
  saveState();
});

$('#color').addEventListener('click', () => {
  state.color = (state.color + 1) % LINE_COLORS.length;
  syncControls();
  paintOverlay();
  saveState();
});

$('#lock').addEventListener('click', () => {
  state.locked = !state.locked;
  syncControls();
  saveState();
});

$('#reset').addEventListener('click', () => {
  Object.assign(state, { tx: 0, ty: 0, tscale: 1, trot: 0, locked: false });
  syncControls();
  placeOverlay();
  saveState();
});

// ───────────────────────── tabs & startup ─────────────────────────

function setTab(name) {
  tab = name;
  document.body.dataset.tab = name;
  for (const b of $$('[data-tab-btn]')) b.classList.toggle('on', b.dataset.tabBtn === name);
  if (name === 'trace') startCam(); else stopCam();
  clearTimeout(settle);
  render(FULL_L);
}

for (const b of $$('[data-tab-btn]')) b.addEventListener('click', () => setTab(b.dataset.tabBtn));

loadState();
syncControls();
placeOverlay();
idbGet('image').then((blob) => { if (blob) loadImage(blob, false); }).catch(() => {});

// Offline support. Skipped on localhost so edits show up without fighting a cache.
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
