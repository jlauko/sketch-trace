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
  // trace overlay
  opacity: 0.5,
  color: 0,
  tx: 0,
  ty: 0,
  tscale: 1,
  trot: 0,
  locked: false,
};

let tagging = false; // Prep: taps on the picture add/remove measuring marks
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
    Object.assign(state, { zoom: 1, cx: 0.5, cy: 0.5, landscape: c.width > c.height, points: [] });
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

// Sized from the canvas shape alone (not the render's pixel size), so the
// picture is exactly the same size on screen in every view and at every quality.
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
function fmt(inches) {
  if (state.unit === 'cm') return (inches * 2.54).toFixed(1);
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
  return {
    short: `${fromB ? '↑' : '↓'} ${v}   ${fromR ? '←' : '→'} ${h}`,
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

function renderPointList() {
  const list = $('#ptList');
  list.textContent = '';
  if (!result) return;
  for (const p of state.points) {
    const c = toCanvas(p, result.crop), li = document.createElement('li');
    li.textContent = onCanvas(c) ? measure(c, result.frame).long : 'outside the canvas';
    li.classList.toggle('off', !onCanvas(c));
    list.append(li);
  }
}

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
  drawGrid(vctx, W, H, result.frame);
  drawPoints(vctx, W, H, result);
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
  if (mask) {
    const hex = LINE_COLORS[state.color % LINE_COLORS.length];
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const img = octx.createImageData(W, H), d = img.data;
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = mask[i] * 255;
    }
    octx.putImageData(img, 0, 0);
  } else {
    octx.putImageData(new ImageData(result.rgba, W, H), 0, 0);
  }
  drawGrid(octx, W, H, result.frame);
  drawPoints(octx, W, H, result);
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
  $('#tag').classList.toggle('on', tagging);
  $('#tag').textContent = tagging ? 'Tagging: tap the picture' : 'Tag points';
  view.classList.toggle('tagging', tagging);

  const line = state.mode === 'edges' || state.mode === 'shapes';
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

$('#tag').addEventListener('click', () => { tagging = !tagging; syncControls(); });
$('#clearPts').addEventListener('click', () => { state.points = []; repaint(); });

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

// Index of the mark under the pointer, or -1.
function pointAt(e) {
  if (!result) return -1;
  const { x, y, r } = viewPos(e);
  let best = -1, reach = 22; // screen px
  state.points.forEach((p, i) => {
    const c = toCanvas(p, result.crop);
    const d = Math.hypot((c.x - x) * r.width, (c.y - y) * r.height);
    if (d < reach) { reach = d; best = i; }
  });
  return best;
}

let held = -1; // mark being dragged

// Prep: move/zoom the photo inside the canvas shape; tag and move marks.
gestures(view, {
  down(e) {
    held = tagging ? pointAt(e) : -1;
  },
  tap(e) {
    if (!tagging || !result) return;
    const i = pointAt(e);
    if (i >= 0) state.points.splice(i, 1);
    else {
      const { x, y } = viewPos(e);
      state.points.push(fromCanvas(x, y, result.crop));
    }
    repaint();
  },
  drag(dx, dy, e) {
    if (!result) return;
    if (held >= 0) {
      const { x, y } = viewPos(e);
      state.points[held] = fromCanvas(clamp(x, 0, 1), clamp(y, 0, 1), result.crop);
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
