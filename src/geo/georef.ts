/**
 * Georeferencing: turns control points (image pixel ↔ lng/lat) into a fitted
 * transform plus per-point residuals.
 */
import { lngLatToMerc, mercScale, mercToLngLat, type LngLat } from './mercator';
import {
  applyTransform,
  fitTransform,
  invertTransform,
  transformInfo,
  type FittedTransform,
  type Pt,
  type TransformKind,
} from './transforms';

export interface ControlPoint {
  id: string;
  /** Pixel coordinates in the original image (x → right, y → down). */
  img: Pt;
  /** Geographic position. */
  lngLat: LngLat;
  enabled: boolean;
}

export interface Georef {
  kind: TransformKind;
  /** image plane → Web Mercator metres */
  forward: FittedTransform;
  /** Web Mercator metres → image plane */
  inverse: FittedTransform;
  /** residual in ground metres per control point id (only enabled points) */
  residuals: Record<string, { dx: number; dy: number; error: number }>;
  /** Root-mean-square error in ground metres. */
  rmse: number;
  /** Whether residuals are meaningful (false when there are no redundant points). */
  redundant: boolean;
}

/** image pixel → image plane (y up). */
export const pixelToPlane = (p: Pt): Pt => ({ x: p.x, y: -p.y });
export const planeToPixel = (p: Pt): Pt => ({ x: p.x, y: -p.y });

/** Number of free parameters per coordinate (for redundancy check). */
function paramsPerAxis(kind: TransformKind, n: number): number {
  switch (kind) {
    case 'helmert':
      return 2;
    case 'affine':
      return 3;
    case 'projective':
      return 4;
    case 'poly2':
      return 6;
    case 'poly3':
      return 10;
    case 'tps':
      return n; // interpolates exactly
  }
}

export function computeGeoref(kind: TransformKind, points: ControlPoint[]): Georef | null {
  const active = points.filter((p) => p.enabled);
  if (active.length < transformInfo(kind).minPoints) return null;
  const src = active.map((p) => pixelToPlane(p.img));
  const dst = active.map((p) => lngLatToMerc(p.lngLat));
  const forward = fitTransform(kind, src, dst);
  const inverse = invertTransform(forward, src, dst);

  const residuals: Georef['residuals'] = {};
  let sum = 0;
  active.forEach((p, i) => {
    const pred = applyTransform(forward, src[i]);
    const k = mercScale(p.lngLat[1]);
    const dx = (pred.x - dst[i].x) * k;
    const dy = (pred.y - dst[i].y) * k;
    const error = Math.hypot(dx, dy);
    residuals[p.id] = { dx, dy, error };
    sum += error * error;
  });

  return {
    kind,
    forward,
    inverse,
    residuals,
    rmse: Math.sqrt(sum / active.length),
    redundant: active.length > paramsPerAxis(kind, active.length),
  };
}

/** Image pixel → lng/lat using a fitted georeference. */
export function pixelToLngLat(g: Georef, p: Pt): LngLat {
  return mercToLngLat(applyTransform(g.forward, pixelToPlane(p)));
}

/** lng/lat → image pixel using a fitted georeference. */
export function lngLatToPixel(g: Georef, ll: LngLat): Pt {
  return planeToPixel(applyTransform(g.inverse, lngLatToMerc(ll)));
}
