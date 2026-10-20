// app.js — Compress Image to Exact KB. Everything runs on this device; nothing is uploaded.
// UI and file handling live here; the size search is in compress.js, run inside worker.js when possible.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import { compressImage } from './compress.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const compressBtn = $('compress-btn');
const statusBox = $('status');
const statusText = $('status-text');
const progressBar = $('progress-bar');
const progressEl = statusBox.querySelector('.progress');
const batchBar = $('batch-bar');
const emptyState = $('empty-state');
const customSize = $('custom-size');
const customUnit = $('custom-unit');
const customRadio = $('target-custom-radio');

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
const SUPPORTED = new Set(Object.values(EXT_TYPES));
const OUT_EXT = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/png': '.png' };

/** @type {{id:number, file:File, type:string, card:HTMLElement, beforeUrl:string, afterUrl?:string, result?:object, name?:string}[]} */
let items = [];
let nextId = 1;
let runToken = 0;

/* ---------- Settings ---------- */

function trimNum(n) { return String(Math.round(n * 1000) / 1000); }

function readSettings() {
  const checked = document.querySelector('input[name="target"]:checked');
  let targetBytes, targetLabel;
  if (!checked || checked.value === 'custom') {
    const n = parseFloat(customSize.value);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a custom target size above zero, for example 75 KB.');
    const unit = customUnit.value;
    targetBytes = Math.round(n * (unit === 'mb' ? 1_000_000 : 1000));
    if (targetBytes < 1000) throw new Error('The smallest target is 1 KB.');
    targetLabel = `${trimNum(n)}${unit}`;
  } else {
    targetBytes = Number(checked.value);
    targetLabel = checked.dataset.label;
  }
  const num = (id) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) && v > 0 ? v : 0; };
  return {
    targetBytes,
    targetLabel,
    format: $('format').value,
    minWidth: num('min-width') || 1,
    maxWidth: num('max-width'),
    maxHeight: num('max-height'),
    background: $('background').value || '#ffffff',
  };
}

customSize.addEventListener('input', () => { if (customSize.value) customRadio.checked = true; });
customUnit.addEventListener('change', () => { customRadio.checked = true; });

/* ---------- Worker (with main-thread fallback) ---------- */

let worker = null;
let workerBroken = typeof Worker === 'undefined' || !(() => {
  try { return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { return false; }
})();
const pending = new Map();

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker('./worker.js', { type: 'module' });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.addEventListener('message', (e) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    if (e.data.type === 'progress') job.onProgress(e.data);
    else {
      pending.delete(e.data.id);
      if (e.data.type === 'done') job.resolve(e.data.result);
      else job.reject(new Error(e.data.message));
    }
  });
  worker.addEventListener('error', (e) => {
    // Module workers unsupported or the script failed to load: finish everything on the main thread.
    e.preventDefault();
    workerBroken = true;
    worker.terminate();
    worker = null;
    for (const job of pending.values()) job.fallback();
    pending.clear();
  });
  return worker;
}

function runJob(file, settings, onProgress) {
  const mainThread = () => compressImage(file, settings, onProgress);
  const w = getWorker();
  if (!w) return mainThread();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { onProgress, resolve, reject, fallback: () => mainThread().then(resolve, reject) });
    w.postMessage({ id, file, settings });
  });
}

/* ---------- Files in ---------- */

