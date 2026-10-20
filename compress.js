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
  // The canvas needs a context before it can be encoded (OffscreenCanvas throws otherwise).
  const c = makeCanvas(1, 1);
  c.getContext('2d').fillRect(0, 0, 1, 1);
  try {
    const blob = await encode(c, type, 0.8);
    return blob.type === type;
  } catch {
    return false;
  }
}

/* ---------- Lossless metadata removal for files that are already small enough ---------- */

// Reads the EXIF Orientation tag (1 when absent) from a JPEG APP1 segment body.
function exifOrientation(seg) {
  if (seg.length < 18 || String.fromCharCode(...seg.subarray(4, 10)) !== 'Exif\0\0') return 1;
  const t = seg.subarray(10);
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = t[0] === 0x49;
  if (dv.getUint16(2, le) !== 42) return 1;
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > t.length) return 1;
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le) || 1;
  }
  return 1;
}

// Drops APP1 (EXIF, XMP), APP13 (IPTC) and comment segments; keeps JFIF, ICC and the picture itself.
// Returns null when the file has an EXIF rotation, because stripping it would change how the photo shows.
function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts = [b.subarray(0, 2)];
  let p = 2, dropped = false;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (m === 0xda) { parts.push(b.subarray(p)); return { parts, dropped }; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) return null;
    const seg = b.subarray(p, p + 2 + len);
    if (m === 0xe1 && exifOrientation(seg) !== 1) return null;
    if (m === 0xe1 || m === 0xed || m === 0xfe) dropped = true;
    else parts.push(seg);
    p += 2 + len;
  }
  return null;
}

// Drops text, time and EXIF chunks from a PNG.
function stripPng(b) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || sig.some((v, i) => b[i] !== v)) return null;
  const parts = [b.subarray(0, 8)];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, dropped = false;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const end = p + 12 + len;
    if (end > b.length) return null;
    if (type === 'eXIf') return null; // may carry an orientation: re-encode instead
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'tIME') dropped = true;
    else parts.push(b.subarray(p, end));
    if (type === 'IEND') return { parts, dropped };
    p = end;
  }
  return null;
}

// WebP: metadata lives in EXIF / XMP chunks; if present, re-encode (the EXIF may rotate the picture).
function checkWebp(b) {
  if (b.length < 12 || String.fromCharCode(...b.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...b.subarray(8, 12)) !== 'WEBP') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  while (p + 8 <= b.length) {
    const fourcc = String.fromCharCode(...b.subarray(p, p + 4));
    if (fourcc === 'EXIF' || fourcc === 'XMP ') return null;
    const len = dv.getUint32(p + 4, true);
    p += 8 + len + (len & 1);
  }
  return { parts: [b], dropped: false };
}

/**
 * Removes metadata from an image file without touching its pixels. Returns { blob, dropped } or null
 * when that is not possible (unknown container, or EXIF data that rotates the image), in which case the
 * caller re-encodes through the canvas, which drops everything.
 */
async function stripMetadata(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  let r = null;
  if (b[0] === 0xff && b[1] === 0xd8) r = stripJpeg(b);
  else if (b[0] === 0x89 && b[1] === 0x50) r = stripPng(b);
  else if (b[0] === 0x52 && b[1] === 0x49) r = checkWebp(b);
  else if ((b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x42 && b[1] === 0x4d)) r = { parts: [b], dropped: false }; // GIF / BMP carry no EXIF
  if (!r) return null;
  return { blob: r.dropped ? new Blob(r.parts, { type: file.type }) : file, dropped: r.dropped };
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
  // Metadata (EXIF, GPS, comments) is still removed, losslessly, so the promise holds for every result.
  if (file.size <= s.targetBytes && sameType && noResizeLock && srcW * srcH <= HUGE_PIXELS) {
    const stripped = await stripMetadata(file);
    if (stripped) {
      bitmap.close?.();
      const note = stripped.dropped
        ? 'Already under the target: pixels kept exactly as they were, only the metadata (EXIF, GPS, comments) was removed.'
        : 'Already under the target and carrying no metadata, so the original file is offered unchanged.';
      return { blob: stripped.blob, type: file.type, width: srcW, height: srcH, srcWidth: srcW, srcHeight: srcH, quality: null, original: true, reached: true, notes: [note] };
    }
    notes.push('Already under the target, but re-encoded once so the EXIF rotation is applied and the metadata (including GPS) is removed.');
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
