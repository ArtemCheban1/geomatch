/**
 * Image warping: resamples the source image into an axis-aligned Web Mercator
 * raster, which MapLibre can then display as an image source exactly.
 * Pure functions, safe to run inside a Web Worker.
 */
import { applyTransform, type FittedTransform, type Pt } from './transforms';

export interface WarpBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WarpRequest {
  forward: FittedTransform;
  inverse: FittedTransform;
  /** Size of the original image in pixels (control points are in this space). */
  imageWidth: number;
  imageHeight: number;
  /** Maximum width/height of the output raster. */
  maxOutputSize: number;
}

export interface WarpResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Mercator bounds of the output raster. */
  bounds: WarpBounds;
}

export interface SourcePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** source pixels per original image pixel (≤ 1 when downscaled) */
  scale: number;
}

const toPlane = (x: number, y: number): Pt => ({ x, y: -y });

/** Image outline transformed to Mercator. */
export function warpedOutline(forward: FittedTransform, w: number, h: number, samplesPerEdge = 32): Pt[] {
  const pts: Pt[] = [];
  const n = samplesPerEdge;
  for (let i = 0; i < n; i++) pts.push(applyTransform(forward, toPlane((w * i) / n, 0)));
  for (let i = 0; i < n; i++) pts.push(applyTransform(forward, toPlane(w, (h * i) / n)));
  for (let i = 0; i < n; i++) pts.push(applyTransform(forward, toPlane(w - (w * i) / n, h)));
  for (let i = 0; i < n; i++) pts.push(applyTransform(forward, toPlane(0, h - (h * i) / n)));
  return pts;
}

function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function warpImage(src: SourcePixels, req: WarpRequest): WarpResult {
  const { forward, inverse, imageWidth: W, imageHeight: H } = req;
  const outline = warpedOutline(forward, W, H);
  const bounds: WarpBounds = {
    minX: Math.min(...outline.map((p) => p.x)),
    minY: Math.min(...outline.map((p) => p.y)),
    maxX: Math.max(...outline.map((p) => p.x)),
    maxY: Math.max(...outline.map((p) => p.y)),
  };
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  if (!(bw > 0 && bh > 0) || !Number.isFinite(bw) || !Number.isFinite(bh)) {
    throw new Error('Перетворення дає некоректний результат — перевірте контрольні точки.');
  }

  // Match source resolution, capped by maxOutputSize.
  const mercPerSrcPixel = Math.sqrt(polygonArea(outline) / (src.width * src.height));
  let outW = Math.ceil(bw / mercPerSrcPixel);
  let outH = Math.ceil(bh / mercPerSrcPixel);
  const k = Math.min(1, req.maxOutputSize / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * k));
  outH = Math.max(1, Math.round(outH * k));
  const px = bw / outW;
  const py = bh / outH;

  // Evaluate the inverse transform on a coarse grid and interpolate between
  // nodes — keeps TPS/polynomial warps fast with negligible error.
  const step = 8;
  const gw = Math.ceil(outW / step) + 1;
  const gh = Math.ceil(outH / step) + 1;
  const gridX = new Float64Array(gw * gh);
  const gridY = new Float64Array(gw * gh);
  for (let gj = 0; gj < gh; gj++) {
    for (let gi = 0; gi < gw; gi++) {
      const mx = bounds.minX + (gi * step + 0.5) * px;
      const my = bounds.maxY - (gj * step + 0.5) * py;
      const p = applyTransform(inverse, { x: mx, y: my });
      // image plane → source pixel space
      gridX[gj * gw + gi] = p.x * src.scale;
      gridY[gj * gw + gi] = -p.y * src.scale;
    }
  }

  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  for (let j = 0; j < outH; j++) {
    const gj = Math.floor(j / step);
    const fy = (j - gj * step) / step;
    for (let i = 0; i < outW; i++) {
      const gi = Math.floor(i / step);
      const fx = (i - gi * step) / step;
      const i00 = gj * gw + gi;
      const i10 = i00 + 1;
      const i01 = i00 + gw;
      const i11 = i01 + 1;
      const sx =
        (gridX[i00] * (1 - fx) + gridX[i10] * fx) * (1 - fy) + (gridX[i01] * (1 - fx) + gridX[i11] * fx) * fy - 0.5;
      const sy =
        (gridY[i00] * (1 - fx) + gridY[i10] * fx) * (1 - fy) + (gridY[i01] * (1 - fx) + gridY[i11] * fx) * fy - 0.5;
      if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5) continue;

      // bilinear sample with edge clamping
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const ax = sx - x0;
      const ay = sy - y0;
      const xa = Math.max(0, Math.min(sw - 1, x0));
      const xb = Math.max(0, Math.min(sw - 1, x0 + 1));
      const ya = Math.max(0, Math.min(sh - 1, y0));
      const yb = Math.max(0, Math.min(sh - 1, y0 + 1));
      const a = (ya * sw + xa) * 4;
      const b = (ya * sw + xb) * 4;
      const c = (yb * sw + xa) * 4;
      const d = (yb * sw + xb) * 4;
      const o = (j * outW + i) * 4;
      for (let ch = 0; ch < 4; ch++) {
        out[o + ch] = (sd[a + ch] * (1 - ax) + sd[b + ch] * ax) * (1 - ay) + (sd[c + ch] * (1 - ax) + sd[d + ch] * ax) * ay;
      }
    }
  }

  return { width: outW, height: outH, data: out, bounds };
}