function extOf(name) { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
function baseOf(name) { return name.replace(/\.[^.]+$/, '') || 'image'; }

function showError(message, where = results) {
  const el = document.createElement('div');
  el.className = 'alert alert--error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  where.prepend(el);
  return el;
}

function clearAlerts() { results.querySelectorAll(':scope > .alert').forEach((a) => a.remove()); }

function validate(file) {
  const ext = extOf(file.name);
  const type = SUPPORTED.has(file.type) ? file.type : EXT_TYPES[ext];
  if (ext === 'heic' || ext === 'heif' || /hei[cf]/.test(file.type)) {
    return { error: `${file.name}: HEIC photos cannot be read by most browsers. Export it as JPEG first (on iPhone, Settings › Camera › Formats › Most Compatible), then add it here.` };
  }
  if (!type) return { error: `${file.name} is not a supported image. Unsupported file type: please use JPG, PNG or WebP.` };
  if (file.size === 0) return { error: `${file.name} is empty (0 bytes), so there is nothing to compress.` };
  return { type };
}

async function addFiles(files) {
  clearAlerts();
  const added = [];
  for (const file of files) {
    const v = validate(file);
    if (v.error) { showError(v.error); continue; }
    const item = { id: nextId++, file, type: v.type, beforeUrl: URL.createObjectURL(file) };
    item.card = buildCard(item);
    results.appendChild(item.card);
    items.push(item);
    added.push(item);
  }
  refreshChrome();
  if (added.length) await runAll(added);
}

wireDropzone(zone, input, (files) => addFiles(files));

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-image${i ? `-${i + 1}` : ''}.${extOf(f.name) || 'png'}`, { type: f.type })));
  addFiles(named);
});

/* ---------- Cards ---------- */

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'result kb-card';
  card.dataset.state = 'pending';
  card.innerHTML = `
    <header class="kb-card__head">
      <h3 class="kb-card__name"></h3>
      <span class="chip kb-card__saved" hidden></span>
    </header>
    <div class="kb-compare">
      <figure class="kb-fig">
        <div class="preview kb-fig__img"><img class="kb-before" alt=""></div>
        <figcaption>Before <span class="stat kb-before-size"></span></figcaption>
      </figure>
      <figure class="kb-fig">
        <div class="preview kb-fig__img"><span class="spinner" aria-hidden="true"></span><img class="kb-after" alt="" hidden></div>
        <figcaption>After <span class="stat kb-after-size">working…</span></figcaption>
      </figure>
    </div>
    <dl class="kb-stats" hidden>
      <div><dt>Original size</dt><dd class="stat" data-k="orig"></dd></div>
      <div><dt>New size</dt><dd class="stat" data-k="new"></dd></div>
      <div><dt>Saved</dt><dd class="stat" data-k="saved"></dd></div>
      <div><dt>Quality</dt><dd class="stat" data-k="quality"></dd></div>
      <div><dt>Dimensions</dt><dd class="stat" data-k="dims"></dd></div>
    </dl>
    <ul class="kb-notes" hidden></ul>
    <div class="kb-card__actions" hidden><button class="btn btn--primary kb-dl" type="button"></button></div>`;
  card.querySelector('.kb-card__name').textContent = item.file.name;
  const before = card.querySelector('.kb-before');
  before.src = item.beforeUrl;
  before.alt = `Before: ${item.file.name}`;
  card.querySelector('.kb-before-size').textContent = `· ${formatBytes(item.file.size)}`;
  card.querySelector('.kb-dl').addEventListener('click', () => {
    if (item.result) downloadBlob(item.result.blob, item.name);
  });
  return card;
}

function setPending(item) {
  const c = item.card;
  c.dataset.state = 'pending';
  c.querySelector('.spinner').hidden = false;
  c.querySelector('.kb-after').hidden = true;
  c.querySelector('.kb-after-size').textContent = 'waiting…';
  c.querySelector('.kb-stats').hidden = true;
  c.querySelector('.kb-notes').hidden = true;
  c.querySelector('.kb-card__actions').hidden = true;
  c.querySelector('.kb-card__saved').hidden = true;
  c.querySelector(':scope > .alert')?.remove();
  if (item.afterUrl) { URL.revokeObjectURL(item.afterUrl); item.afterUrl = null; }
  item.result = null;
}

function downloadName(item, result, settings) {
  const ext = result.original ? `.${extOf(item.file.name) || 'jpg'}` : OUT_EXT[result.type] || '.jpg';
  return `${baseOf(item.file.name)}-${settings.targetLabel}${ext}`;
}

function showResult(item, result, settings) {
  const c = item.card;
  item.result = result;
  item.name = downloadName(item, result, settings);
  item.afterUrl = URL.createObjectURL(result.blob);
  c.dataset.state = result.reached ? 'done' : 'unreached';
  c.dataset.size = String(result.blob.size);

  const after = c.querySelector('.kb-after');
  after.src = item.afterUrl;
  after.alt = `After: ${item.name}`;
  after.hidden = false;
  c.querySelector('.spinner').hidden = true;
  c.querySelector('.kb-after-size').textContent = `· ${formatBytes(result.blob.size)}`;

  const orig = item.file.size;
  const savedPct = Math.max(0, Math.round((1 - result.blob.size / orig) * 100));
  const set = (k, v) => { c.querySelector(`[data-k="${k}"]`).textContent = v; };
  set('orig', `${formatBytes(orig)} (${orig.toLocaleString()} bytes)`);
  set('new', `${formatBytes(result.blob.size)} (${result.blob.size.toLocaleString()} bytes)`);
  set('saved', `${savedPct}%`);
  set('quality', result.original ? 'Unchanged original' : result.quality == null ? 'Lossless PNG' : `${Math.round(result.quality * 100)}%`);
  set('dims', result.width === result.srcWidth && result.height === result.srcHeight
    ? `${result.width} × ${result.height} px`
    : `${result.srcWidth} × ${result.srcHeight} → ${result.width} × ${result.height} px`);
  c.querySelector('.kb-stats').hidden = false;

  const savedChip = c.querySelector('.kb-card__saved');
  savedChip.textContent = result.reached ? `−${savedPct}%` : 'Target not reached';
  savedChip.classList.toggle('kb-chip--warn', !result.reached);
  savedChip.hidden = false;

  const notes = c.querySelector('.kb-notes');
  notes.replaceChildren(...result.notes.map((n) => { const li = document.createElement('li'); li.textContent = n; return li; }));
  notes.classList.toggle('kb-notes--warn', !result.reached);
  notes.hidden = !result.notes.length;

  const btn = c.querySelector('.kb-dl');
  btn.textContent = `Download ${item.name}`;
  btn.setAttribute('aria-label', `Download ${item.name}`);
  c.querySelector('.kb-card__actions').hidden = false;
}

function showCardError(item, message) {
  const c = item.card;
  c.dataset.state = 'error';
  c.querySelector('.spinner').hidden = true;
  c.querySelector('.kb-after-size').textContent = '· failed';
  c.appendChild(showError(`${item.file.name}: ${message}`, c));
}

/* ---------- Running ---------- */

function setProgress(fraction, text) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  progressBar.style.width = `${pct}%`;
  progressEl.setAttribute('aria-valuenow', String(pct));
  if (text) statusText.textContent = text;
}

async function runAll(list = items) {
  clearAlerts();
  let settings;
  try { settings = readSettings(); } catch (err) { showError(err.message); return; }
  const token = ++runToken;
  list.forEach(setPending);
  statusBox.hidden = false;
  compressBtn.disabled = true;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    if (token !== runToken) return;
    const item = list[i];
    const head = list.length > 1 ? `File ${i + 1} of ${list.length}: ${item.file.name}` : item.file.name;
    setProgress(i / list.length, `${head} · starting`);
    item.card.querySelector('.kb-after-size').textContent = 'working…';
    try {
      const file = item.file.type === item.type ? item.file : new File([item.file], item.file.name, { type: item.type });
      const result = await runJob(file, settings, (p) => {
        if (token === runToken) setProgress((i + p.value) / list.length, `${head} · ${p.label}`);
      });
      if (token !== runToken) return;
      showResult(item, result, settings);
      ok++;
    } catch (err) {
      if (token !== runToken) return;
      showCardError(item, err?.message || 'Something went wrong while compressing this image.');
    }
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe between files
  }
  setProgress(1, `Done: ${ok} of ${list.length} compressed to ${settings.targetLabel.toUpperCase()}.`);
  statusBox.hidden = true;
  refreshChrome();
  if (ok) toast(`${ok} image${ok > 1 ? 's' : ''} ready. Nothing was uploaded.`);
}

function refreshChrome() {
  compressBtn.disabled = items.length === 0;
  compressBtn.textContent = items.some((i) => i.result) ? 'Compress again' : 'Compress';
  emptyState.hidden = items.length > 0;
  batchBar.hidden = items.length === 0;
  $('download-all').hidden = items.filter((i) => i.result).length < 2;
}

compressBtn.addEventListener('click', () => runAll());

$('download-all').addEventListener('click', async () => {
  for (const item of items.filter((i) => i.result)) {
    downloadBlob(item.result.blob, item.name);
    await new Promise((r) => setTimeout(r, 400)); // browsers drop rapid-fire downloads
  }
});

$('clear-btn').addEventListener('click', () => {
  runToken++;
  for (const item of items) {
    URL.revokeObjectURL(item.beforeUrl);
    if (item.afterUrl) URL.revokeObjectURL(item.afterUrl);
  }
  items = [];
  results.replaceChildren();
  statusBox.hidden = true;
  refreshChrome();
  zone.focus();
});

/* ---------- Sample & demo ---------- */

// The "Try a sample photo" link draws a fictional 3000×2000 landscape on a canvas right here, so no file
// is ever requested from anywhere. (The identical bundled fixture is used by __demo and the tests.)
async function makeSamplePhoto() {
  const W = 3000, H = 2000;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 42;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sky = g.createLinearGradient(0, 0, 0, H * 0.6);
  sky.addColorStop(0, '#1d3b72'); sky.addColorStop(0.55, '#e98a5c'); sky.addColorStop(1, '#f7d39a');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.6);
  const sun = g.createRadialGradient(2100, 1080, 10, 2100, 1080, 420);
  sun.addColorStop(0, 'rgba(255,240,200,1)'); sun.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = sun; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(255,${200 + r() * 55 | 0},${180 + r() * 60 | 0},${0.08 + r() * 0.15})`;
    g.beginPath(); g.ellipse(r() * W, r() * H * 0.45, 120 + r() * 300, 20 + r() * 50, 0, 0, Math.PI * 2); g.fill();
  }
  const sea = g.createLinearGradient(0, H * 0.6, 0, H);
  sea.addColorStop(0, '#2f6c8f'); sea.addColorStop(1, '#0d2a40');
  g.fillStyle = sea; g.fillRect(0, H * 0.6, W, H * 0.4);
  for (let i = 0; i < 2500; i++) {
    const y = H * 0.6 + r() * H * 0.4;
    g.strokeStyle = `rgba(255,${210 + r() * 40 | 0},${170 + r() * 60 | 0},${0.05 + r() * 0.25})`;
    g.lineWidth = 1 + r() * 3;
    const x = r() * W; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + r() * 80, y); g.stroke();
  }
  g.fillStyle = '#3b3328';
  g.beginPath(); g.moveTo(0, H * 0.62);
  for (let x = 0; x <= 1300; x += 20) g.lineTo(x, H * 0.5 + Math.sin(x / 140) * 30 + r() * 18 + (x > 900 ? (x - 900) * 0.35 : 0));
  g.lineTo(1300, H * 0.66); g.lineTo(0, H * 0.7); g.closePath(); g.fill();
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${60 + r() * 60 | 0},${90 + r() * 70 | 0},${40 + r() * 30 | 0},0.6)`;
    g.fillRect(r() * 1200, H * 0.5 + r() * H * 0.18, 2 + r() * 4, 2 + r() * 8);
  }
  const lx = 620, base = H * 0.52;
  g.fillStyle = '#f4f1ea';
  g.beginPath(); g.moveTo(lx - 70, base); g.lineTo(lx - 42, base - 560); g.lineTo(lx + 42, base - 560); g.lineTo(lx + 70, base); g.closePath(); g.fill();
  g.fillStyle = '#c0392b';
  for (let k = 0; k < 3; k++) g.fillRect(lx - 66 + k * 8, base - 120 - k * 170, 132 - k * 16, 60);
  g.fillStyle = '#222'; g.fillRect(lx - 60, base - 600, 120, 40);
  g.fillStyle = '#ffe9a8'; g.fillRect(lx - 40, base - 680, 80, 80);
  g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(lx - 60, base - 680); g.lineTo(lx, base - 740); g.lineTo(lx + 60, base - 680); g.fill();
  const beam = g.createLinearGradient(lx, 0, lx + 1400, 0);
  beam.addColorStop(0, 'rgba(255,240,180,0.45)'); beam.addColorStop(1, 'rgba(255,240,180,0)');
  g.fillStyle = beam; g.beginPath(); g.moveTo(lx, base - 640); g.lineTo(lx + 1400, base - 820); g.lineTo(lx + 1400, base - 520); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold 72px sans-serif';
  g.fillText('HARBOR POINT', 1900, 1900);
  const img = g.getImageData(0, 0, W, H); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 34; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('The sample photo could not be created.'))), 'image/jpeg', 0.94));
  return new File([blob], 'harbor-point.jpg', { type: 'image/jpeg' });
}

$('sample-btn').addEventListener('click', async () => {
  const btn = $('sample-btn');
  btn.disabled = true;
  try { await addFiles([await makeSamplePhoto()]); } catch (err) { showError(err.message); } finally { btn.disabled = false; }
});

// Called by the factory's screenshot script to show the tool with a finished, fictional result.
// This is the only place a file is requested, and it is one of the page's own bundled fixtures.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/harbor-point.jpg');
  const blob = await res.blob();
  await addFiles([new File([blob], 'harbor-point.jpg', { type: 'image/jpeg' })]);
};

refreshChrome();

export { addFiles, runAll };
