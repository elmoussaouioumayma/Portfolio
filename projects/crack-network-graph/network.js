/*
 * Crack Network Graph: browser port of network.py.
 *   segment()       colour -> grey (1st principal component), black-hat / top-hat with automatic
 *                   polarity, hysteresis threshold (Otsu, low = 65 %), median smoothing, shape filter
 *   skeletonGraph() skeleton -> multigraph (junction / end nodes, edges keep their pixel path),
 *                   width-aware spur pruning, gap bridging, merging of close junctions
 *   measure()       lengths, widths, orientations, T / Y / X junctions, closed cells with corners
 * Runs as a Web Worker (preferred) or directly on the page.
 */
var CNG = (function () {
  "use strict";
  var NB8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  /* ---------------- small numeric helpers ---------------- */
  function sortedCopy(a) { return Float64Array.from(a).sort(); }
  function percentileSorted(s, q) { // numpy 'linear'
    var pos = (s.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function median(a) {
    if (!a.length) return 0;
    var s = sortedCopy(a), m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }
  function roundHalfEven(v) {
    var r = Math.round(v);
    if (Math.abs(v % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return r;
  }
  function pmod(a, m) { return ((a % m) + m) % m; }

  /* ---------------- grey + filters ---------------- */
  function toGrey(rgba, n) {
    var mean = [0, 0, 0], i, c;
    for (i = 0; i < n; i++) for (c = 0; c < 3; c++) mean[c] += rgba[i * 4 + c];
    for (c = 0; c < 3; c++) mean[c] /= n;
    // covariance of every 7th pixel (np.cov, ddof = 1)
    var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], m = 0, sm = [0, 0, 0], rows = [];
    for (i = 0; i < n; i += 7) { var v = [rgba[i * 4] - mean[0], rgba[i * 4 + 1] - mean[1], rgba[i * 4 + 2] - mean[2]]; rows.push(v); sm[0] += v[0]; sm[1] += v[1]; sm[2] += v[2]; m++; }
    for (c = 0; c < 3; c++) sm[c] /= m;
    rows.forEach(function (v) { for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) S[a][b] += (v[a] - sm[a]) * (v[b] - sm[b]); });
    for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) S[a][b] /= (m - 1);
    var w = topEigenvector(S);
    if (w[0] + w[1] + w[2] < 0) w = [-w[0], -w[1], -w[2]];
    var g = new Float32Array(n);
    for (i = 0; i < n; i++) g[i] = (rgba[i * 4] - mean[0]) * w[0] + (rgba[i * 4 + 1] - mean[1]) * w[1] + (rgba[i * 4 + 2] - mean[2]) * w[2];
    var s = sortedCopy(g), lo = percentileSorted(s, 0.5), hi = percentileSorted(s, 99.5), d = Math.max(hi - lo, 1e-6);
    for (i = 0; i < n; i++) g[i] = Math.max(0, Math.min(255, (g[i] - lo) / d * 255));
    return g;
  }
  function topEigenvector(A) { // Jacobi for symmetric 3×3
    var a = A.map(function (r) { return r.slice(); }), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var it = 0; it < 50; it++) {
      var p = 0, q = 1;
      if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
      if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-12) break;
      var th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (var k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (k = 0; k < 3; k++) { var vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
    var best = 0; for (var j = 1; j < 3; j++) if (a[j][j] > a[best][best]) best = j;
    return [V[0][best], V[1][best], V[2][best]];
  }
  function reflect101(i, n) { if (n === 1) return 0; while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; } return i; }
  function gaussianBlur(src, W, H, sigma) { // cv2.GaussianBlur(ksize=(0,0)) for float images
    var r = (Math.round(sigma * 8 + 1) | 1) >> 1, k = [], sum = 0, i, x, y;
    for (i = -r; i <= r; i++) { var v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
    k = k.map(function (v) { return v / sum; });
    var tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var s = 0; for (i = -r; i <= r; i++) s += k[i + r] * src[y * W + reflect101(x + i, W)]; tmp[y * W + x] = s;
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = 0; for (i = -r; i <= r; i++) t += k[i + r] * tmp[reflect101(y + i, H) * W + x]; out[y * W + x] = t;
    }
    return out;
  }
  // grey dilation / erosion with OpenCV's elliptical structuring element (borders ignored)
  function ellipseHalfWidths(size) {
    var r = size >> 1, c = r, out = [];
    for (var i = 0; i < size; i++) {
      var dy = i - r;
      out.push(Math.abs(dy) <= r ? Math.round(c * Math.sqrt((r * r - dy * dy) / (r * r))) : -1);
    }
    return out;
  }
  function hRank(src, W, H, w, isMax) { // running max/min over [x-w, x+w] (van Herk / Gil-Werman)
    var out = new Float32Array(W * H), L = 2 * w + 1, g = new Float32Array(W + L), h = new Float32Array(W + L);
    var f = isMax ? function (a, b) { return a > b ? a : b; } : function (a, b) { return a < b ? a : b; };
    var pad = isMax ? -Infinity : Infinity;
    for (var y = 0; y < H; y++) {
      var o = y * W, n = W + 2 * w, x;
      // padded row: index j corresponds to x = j - w
      for (var j = 0; j < n; j++) {
        var xx = j - w, v = xx >= 0 && xx < W ? src[o + xx] : pad;
        g[j] = j % L === 0 ? v : f(g[j - 1], v);
      }
      for (j = n - 1; j >= 0; j--) {
        var xx2 = j - w, v2 = xx2 >= 0 && xx2 < W ? src[o + xx2] : pad;
        h[j] = (j === n - 1 || (j + 1) % L === 0) ? v2 : f(h[j + 1], v2);
      }
      for (x = 0; x < W; x++) out[o + x] = f(h[x], g[x + 2 * w]);
    }
    return out;
  }
  function ellipseMorph(src, W, H, size, isMax) {
    var hw = ellipseHalfWidths(size), r = size >> 1, cache = {}, out = new Float32Array(W * H);
    out.fill(isMax ? -Infinity : Infinity);
    for (var i = 0; i < size; i++) {
      var w = hw[i]; if (w < 0) continue;
      var rows = cache[w] || (cache[w] = hRank(src, W, H, w, isMax)), dy = i - r;
      for (var y = 0; y < H; y++) {
        var yy = y + dy; if (yy < 0 || yy >= H) continue;
        var o = y * W, oo = yy * W;
        if (isMax) { for (var x = 0; x < W; x++) if (rows[oo + x] > out[o + x]) out[o + x] = rows[oo + x]; }
        else { for (var x2 = 0; x2 < W; x2++) if (rows[oo + x2] < out[o + x2]) out[o + x2] = rows[oo + x2]; }
      }
    }
    return out;
  }
  function response(grey, W, H, size, dark) {
    var b = gaussianBlur(grey, W, H, 1.2), n = W * H, out = new Float32Array(n), i;
    if (dark) { var c = ellipseMorph(ellipseMorph(b, W, H, size, true), W, H, size, false); for (i = 0; i < n; i++) out[i] = c[i] - b[i]; }
    else { var o = ellipseMorph(ellipseMorph(b, W, H, size, false), W, H, size, true); for (i = 0; i < n; i++) out[i] = b[i] - o[i]; }
    return out;
  }
  function tailScore(resp) {
    var s = sortedCopy(resp), med = percentileSorted(s, 50);
    var dev = new Float64Array(s.length); for (var i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
    dev.sort();
    var mad = percentileSorted(dev, 50) + 1e-6;
    return (percentileSorted(s, 99) - med) / mad;
  }
  function otsu(img) { // skimage.filters.threshold_otsu (256 bins)
    var mn = Infinity, mx = -Infinity, n = img.length, i;
    for (i = 0; i < n; i++) { if (img[i] < mn) mn = img[i]; if (img[i] > mx) mx = img[i]; }
    if (mn === mx) return mn;
    var nb = 256, hist = new Float64Array(nb), bw = (mx - mn) / nb;
    for (i = 0; i < n; i++) { var b = Math.floor((img[i] - mn) / bw); if (b >= nb) b = nb - 1; hist[b]++; }
    var c = new Float64Array(nb); for (i = 0; i < nb; i++) c[i] = mn + bw * (i + 0.5);
    var w1 = new Float64Array(nb), w2 = new Float64Array(nb), m1 = new Float64Array(nb), m2 = new Float64Array(nb), s = 0, sc = 0;
    for (i = 0; i < nb; i++) { s += hist[i]; sc += hist[i] * c[i]; w1[i] = s; m1[i] = sc / (s || 1); }
    s = 0; sc = 0;
    for (i = nb - 1; i >= 0; i--) { s += hist[i]; sc += hist[i] * c[i]; w2[i] = s; m2[i] = sc / (s || 1); }
    var best = -1, idx = 0;
    for (i = 0; i < nb - 1; i++) { var v = w1[i] * w2[i + 1] * (m1[i] - m2[i + 1]) * (m1[i] - m2[i + 1]); if (v > best) { best = v; idx = i; } }
    return c[idx];
  }

  /* ---------------- labelling ---------------- */
  function label(mask, W, H, conn8) { // raster-order labels (like skimage.measure.label)
    var lab = new Int32Array(W * H), n = 0, stack = [];
    for (var s = 0; s < W * H; s++) {
      if (!mask[s] || lab[s]) continue;
      n++; lab[s] = n; stack.push(s);
      while (stack.length) {
        var p = stack.pop(), x = p % W, y = (p - x) / W;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!conn8 && dx && dy)) continue;
          var xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          var q = yy * W + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack.push(q); }
        }
      }
    }
    return { lab: lab, n: n };
  }
  function regions(L, W) { // per label: sorted pixel list (raster order)
    var out = []; for (var i = 1; i <= L.n; i++) out[i] = [];
    for (var p = 0; p < L.lab.length; p++) if (L.lab[p]) out[L.lab[p]].push(p);
    return out;
  }
  function axes(coords, W) {
    var n = coords.length, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    coords.forEach(function (p) { var x = p % W, y = (p - x) / W; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; });
    var mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
    var tr = (cxx + cyy) / 2, d = Math.sqrt(Math.max(0, (cxx - cyy) * (cxx - cyy) / 4 + cxy * cxy));
    return { major: 4 * Math.sqrt(Math.max(0, tr + d)), minor: 4 * Math.sqrt(Math.max(0, tr - d)) };
  }

  /* ---------------- segmentation ---------------- */
  function segment(rgba, W, H, P) {
    var n = W * H, grey = toGrey(rgba, n), size = 2 * P.maxWidth + 1, dark, resp, i;
    if (P.polarity === "auto") {
      var rd = response(grey, W, H, size, true), rl = response(grey, W, H, size, false);
      dark = tailScore(rd) >= tailScore(rl); resp = dark ? rd : rl;
    } else { dark = P.polarity === "dark"; resp = response(grey, W, H, size, dark); }
    // hysteresis
    var hi = otsu(resp) / P.sensitivity, lo = 0.65 * hi, low = new Uint8Array(n);
    for (i = 0; i < n; i++) low[i] = resp[i] > lo ? 1 : 0;
    var L = label(low, W, H, false), ok = new Uint8Array(L.n + 1);
    for (i = 0; i < n; i++) if (L.lab[i] && resp[i] > hi) ok[L.lab[i]] = 1;
    var m = new Uint8Array(n); for (i = 0; i < n; i++) m[i] = ok[L.lab[i]];
    // 3×3 median (majority) with replicated border
    var med = new Uint8Array(n);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var c = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) c += m[Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))];
      med[y * W + x] = c >= 5 ? 1 : 0;
    }
    // remove small objects (4-connected, area <= min area)
    var Ls = label(med, W, H, false), area = new Int32Array(Ls.n + 1);
    for (i = 0; i < n; i++) area[Ls.lab[i]]++;
    for (i = 0; i < n; i++) if (med[i] && area[Ls.lab[i]] <= P.minArea) med[i] = 0;
    // keep line-like pieces and large networks
    var R = label(med, W, H, true), regs = regions(R, W), keepL = new Uint8Array(R.n + 1);
    for (var l = 1; l <= R.n; l++) {
      var ax = axes(regs[l], W);
      if (ax.major / Math.max(ax.minor, 1) >= 3 || regs[l].length > 30 * P.minArea) keepL[l] = 1;
    }
    var keep = new Uint8Array(n); for (i = 0; i < n; i++) keep[i] = keepL[R.lab[i]];
    // closing 3×3 (outside counts as background for dilation, foreground for erosion)
    var dil = new Uint8Array(n), out = new Uint8Array(n);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var v = 0;
      for (dy = -1; dy <= 1 && !v; dy++) for (dx = -1; dx <= 1; dx++) { var yy = y + dy, xx = x + dx; if (yy >= 0 && yy < H && xx >= 0 && xx < W && keep[yy * W + xx]) { v = 1; break; } }
      dil[y * W + x] = v;
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var e = 1;
      for (dy = -1; dy <= 1 && e; dy++) for (dx = -1; dx <= 1; dx++) { var y2 = y + dy, x2 = x + dx; if (y2 >= 0 && y2 < H && x2 >= 0 && x2 < W && !dil[y2 * W + x2]) { e = 0; break; } }
      out[y * W + x] = e;
    }
    return { mask: out, polarity: dark ? "dark" : "light" };
  }

  /* ---------------- skeleton + distance ---------------- */
  function skeletonize(bin, W0, H0) { // Zhang–Suen + staircase removal (one-pixel, 8-connected lines)
    // pad by replicating the border (then a zero frame), so cracks that leave the image keep
    // running to its edge instead of being rounded off a few pixels inside
    var R = 24, W = W0 + 2 * R + 2, H = H0 + 2 * R + 2;
    var img = new Uint8Array(W * H), del = [], changed = true, x, y;
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      var sy = Math.min(H0 - 1, Math.max(0, y - 1 - R)), sx = Math.min(W0 - 1, Math.max(0, x - 1 - R));
      img[y * W + x] = bin[sy * W0 + sx] ? 1 : 0;
    }
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
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      var j = y * W + x; if (!img[j]) continue;
      var n2 = img[j - W], n4 = img[j + 1], n6 = img[j + W], n8 = img[j - 1],
          n3 = img[j - W + 1], n5 = img[j + W + 1], n7 = img[j + W - 1], n9 = img[j - W - 1];
      if ((n2 && n4 && !n6 && !n7 && !n8) || (n4 && n6 && !n8 && !n9 && !n2) ||
          (n6 && n8 && !n2 && !n3 && !n4) || (n8 && n2 && !n4 && !n5 && !n6)) img[j] = 0;
    }
    var out = new Uint8Array(W0 * H0);
    for (y = 0; y < H0; y++) for (x = 0; x < W0; x++) out[y * W0 + x] = img[(y + 1 + R) * W + x + 1 + R];
    return out;
  }
  function edt(mask, W, H) { // distance of each mask pixel to the nearest background pixel
    var INF = 1e20, N = Math.max(W, H), f = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1), g = new Float64Array(W * H);
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
    for (x = 0; x < W; x++) { for (y = 0; y < H; y++) f[y] = mask[y * W + x] ? INF : 0; dt1(H); for (y = 0; y < H; y++) g[y * W + x] = d[y]; }
    var out = new Float32Array(W * H);
    for (y = 0; y < H; y++) { for (x = 0; x < W; x++) f[x] = g[y * W + x]; dt1(W); for (x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]); }
    return out;
  }

  /* ---------------- multigraph with networkx iteration order ---------------- */
  function Graph() { this.nodes = new Map(); this.adj = new Map(); this.E = new Map(); this.nextKey = 0; this.nextId = 0; }
  Graph.prototype.addNode = function (id, attrs) { this.nodes.set(id, attrs); this.adj.set(id, new Map()); };
  Graph.prototype.addEdge = function (u, v, path) {
    var key = this.nextKey++, e = { u: u, v: v, path: path, key: key };
    this.E.set(key, e);
    var au = this.adj.get(u); if (!au.has(v)) au.set(v, []); au.get(v).push(key);
    if (u !== v) { var av = this.adj.get(v); if (!av.has(u)) av.set(u, []); av.get(u).push(key); }
    return e;
  };
  Graph.prototype.removeEdge = function (key) {
    var e = this.E.get(key); this.E.delete(key);
    var drop = function (m, a, b) { var arr = m.get(a).get(b); arr.splice(arr.indexOf(key), 1); if (!arr.length) m.get(a).delete(b); };
    drop(this.adj, e.u, e.v); if (e.u !== e.v) drop(this.adj, e.v, e.u);
  };
  Graph.prototype.removeNode = function (n) {
    var self = this, keys = [];
    this.adj.get(n).forEach(function (arr) { arr.forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    keys.forEach(function (k) { self.removeEdge(k); });
    this.adj.delete(n); this.nodes.delete(n);
  };
  Graph.prototype.degree = function (n) {
    var d = 0; this.adj.get(n).forEach(function (arr, nbr) { d += arr.length * (nbr === n ? 2 : 1); }); return d;
  };
  Graph.prototype.edges = function () { // (u, v, key, edge) in networkx order
    var out = [], seen = new Set(), self = this;
    this.adj.forEach(function (nbrs, n) {
      nbrs.forEach(function (keys, nbr) { if (!seen.has(nbr)) keys.forEach(function (k) { out.push([n, nbr, k, self.E.get(k)]); }); });
      seen.add(n);
    });
    return out;
  };
  Graph.prototype.edgesOf = function (n) {
    var out = [], self = this;
    this.adj.get(n).forEach(function (keys, nbr) { keys.forEach(function (k) { out.push([n, nbr, k, self.E.get(k)]); }); });
    return out;
  };
  Graph.prototype.relabel = function () {
    var G = new Graph(), map = new Map(), i = 0, self = this;
    this.nodes.forEach(function (a, n) { map.set(n, i); G.addNode(i, a); i++; });
    // re-add edges in adjacency order so iteration order is preserved
    this.edges().forEach(function (t) { G.addEdge(map.get(t[0]), map.get(t[1]), t[3].path); });
    return G;
  };

  function neighbours(skel, W, H) {
    var nb = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x; if (!skel[i]) continue;
      for (var k = 0; k < 8; k++) {
        var yy = y + NB8[k][0], xx = x + NB8[k][1];
        if (yy >= 0 && yy < H && xx >= 0 && xx < W) nb[yy * W + xx]++;
      }
    }
    return nb;
  }
  function trace(start, prev, skelHas, stop, W, H) {
    var path = [start], cur = start, last = prev, guard = 0;
    while (!stop.has(cur) || path.length === 1) {
      if (++guard > 1e6) break;
      var cy = Math.floor(cur / W), cx = cur - cy * W, nxt = [];
      for (var k = 0; k < 8; k++) {
        var yy = cy + NB8[k][0], xx = cx + NB8[k][1];
        if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        var q = yy * W + xx;
        if (!skelHas(q) || q === last) continue;
        var L = path.length, inTail = false;
        for (var t = Math.max(0, L - 3); t < L; t++) if (path[t] === q) inTail = true;
        if (inTail) continue;
        nxt.push({ q: q, a: stop.has(q) ? 1 : 0, b: Math.abs(NB8[k][0]) + Math.abs(NB8[k][1]), k: k });
      }
      if (!nxt.length) break;
      nxt.sort(function (p, r) { return p.a - r.a || p.b - r.b || p.k - r.k; });
      last = cur; cur = nxt[0].q; path.push(cur);
      if (stop.has(cur)) break;
    }
    return path;
  }
  function yx(p, W) { var y = Math.floor(p / W); return [y, p - y * W]; }

  function buildGraph(skel, W, H) {
    var n = W * H, nb = neighbours(skel, W, H), jp = new Uint8Array(n), i;
    for (i = 0; i < n; i++) jp[i] = skel[i] && nb[i] >= 3 ? 1 : 0;
    var JL = label(jp, W, H, true), regs = regions(JL, W), G = new Graph(), nodeOf = new Map(), nid = 0;
    for (var l = 1; l <= JL.n; l++) {
      var sy = 0, sx = 0; regs[l].forEach(function (p) { var c = yx(p, W); sy += c[0]; sx += c[1]; });
      G.addNode(nid, { pos: [sy / regs[l].length, sx / regs[l].length], kind: "junction" });
      regs[l].forEach(function (p) { nodeOf.set(p, nid); });
      nid++;
    }
    for (i = 0; i < n; i++) if (skel[i] && nb[i] === 1) { var c = yx(i, W); G.addNode(nid, { pos: [c[0], c[1]], kind: "end" }); nodeOf.set(i, nid); nid++; }
    var skelHas = function (q) { return skel[q] === 1; }, stop = nodeOf, seen = new Set();
    nodeOf.forEach(function (id, p) {
      var c = yx(p, W);
      for (var k = 0; k < 8; k++) {
        var yy = c[0] + NB8[k][0], xx = c[1] + NB8[k][1];
        if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        var q = yy * W + xx;
        if (!skel[q] || nodeOf.get(q) === id) continue;
        if (stop.has(q)) {
          var key = Math.min(p, q) + "," + Math.max(p, q);
          if (!seen.has(key) && nodeOf.get(q) !== id) { seen.add(key); G.addEdge(id, nodeOf.get(q), [p, q]); }
          continue;
        }
        if (seen.has(q + "," + p)) continue;
        var path = trace(q, p, skelHas, stop, W, H), end = path[path.length - 1];
        if (path.length > 1) seen.add(path[path.length - 2] + "," + end);
        seen.add(q + "," + p);
        var full = [p].concat(path);
        if (stop.has(end)) {
          var a = full[1], b = full[full.length - 2], tk = "t" + Math.min(a, b) + "," + Math.max(a, b) + "," + full.length;
          if (seen.has(tk)) continue;
          seen.add(tk);
          G.addEdge(id, nodeOf.get(end), full);
        }
      }
    });
    // closed loops without any junction
    var used = new Uint8Array(n);
    G.E.forEach(function (e) { e.path.forEach(function (p) { used[p] = 1; }); });
    var lm = new Uint8Array(n); for (i = 0; i < n; i++) lm[i] = skel[i] && !used[i] && nb[i] === 2 ? 1 : 0;
    var LL = label(lm, W, H, true), lr = regions(LL, W);
    for (l = 1; l <= LL.n; l++) {
      var coords = lr[l]; if (coords.length < 10) continue;
      var s0 = coords[0], set = new Set(coords), c0 = yx(s0, W);
      G.addNode(nid, { pos: [c0[0], c0[1]], kind: "loop" });
      var tp = trace(coords.length > 1 ? coords[1] : s0, s0, function (q) { return set.has(q); }, new Set([s0]), W, H);
      G.addEdge(nid, nid, [s0].concat(tp)); nid++;
    }
    return G;
  }

  function prune(skel, W, H, minLen, hw, rounds) {
    skel = skel.slice();
    for (var r = 0; r < rounds; r++) {
      var G = buildGraph(skel, W, H), removed = 0;
      G.edges().forEach(function (t) {
        var u = t[0], v = t[1], path = t[3].path, du = G.degree(u), dv = G.degree(v);
        var hub = du === 1 ? v : u, pos = G.nodes.get(hub).pos;
        var limit = minLen + 2 * hw[roundHalfEven(pos[0]) * W + roundHalfEven(pos[1])];
        if ((du === 1) !== (dv === 1) && path.length < limit) {
          var inner = du === 1 ? path.slice(0, -1) : path.slice(1);
          inner.forEach(function (p) { skel[p] = 0; });
          removed++;
        }
      });
      skel = skeletonize(skel, W, H);
      if (!removed) break;
    }
    return skel;
  }

  function line8(out, W, x0, y0, x1, y1) { // Bresenham, 8-connected
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      out[y0 * W + x0] = 1;
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function bridge(skel, W, H, maxGap) {
    var G = buildGraph(skel, W, H), out = skel.slice();
    G.nodes.forEach(function (d, n) {
      if (d.kind !== "end" || G.degree(n) !== 1) return;
      var path = G.edgesOf(n)[0][3].path.map(function (p) { return yx(p, W); });
      if (path.length < 6) return;
      var here = d.pos, L = path.length;
      if (Math.hypot(path[0][0] - here[0], path[0][1] - here[1]) > Math.hypot(path[L - 1][0] - here[0], path[L - 1][1] - here[1])) path = path.slice().reverse();
      var k = Math.min(L - 1, 10), dir = [path[0][0] - path[k][0], path[0][1] - path[k][1]], nn = Math.hypot(dir[0], dir[1]) + 1e-9;
      dir = [dir[0] / nn, dir[1] / nn];
      var own = new Set(path.slice(0, 25).map(function (c) { return c[0] * W + c[1]; }));
      var offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var t = 2; t < maxGap; t += 0.5) {
        var qy = roundHalfEven(here[0] + t * dir[0]), qx = roundHalfEven(here[1] + t * dir[1]);
        if (qy < 0 || qy >= H || qx < 0 || qx >= W) break;
        var hit = null;
        for (var o = 0; o < 5 && !hit; o++) {
          var yy = qy + offs[o][0], xx = qx + offs[o][1];
          if (yy >= 0 && yy < H && xx >= 0 && xx < W && skel[yy * W + xx] && !own.has(yy * W + xx)) hit = [yy, xx];
        }
        if (hit) { line8(out, W, Math.trunc(here[1]), Math.trunc(here[0]), hit[1], hit[0]); break; }
      }
    });
    return skeletonize(out, W, H);
  }

  function mergeCloseJunctions(G, hw, W) {
    var changed = true;
    while (changed) {
      changed = false;
      var list = G.edges();
      for (var i = 0; i < list.length; i++) {
        var u = list[i][0], v = list[i][1], key = list[i][2], e = list[i][3];
        if (u === v || G.nodes.get(u).kind !== "junction" || G.nodes.get(v).kind !== "junction") continue;
        var pu = G.nodes.get(u).pos, pv = G.nodes.get(v).pos;
        var w = 2 * Math.max(hw[Math.trunc(pu[0]) * W + Math.trunc(pu[1])], hw[Math.trunc(pv[0]) * W + Math.trunc(pv[1])]);
        if (e.path.length <= Math.max(4, w)) {
          G.removeEdge(key);
          G.edgesOf(v).forEach(function (t) { G.addEdge(u, t[1] !== v ? t[1] : u, t[3].path); });
          G.removeNode(v);
          G.nodes.get(u).pos = [(pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2];
          changed = true;
          break;
        }
      }
    }
    return G.relabel();
  }

  function skeletonGraph(mask, W, H, P) {
    var hw = edt(mask, W, H), skel = skeletonize(mask, W, H);
    skel = prune(skel, W, H, P.prune, hw, 3);
    if (P.bridge > 0) { skel = bridge(skel, W, H, P.bridge); skel = prune(skel, W, H, P.prune, hw, 1); }
    return { skel: skel, G: mergeCloseJunctions(buildGraph(skel, W, H), hw, W), hw: hw };
  }

  /* ---------------- measurements ---------------- */
  var GK = (function () { var s = 2, r = Math.floor(4 * s + 0.5), k = [], t = 0; for (var i = -r; i <= r; i++) { var v = Math.exp(-0.5 * i * i / (s * s)); k.push(v); t += v; } return k.map(function (v) { return v / t; }); })();
  function pathLength(P) { // P: [[y,x],...]
    var n = P.length;
    if (n < 3) return n === 2 ? Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) : 0;
    var r = (GK.length - 1) / 2, sm = [];
    for (var i = 0; i < n; i++) {
      var y = 0, x = 0;
      for (var k = -r; k <= r; k++) { var j = Math.min(n - 1, Math.max(0, i + k)); y += GK[k + r] * P[j][0]; x += GK[k + r] * P[j][1]; }
      sm.push([y, x]);
    }
    sm[0] = P[0]; sm[n - 1] = P[n - 1];
    var L = 0; for (i = 1; i < n; i++) L += Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1]);
    return L;
  }
  function branchDir(here, P, reach) {
    var L = P.length;
    if (Math.hypot(P[0][0] - here[0], P[0][1] - here[1]) > Math.hypot(P[L - 1][0] - here[0], P[L - 1][1] - here[1])) P = P.slice().reverse();
    var k = Math.min(L - 1, Math.trunc(reach)), v = [P[k][0] - here[0], P[k][1] - here[1]], n = Math.hypot(v[0], v[1]) + 1e-9;
    return [v[0] / n, v[1] / n];
  }
  function atBorder(pos, H, W, m) { return pos[0] < m || pos[1] < m || pos[0] > H - 1 - m || pos[1] > W - 1 - m; }

  function measure(mask, skel, G, hw, W, H, polarity, ppm) {
    var edges = [], junctions = [], cellStats = [], i;
    var paths = new Map();
    G.edges().forEach(function (t, idx) {
      var P = t[3].path.map(function (p) { return yx(p, W); }); paths.set(t[2], P);
      var length = pathLength(P), a = P[0], b = P[P.length - 1], chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var ang = pmod(Math.atan2(-(b[0] - a[0]), b[1] - a[1]) * 180 / Math.PI, 180);
      var width = median(P.map(function (c) { return 2 * hw[c[0] * W + c[1]]; }));
      edges.push({ id: idx, u: t[0], v: t[1], length: length, chord: chord, tortuosity: chord > 0 ? length / chord : Infinity, orientation_deg: ang, width: width, path: P });
    });
    var bg = new Uint8Array(W * H); for (i = 0; i < W * H; i++) bg[i] = skel[i] ? 0 : 1;
    var CL = label(bg, W, H, false), lab = CL.lab, border = new Set();
    for (var x = 0; x < W; x++) { border.add(lab[x]); border.add(lab[(H - 1) * W + x]); }
    for (var y = 0; y < H; y++) { border.add(lab[y * W]); border.add(lab[y * W + W - 1]); }
    var corners = new Map();
    G.nodes.forEach(function (nd, n) {
      var deg = G.degree(n); if (deg < 3) return;
      var here = nd.pos, reach = Math.max(6, 2 * hw[Math.trunc(here[0]) * W + Math.trunc(here[1])] + 4);
      var dirs = G.edgesOf(n).map(function (t) { return branchDir(here, paths.get(t[2]), reach); });
      var ang = dirs.map(function (v) { return Math.atan2(-v[0], v[1]); }).sort(function (a, b) { return a - b; });
      var gaps = ang.map(function (a, k) { return (k < ang.length - 1 ? ang[k + 1] : ang[0] + 2 * Math.PI) - a; });
      ang.forEach(function (a0, k) {
        var g = gaps[k];
        if (g * 180 / Math.PI < 155) {
          var mid = a0 + g / 2, qy = roundHalfEven(here[0] + 1.5 * reach * -Math.sin(mid)), qx = roundHalfEven(here[1] + 1.5 * reach * Math.cos(mid));
          if (qy >= 0 && qy < H && qx >= 0 && qx < W && lab[qy * W + qx]) { var L = lab[qy * W + qx]; corners.set(L, (corners.get(L) || 0) + 1); }
        }
      });
      if (atBorder(here, H, W, 5)) return;
      var gd = gaps.map(function (g) { return g * 180 / Math.PI; });
      nd.type = gd.length >= 4 ? "X" : (Math.max.apply(null, gd) >= 150 ? "T" : "Y");
      junctions.push({ node: n, y: here[0], x: here[1], degree: deg, angles_deg: gd.slice().sort(function (a, b) { return a - b; }).map(function (v) { return Math.round(v * 10) / 10; }), type: nd.type });
    });
    var cells = new Int32Array(W * H), regs = regions(CL, W), k = 0;
    for (var l = 1; l <= CL.n; l++) {
      if (border.has(l) || regs[l].length < 30) continue;
      k++;
      regs[l].forEach(function (p) { cells[p] = k; });
      var ax = axes(regs[l], W);
      cellStats.push({ id: k, area: regs[l].length, corners: corners.get(l) || 0, eq_diameter: Math.sqrt(4 * regs[l].length / Math.PI), elongation: ax.major / Math.max(ax.minor, 1) });
    }
    var net = { W: W, H: H, mask: mask, skel: skel, cells: cells, polarity: polarity, ppm: ppm, edges: edges, junctions: junctions, cellStats: cellStats,
      nodes: [] };
    G.nodes.forEach(function (nd, n) { net.nodes.push({ id: n, y: nd.pos[0], x: nd.pos[1], kind: nd.kind, type: nd.type || null }); });
    net.summary = summary(net);
    return net;
  }

  function summary(net) {
    var u = net.ppm ? "mm" : "px", Lf = function (v) { return net.ppm ? v / net.ppm : v; }, Af = function (v) { return net.ppm ? v / (net.ppm * net.ppm) : v; };
    var W = net.W, H = net.H, total = 0, kinds = net.junctions.map(function (j) { return j.type; });
    net.edges.forEach(function (e) { total += e.length; });
    var cnt = function (t) { return kinds.filter(function (k) { return k === t; }).length; };
    var ends = net.nodes.filter(function (d) { return d.kind === "end" && !atBorder([d.y, d.x], H, W, 3); }).length;
    var re = 0, im = 0, ws = 0;
    net.edges.forEach(function (e) { var th = e.orientation_deg * Math.PI / 180; re += e.length * Math.cos(2 * th); im += e.length * Math.sin(2 * th); ws += e.length; });
    var aniso = net.edges.length ? Math.hypot(re, im) / Math.max(ws, 1e-9) : 0;
    var dom = net.edges.length ? pmod(Math.atan2(im, re) * 180 / Math.PI / 2, 180) : 0;
    var areas = net.cellStats.map(function (c) { return c.area; }), sides = net.cellStats.map(function (c) { return c.corners; });
    var area = 0; for (var i = 0; i < net.mask.length; i++) area += net.mask[i];
    var T = cnt("T"), Y = cnt("Y");
    var r = function (v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; };
    var s = {};
    s.polarity = net.polarity;
    s["total_crack_length_" + u] = r(Lf(total), 1);
    s["crack_density_" + u + "_per_" + u + "2"] = r(Lf(total) / Af(H * W), 4);
    s["crack_area_%"] = r(100 * area / (W * H), 2);
    s.segments = net.edges.length;
    s["median_segment_length_" + u] = net.edges.length ? r(Lf(median(net.edges.map(function (e) { return e.length; }))), 1) : 0;
    s["median_width_" + u] = net.edges.length ? r(Lf(median(net.edges.map(function (e) { return e.width; }))), 2) : 0;
    s.junctions = kinds.length; s.T_junctions = T; s.Y_junctions = Y; s.X_junctions = cnt("X");
    s.T_fraction = r(T / Math.max(T + Y, 1), 2);
    s.free_crack_ends = ends;
    s.closed_cells = net.cellStats.length;
    s["median_cell_area_" + u + "2"] = areas.length ? r(Af(median(areas)), 1) : 0;
    s.mean_cell_corners = sides.length ? r(sides.reduce(function (a, b) { return a + b; }, 0) / sides.length, 2) : 0;
    s.orientation_anisotropy = r(aniso, 2);
    s.dominant_orientation_deg = Math.round(dom);
    return s;
  }

  function analyse(rgba, W, H, P) {
    var t0 = Date.now(), seg = segment(rgba, W, H, P), t1 = Date.now();
    var sg = skeletonGraph(seg.mask, W, H, P), t2 = Date.now();
    var net = measure(seg.mask, sg.skel, sg.G, sg.hw, W, H, seg.polarity, P.ppm || null);
    net.timing = { segment: t1 - t0, graph: t2 - t1, measure: Date.now() - t2, total: Date.now() - t0 };
    return net;
  }

  return { analyse: analyse };
})();

if (typeof window === "undefined" && typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = function (e) {
    try { self.postMessage({ ok: true, id: e.data.id, net: CNG.analyse(e.data.rgba, e.data.W, e.data.H, e.data.params) }); }
    catch (err) { self.postMessage({ ok: false, id: e.data.id, error: String(err && err.stack || err) }); }
  };
}
