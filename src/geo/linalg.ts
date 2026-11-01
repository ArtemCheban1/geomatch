/**
 * Minimal dense linear algebra used by the transform fitting code.
 * Matrices are row-major arrays of rows.
 */

/** Solve the square system A·x = b with Gaussian elimination and partial pivoting. */
export function solveSquare(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error('Singular system: control points are degenerate (e.g. collinear or duplicated).');
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Least-squares solution of the (possibly over-determined) system A·x ≈ b
 * using Householder QR, which is numerically much better behaved than the
 * normal equations.
 */
export function leastSquares(A: number[][], b: number[]): number[] {
  const m = A.length;
  const n = A[0].length;
  if (m < n) throw new Error(`Not enough equations: need ${n}, got ${m}.`);
  const R = A.map((row) => row.slice());
  const y = b.slice();

  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      throw new Error('Singular system: control points are degenerate (e.g. collinear or duplicated).');
    }
    const alpha = R[k][k] > 0 ? -norm : norm;
    const v = new Array<number>(m).fill(0);
    for (let i = k; i < m; i++) v[i] = R[i][k];
    v[k] -= alpha;
    let vnorm2 = 0;
    for (let i = k; i < m; i++) vnorm2 += v[i] * v[i];
    if (vnorm2 === 0) continue;
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * R[i][j];
      const f = (2 * dot) / vnorm2;
      for (let i = k; i < m; i++) R[i][j] -= f * v[i];
    }
    let dot = 0;
    for (let i = k; i < m; i++) dot += v[i] * y[i];
    const f = (2 * dot) / vnorm2;
    for (let i = k; i < m; i++) y[i] -= f * v[i];
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    if (Math.abs(R[r][r]) < 1e-10) {
      throw new Error('Singular system: control points are degenerate (e.g. collinear or duplicated).');
    }
    let s = y[r];
    for (let c = r + 1; c < n; c++) s -= R[r][c] * x[c];
    x[r] = s / R[r][r];
  }
  return x;
}

/** Inverse of a 3×3 matrix. */
export function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Transform is not invertible.');
  const inv = 1 / det;
  return [
    [A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv],
    [B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv],
    [C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv],
  ];
}
