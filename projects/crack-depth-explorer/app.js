(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = ["top", "right", "bottom", "left"];
  var AZ = [90, 0, 270, 180];
  var PARAMS = { maxWidth: 7, seed: 0.4, edge: 0.15, minElong: 3, minSeg: 2 };

  var S = {
    W: 640, H: 480, pxmm: 0.1, detrend: null, dataId: "demo",
    photos: null, use: [1, 1, 1, 1], elevation: 45,
    truthPts: null, truthH: null, isDemo: true,
    res: null, view: "depth", line: null, pending: [], seq: 0, busy: false, queued: false
  };

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  /* ---------- colour maps ---------- */
  var VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
  var INFERNO = [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]];
  function cmap(stops, t) {
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function gradientCss(stops) {
    return "linear-gradient(90deg," + stops.map(function (c, i) { return "rgb(" + c.join(",") + ") " + Math.round(100 * i / (stops.length - 1)) + "%"; }).join(",") + ")";
  }
  function percentile(arr, p) {
    var step = Math.max(1, Math.floor(arr.length / 20000)), s = [];
    for (var i = 0; i < arr.length; i += step) s.push(arr[i]);
    s.sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  /* ---------- worker ---------- */
  var worker = null, fallback = false;
  try {
    worker = new Worker("pipeline.js");
    worker.onmessage = onWorker;
    worker.onerror = function (e) { e.preventDefault && e.preventDefault(); worker = null; fallback = true; S.busy = false; compute(); };
  } catch (e) { fallback = true; }

  function loadFallback(cb) {
    if (window.CDE) return cb();
    var s = document.createElement("script"); s.src = "pipeline.js"; s.onload = cb; document.head.appendChild(s);
  }

  function compute() {
    if (!S.photos) return;
    if (S.busy) { S.queued = true; return; }
    S.busy = true; S.queued = false;
    $("busy").hidden = false;
    var msg = {
      id: ++S.seq, W: S.W, H: S.H, photos: S.photos, az: AZ, elevation: S.elevation, use: S.use.slice(),
      pxmm: S.pxmm, detrend: S.detrend, dataId: S.dataId, params: Object.assign({}, PARAMS)
    };
    if (worker && !fallback) { worker.postMessage(msg); return; }
    loadFallback(function () {
      setTimeout(function () {
        try { onWorker({ data: { ok: true, id: msg.id, r: window.CDE.run(msg) } }); }
        catch (err) { onWorker({ data: { ok: false, error: String(err) } }); }
      }, 30);
    });
  }

  function onWorker(e) {
    S.busy = false;
    if (S.queued) { compute(); return; }
    $("busy").hidden = true;
    if (!e.data.ok) { $("timing").textContent = "error: " + e.data.error.split("\n")[0]; return; }
    S.res = e.data.r;
    var t = S.res.timing;
    $("timing").textContent = (t.normals != null ? "reconstructed + analysed" : "analysed") + " in " + (t.total / 1000).toFixed(1) + " s";
    if (!S.line) S.line = defaultLine();
    renderView(); renderSummary(); renderAccuracy(); renderSegments(); renderProfile(); update3D();
  }

  /* ---------- loading ---------- */
  function imageToGray(img, W, H) {
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var x = c.getContext("2d"); x.drawImage(img, 0, 0, W, H);
    var d = x.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) g[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    return g;
  }
  function loadImg(src) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; });
  }

  function loadDemo() {
    var names = ["N", "E", "S", "W"];
    return Promise.all(names.map(function (n) { return loadImg("data/scene_" + n + ".png"); })).then(function (imgs) {
      S.W = imgs[0].naturalWidth; S.H = imgs[0].naturalHeight; S.pxmm = 0.1; S.detrend = null; S.dataId = "demo";
      S.photos = imgs.map(function (im) { return imageToGray(im, S.W, S.H); });
      S.isDemo = true; S.line = null;
      return Promise.all([
        fetch("data/truth_points.bin").then(function (r) { return r.arrayBuffer(); }),
        fetch("data/truth_height.bin").then(function (r) { return r.arrayBuffer(); })
      ]).then(function (b) {
        var m = b[0].byteLength / 6;
        S.truthPts = { idx: new Uint32Array(b[0], 0, m), depth: new Uint16Array(b[0], m * 4, m) };
        S.truthH = new Int16Array(b[1]);
      }).catch(function () { S.truthPts = null; S.truthH = null; });
    }).then(function () { buildThumbs(); compute(); });
  }

  /* ---------- thumbnails / light toggles ---------- */
  function buildThumbs() {
    var box = $("photos"); box.innerHTML = "";
    S.photos.forEach(function (g, i) {
      var fig = document.createElement("figure"); fig.className = "pj-photo" + (S.use[i] ? "" : " off");
      var c = document.createElement("canvas"); c.width = S.W; c.height = S.H;
      var x = c.getContext("2d"), im = x.createImageData(S.W, S.H);
      for (var p = 0; p < S.W * S.H; p++) { im.data[p * 4] = im.data[p * 4 + 1] = im.data[p * 4 + 2] = g[p]; im.data[p * 4 + 3] = 255; }
      x.putImageData(im, 0, 0);
      var lab = document.createElement("label");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!S.use[i];
      cb.setAttribute("aria-label", "Use photo with light from " + NAMES[i]);
      cb.addEventListener("change", function () {
        if (!cb.checked && S.use.reduce(function (a, b) { return a + b; }, 0) <= 3) {
          cb.checked = true; $("elevHint").textContent = "At least three lights are needed to solve for the surface normal.";
          return;
        }
        S.use[i] = cb.checked ? 1 : 0; fig.classList.toggle("off", !cb.checked); compute();
      });
      lab.appendChild(cb); lab.appendChild(document.createTextNode("light from " + NAMES[i]));
      fig.appendChild(c); fig.appendChild(lab); box.appendChild(fig);
    });
  }

  /* ---------- main view ---------- */
  var view = $("view"), vctx = view.getContext("2d");
  function renderView() {
    var r = S.res; if (!r) return;
    var W = r.W, H = r.H, n = W * H;
    view.width = W; view.height = H;
    var img = vctx.createImageData(W, H), d = img.data, i, c, v;
    var aMax = percentile(r.albedo, 0.99) || 1;
    var legend = "";
    if (S.view === "height") {
      var lo = percentile(r.height, 0.01), hi = percentile(r.height, 0.995);
      for (i = 0; i < n; i++) { c = cmap(VIRIDIS, (r.height[i] - lo) / (hi - lo || 1)); d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; }
      legend = colorbar(VIRIDIS, lo.toFixed(1) + " mm", hi.toFixed(1) + " mm", "height");
    } else if (S.view === "albedo") {
      for (i = 0; i < n; i++) { v = Math.min(255, 255 * Math.sqrt(r.albedo[i] / aMax)); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      legend = "<span>surface colour with the lighting removed: stains stay, shading disappears</span>";
    } else if (S.view === "single") {
      for (i = 0; i < n; i++) { c = cmap(INFERNO, r.single[i] / 0.6); d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; }
      legend = colorbar(INFERNO, "0", "0.6", "darkness index (no unit)");
    } else if (S.view === "photo") {
      var ph = S.photos[0];
      for (i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = ph[i];
      legend = "<span>input photo, light from the top</span>";
    } else {
      for (i = 0; i < n; i++) {
        v = 40 + 150 * Math.sqrt(Math.min(1, r.albedo[i] / aMax));
        if (r.mask[i]) { c = cmap(INFERNO, 0.15 + 0.85 * r.depth[i] / 3); d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; }
        else { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
        if (r.skel[i] && r.segLab[i]) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; }
      }
      legend = colorbar(INFERNO.slice(1), "0", "3 mm", "depth below local surface") + "<span>white: centre lines</span>";
    }
    for (i = 0; i < n; i++) d[i * 4 + 3] = 255;
    vctx.putImageData(img, 0, 0);

    if (S.view === "depth") { // segment numbers (top 12 by length)
      vctx.font = "600 13px Inter, sans-serif"; vctx.textAlign = "center"; vctx.textBaseline = "middle";
      topSegments(12).forEach(function (s) {
        vctx.fillStyle = "rgba(10,14,13,.78)"; vctx.beginPath(); vctx.arc(s.cx, s.cy, 10, 0, 7); vctx.fill();
        vctx.fillStyle = "#fff"; vctx.fillText(s.rank, s.cx, s.cy + 0.5);
      });
    }
    if (S.line) {
      var L = S.line;
      vctx.strokeStyle = "#ffd166"; vctx.lineWidth = 2.5; vctx.setLineDash([]);
      vctx.beginPath(); vctx.moveTo(L[0][0], L[0][1]); if (L[1]) vctx.lineTo(L[1][0], L[1][1]); vctx.stroke();
      L.forEach(function (p, k) {
        if (!p) return;
        vctx.fillStyle = "#ffd166"; vctx.beginPath(); vctx.arc(p[0], p[1], 5, 0, 7); vctx.fill();
        vctx.fillStyle = "#111"; vctx.font = "700 10px Inter, sans-serif"; vctx.fillText(k ? "B" : "A", p[0], p[1] + 0.5);
      });
    }
    $("legend").innerHTML = legend;
  }
  function colorbar(stops, lo, hi, label) {
    return '<span class="pj-cbar">' + lo + ' <i style="background:' + gradientCss(stops) + '"></i> ' + hi + "</span><span>" + label + "</span>";
  }
  function topSegments(k) {
    var segs = (S.res.segments || []).slice().sort(function (a, b) { return b.length_mm - a.length_mm; });
    return segs.slice(0, k).map(function (s, i) { return Object.assign({ rank: i + 1 }, s); });
  }

  view.addEventListener("click", function (e) {
    if (!S.res) return;
    var b = view.getBoundingClientRect();
    var p = [(e.clientX - b.left) * view.width / b.width, (e.clientY - b.top) * view.height / b.height];
    if (!S.line || S.line[1]) S.line = [p, null];
    else S.line[1] = p;
    renderView();
    if (S.line[1]) renderProfile();
  });

  document.querySelectorAll(".cd-views button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".cd-views button").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      btn.setAttribute("aria-pressed", "true"); S.view = btn.dataset.view; renderView();
    });
  });

  /* ---------- summary + accuracy + table ---------- */
  function f(v, d) { return v == null || isNaN(v) ? "–" : v.toFixed(d); }
  function renderSummary() {
    var s = S.res.summary;
    $("sSeg").textContent = s.crack_segments;
    $("sLen").textContent = s.total_length_mm != null ? f(s.total_length_mm, 0) + " mm" : "–";
    $("sMaxD").textContent = s.max_depth_mm != null ? f(s.max_depth_mm, 2) + " mm" : "–";
    $("sMedD").textContent = s.median_depth_mm != null ? f(s.median_depth_mm, 2) + " mm" : "–";
    $("sMedW").textContent = s.median_width_mm != null ? f(s.median_width_mm, 2) + " mm" : "–";
    $("sArea").textContent = s.crack_area_pct != null ? f(s.crack_area_pct, 1) + " %" : "–";
  }
  function maxFilter7(src, W, H) {
    var tmp = new Float32Array(W * H), out = new Float32Array(W * H), x, y, k, v;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      v = -Infinity; for (k = -3; k <= 3; k++) { var xx = x + k; if (xx >= 0 && xx < W && src[y * W + xx] > v) v = src[y * W + xx]; }
      tmp[y * W + x] = v;
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      v = -Infinity; for (k = -3; k <= 3; k++) { var yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x] > v) v = tmp[yy * W + x]; }
      out[y * W + x] = v;
    }
    return out;
  }
  function stats(e, t) {
    var n = e.length, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, ae = new Float64Array(n), sum = 0;
    for (var i = 0; i < n; i++) {
      var x = e[i], y = t[i]; ae[i] = Math.abs(x - y); sum += ae[i];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    ae.sort();
    return { mae: sum / n, med: ae[n >> 1], corr: (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy)) };
  }
  function renderAccuracy() {
    var box = $("accuracy");
    if (!S.isDemo || !S.truthPts) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    var r = S.res, T = S.truthPts, m = T.idx.length;
    var est = maxFilter7(r.depth, r.W, r.H), one = maxFilter7(r.single, r.W, r.H);
    var E = new Float64Array(m), B = new Float64Array(m), Tr = new Float64Array(m), bb = 0, bt = 0;
    for (var i = 0; i < m; i++) { Tr[i] = T.depth[i] / 1000; E[i] = est[T.idx[i]]; B[i] = one[T.idx[i]]; bb += B[i] * B[i]; bt += B[i] * Tr[i]; }
    var sc = bt / bb; for (i = 0; i < m; i++) B[i] *= sc;
    var a = stats(E, Tr), b = stats(B, Tr);
    $("accPts").textContent = "(" + m.toLocaleString("en-US") + " centre-line points)";
    $("aPsMae").textContent = f(a.mae, 2) + " mm"; $("aOneMae").textContent = f(b.mae, 2) + " mm";
    $("aPsMed").textContent = f(a.med, 2) + " mm"; $("aOneMed").textContent = f(b.med, 2) + " mm";
    $("aPsCor").textContent = f(a.corr, 2); $("aOneCor").textContent = f(b.corr, 2);
  }
  function renderSegments() {
    var tb = $("segTable").querySelector("tbody"), rows = topSegments(12);
    tb.innerHTML = rows.length ? rows.map(function (s) {
      return "<tr><td>" + s.rank + "</td><td>" + f(s.length_mm, 1) + " mm</td><td>" + f(s.mean_depth_mm, 2) + " mm</td><td>" +
        f(s.max_depth_mm, 2) + " mm</td><td>" + f(s.mean_width_mm, 2) + " mm</td><td>" + f(s.max_width_mm, 2) + " mm</td></tr>";
    }).join("") : '<tr><td colspan="6">No cracks found with these settings.</td></tr>';
  }

  /* ---------- cross-section ---------- */
  function defaultLine() {
    var r = S.res, W = r.W, H = r.H, segs = topSegments(50);
    // start on the longest crack of typical shape (not a deep, narrow one whose floor is hidden in shadow)
    var top = segs.filter(function (s) { return s.mean_width_mm > 0 && s.mean_depth_mm / s.mean_width_mm < 0.7; })[0] || segs[0];
    if (!top) return [[W * 0.3, H / 2], [W * 0.7, H / 2]];
    // local direction of the longest segment near its centre (PCA of nearby centre-line pixels)
    var id = top.id, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, c = 0;
    for (var y = Math.max(0, top.cy - 12); y < Math.min(H, top.cy + 13); y++)
      for (var x = Math.max(0, top.cx - 12); x < Math.min(W, top.cx + 13); x++)
        if (r.segLab[y * W + x] === id) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; c++; }
    var ang = 0;
    if (c > 2) { var mx = sx / c, my = sy / c; ang = 0.5 * Math.atan2(2 * (sxy / c - mx * my), (sxx / c - mx * mx) - (syy / c - my * my)); }
    var nx = -Math.sin(ang), ny = Math.cos(ang), L = 45;
    function clip(p) { return [Math.max(2, Math.min(W - 3, p[0])), Math.max(2, Math.min(H - 3, p[1]))]; }
    return [clip([top.cx - nx * L, top.cy - ny * L]), clip([top.cx + nx * L, top.cy + ny * L])];
  }
  function bilinear(arr, W, H, x, y, scale) {
    var x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y))), fx = x - x0, fy = y - y0;
    var i = y0 * W + x0;
    return scale * ((arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + W] * (1 - fx) + arr[i + W + 1] * fx) * fy);
  }
  var prof = $("profile"), pctx = prof.getContext("2d");
  function renderProfile() {
    var r = S.res; if (!r || !S.line || !S.line[1]) return;
    var A = S.line[0], B = S.line[1], W = r.W, H = r.H;
    var len = Math.hypot(B[0] - A[0], B[1] - A[1]), N = Math.max(2, Math.round(len * 2)), xs = [], hm = [], ht = [], dp = [];
    for (var k = 0; k <= N; k++) {
      var t = k / N, x = A[0] + (B[0] - A[0]) * t, y = A[1] + (B[1] - A[1]) * t;
      xs.push(t * len * r.pxmm);
      hm.push(bilinear(r.height, W, H, x, y, 1));
      if (S.isDemo && S.truthH) ht.push(bilinear(S.truthH, W, H, x, y, 0.0002));
      dp.push(r.depth[Math.round(y) * W + Math.round(x)] || 0);
    }
    // deepest point and width at half depth along the line
    var im = 0; dp.forEach(function (v, i) { if (v > dp[im]) im = i; });
    var dmax = dp[im], a = im, b = im;
    while (a > 0 && dp[a - 1] >= dmax / 2) a--;
    while (b < N && dp[b + 1] >= dmax / 2) b++;
    var widthMm = dmax > PARAMS.edge ? xs[b] - xs[a] : 0;
    // true depth: nearest true centre-line point to the deepest sample
    var trueDepth = null;
    if (S.isDemo && S.truthPts && dmax > PARAMS.edge) {
      var px = Math.round(A[0] + (B[0] - A[0]) * im / N), py = Math.round(A[1] + (B[1] - A[1]) * im / N), best = 9;
      for (var q = 0; q < S.truthPts.idx.length; q++) {
        var ii = S.truthPts.idx[q], tx = ii % W, ty = (ii - tx) / W, dd = (tx - px) * (tx - px) + (ty - py) * (ty - py);
        if (dd <= best) { best = dd; trueDepth = S.truthPts.depth[q] / 1000; }
      }
    }
    $("profRead").innerHTML = dmax > PARAMS.edge
      ? "depth <b>" + dmax.toFixed(2) + " mm</b>" + (trueDepth != null ? " (true " + trueDepth.toFixed(2) + ")" : "") + " · width <b>" + widthMm.toFixed(2) + " mm</b>"
      : "no crack on this line";

    // draw
    var dpr = window.devicePixelRatio || 1, cw = prof.clientWidth || 640, ch = Math.round(cw * 0.42);
    prof.width = cw * dpr; prof.height = ch * dpr; pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var padL = 44, padR = 10, padT = 10, padB = 28, w = cw - padL - padR, h = ch - padT - padB;
    var all = hm.concat(ht), lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var span = Math.max(1, hi - lo); lo -= span * 0.08; hi += span * 0.08;
    var X = function (v) { return padL + v / xs[N] * w; }, Y = function (v) { return padT + (hi - v) / (hi - lo) * h; };
    var ink = css("--ink-soft"), line = css("--line"), acc = css("--accent"), muted = css("--muted"), warm = css("--warm");
    pctx.clearRect(0, 0, cw, ch);
    pctx.font = "11px JetBrains Mono, monospace"; pctx.fillStyle = muted; pctx.strokeStyle = line; pctx.lineWidth = 1;
    var step = niceStep(hi - lo);
    for (var gv = Math.ceil(lo / step) * step; gv <= hi; gv += step) {
      pctx.beginPath(); pctx.moveTo(padL, Y(gv)); pctx.lineTo(cw - padR, Y(gv)); pctx.stroke();
      pctx.textAlign = "right"; pctx.textBaseline = "middle"; pctx.fillText(gv.toFixed(step < 1 ? 1 : 0), padL - 6, Y(gv));
    }
    var xstep = niceStep(xs[N]);
    pctx.textAlign = "center"; pctx.textBaseline = "top";
    for (var gx = 0; gx <= xs[N] + 1e-9; gx += xstep) if (X(gx) < cw - padR - 92) pctx.fillText(gx.toFixed(xstep < 1 ? 1 : 0), X(gx), padT + h + 6);
    pctx.textAlign = "right"; pctx.fillText("mm along A→B", cw - padR, padT + h + 6);
    pctx.save(); pctx.translate(11, padT + h / 2); pctx.rotate(-Math.PI / 2); pctx.textAlign = "center"; pctx.textBaseline = "middle"; pctx.fillText("height (mm)", 0, 0); pctx.restore();
    if (widthMm > 0) {
      pctx.fillStyle = "color-mix(in srgb, " + warm + " 22%, transparent)";
      pctx.fillStyle = hexA(warm, 0.18);
      pctx.fillRect(X(xs[a]), padT, X(xs[b]) - X(xs[a]), h);
      pctx.strokeStyle = warm; pctx.setLineDash([]); pctx.strokeRect(X(xs[a]) + 0.5, padT + 0.5, X(xs[b]) - X(xs[a]), h - 1);
    }
    if (ht.length) { drawLine(xs, ht, X, Y, muted, [5, 4], 1.5); }
    drawLine(xs, hm, X, Y, acc, [], 2.2);
    pctx.fillStyle = ink;
  }
  function hexA(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return "rgba(180,83,42," + a + ")";
    var n = parseInt(m[1], 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }
  function drawLine(xs, ys, X, Y, color, dash, w) {
    pctx.strokeStyle = color; pctx.lineWidth = w; pctx.setLineDash(dash); pctx.beginPath();
    for (var i = 0; i < xs.length; i++) { if (i) pctx.lineTo(X(xs[i]), Y(ys[i])); else pctx.moveTo(X(xs[i]), Y(ys[i])); }
    pctx.stroke(); pctx.setLineDash([]);
  }
  function niceStep(range) {
    var raw = range / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  /* ---------- 3D ---------- */
  var T3 = null;
  function init3D() {
    var box = $("three");
    if (!window.THREE) { box.innerHTML = '<div class="pj-fallback">3D view unavailable (could not load three.js).</div>'; return null; }
    try {
      var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      box.appendChild(renderer.domElement);
      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(35, 1, 1, 1000);
      camera.position.set(0, 62, 70);
      scene.add(new THREE.AmbientLight(0xffffff, 0.45));
      var dl = new THREE.DirectionalLight(0xffffff, 0.75); dl.position.set(-40, 60, 30); scene.add(dl);
      var controls = THREE.OrbitControls ? new THREE.OrbitControls(camera, renderer.domElement) : null;
      if (controls) { controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.addEventListener("change", draw); }
      var t = { renderer: renderer, scene: scene, camera: camera, controls: controls, mesh: null, key: "" };
      function draw() { renderer.render(scene, camera); }
      function size() {
        var w = box.clientWidth, h = box.clientHeight;
        renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); draw();
      }
      t.draw = draw; t.size = size;
      window.addEventListener("resize", size); size();
      (function loop() { if (controls) controls.update(); requestAnimationFrame(loop); })();
      return t;
    } catch (e) {
      box.innerHTML = '<div class="pj-fallback">3D view needs WebGL, which is not available here.</div>';
      return null;
    }
  }
  function update3D() {
    var r = S.res; if (!r) return;
    if (!T3) T3 = init3D(); if (!T3) return;
    var step = Math.max(1, Math.round(Math.max(r.W, r.H) / 320));
    var gw = Math.floor((r.W - 1) / step) + 1, gh = Math.floor((r.H - 1) / step) + 1;
    var Wmm = (gw - 1) * step * r.pxmm, Hmm = (gh - 1) * step * r.pxmm, k = 64 / Math.max(Wmm, Hmm);
    var key = gw + "x" + gh;
    if (T3.key !== key) {
      if (T3.mesh) { T3.scene.remove(T3.mesh); T3.mesh.geometry.dispose(); }
      var geo = new THREE.PlaneGeometry(Wmm * k, Hmm * k, gw - 1, gh - 1);
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(gw * gh * 3), 3));
      var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2; T3.scene.add(mesh); T3.mesh = mesh; T3.key = key;
    }
    T3.grid = { gw: gw, gh: gh, step: step, k: k };
    var exag = +$("exag").value, pos = T3.mesh.geometry.attributes.position, col = T3.mesh.geometry.attributes.color;
    var aMax = percentile(r.albedo, 0.99) || 1;
    for (var j = 0; j < gh; j++) for (var i = 0; i < gw; i++) {
      var v = j * gw + i, p = (j * step) * r.W + i * step;
      pos.setZ(v, r.height[p] * exag * k);
      var g = 0.25 + 0.7 * Math.sqrt(Math.min(1, r.albedo[p] / aMax)), c;
      if (r.mask[p]) { c = cmap(INFERNO, 0.15 + 0.85 * r.depth[p] / 3); col.setXYZ(v, c[0] / 255, c[1] / 255, c[2] / 255); }
      else col.setXYZ(v, g, g, g * 0.97);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    T3.mesh.geometry.computeVertexNormals();
    T3.draw();
  }
  $("exag").addEventListener("input", function () { $("exagOut").textContent = this.value; update3D(); });

  /* ---------- controls ---------- */
  var deb;
  function debounce(fn) { clearTimeout(deb); deb = setTimeout(fn, 250); }
  $("elev").addEventListener("input", function () {
    S.elevation = +this.value; $("elevOut").textContent = this.value + "°"; debounce(compute);
  });
  $("seed").addEventListener("input", function () {
    PARAMS.seed = +this.value; $("seedOut").textContent = PARAMS.seed.toFixed(2) + " mm"; debounce(compute);
  });
  $("edge").addEventListener("input", function () {
    PARAMS.edge = +this.value; $("edgeOut").textContent = PARAMS.edge.toFixed(2) + " mm"; debounce(compute);
  });
  window.addEventListener("resize", function () { clearTimeout(window.__pr); window.__pr = setTimeout(renderProfile, 150); });
  new MutationObserver(function () { renderProfile(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------- own photos ---------- */
  $("ownForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var inputs = this.querySelectorAll("input[type=file]"), files = [];
    inputs.forEach(function (inp) { files[+inp.dataset.i] = inp.files[0]; });
    if (files.some(function (f) { return !f; })) { $("ownMsg").textContent = "Please choose all four photos."; return; }
    $("ownMsg").textContent = "Loading photos…";
    Promise.all(files.map(function (f) { return loadImg(URL.createObjectURL(f)); })).then(function (imgs) {
      var w = imgs[0].naturalWidth, h = imgs[0].naturalHeight;
      if (imgs.some(function (im) { return im.naturalWidth !== w || im.naturalHeight !== h; })) {
        $("ownMsg").textContent = "All four photos must have the same size (same camera position and zoom)."; return;
      }
      var sc = Math.min(1, 640 / w, 640 / h);
      S.W = Math.round(w * sc); S.H = Math.round(h * sc);
      S.photos = imgs.map(function (im) { var g = imageToGray(im, S.W, S.H); URL.revokeObjectURL(im.src); return g; });
      S.pxmm = (parseFloat($("ownPx").value) || 0.1) / sc;
      var det = parseFloat($("ownDet").value);
      S.detrend = det > 0 ? det : null;
      S.elevation = Math.max(10, Math.min(80, parseFloat($("ownEl").value) || 45));
      $("elev").value = Math.max(30, Math.min(60, S.elevation)); $("elevOut").textContent = S.elevation + "°";
      $("elevHint").textContent = "Elevation set from your photos.";
      S.dataId = "user-" + Date.now(); S.isDemo = false; S.use = [1, 1, 1, 1]; S.line = null;
      buildThumbs(); compute();
      $("ownMsg").textContent = "Analysing " + S.W + "×" + S.H + " px at " + S.pxmm.toFixed(3) + " mm/px. Results are shown above.";
      $("backDemo").hidden = false;
      $("live").scrollIntoView({ behavior: "smooth" });
    }).catch(function () { $("ownMsg").textContent = "Could not read one of the photos."; });
  });
  $("backDemo").addEventListener("click", function () {
    S.use = [1, 1, 1, 1]; S.elevation = 45; $("elev").value = 45; $("elevOut").textContent = "45°";
    $("elevHint").textContent = "The photos were lit at 45°. Try 40° or 50° to see how sensitive depth is to this.";
    this.hidden = true; $("ownMsg").textContent = "";
    loadDemo();
  });

  loadDemo().catch(function () { $("timing").textContent = "Could not load the demo photos."; });
})();
