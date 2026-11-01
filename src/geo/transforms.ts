/**
 * 2D transforms used for georeferencing.
 *
 * All transforms are fitted between two planar coordinate systems:
 *   source = "image plane": (pixelX, -pixelY)   (y flipped so that it points up, like map y)
 *   target = Web Mercator metres (EPSG:3857)
 *
 * Fitted transforms are plain JSON-serialisable objects so they can be sent
 * to a Web Worker and stored in a project file.
 */
import { invert3, leastSquares, solveSquare } from './linalg';

export type Pt = { x: number; y: number };

export type TransformKind = 'helmert' | 'affine' | 'projective' | 'poly2' | 'poly3' | 'tps';

export interface TransformInfo {
  kind: TransformKind;
  label: string;
  minPoints: number;
  description: string;
}

export const TRANSFORMS: TransformInfo[] = [
  {
    kind: 'helmert',
    label: 'Helmert (подібність)',
    minPoints: 2,
    description: 'Зсув + поворот + єдиний масштаб. Карта не деформується.',
  },
  {
    kind: 'affine',
    label: 'Афінне (поліном 1)',
    minPoints: 3,
    description: 'Зсув, поворот, різний масштаб по осях, скіс. Стандарт для більшості карт.',
  },
  {
    kind: 'projective',
    label: 'Проєктивне',
    minPoints: 4,
    description: 'Перспектива. Добре для фото карти, знятого під кутом.',
  },
  {
    kind: 'poly2',
    label: 'Поліном 2-го порядку',
    minPoints: 6,
    description: 'Плавне викривлення. Для старих карт з іншою проєкцією.',
  },
  {
    kind: 'poly3',
    label: 'Поліном 3-го порядку',
    minPoints: 10,
    description: 'Сильніше викривлення. Потребує багато рівномірно розкиданих точок.',
  },
  {
    kind: 'tps',
    label: 'Thin Plate Spline (гумовий лист)',
    minPoints: 3,
    description: 'Точно проходить через кожну точку, локально «розтягує» карту. Для сильно деформованих карт.',
  },
];

export function transformInfo(kind: TransformKind): TransformInfo {
  const info = TRANSFORMS.find((t) => t.kind === kind);
  if (!info) throw new Error(`Unknown transform ${kind}`);
  return info;
}

/** Normalisation p' = (p - c) / s, used to keep the fitting well conditioned. */
export interface Norm {
  cx: number;
  cy: number;
  s: number;
}

export interface FittedTransform {
  kind: TransformKind;
  srcNorm: Norm;
  dstNorm: Norm;
  /** Kind-specific coefficients (in normalised space). */
  coef: number[];
  /** TPS only: normalised control points [x0, y0, x1, y1, ...]. */
  ctrl?: number[];
}

function computeNorm(pts: Pt[]): Norm {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  return { cx, cy, s: d > 0 ? d : 1 };
}

const norm = (n: Norm, p: Pt): Pt => ({ x: (p.x - n.cx) / n.s, y: (p.y - n.cy) / n.s });
const denorm = (n: Norm, p: Pt): Pt => ({ x: p.x * n.s + n.cx, y: p.y * n.s + n.cy });

function polyTerms(order: 2 | 3, x: number, y: number): number[] {
  if (order === 2) return [1, x, y, x * x, x * y, y * y];
  return [1, x, y, x * x, x * y, y * y, x * x * x, x * x * y, x * y * y, y * y * y];
}

/** TPS radial basis U(r) = r² · ln(r²)  (the constant factor is irrelevant). */
function tpsU(r2: number): number {
  return r2 === 0 ? 0 : r2 * Math.log(r2);
}

