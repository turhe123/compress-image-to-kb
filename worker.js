// worker.js — runs the size search off the main thread (module worker, needs OffscreenCanvas).
import { compressImage } from './compress.js';

self.addEventListener('message', async (e) => {
  const { id, file, settings } = e.data;
  try {
    const result = await compressImage(file, settings, (p) => self.postMessage({ id, type: 'progress', ...p }));
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
});
