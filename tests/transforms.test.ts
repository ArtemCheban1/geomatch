import { describe, expect, it } from 'vitest';
import { applyTransform, fitTransform, invertTransform, TRANSFORMS, type Pt } from '../src/geo/transforms';
import { computeGeoref, lngLatToPixel, pixelToLngLat, type ControlPoint } from '../src/geo/georef';
import { lngLatToMerc, mercToLngLat } from '../src/geo/mercator';
import { warpImage } from '../src/geo/warp';

const grid = (n: number, w = 4000, h = 3000): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) pts.push({ x: (w * (i + 0.3 * (j % 2))) / (n - 1 || 1), y: -(h * j) / (n - 1 || 1) });
  }
  return pts;
};

// A "true" affine mapping from image plane to Mercator (rotation + anisotropic scale)
const trueAffine = (p: Pt): Pt => ({
  x: 3_380_000 + 2.1 * p.x + 0.35 * p.y,
  y: 6_500_000 - 0.3 * p.x + 2.4 * p.y,
});

describe('transform fitting', () => {
  it('recovers an exact affine mapping for every kind that contains affine', () => {
    const src = grid(4);
    const dst = src.map(trueAffine);
    for (const kind of ['affine', 'projective', 'poly2', 'poly3', 'tps'] as const) {
      const t = fitTransform(kind, src, dst);
      for (const p of [{ x: 1234, y: -567 }, { x: 10, y: -2900 }]) {
        const q = applyTransform(t, p);
        const e = trueAffine(p);
        expect(Math.hypot(q.x - e.x, q.y - e.y)).toBeLessThan(1e-3);
      }
    }
  });

  it('helmert recovers similarity with 2 points', () => {
    const sim = (p: Pt): Pt => {
      const a = 0.4, s = 1.7;
      return { x: 100 + s * (Math.cos(a) * p.x - Math.sin(a) * p.y), y: -50 + s * (Math.sin(a) * p.x + Math.cos(a) * p.y) };
    };
    const src = [{ x: 0, y: 0 }, { x: 1000, y: -500 }];
    const t = fitTransform('helmert', src, src.map(sim));
    const q = applyTransform(t, { x: 300, y: -700 });
    const e = sim({ x: 300, y: -700 });
    expect(Math.hypot(q.x - e.x, q.y - e.y)).toBeLessThan(1e-6);
  });

  it('projective recovers a homography exactly with 4 points', () => {
    const H = (p: Pt): Pt => {
      const w = 1e-5 * p.x + 2e-5 * p.y + 1;
      return { x: (2 * p.x + 0.1 * p.y + 500) / w, y: (0.2 * p.x + 1.5 * p.y - 300) / w };
    };
    const src = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: -1500 }, { x: 0, y: -1500 }];
    const t = fitTransform('projective', src, src.map(H));
    const q = applyTransform(t, { x: 777, y: -333 });
    const e = H({ x: 777, y: -333 });
    expect(Math.hypot(q.x - e.x, q.y - e.y)).toBeLessThan(1e-6);
  });

  it('inverse transforms round-trip', () => {
    const src = grid(4);
    const dst = src.map((p) => {
      const q = trueAffine(p);
      return { x: q.x + 3 * Math.sin(p.x / 500), y: q.y + 2 * Math.cos(p.y / 400) };
    });
    for (const info of TRANSFORMS) {
      const t = fitTransform(info.kind, src, dst);
      const inv = invertTransform(t, src, dst);
      const p = { x: 2100, y: -1400 };
      const back = applyTransform(inv, applyTransform(t, p));
      // analytic inverses are exact; refitted ones are approximate
      const tol = ['helmert', 'affine', 'projective'].includes(info.kind) ? 1e-6 : 5;
      expect(Math.hypot(back.x - p.x, back.y - p.y)).toBeLessThan(tol);
    }
  });

  it('throws for degenerate (collinear) points', () => {
    const src = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(() => fitTransform('affine', src, src)).toThrow();
  });
});

describe('georef', () => {
  const lngLats: [number, number][] = [
    [30.5, 50.45], [30.55, 50.46], [30.52, 50.42], [30.58, 50.41], [30.6, 50.44],
  ];
  // Synthesize pixel positions from a known affine (Mercator → pixel)
  const pts: ControlPoint[] = lngLats.map((ll, i) => {
    const m = lngLatToMerc(ll);
    return { id: String(i), lngLat: ll, enabled: true, img: { x: (m.x - 3_390_000) / 2.5, y: -(m.y - 6_530_000) / 2.5 } };
  });

  it('mercator round-trips', () => {
    const [lng, lat] = mercToLngLat(lngLatToMerc([30.5, 50.45]));
    expect(lng).toBeCloseTo(30.5, 9);
    expect(lat).toBeCloseTo(50.45, 9);
  });

  it('fits with ~0 residuals and maps both ways', () => {
    const g = computeGeoref('affine', pts)!;
    expect(g.rmse).toBeLessThan(1e-3);
    expect(g.redundant).toBe(true);
    const ll = pixelToLngLat(g, pts[2].img);
    expect(ll[0]).toBeCloseTo(30.52, 7);
    const px = lngLatToPixel(g, [30.55, 50.46]);
    expect(px.x).toBeCloseTo(pts[1].img.x, 3);
  });

  it('returns null with too few enabled points', () => {
    expect(computeGeoref('projective', pts.slice(0, 3))).toBeNull();
    expect(computeGeoref('affine', pts.map((p, i) => ({ ...p, enabled: i < 2 })))).toBeNull();
  });

  it('reports residuals in metres for a misplaced point', () => {
    const bad = pts.map((p) => ({ ...p }));
    bad[4] = { ...bad[4], img: { x: bad[4].img.x + 40, y: bad[4].img.y } }; // 40 px * 2.5 m ≈ 100 merc m
    const g = computeGeoref('affine', bad)!;
    expect(g.rmse).toBeGreaterThan(10);
    const worst = Object.entries(g.residuals).sort((a, b) => b[1].error - a[1].error)[0][0];
    expect(worst).toBe('4');
  });
});

describe('warp', () => {
  it('produces a raster that contains the image content', () => {
    const w = 64, h = 32;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: -h }];
    const dst = src.map((p) => ({ x: p.x * 10 + 1000, y: p.y * 10 + 5000 }));
    const fwd = fitTransform('affine', src, dst);
    const inv = invertTransform(fwd, src, dst);
    const res = warpImage({ width: w, height: h, data, scale: 1 }, {
      forward: fwd, inverse: inv, imageWidth: w, imageHeight: h, maxOutputSize: 256,
    });
    expect(res.width).toBe(64);
    expect(res.height).toBe(32);
    expect(res.bounds.minX).toBeCloseTo(1000, 6);
    expect(res.bounds.maxY).toBeCloseTo(5000, 6);
    expect(res.data[(16 * 64 + 32) * 4 + 3]).toBe(255);
  });
});
