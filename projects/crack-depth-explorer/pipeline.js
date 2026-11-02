/*
 * Crack Depth Explorer: browser port of the Python pipeline.
 *   photostereo.py : sRGB -> linear, per-pixel least squares with cast-shadow handling,
 *                    Poisson integration with the DCT (Simchony et al. 1990), plane / trend removal
 *   cracks.py      : local depth = closing(height) - height, hysteresis mask, shape filter,
 *                    skeleton split at junctions, length / depth / width at half depth per segment
 * Runs as a Web Worker (preferred) or directly on the page.
 */
var CDE = (function () {
  "use strict";

  /* ---------- photometric stereo ---------- */
  var LUT = (function () {
    var t = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = i / 255;
      t[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    }
    return t;
  })();

  function lightDirs(azDeg, elDeg) {
    var e = elDeg * Math.PI / 180;
    return azDeg.map(function (a) {
      a = a * Math.PI / 180;
      return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
    });
  }

  function pinv(L) { // (LᵀL)⁻¹Lᵀ, 3×k
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], k = L.length, i, j, r;
    for (r = 0; r < k; r++) for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) A[i][j] += L[r][i] * L[r][j];
    var a = A, det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    var inv = [
      [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
      [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
      [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det]];
    var P = [[], [], []];
    for (i = 0; i < 3; i++) for (r = 0; r < k; r++) P[i][r] = inv[i][0] * L[r][0] + inv[i][1] * L[r][1] + inv[i][2] * L[r][2];
    return P;
  }

  function estimateNormals(imgs, L, n, shadowRatio) {
    var k = imgs.length, P = pinv(L), Pd = [];
    if (k >= 4) for (var j = 0; j < k; j++) Pd[j] = pinv(L.filter(function (_, i) { return i !== j; }));
    var nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n), alb = new Float32Array(n);
    var I = new Float64Array(k);
    for (var p = 0; p < n; p++) {
      var mn = Infinity, mi = 0, sum = 0;
      for (var i = 0; i < k; i++) { I[i] = imgs[i][p]; sum += I[i]; if (I[i] < mn) { mn = I[i]; mi = i; } }
      var M = P, skip = -1;
      if (k >= 4 && mn < shadowRatio * (sum - mn) / (k - 1)) { M = Pd[mi]; skip = mi; }
      var g0 = 0, g1 = 0, g2 = 0, c = 0;
      for (var q = 0; q < k; q++) {
        if (q === skip) continue;
        g0 += M[0][c] * I[q]; g1 += M[1][c] * I[q]; g2 += M[2][c] * I[q]; c++;
      }
      var a = Math.sqrt(g0 * g0 + g1 * g1 + g2 * g2), d = Math.max(a, 1e-9);
      var x = g0 / d, y = g1 / d, z = g2 / d;
      if (z < 0.05) { x = 0; y = 0; z = 1; }
      nx[p] = x; ny[p] = y; nz[p] = z; alb[p] = a;
    }
    return { nx: nx, ny: ny, nz: nz, albedo: alb };
  }

  // orthonormal DCT-II matrix, row-major: C[k*N+n]
  var dctCache = {};
  function dctMat(N) {
    if (dctCache[N]) return dctCache[N];
    var C = new Float64Array(N * N), CT = new Float64Array(N * N);
    for (var k = 0; k < N; k++) {
      var s = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
      for (var n = 0; n < N; n++) {
        var v = s * Math.cos(Math.PI * (2 * n + 1) * k / (2 * N));
        C[k * N + n] = v; CT[n * N + k] = v;
      }
    }
    return (dctCache[N] = { C: C, CT: CT });
  }
  function rowsTransform(src, W, H, M) {
    var out = new Float64Array(W * H), row = new Float64Array(W);
    for (var y = 0; y < H; y++) {
      var o = y * W;
      for (var x = 0; x < W; x++) row[x] = src[o + x];
      for (var k = 0; k < W; k++) {
        var s = 0, m = k * W;
        for (var n = 0; n < W; n++) s += M[m + n] * row[n];
        out[o + k] = s;
      }
    }
    return out;
  }
  function transpose(src, W, H) {
    var out = new Float64Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) out[x * H + y] = src[y * W + x];
    return out;
  }
  function dct2(src, W, H, inverse) {
    var a = dctMat(W), b = dctMat(H);
    var r = rowsTransform(src, W, H, inverse ? a.CT : a.C);
    var t = rowsTransform(transpose(r, W, H), H, W, inverse ? b.CT : b.C);
    return transpose(t, H, W);
  }

  function median(arr) {
    var c = Float32Array.from(arr).sort();
    var m = c.length >> 1;
    return c.length % 2 ? c[m] : 0.5 * (c[m - 1] + c[m]);
  }

  function integrate(N, W, H, px, maxSlope) {
    maxSlope = maxSlope || 5;
    var n = W * H, p = new Float64Array(n), q = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var nz = Math.max(N.nz[i], 1 / maxSlope);
      p[i] = Math.max(-maxSlope, Math.min(maxSlope, -N.nx[i] / nz));
      q[i] = Math.max(-maxSlope, Math.min(maxSlope, N.ny[i] / nz));
    }
    var pe = new Float64Array(n), qe = new Float64Array(n), f = new Float64Array(n), x, y, o;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      o = y * W + x;
      if (x < W - 1) pe[o] = 0.5 * (p[o] + p[o + 1]);
      if (y < H - 1) qe[o] = 0.5 * (q[o] + q[o + W]);
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      o = y * W + x;
      f[o] = pe[o] - (x > 0 ? pe[o - 1] : 0) + qe[o] - (y > 0 ? qe[o - W] : 0);
    }
    var F = dct2(f, W, H, false);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      o = y * W + x;
      var d = (2 * Math.cos(Math.PI * x / W) - 2) + (2 * Math.cos(Math.PI * y / H) - 2);
      F[o] = o === 0 ? 0 : F[o] / d;
    }
    var z = dct2(F, W, H, true), out = new Float32Array(n);
    for (i = 0; i < n; i++) out[i] = z[i] * px;
    var m = median(out);
    for (i = 0; i < n; i++) out[i] -= m;
    return out;
  }

  function boxBlur(src, W, H, r) { // separable running-sum box filter, edge-clamped
    var tmp = new Float32Array(W * H), out = new Float32Array(W * H), w = 2 * r + 1, x, y, s;
    for (y = 0; y < H; y++) {
      var o = y * W; s = 0;
      for (x = -r; x <= r; x++) s += src[o + Math.min(W - 1, Math.max(0, x))];
      for (x = 0; x < W; x++) {
        tmp[o + x] = s / w;
        s += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
    for (x = 0; x < W; x++) {
      s = 0;
      for (y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (y = 0; y < H; y++) {
        out[y * W + x] = s / w;
        s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
    return out;
  }
  function gaussian(src, W, H, sigma) { // three box passes ≈ Gaussian
    var r = Math.max(1, Math.round((Math.sqrt(12 * sigma * sigma / 3 + 1) - 1) / 2));
    return boxBlur(boxBlur(boxBlur(src, W, H, r), W, H, r), W, H, r);
  }

  function removeTrend(h, W, H, px, sigmaMm) {
    var n = W * H, Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0, x, y, i;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var z = h[y * W + x];
      Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y; Sxz += x * z; Syz += y * z; Sz += z;
    }
    var A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], b = [Sxz, Syz, Sz];
    var c = solve3(A, b), out = new Float32Array(n);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { i = y * W + x; out[i] = h[i] - (c[0] * x + c[1] * y + c[2]); }
    if (sigmaMm) {
      var g = gaussian(out, W, H, sigmaMm / px);
      for (i = 0; i < n; i++) out[i] -= g[i];
    }
    var m = median(out);
    for (i = 0; i < n; i++) out[i] -= m;
    return out;
  }
  function solve3(A, b) {
    var M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var piv = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (r = 0; r < 3; r++) if (r !== c) {
        var f = M[r][c] / M[c][c];
        for (var k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  /* ---------- morphology ---------- */
  function lineFilter(src, W, H, dx, dy, half, isMax) {
    var out = new Float32Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var v = src[y * W + x];
      for (var t = 1; t <= half; t++) {
        var x1 = x + t * dx, y1 = y + t * dy, x2 = x - t * dx, y2 = y - t * dy, u;
        if (x1 >= 0 && x1 < W && y1 >= 0 && y1 < H) { u = src[y1 * W + x1]; if (isMax ? u > v : u < v) v = u; }
        if (x2 >= 0 && x2 < W && y2 >= 0 && y2 < H) { u = src[y2 * W + x2]; if (isMax ? u > v : u < v) v = u; }
      }
      out[y * W + x] = v;
    }
    return out;
  }
  // octagonal structuring element of radius r (close approximation of a disk)
  function octagon(src, W, H, r, isMax) {
    var a = Math.round(0.4142 * r), b = Math.round(0.2929 * r), o = src;
    o = lineFilter(o, W, H, 1, 0, a, isMax);
    o = lineFilter(o, W, H, 0, 1, a, isMax);
    if (b > 0) {
      o = lineFilter(o, W, H, 1, 1, b, isMax);
      o = lineFilter(o, W, H, 1, -1, b, isMax);
    }
    return o;
  }
  function closing(src, W, H, r) { return octagon(octagon(src, W, H, r, true), W, H, r, false); }
  function maxFilter(src, W, H, size) {
    var h = size >> 1;
    return lineFilter(lineFilter(src, W, H, 1, 0, h, true), W, H, 0, 1, h, true);
  }

  function label(mask, W, H, conn8) {
    var lab = new Int32Array(W * H), n = 0, stack = [];
    for (var s = 0; s < W * H; s++) {
      if (!mask[s] || lab[s]) continue;
      n++; lab[s] = n; stack.push(s);
      while (stack.length) {
        var p = stack.pop(), x = p % W, y = (p - x) / W;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!conn8 && dx && dy) continue;
          var xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          var q = yy * W + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack.push(q); }
        }
      }
    }
    return { lab: lab, n: n };
  }

  function hullArea(pts) { // monotone chain on pixel corners
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < pts.length; i++) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop(); lo.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], pts[i]) <= 0) up.pop(); up.push(pts[i]); }
    var h = lo.slice(0, -1).concat(up.slice(0, -1)), A = 0;
    for (i = 0; i < h.length; i++) { var j = (i + 1) % h.length; A += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
    return Math.abs(A) / 2;
  }

  function crackMask(depth, W, H, px, P) {
    var n = W * H, low = new Uint8Array(n), i;
    for (i = 0; i < n; i++) low[i] = depth[i] > P.edge ? 1 : 0;
    var L = label(low, W, H, false), hasSeed = new Uint8Array(L.n + 1);
    for (i = 0; i < n; i++) if (L.lab[i] && depth[i] > P.seed) hasSeed[L.lab[i]] = 1;
    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = L.lab[i] && hasSeed[L.lab[i]] ? 1 : 0;

    // shape filter: keep elongated regions (and large branched networks), drop round air voids
    var R = label(mask, W, H, true), m = R.n;
    var cnt = new Float64Array(m + 1), sx = new Float64Array(m + 1), sy = new Float64Array(m + 1),
        sxx = new Float64Array(m + 1), syy = new Float64Array(m + 1), sxy = new Float64Array(m + 1);
    for (i = 0; i < n; i++) {
      var l = R.lab[i]; if (!l) continue;
      var x = i % W, y = (i - x) / W;
      cnt[l]++; sx[l] += x; sy[l] += y; sxx[l] += x * x; syy[l] += y * y; sxy[l] += x * y;
    }
    var keep = new Uint8Array(m + 1), needHull = [];
    for (l = 1; l <= m; l++) {
      var c = cnt[l], mx = sx[l] / c, my = sy[l] / c;
      var cxx = sxx[l] / c - mx * mx, cyy = syy[l] / c - my * my, cxy = sxy[l] / c - mx * my;
      var tr = (cxx + cyy) / 2, dd = Math.sqrt(Math.max(0, (cxx - cyy) * (cxx - cyy) / 4 + cxy * cxy));
      var l1 = tr + dd, l2 = Math.max(tr - dd, 0);
      var elong = l2 > 0 ? Math.sqrt(l1 / l2) : Infinity;
      if (elong >= P.minElong) keep[l] = 1;
      else if (c * px * px > 20) needHull.push(l);
    }
    if (needHull.length) {
      var pts = {};
      needHull.forEach(function (l) { pts[l] = []; });
      for (i = 0; i < n; i++) {
        var lb = R.lab[i];
        if (lb && pts[lb]) { var xx = i % W, yy = (i - xx) / W; pts[lb].push([xx, yy], [xx + 1, yy], [xx, yy + 1], [xx + 1, yy + 1]); }
      }
      needHull.forEach(function (l) { if (cnt[l] / hullArea(pts[l]) < 0.4) keep[l] = 1; });
    }
    var out = new Uint8Array(n);
    for (i = 0; i < n; i++) out[i] = keep[R.lab[i]] ? 1 : 0;
    return out;
  }

  function skeletonize(bin, W, H) { // Zhang–Suen
    var img = bin.slice(), del = [], changed = true, x, y;
    for (x = 0; x < W; x++) { img[x] = 0; img[(H - 1) * W + x] = 0; }
    for (y = 0; y < H; y++) { img[y * W] = 0; img[y * W + W - 1] = 0; }
    while (changed) {
      changed = false;
      for (var pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
          var i = y * W + x; if (!img[i]) continue;
          var p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1],
              p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          var A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (var d = 0; d < del.length; d++) img[del[d]] = 0;
        if (del.length) changed = true;
      }
    }
    // remove staircase corners: a pixel whose two orthogonal neighbours are already joined
    // diagonally is redundant under 8-connectivity (gives a strictly one-pixel-wide line)
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      var j = y * W + x; if (!img[j]) continue;
      var n2 = img[j - W], n4 = img[j + 1], n6 = img[j + W], n8 = img[j - 1],
          n3 = img[j - W + 1], n5 = img[j + W + 1], n7 = img[j + W - 1], n9 = img[j - W - 1];
      if ((n2 && n4 && !n6 && !n7 && !n8) || (n4 && n6 && !n8 && !n9 && !n2) ||
          (n6 && n8 && !n2 && !n3 && !n4) || (n8 && n2 && !n4 && !n5 && !n6)) img[j] = 0;
    }
    return img;
  }

  function edt(mask, W, H) { // exact Euclidean distance to nearest 0 pixel (Felzenszwalb & Huttenlocher)
    var INF = 1e20, f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H)),
        v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1), g = new Float64Array(W * H);
    function dt1(n) {
      var k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (var q = 1; q < n; q++) {
        var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    }
    var x, y;
    for (x = 0; x < W; x++) {
      for (y = 0; y < H; y++) f[y] = mask[y * W + x] ? INF : 0;
      dt1(H);
      for (y = 0; y < H; y++) g[y * W + x] = d[y];
    }
    var out = new Float32Array(W * H);
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) f[x] = g[y * W + x];
      dt1(W);
      for (x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  function chainLength(coords, W) {
    var s = new Set(coords), L = 0;
    coords.forEach(function (i) {
      var x = i % W;
      if (x + 1 < W && s.has(i + 1)) L++;
      if (s.has(i + W)) L++;
      [1, -1].forEach(function (dx) {
        if (x + dx < 0 || x + dx >= W) return;
        if (s.has(i + W + dx) && !s.has(i + dx) && !s.has(i + W)) L += Math.SQRT2;
      });
    });
    return Math.max(L, 1);
  }

  function analyse(height, W, H, px, P) {
    var n = W * H, i;
    var r = Math.max(1, Math.round(P.maxWidth / px / 2));
    var closed = closing(height, W, H, r), depth = new Float32Array(n);
    for (i = 0; i < n; i++) depth[i] = Math.max(0, closed[i] - height[i]);
    var mask = crackMask(depth, W, H, px, P);
    var skel = skeletonize(mask, W, H);
    var lm = maxFilter(depth, W, H, Math.max(3, Math.floor(P.maxWidth / px / 3)));
    var half = new Uint8Array(n);
    for (i = 0; i < n; i++) half[i] = mask[i] && depth[i] >= 0.5 * lm[i] ? 1 : 0;
    var dist = edt(half, W, H);
    var depthLine = new Float32Array(n), widthLine = new Float32Array(n), on = [];
    for (i = 0; i < n; i++) if (skel[i]) { depthLine[i] = lm[i]; widthLine[i] = 2 * dist[i] * px; on.push(i); }

    // split skeleton at junctions
    var junc = new Uint8Array(n), x, y;
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      i = y * W + x; if (!skel[i]) continue;
      var nb = skel[i - W - 1] + skel[i - W] + skel[i - W + 1] + skel[i - 1] + skel[i + 1] + skel[i + W - 1] + skel[i + W] + skel[i + W + 1];
      if (nb > 2) junc[i] = 1;
    }
    var jd = new Uint8Array(n);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!junc[y * W + x]) continue;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) jd[yy * W + xx] = 1;
      }
    }
    var seg = new Uint8Array(n);
    for (i = 0; i < n; i++) seg[i] = skel[i] && !jd[i] ? 1 : 0;
    var SL = label(seg, W, H, true), groups = [];
    for (i = 0; i < n; i++) if (SL.lab[i]) (groups[SL.lab[i]] = groups[SL.lab[i]] || []).push(i);
    var segments = [], segLab = new Int32Array(n);
    groups.forEach(function (g) {
      if (!g) return;
      var len = chainLength(g, W) * px;
      if (len < P.minSeg) return;
      var dsum = 0, dmax = 0, wsum = 0, wmax = 0, xs = [], ys = [];
      g.forEach(function (p) {
        dsum += depthLine[p]; if (depthLine[p] > dmax) dmax = depthLine[p];
        wsum += widthLine[p]; if (widthLine[p] > wmax) wmax = widthLine[p];
        xs.push(p % W); ys.push(Math.floor(p / W));
      });
      xs.sort(function (a, b) { return a - b; }); ys.sort(function (a, b) { return a - b; });
      var id = segments.length + 1;
      g.forEach(function (p) { segLab[p] = id; });
      segments.push({ id: id, length_mm: len, mean_depth_mm: dsum / g.length, max_depth_mm: dmax,
        mean_width_mm: wsum / g.length, max_width_mm: wmax, cx: xs[xs.length >> 1], cy: ys[ys.length >> 1] });
    });

    var summary = { crack_segments: segments.length };
    if (segments.length) {
      var dl = on.map(function (p) { return depthLine[p]; }), wl = on.map(function (p) { return widthLine[p]; });
      var area = 0; for (i = 0; i < n; i++) area += mask[i];
      summary.total_length_mm = segments.reduce(function (s, g) { return s + g.length_mm; }, 0);
      summary.max_depth_mm = Math.max.apply(null, dl);
      summary.median_depth_mm = median(dl);
      summary.max_width_mm = Math.max.apply(null, wl);
      summary.median_width_mm = median(wl);
      summary.crack_area_pct = 100 * area / n;
    }
    return { depth: depth, mask: mask, skel: skel, segLab: segLab, segments: segments, summary: summary };
  }

  // the shortcut photometric stereo replaces: "darker = deeper" from ONE image
  function singleImageShading(img, W, H) {
    var n = W * H, u8 = new Float32Array(n), i;
    for (i = 0; i < n; i++) u8[i] = Math.floor(img[i] * 255);
    var ref = closing(u8, W, H, 20);
    for (i = 0; i < n; i++) ref[i] /= 255;
    ref = gaussian(ref, W, H, 3);
    var idx = new Float32Array(n);
    for (i = 0; i < n; i++) idx[i] = Math.max(0, Math.min(1, (ref[i] - img[i]) / Math.max(ref[i], 1e-6)));
    return idx;
  }

  /* ---------- full run ---------- */
  var cache = { key: null };
  function run(msg) {
    var W = msg.W, H = msg.H, n = W * H, t0 = Date.now(), t = {};
    var use = msg.use, imgs = [], az = [], i;
    var key = [msg.dataId, msg.elevation, use.join(""), msg.pxmm, msg.detrend, msg.az.join(",")].join("|");
    var lin = msg.photos.map(function (ph) { var o = new Float32Array(n); for (var p = 0; p < n; p++) o[p] = LUT[ph[p]]; return o; });
    if (cache.key !== key) {
      for (i = 0; i < lin.length; i++) if (use[i]) { imgs.push(lin[i]); az.push(msg.az[i]); }
      var N = estimateNormals(imgs, lightDirs(az, msg.elevation), n, 0.25);
      t.normals = Date.now() - t0;
      var h = removeTrend(integrate(N, W, H, msg.pxmm), W, H, msg.pxmm, msg.detrend || null);
      t.integrate = Date.now() - t0 - t.normals;
      var avg = new Float32Array(n);
      for (i = 0; i < lin.length; i++) for (var p = 0; p < n; p++) avg[p] += lin[i][p] / lin.length;
      cache = { key: key, height: h, albedo: N.albedo, single: singleImageShading(avg, W, H) };
    }
    var t1 = Date.now();
    var A = analyse(cache.height, W, H, msg.pxmm, msg.params);
    t.analyse = Date.now() - t1;
    t.total = Date.now() - t0;
    return { height: cache.height, albedo: cache.albedo, single: cache.single, depth: A.depth, mask: A.mask, skel: A.skel,
             segLab: A.segLab, segments: A.segments, summary: A.summary, timing: t, W: W, H: H, pxmm: msg.pxmm };
  }

  return { run: run, maxFilter: maxFilter };
})();

if (typeof window === "undefined" && typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = function (e) {
    try {
      var r = CDE.run(e.data);
      self.postMessage({ ok: true, id: e.data.id, r: r });
    } catch (err) {
      self.postMessage({ ok: false, id: e.data.id, error: String(err && err.stack || err) });
    }
  };
}
