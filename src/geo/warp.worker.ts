/// <reference lib="webworker" />
import { warpImage, type SourcePixels, type WarpRequest } from './warp';

/**
 * Messages:
 *   { type: 'source', key, bitmap, maxSourceSize, clip } — cache decoded image pixels (once per layer)
 *   { type: 'clip', key, clip }                          — change the clip polygon (image pixels or null)
 *   { type: 'warp', id, key, req }                       — warp with a fitted transform
 *   { type: 'drop', key }                                — forget a cached source
 */
interface CachedSource {
  original: SourcePixels;
  clipped: SourcePixels;
}
const sources = new Map<string, CachedSource>();

type P = { x: number; y: number };

function decode(bitmap: ImageBitmap, maxSize: number): SourcePixels {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const sourceWidth = bitmap.width;
  bitmap.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data, scale: w / sourceWidth };
}

/** Make everything outside the clip polygon transparent. */
function applyClip(src: SourcePixels, clip: P[] | null): SourcePixels {
  if (!clip || clip.length < 3) return src;
  const canvas = new OffscreenCanvas(src.width, src.height);
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  clip.forEach((p, i) => {
    const x = p.x * src.scale;
    const y = p.y * src.scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  const mask = ctx.getImageData(0, 0, src.width, src.height).data;
  const data = new Uint8ClampedArray(src.data);
  for (let i = 3; i < data.length; i += 4) data[i] = (data[i] * mask[i]) / 255;
  return { ...src, data };
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'source') {
    const original = decode(msg.bitmap, msg.maxSourceSize);
    sources.set(msg.key, { original, clipped: applyClip(original, msg.clip) });
  } else if (msg.type === 'clip') {
    const s = sources.get(msg.key);
    if (s) s.clipped = applyClip(s.original, msg.clip);
  } else if (msg.type === 'drop') {
    sources.delete(msg.key);
  } else if (msg.type === 'warp') {
    const src = sources.get(msg.key);
    if (!src) {
      self.postMessage({ id: msg.id, error: 'source not loaded' });
      return;
    }
    try {
      const res = warpImage(src.clipped, msg.req as WarpRequest);
      self.postMessage({ id: msg.id, result: res }, [res.data.buffer]);
    } catch (err) {
      self.postMessage({ id: msg.id, error: (err as Error).message });
    }
  }
};