/** Fit a transform mapping `src[i]` → `dst[i]`. */
export function fitTransform(kind: TransformKind, src: Pt[], dst: Pt[]): FittedTransform {
  if (src.length !== dst.length) throw new Error('src/dst length mismatch');
  const min = transformInfo(kind).minPoints;
  if (src.length < min) {
    throw new Error(`Для перетворення «${transformInfo(kind).label}» потрібно щонайменше ${min} точок.`);
  }
  const srcNorm = computeNorm(src);
  const dstNorm = computeNorm(dst);
  const s = src.map((p) => norm(srcNorm, p));
  const d = dst.map((p) => norm(dstNorm, p));

  let coef: number[];
  let ctrl: number[] | undefined;

  switch (kind) {
    case 'helmert': {
      // x' = a x - b y + tx ; y' = b x + a y + ty
      const A: number[][] = [];
      const b: number[] = [];
      s.forEach((p, i) => {
        A.push([p.x, -p.y, 1, 0]);
        b.push(d[i].x);
        A.push([p.y, p.x, 0, 1]);
        b.push(d[i].y);
      });
      coef = leastSquares(A, b);
      break;
    }
    case 'affine': {
      const A = s.map((p) => [p.x, p.y, 1]);
      const cx = leastSquares(A, d.map((p) => p.x));
      const cy = leastSquares(A, d.map((p) => p.y));
      coef = [...cx, ...cy];
      break;
    }
    case 'projective': {
      // u = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), v = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
      const A: number[][] = [];
      const b: number[] = [];
      s.forEach((p, i) => {
        const { x: u, y: v } = d[i];
        A.push([p.x, p.y, 1, 0, 0, 0, -p.x * u, -p.y * u]);
        b.push(u);
        A.push([0, 0, 0, p.x, p.y, 1, -p.x * v, -p.y * v]);
        b.push(v);
      });
      coef = leastSquares(A, b);
      break;
    }
    case 'poly2':
    case 'poly3': {
      const order = kind === 'poly2' ? 2 : 3;
      const A = s.map((p) => polyTerms(order, p.x, p.y));
      const cx = leastSquares(A, d.map((p) => p.x));
      const cy = leastSquares(A, d.map((p) => p.y));
      coef = [...cx, ...cy];
      break;
    }
    case 'tps': {
      // Solve [K P; Pᵀ 0] [w; a] = [v; 0] for each output coordinate.
      const n = s.length;
      const L: number[][] = [];
      for (let i = 0; i < n + 3; i++) L.push(new Array<number>(n + 3).fill(0));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const dx = s[i].x - s[j].x;
          const dy = s[i].y - s[j].y;
          L[i][j] = tpsU(dx * dx + dy * dy);
        }
        L[i][n] = 1;
        L[i][n + 1] = s[i].x;
        L[i][n + 2] = s[i].y;
        L[n][i] = 1;
        L[n + 1][i] = s[i].x;
        L[n + 2][i] = s[i].y;
      }
      const bx = [...d.map((p) => p.x), 0, 0, 0];
      const by = [...d.map((p) => p.y), 0, 0, 0];
      const wx = solveSquare(L, bx);
      const wy = solveSquare(L, by);
      coef = [...wx, ...wy];
      ctrl = s.flatMap((p) => [p.x, p.y]);
      break;
    }
  }

  return { kind, srcNorm, dstNorm, coef, ctrl };
}

/** Apply the transform in normalised space. */
function applyCore(t: FittedTransform, p: Pt): Pt {
  const c = t.coef;
  switch (t.kind) {
    case 'helmert':
      return { x: c[0] * p.x - c[1] * p.y + c[2], y: c[1] * p.x + c[0] * p.y + c[3] };
    case 'affine':
      return { x: c[0] * p.x + c[1] * p.y + c[2], y: c[3] * p.x + c[4] * p.y + c[5] };
    case 'projective': {
      const w = c[6] * p.x + c[7] * p.y + 1;
      return {
        x: (c[0] * p.x + c[1] * p.y + c[2]) / w,
        y: (c[3] * p.x + c[4] * p.y + c[5]) / w,
      };
    }
    case 'poly2':
    case 'poly3': {
      const terms = polyTerms(t.kind === 'poly2' ? 2 : 3, p.x, p.y);
      const k = terms.length;
      let x = 0;
      let y = 0;
      for (let i = 0; i < k; i++) {
        x += c[i] * terms[i];
        y += c[k + i] * terms[i];
      }
      return { x, y };
    }
    case 'tps': {
      const ctrl = t.ctrl!;
      const n = ctrl.length / 2;
      const m = n + 3;
      let x = c[n] + c[n + 1] * p.x + c[n + 2] * p.y;
      let y = c[m + n] + c[m + n + 1] * p.x + c[m + n + 2] * p.y;
      for (let i = 0; i < n; i++) {
        const dx = p.x - ctrl[2 * i];
        const dy = p.y - ctrl[2 * i + 1];
        const u = tpsU(dx * dx + dy * dy);
        x += c[i] * u;
        y += c[m + i] * u;
      }
      return { x, y };
    }
  }
}

export function applyTransform(t: FittedTransform, p: Pt): Pt {
  return denorm(t.dstNorm, applyCore(t, norm(t.srcNorm, p)));
}

/**
 * Inverse of a transform. Helmert/affine/projective are inverted analytically,
 * polynomial and TPS transforms are re-fitted in the opposite direction using
 * the provided point pairs.
 */
export function invertTransform(t: FittedTransform, src: Pt[], dst: Pt[]): FittedTransform {
  const c = t.coef;
  const swapped = { srcNorm: t.dstNorm, dstNorm: t.srcNorm };
  switch (t.kind) {
    case 'helmert':
    case 'affine': {
      const m =
        t.kind === 'helmert'
          ? [
              [c[0], -c[1], c[2]],
              [c[1], c[0], c[3]],
              [0, 0, 1],
            ]
          : [
              [c[0], c[1], c[2]],
              [c[3], c[4], c[5]],
              [0, 0, 1],
            ];
      const inv = invert3(m);
      return { kind: 'affine', ...swapped, coef: [...inv[0], ...inv[1]] };
    }
    case 'projective': {
      const inv = invert3([
        [c[0], c[1], c[2]],
        [c[3], c[4], c[5]],
        [c[6], c[7], 1],
      ]);
      const k = inv[2][2];
      return {
        kind: 'projective',
        ...swapped,
        coef: [inv[0][0], inv[0][1], inv[0][2], inv[1][0], inv[1][1], inv[1][2], inv[2][0], inv[2][1]].map(
          (v) => v / k,
        ),
      };
    }
    default:
      return fitTransform(t.kind, dst, src);
  }
}
