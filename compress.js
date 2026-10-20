// compress.js — the size search, shared by worker.js (OffscreenCanvas) and app.js (main-thread fallback).
// Finds the highest quality that fits under the target; if quality 0.4 is still too big, shrinks the
// dimensions step by step, never below the minimum width. Re-encoding drops all metadata (EXIF, GPS).

const MAX_PIXELS = 16_000_000; // safe canvas size on mobile Safari
const HUGE_PIXELS = 40_000_000;
const Q_MIN = 0.05;
const Q_FLOOR = 0.4; // below this, shrink the image instead of crushing quality
const Q_MAX = 0.95;
const ITERATIONS = 7;

const hasOffscreen = (() => {
  try { return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { return false; }
})();

function makeCanvas(w, h) {
  if (hasOffscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function encode(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}

async function canEncode(type) {
  const blob = await encode(makeCanvas(1, 1), type, 0.8);
  return blob.type === type;
}

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const ascii = String.fromCharCode(...head.subarray(0, 4096));
  const isGif = ascii.startsWith('GIF8');
  const isWebp = ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  let animated = false;
  if (isGif) {
    // A second image descriptor or a NETSCAPE loop block means more than one frame.
    let text = '';
    for (let i = 0; i < head.length; i += 8192) text += String.fromCharCode(...head.subarray(i, i + 8192));
    animated = text.includes('NETSCAPE2.0') || (text.match(/\x00\x21\xF9\x04/g) || []).length > 1;
  }
  if (isWebp) animated = ascii.includes('ANIM');
  return { isGif, isWebp, animated };
}

export function outputType(format, inputType) {
  if (format === 'webp') return 'image/webp';
  if (format === 'original') {
    if (inputType === 'image/png' || inputType === 'image/webp') return inputType;
    return 'image/jpeg';
  }
  return 'image/jpeg';
}

/**
 * @param {Blob} file  original image
 * @param {object} s   { targetBytes, format, minWidth, maxWidth, maxHeight, background }
 * @param {(p:{value:number,label:string})=>void} onProgress
 */
export async function compressImage(file, s, onProgress = () => {}) {
  const notes = [];
  const info = await sniff(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be decoded. The file may be damaged or in a format this browser cannot read.');
  }
  if (info.animated) notes.push('Animated image: only the first frame was kept.');

  const srcW = bitmap.width, srcH = bitmap.height;
  let type = outputType(s.format, file.type);

  // Already small enough and no conversion asked for: hand back the original untouched.
  const sameType = type === file.type || (s.format === 'original' && !info.isGif);
  const noResizeLock = !(s.maxWidth && srcW > s.maxWidth) && !(s.maxHeight && srcH > s.maxHeight);
  if (file.size <= s.targetBytes && sameType && noResizeLock && srcW * srcH <= HUGE_PIXELS) {
    bitmap.close?.();
    return { blob: file, type: file.type, width: srcW, height: srcH, srcWidth: srcW, srcHeight: srcH, quality: null, original: true, reached: true, notes: ['Already under the target, so the original file is offered unchanged.'] };
  }

  // Starting size: honour the optional max width / height lock and the canvas safety limit.
  let scale = 1;
  if (s.maxWidth && srcW > s.maxWidth) scale = Math.min(scale, s.maxWidth / srcW);
  if (s.maxHeight && srcH > s.maxHeight) scale = Math.min(scale, s.maxHeight / srcH);
  if (srcW * srcH > HUGE_PIXELS && srcW * srcH * scale * scale > MAX_PIXELS) {
    scale = Math.sqrt(MAX_PIXELS / (srcW * srcH));
    notes.push(`Very large photo (${Math.round(srcW * srcH / 1e6)} MP) was first reduced to 16 MP so it fits in browser memory.`);
  }
  const minWidth = Math.max(1, Math.min(s.minWidth || 1, Math.round(srcW * scale)));

  if (type === 'image/webp' && !(await canEncode(type))) {
    notes.push('This browser cannot save WebP, so JPEG was used instead.');
    type = 'image/jpeg';
  }
  const isJpeg = type === 'image/jpeg';
  const render = (w, h) => {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    if (isJpeg) { g.fillStyle = s.background || '#ffffff'; g.fillRect(0, 0, w, h); }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, w, h);
    return c;
  };

  const lossy = type !== 'image/png';
  let smallest = null; // best effort if the target is out of reach
  let round = 0;
  for (;;) {
    round++;
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = render(w, h);
    const atMin = w <= minWidth;
    const label = `${w}×${h}`;
    const pct = (k) => Math.min(0.97, 0.05 + 0.12 * (round - 1) + k * 0.06);

    if (lossy) {
      onProgress({ value: pct(0), label: `Trying quality 95% at ${label}` });
      const top = await encode(canvas, type, Q_MAX);
      if (top.size <= s.targetBytes) return done(top, w, h, Q_MAX);

      const floor = atMin ? Q_MIN : Q_FLOOR;
      const low = await encode(canvas, type, floor);
      if (!smallest || low.size < smallest.blob.size) smallest = { blob: low, w, h, q: floor };
      if (low.size <= s.targetBytes) {
        let lo = floor, hi = Q_MAX, best = low, bestQ = floor;
        for (let i = 0; i < ITERATIONS; i++) {
          const q = (lo + hi) / 2;
          onProgress({ value: pct(1 + i), label: `Trying quality ${Math.round(q * 100)}% at ${label}` });
          const b = await encode(canvas, type, q);
          if (b.size <= s.targetBytes) { best = b; bestQ = q; lo = q; } else hi = q;
        }
        return done(best, w, h, bestQ);
      }
      if (atMin) return unreachable();
      scale = nextScale(scale, low.size, w);
    } else {
      onProgress({ value: pct(0), label: `Encoding PNG at ${label}` });
      const b = await encode(canvas, type);
      if (!smallest || b.size < smallest.blob.size) smallest = { blob: b, w, h, q: null };
      if (b.size <= s.targetBytes) return done(b, w, h, null);
      if (atMin) return unreachable();
      scale = nextScale(scale, b.size, w);
    }
  }

  function nextScale(cur, size, w) {
    // Small 10% steps near the target, bigger jumps when far away (size scales roughly with area).
    const est = Math.sqrt(s.targetBytes / size) * 1.05;
    const factor = Math.min(0.9, Math.max(0.5, est));
    const next = cur * factor;
    return Math.max(next, minWidth / srcW);
  }

  function done(blob, w, h, q) {
    bitmap.close?.();
    if (w < srcW) notes.push(`Dimensions reduced to ${w}×${h} to reach the target.`);
    return { blob, type, width: w, height: h, srcWidth: srcW, srcHeight: srcH, quality: q, original: false, reached: true, notes };
  }

  function unreachable() {
    bitmap.close?.();
    notes.push(`The target could not be reached even at the minimum width of ${minWidth} px. This is the smallest result.`);
    return { blob: smallest.blob, type, width: smallest.w, height: smallest.h, srcWidth: srcW, srcHeight: srcH, quality: smallest.q, original: false, reached: false, notes };
  }
}
