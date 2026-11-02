/*
 * Live crack-analysis demo.
 * A simplified, in-browser re-implementation of the classical pipeline:
 *   grayscale -> black top-hat -> threshold (Otsu or manual) -> small-object removal
 *   -> Zhang–Suen skeletonization -> junctions / endpoints / length / line-intercept density.
 * Synthetic samples come with a known ground-truth mask, so detection quality (F1) is computed live.
 */
(function () {
  "use strict";
  var root = document.getElementById("crackDemo");
  if (!root) return;

  var canvas = document.getElementById("cdCanvas");
  var ctx = canvas.getContext("2d");
  var $ = function (id) { return document.getElementById(id); };
  var W = 480, H = 320;

  var state = {
    gray: null,      // Float32Array original grayscale 0..255
    gt: null,        // Uint8Array ground truth (synthetic only)
    seed: 7,
    view: "overlay",
    result: null
  };

  /* ---------- helpers ---------- */
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function hexToRgb(c) {
    var m = /^#?([0-9a-f]{6})$/i.exec(c);
    if (!m) return [15, 95, 92];
    var n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }

  /* ---------- synthetic sample ---------- */
  function synth(seed) {
    var r = rng(seed);
    var off = document.createElement("canvas"); off.width = W; off.height = H;
    var o = off.getContext("2d");
    var gtc = document.createElement("canvas"); gtc.width = W; gtc.height = H;
    var g = gtc.getContext("2d");

    o.fillStyle = "rgb(176,176,176)"; o.fillRect(0, 0, W, H);
    // uneven illumination
    var grad = o.createRadialGradient(W * r(), H * r(), 20, W / 2, H / 2, W * 0.8);
    grad.addColorStop(0, "rgba(255,255,255,0.22)"); grad.addColorStop(1, "rgba(0,0,0,0.18)");
    o.fillStyle = grad; o.fillRect(0, 0, W, H);
    // grain / surface texture
    for (var i = 0; i < 900; i++) {
      var v = 140 + Math.round(r() * 80);
      o.fillStyle = "rgba(" + v + "," + v + "," + v + ",0.35)";
      o.beginPath();
      o.ellipse(r() * W, r() * H, 1 + r() * 5, 1 + r() * 4, r() * Math.PI, 0, Math.PI * 2);
      o.fill();
    }
    // crack network
    o.lineCap = g.lineCap = "round"; o.lineJoin = g.lineJoin = "round";
    function crack(x, y, a, len, w, depth) {
      var steps = Math.max(4, Math.round(len / 10));
      o.beginPath(); g.beginPath(); o.moveTo(x, y); g.moveTo(x, y);
      var branches = [];
      for (var s = 0; s < steps; s++) {
        a += (r() - 0.5) * 0.55;
        x += Math.cos(a) * len / steps; y += Math.sin(a) * len / steps;
        o.lineTo(x, y); g.lineTo(x, y);
        if (depth < 2 && r() < 0.08) branches.push([x, y, a + (r() < 0.5 ? 1 : -1) * (0.9 + r() * 0.6)]);
      }
      var shade = 55 + Math.round(r() * 35);
      o.strokeStyle = "rgba(" + shade + "," + shade + "," + shade + ",0.92)";
      o.lineWidth = w; o.stroke();
      g.strokeStyle = "#000"; g.lineWidth = Math.max(1, w); g.stroke();
      branches.forEach(function (b) { crack(b[0], b[1], b[2], len * (0.3 + r() * 0.35), w * 0.75, depth + 1); });
    }
    var n = 4 + Math.floor(r() * 3);
    for (var k = 0; k < n; k++) {
      var sx = r() * W, sy = r() * H, a = r() * Math.PI * 2, L = 160 + r() * 240, w = 1.6 + r() * 1.8;
      crack(sx, sy, a, L, w, 0);
      crack(sx, sy, a + Math.PI + (r() - 0.5) * 0.5, L * 0.6, w, 0);
    }

    var px = o.getImageData(0, 0, W, H).data, gp = g.getImageData(0, 0, W, H).data;
    var gray = new Float32Array(W * H), gt = new Uint8Array(W * H);
    for (var p = 0; p < W * H; p++) {
      gray[p] = px[p * 4];
      gt[p] = gp[p * 4 + 3] > 110 ? 1 : 0;
    }
    gray = boxBlur(gray, W, H);
    // sensor noise (Box–Muller)
    for (var q = 0; q < W * H; q++) {
      var u = r() || 1e-9, z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
      gray[q] = Math.max(0, Math.min(255, gray[q] + z * 9));
    }
    return { gray: gray, gt: gt };
  }

  function loadImage(file) {
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 640 / img.width, 480 / img.height);
      W = Math.max(32, Math.round(img.width * scale)); H = Math.max(32, Math.round(img.height * scale));
      var off = document.createElement("canvas"); off.width = W; off.height = H;
      var o = off.getContext("2d"); o.drawImage(img, 0, 0, W, H);
      var d = o.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
      for (var p = 0; p < W * H; p++) gray[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
      state.gray = gray; state.gt = null;
      $("cdSource").textContent = file.name + " · " + W + "×" + H + " px (scaled)";
      URL.revokeObjectURL(img.src);
      run();
    };
    img.onerror = function () { $("cdSource").textContent = "Could not read that image."; };
    img.src = URL.createObjectURL(file);
  }

  /* ---------- image ops ---------- */
  function boxBlur(src, w, h) {
    var out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var s = 0, c = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += src[yy * w + xx]; c++; }
      }
      out[y * w + x] = s / c;
    }
    return out;
  }
  // separable square min/max filter
  function rankFilter(src, w, h, k, isMax) {
    var r = k >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var f = isMax ? Math.max : Math.min;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var v = src[row + x];
        for (var d = 1; d <= r; d++) {
          if (x - d >= 0) v = f(v, src[row + x - d]);
          if (x + d < w) v = f(v, src[row + x + d]);
        }
        tmp[row + x] = v;
      }
    }
    for (var y2 = 0; y2 < h; y2++) for (var x2 = 0; x2 < w; x2++) {
      var v2 = tmp[y2 * w + x2];
      for (var d2 = 1; d2 <= r; d2++) {
        if (y2 - d2 >= 0) v2 = f(v2, tmp[(y2 - d2) * w + x2]);
        if (y2 + d2 < h) v2 = f(v2, tmp[(y2 + d2) * w + x2]);
      }
      out[y2 * w + x2] = v2;
    }
    return out;
  }
  function topHat(gray, w, h, k, darkCracks) {
    var out = new Float32Array(w * h);
    if (darkCracks) { // black top-hat: closing - image
      var closed = rankFilter(rankFilter(gray, w, h, k, true), w, h, k, false);
      for (var i = 0; i < w * h; i++) out[i] = closed[i] - gray[i];
    } else {          // white top-hat: image - opening
      var opened = rankFilter(rankFilter(gray, w, h, k, false), w, h, k, true);
      for (var j = 0; j < w * h; j++) out[j] = gray[j] - opened[j];
    }
    return out;
  }
  function otsu(arr) {
    var hist = new Float64Array(256), n = arr.length;
    for (var i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(arr[i])))]++;
    var sum = 0; for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = 0, thr = 0;
    for (var t2 = 0; t2 < 256; t2++) {
      wB += hist[t2]; if (!wB) continue;
      var wF = n - wB; if (!wF) break;
      sumB += t2 * hist[t2];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t2; }
    }
    return thr;
  }
  var N8 = function (w) { return [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]; };
  function removeSmall(bin, w, h, minArea) {
    var lab = new Int32Array(w * h), out = new Uint8Array(w * h), stack = [], comp = [], id = 0;
    for (var s = 0; s < w * h; s++) {
      if (!bin[s] || lab[s]) continue;
      id++; stack.length = 0; comp.length = 0; stack.push(s); lab[s] = id;
      while (stack.length) {
        var p = stack.pop(); comp.push(p);
        var x = p % w, y = (p - x) / w;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          var q = yy * w + xx;
          if (bin[q] && !lab[q]) { lab[q] = id; stack.push(q); }
        }
      }
      if (comp.length >= minArea) for (var c = 0; c < comp.length; c++) out[comp[c]] = 1;
    }
    return out;
  }
  function thin(bin, w, h) { // Zhang–Suen
    var img = bin.slice(), del = [], changed = true;
    for (var x0 = 0; x0 < w; x0++) { img[x0] = 0; img[(h - 1) * w + x0] = 0; }
    for (var y0 = 0; y0 < h; y0++) { img[y0 * w] = 0; img[y0 * w + w - 1] = 0; }
    while (changed) {
      changed = false;
      for (var pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
          var i = y * w + x; if (!img[i]) continue;
          var p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1],
              p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
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
    return img;
  }
  function dilate(bin, w, h, r) {
    var f = new Float32Array(w * h); for (var i = 0; i < w * h; i++) f[i] = bin[i];
    var d = rankFilter(f, w, h, 2 * r + 1, true), out = new Uint8Array(w * h);
    for (var j = 0; j < w * h; j++) out[j] = d[j] > 0.5 ? 1 : 0;
    return out;
  }

  // crossing number: 0->1 transitions around the 8-ring (1 = endpoint, >=3 = junction)
  function crossing(img, i, w) {
    var r = [img[i - w], img[i - w + 1], img[i + 1], img[i + w + 1], img[i + w], img[i + w - 1], img[i - 1], img[i - w - 1]];
    var c = 0; for (var k = 0; k < 8; k++) if (!r[k] && r[(k + 1) & 7]) c++;
    return c;
  }
  // remove short side branches (spurs) left by skeletonizing noisy crack borders
  function prune(skel, w, h, maxLen) {
    var nb = N8(w), out = skel.slice();
    function deg(i) { var n = 0; for (var k = 0; k < 8; k++) n += out[i + nb[k]]; return n; }
    for (var iter = 0; iter < 2; iter++) {
      for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        if (!out[i] || crossing(out, i, w) !== 1) continue;
        var path = [i], prev = -1, cur = i, hitJunction = false;
        while (path.length <= maxLen) {
          var next = -1;
          for (var k = 0; k < 8; k++) { var q = cur + nb[k]; if (out[q] && q !== prev && path.indexOf(q) < 0) { next = q; break; } }
          if (next < 0) break;
          if (crossing(out, next, w) >= 3) { hitJunction = true; break; }
          path.push(next); prev = cur; cur = next;
        }
        if (hitJunction && path.length <= maxLen) for (var d = 0; d < path.length; d++) out[path[d]] = 0;
      }
    }
    return out;
  }

  /* ---------- analysis ---------- */
  function analyse(skel, mask, w, h, umPerPx) {
    var nb = N8(w), length = 0, ends = [], junc = new Uint8Array(w * h), nJ = 0;
    for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
      var i = y * w + x; if (!skel[i]) continue;
      var n = 0; for (var k = 0; k < 8; k++) n += skel[i + nb[k]];
      if (skel[i + 1]) length += 1;
      if (skel[i + w]) length += 1;
      if (skel[i + w + 1] && !skel[i + 1] && !skel[i + w]) length += Math.SQRT2;
      if (skel[i + w - 1] && !skel[i - 1] && !skel[i + w]) length += Math.SQRT2;
      var cn = crossing(skel, i, w);
      if (cn === 1 || n === 1) ends.push(i);
      if (cn >= 3) { junc[i] = 1; nJ++; }
    }
    // cluster junction pixels -> junction points
    var seen = new Uint8Array(w * h), junctions = [];
    for (var s = 0; s < w * h; s++) {
      if (!junc[s] || seen[s]) continue;
      var st = [s], sx = 0, sy = 0, c = 0; seen[s] = 1;
      while (st.length) {
        var p = st.pop(), px = p % w, py = (p - px) / w; sx += px; sy += py; c++;
        for (var kk = 0; kk < 8; kk++) {
          var q = p + nb[kk];
          if (q >= 0 && q < w * h && junc[q] && !seen[q]) { seen[q] = 1; st.push(q); }
        }
      }
      junctions.push([sx / c, sy / c]);
    }
    // merge junctions closer than 6 px (one physical junction often yields two skeleton nodes)
    var merged = [];
    junctions.forEach(function (j) {
      for (var m = 0; m < merged.length; m++) {
        var dx = merged[m][0] - j[0], dy = merged[m][1] - j[1];
        if (dx * dx + dy * dy < 36) { merged[m] = [(merged[m][0] + j[0]) / 2, (merged[m][1] + j[1]) / 2]; return; }
      }
      merged.push(j);
    });
    junctions = merged;
    // line-intercept crack density: crossings along a grid of test lines
    var step = 16, crossings = 0, lineLen = 0;
    for (var ly = step / 2; ly < h; ly += step) {
      var prev = 0; lineLen += w;
      for (var lx = 0; lx < w; lx++) { var v = mask[ly * w + lx]; if (v && !prev) crossings++; prev = v; }
    }
    for (var cx = step / 2; cx < w; cx += step) {
      var prev2 = 0; lineLen += h;
      for (var cy = 0; cy < h; cy++) { var v2 = mask[cy * w + cx]; if (v2 && !prev2) crossings++; prev2 = v2; }
    }
    var area = 0; for (var a = 0; a < w * h; a++) area += mask[a];
    var lineCm = lineLen * umPerPx / 1e4;
    return {
      lengthUm: length * umPerPx,
      junctions: junctions,
      ends: ends,
      density: lineCm > 0 ? crossings / lineCm : 0,
      areaFrac: area / (w * h)
    };
  }
  function f1(pred, gt, w, h) {
    var gtD = dilate(gt, w, h, 2), prD = dilate(pred, w, h, 2), tp = 0, np = 0, tg = 0, ng = 0;
    for (var i = 0; i < w * h; i++) {
      if (pred[i]) { np++; if (gtD[i]) tp++; }
      if (gt[i]) { ng++; if (prD[i]) tg++; }
    }
    var P = np ? tp / np : 0, R = ng ? tg / ng : 0;
    return { p: P, r: R, f: P + R ? 2 * P * R / (P + R) : 0 };
  }

  /* ---------- pipeline ---------- */
  function run() {
    if (!state.gray) return;
    var t0 = performance.now();
    var k = +$("cdKernel").value | 1;
    var auto = $("cdAuto").checked;
    var dark = $("cdDark").checked;
    var minArea = +$("cdMin").value;
    var umPerPx = parseFloat($("cdScale").value) || 1;

    var th = topHat(state.gray, W, H, k, dark);
    var thr = auto ? otsu(th) : +$("cdThr").value;
    if (auto) $("cdThr").value = thr;
    $("cdThr").disabled = auto;
    var bin = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) bin[i] = th[i] > thr ? 1 : 0;
    var mask = removeSmall(bin, W, H, minArea);
    var skel = prune(thin(mask, W, H), W, H, 10);
    var m = analyse(skel, mask, W, H, umPerPx);
    var q = state.gt ? f1(mask, state.gt, W, H) : null;
    var ms = performance.now() - t0;

    state.result = { th: th, mask: mask, skel: skel, m: m };
    $("cdKernelOut").textContent = k + " px";
    $("cdThrOut").textContent = thr + (auto ? " (Otsu)" : "");
    $("cdMinOut").textContent = minArea + " px";

    $("mLen").textContent = fmt(m.lengthUm) + " µm";
    $("mDens").textContent = fmt(m.density) + " /cm";
    $("mJunc").textContent = m.junctions.length;
    $("mEnds").textContent = m.ends.length;
    $("mArea").textContent = (m.areaFrac * 100).toFixed(1) + " %";
    $("mF1").textContent = q ? q.f.toFixed(3) : "n/a";
    $("mF1Sub").textContent = q ? "P " + q.p.toFixed(2) + " · R " + q.r.toFixed(2) : "no ground truth for uploads";
    $("cdTime").textContent = "processed in " + Math.round(ms) + " ms";
    draw();
  }
  function fmt(v) {
    return v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }

  function draw() {
    if (!state.result) return;
    canvas.width = W; canvas.height = H;
    var res = state.result, img = ctx.createImageData(W, H), d = img.data, view = state.view;
    var acc = hexToRgb(cssVar("--accent")), warm = hexToRgb(cssVar("--warm"));
    var thMax = 1; if (view === "tophat") for (var t = 0; t < W * H; t++) if (res.th[t] > thMax) thMax = res.th[t];
    for (var i = 0; i < W * H; i++) {
      var o = i * 4, g = state.gray[i], rr, gg, bb;
      if (view === "original") { rr = gg = bb = g; }
      else if (view === "tophat") { rr = gg = bb = Math.min(255, res.th[i] / thMax * 255 * 1.6); }
      else if (view === "mask") { rr = gg = bb = res.mask[i] ? 255 : 18; }
      else {
        rr = gg = bb = g * 0.7 + 30;
        if (res.mask[i]) { rr = rr * 0.45 + acc[0] * 0.55; gg = gg * 0.45 + acc[1] * 0.55; bb = bb * 0.45 + acc[2] * 0.55; }
        if (res.skel[i]) { rr = warm[0]; gg = warm[1]; bb = warm[2]; }
      }
      d[o] = rr; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (view === "overlay") {
      ctx.lineWidth = 1.5;
      res.m.junctions.forEach(function (j) {
        ctx.beginPath(); ctx.arc(j[0], j[1], 3.2, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd166"; ctx.fill(); ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();
      });
    }
  }

  /* ---------- wiring ---------- */
  var pending;
  function schedule() { cancelAnimationFrame(pending); pending = requestAnimationFrame(run); }
  ["cdKernel", "cdThr", "cdMin"].forEach(function (id) { $(id).addEventListener("input", schedule); });
  ["cdAuto", "cdDark"].forEach(function (id) { $(id).addEventListener("change", schedule); });
  $("cdScale").addEventListener("change", schedule);

  document.querySelectorAll("#crackDemo .cd-views button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("#crackDemo .cd-views button").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      b.setAttribute("aria-pressed", "true");
      state.view = b.dataset.view; draw();
    });
  });

  function newSample() {
    W = 480; H = 320;
    var s = synth(state.seed);
    state.gray = s.gray; state.gt = s.gt;
    $("cdSource").textContent = "Synthetic sample #" + state.seed + " · " + W + "×" + H + " px · ground truth known";
    $("cdDark").checked = true;
    run();
  }
  $("cdNew").addEventListener("click", function () { state.seed = Math.floor(Math.random() * 1e6); newSample(); });
  $("cdFile").addEventListener("change", function (e) { if (e.target.files[0]) loadImage(e.target.files[0]); });

  // re-tint overlay when theme changes
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // start when the demo scrolls near the viewport
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (en) {
      if (en[0].isIntersecting) { io.disconnect(); newSample(); }
    }, { rootMargin: "300px" });
    io.observe(root);
  } else newSample();
})();
