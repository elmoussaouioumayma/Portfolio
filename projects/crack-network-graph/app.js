(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SIDE = 1400;
  var EXAMPLES = [
    { id: "basalt_like_mud", name: "Basalt-like mud", note: "formed at once → Y" },
    { id: "dried_mud", name: "Dried mud", note: "one after another → T" },
    { id: "glaze_crazing", name: "Glaze crazing", note: "mixed T + Y" },
    { id: "old_paint", name: "Old paint", note: "light cracks, T" }
  ];
  var JCOL = { T: "#ff8c00", Y: "#1e90ff", X: "#ba55d3" };
  var CORNER = { 3: "#f4a259", 4: "#e9c46a", 5: "#8ab17d", 6: "#2a9d8f", 7: "#264653" };
  var P = { polarity: "auto", maxWidth: 15, sensitivity: 1, minArea: 60, prune: 12, bridge: 15, ppm: null };
  var S = { img: null, rgba: null, W: 0, H: 0, truth: null, name: "", net: null, view: "type", busy: false, queued: false, seq: 0 };

  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function hsv(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s), r, g, b;
    switch (i % 6) { case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; default: r = v; g = p; b = q; }
    return "rgb(" + Math.round(r * 255) + "," + Math.round(g * 255) + "," + Math.round(b * 255) + ")";
  }
  function dirColour(deg) { return hsv(((deg % 180) + 180) % 180 / 180, 0.75, 1); }

  /* ---------- worker ---------- */
  var worker = null, fallback = false;
  try {
    worker = new Worker("network.js");
    worker.onmessage = onResult;
    worker.onerror = function (e) { if (e.preventDefault) e.preventDefault(); worker = null; fallback = true; S.busy = false; run(); };
  } catch (e) { fallback = true; }
  function loadFallback(cb) {
    if (window.CNG) return cb();
    var s = document.createElement("script"); s.src = "network.js"; s.onload = cb; document.head.appendChild(s);
  }
  function run() {
    if (!S.rgba) return;
    if (S.busy) { S.queued = true; return; }
    S.busy = true; S.queued = false; $("busy").hidden = false;
    var msg = { id: ++S.seq, rgba: S.rgba, W: S.W, H: S.H, params: Object.assign({}, P) };
    if (worker && !fallback) { worker.postMessage(msg); return; }
    loadFallback(function () {
      setTimeout(function () {
        try { onResult({ data: { ok: true, net: window.CNG.analyse(msg.rgba, msg.W, msg.H, msg.params) } }); }
        catch (err) { onResult({ data: { ok: false, error: String(err) } }); }
      }, 30);
    });
  }
  function onResult(e) {
    S.busy = false;
    if (S.queued) { run(); return; }
    $("busy").hidden = true;
    if (!e.data.ok) { $("timing").textContent = "error: " + String(e.data.error).split("\n")[0]; return; }
    S.net = e.data.net;
    $("timing").textContent = S.W + "×" + S.H + " px · " + (S.net.timing.total / 1000).toFixed(1) + " s";
    drawGraph(); drawCells(); story(); metrics(); accuracy(); charts();
  }

  /* ---------- input ---------- */
  function loadImg(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; }); }
  function setImage(img, truth, name) {
    var sc = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    S.W = Math.round(img.naturalWidth * sc); S.H = Math.round(img.naturalHeight * sc);
    var c = document.createElement("canvas"); c.width = S.W; c.height = S.H;
    var x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, S.W, S.H);
    S.rgba = x.getImageData(0, 0, S.W, S.H).data; S.img = c; S.truth = truth; S.name = name;
    S.scale = sc;
    run();
  }
  function pickExample(ex, btn) {
    document.querySelectorAll(".ng-ex").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
    $("drop").classList.remove("active");
    if (btn) btn.setAttribute("aria-pressed", "true");
    Promise.all([loadImg("examples/" + ex.id + ".jpg"), fetch("examples/" + ex.id + ".truth.json").then(function (r) { return r.json(); }).catch(function () { return null; })])
      .then(function (r) { setImage(r[0], r[1], ex.id); });
  }
  var pick = $("pick"), drop = $("drop");
  EXAMPLES.forEach(function (ex, i) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "ng-ex"; b.setAttribute("aria-pressed", i === 1 ? "true" : "false");
    b.innerHTML = '<img src="examples/' + ex.id + '.jpg" alt="" loading="lazy" width="900" height="640"><span>' + ex.name + "<small>" + ex.note + "</small></span>";
    b.addEventListener("click", function () { pickExample(ex, b); });
    pick.insertBefore(b, drop);
  });
  function useFile(f) {
    if (!f || !/^image\//.test(f.type)) return;
    var url = URL.createObjectURL(f);
    loadImg(url).then(function (img) {
      document.querySelectorAll(".ng-ex").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
      drop.classList.add("active");
      setImage(img, null, f.name.replace(/\.[^.]+$/, ""));
      URL.revokeObjectURL(url);
    });
  }
  $("file").addEventListener("change", function (e) { useFile(e.target.files[0]); });
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { useFile(e.dataTransfer.files[0]); });

  /* ---------- settings ---------- */
  var deb;
  function later() { clearTimeout(deb); deb = setTimeout(run, 300); }
  function slider(id, key, fmt) {
    $(id).addEventListener("input", function () { P[key] = +this.value; $(id + "Out").textContent = fmt(P[key]); later(); });
  }
  slider("maxw", "maxWidth", function (v) { return v + " px"; });
  slider("sens", "sensitivity", function (v) { return v.toFixed(2); });
  slider("prune", "prune", function (v) { return v + " px"; });
  slider("bridge", "bridge", function (v) { return v + " px"; });
  $("ppm").addEventListener("change", function () { var v = parseFloat(this.value); P.ppm = v > 0 ? v * (S.scale || 1) : null; later(); });
  document.querySelectorAll("[data-pol]").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("[data-pol]").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      b.setAttribute("aria-pressed", "true"); P.polarity = b.dataset.pol; later();
    });
  });
  document.querySelectorAll("[data-g]").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("[data-g]").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      b.setAttribute("aria-pressed", "true"); S.view = b.dataset.g; drawGraph();
    });
  });

  /* ---------- drawing ---------- */
  function drawGraph() {
    var net = S.net; if (!net) return;
    var c = $("graph"), x = c.getContext("2d"); c.width = net.W; c.height = net.H;
    if (S.view === "photo") { x.drawImage(S.img, 0, 0); return; }
    var id = x.createImageData(net.W, net.H), d = id.data, s = S.rgba;
    for (var i = 0; i < net.W * net.H; i++) {
      var g = 0.35 * (0.299 * s[i * 4] + 0.587 * s[i * 4 + 1] + 0.114 * s[i * 4 + 2]) + 20;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255;
    }
    x.putImageData(id, 0, 0);
    var lw = Math.max(2, Math.round(Math.max(net.W, net.H) / 450));
    x.lineWidth = lw; x.lineCap = "round"; x.lineJoin = "round";
    net.edges.forEach(function (e) {
      x.strokeStyle = S.view === "dir" ? dirColour(e.orientation_deg) : "rgb(235,235,225)";
      x.beginPath();
      e.path.forEach(function (p, k) { if (k) x.lineTo(p[1] + 0.5, p[0] + 0.5); else x.moveTo(p[1] + 0.5, p[0] + 0.5); });
      x.stroke();
    });
    var r = Math.max(5, lw + 4);
    net.nodes.forEach(function (n) {
      if (n.type && JCOL[n.type]) {
        x.beginPath(); x.arc(n.x + 0.5, n.y + 0.5, r, 0, 7); x.fillStyle = JCOL[n.type]; x.fill();
        x.lineWidth = 1.2; x.strokeStyle = "#fff"; x.stroke();
      } else if (n.kind === "end") {
        x.beginPath(); x.arc(n.x + 0.5, n.y + 0.5, r - 1, 0, 7); x.lineWidth = 1.2; x.strokeStyle = "rgb(230,230,230)"; x.stroke();
      }
    });
  }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function drawCells() {
    var net = S.net, c = $("cells"), x = c.getContext("2d"); c.width = net.W; c.height = net.H;
    var id = x.createImageData(net.W, net.H), d = id.data, lut = [null];
    net.cellStats.forEach(function (cs) { lut[cs.id] = hexRgb(CORNER[Math.max(3, Math.min(7, cs.corners))]); });
    var W = net.W, H = net.H;
    for (var y = 0; y < H; y++) for (var xx = 0; xx < W; xx++) {
      var i = y * W + xx, col = net.cells[i] ? lut[net.cells[i]] : [235, 235, 235], dark = false;
      for (var dy = -1; dy <= 1 && !dark; dy++) for (var dx = -1; dx <= 1; dx++) {
        var yy = y + dy, x2 = xx + dx;
        if (yy >= 0 && yy < H && x2 >= 0 && x2 < W && net.skel[yy * W + x2]) { dark = true; break; }
      }
      if (dark) col = [40, 40, 40];
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
    x.putImageData(id, 0, 0);
  }

  /* ---------- text, metrics, accuracy ---------- */
  function story() {
    var s = S.net.summary, t = s.T_junctions, y = s.Y_junctions, el = $("story");
    if (t + y < 5) { el.innerHTML = "<p>Too few junctions for a statement about how the network formed.</p>"; return; }
    var f = s.T_fraction, txt;
    if (f >= 0.65) txt = "Mostly <strong>T junctions</strong>: new cracks ran into older ones at about 90°, so the cracks formed <strong>one after another</strong> (hierarchical cracking, e.g. one drying event).";
    else if (f <= 0.35) txt = "Mostly <strong>Y junctions</strong> (about 120°): the cracks formed <strong>at the same time</strong>, or the network has <strong>matured</strong> over repeated cycles (e.g. wetting and drying).";
    else txt = "A <strong>mix of T and Y junctions</strong>: an older network that was later divided by newer cracks.";
    el.innerHTML = "<p>" + txt + "</p><p>T fraction " + f.toFixed(2) + " · " + s.closed_cells + " closed cells with on average " + s.mean_cell_corners + " corners · " +
      s.free_crack_ends + " crack ends that stop in the open surface · " + s.polarity + " cracks detected</p>";
  }
  function unit() { return S.net.ppm ? "mm" : "px"; }
  function metrics() {
    var s = S.net.summary, u = unit();
    var items = [
      ["Total length", s["total_crack_length_" + u] + " " + u],
      ["Segments", s.segments],
      ["Junctions", s.junctions + " <small>T " + s.T_junctions + " · Y " + s.Y_junctions + " · X " + s.X_junctions + "</small>"],
      ["T fraction", s.T_fraction.toFixed(2)],
      ["Closed cells", s.closed_cells],
      ["Corners / cell", s.mean_cell_corners],
      ["Median width", s["median_width_" + u] + " " + u],
      ["Median cell area", s["median_cell_area_" + u + "2"] + " " + u + "²"],
      ["Anisotropy", s.orientation_anisotropy + " <small>" + s.dominant_orientation_deg + "°</small>"]
    ];
    $("metrics").innerHTML = items.map(function (it) { return "<div><dt>" + it[0] + "</dt><dd>" + it[1] + "</dd></div>"; }).join("");
  }
  function accuracy() {
    var box = $("accuracy"), tr = S.truth, net = S.net;
    if (!tr) { box.hidden = true; return; }
    box.hidden = false;
    var W = net.W, H = net.H, M = 12, inside = function (x, y) { return x >= M && x < W - M && y >= M && y < H - M; };
    var tj = tr.junction_xy_type.filter(function (j) { return inside(j[0], j[1]); });
    var mj = net.junctions.filter(function (j) { return inside(j.x, j.y); });
    var used = {}, pairs = [];
    tj.forEach(function (t) {
      var bi = -1, bd = Infinity;
      mj.forEach(function (m, i) { var d = Math.hypot(m.x - t[0], m.y - t[1]); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0) return;
      var cap = mj[bi].type === "X" ? 2 : 1;
      if (bd <= 10 && (used[bi] || 0) < cap) { used[bi] = (used[bi] || 0) + 1; pairs.push([t[2], mj[bi].type]); }
    });
    var rec = tj.length ? pairs.length / tj.length : 0, prec = mj.length ? Object.keys(used).length / mj.length : 0;
    var ty = pairs.filter(function (p) { return p[1] === "T" || p[1] === "Y"; }), ok = ty.filter(function (p) { return p[0] === p[1]; }).length;
    var s = net.summary, lenErr = 100 * (s.total_crack_length_px / tr.total_length_px - 1);
    var tf = tr.T_junctions / Math.max(tr.T_junctions + tr.Y_junctions, 1);
    if (net.ppm) lenErr = 100 * ((s.total_crack_length_mm * net.ppm) / tr.total_length_px - 1);
    var rows = [
      ["Junctions found (recall / precision)", "<b>" + rec.toFixed(2) + " / " + prec.toFixed(2) + "</b>"],
      ["Junction type correct (T vs Y)", "<b>" + (ty.length ? Math.round(100 * ok / ty.length) : 0) + " %</b> <small>(" + ok + "/" + ty.length + ")</small>"],
      ["T fraction: measured / true", "<b>" + s.T_fraction.toFixed(2) + "</b> / " + tf.toFixed(2)],
      ["Closed cells: measured / true", "<b>" + s.closed_cells + "</b> / " + tr.closed_cells],
      ["Total length error", "<b>" + (lenErr > 0 ? "+" : "") + lenErr.toFixed(1) + " %</b>"]
    ];
    $("accBody").innerHTML = rows.map(function (r) { return "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td></tr>"; }).join("");
  }

  /* ---------- charts ---------- */
  function prep(id) {
    var c = $(id), dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = Math.round(w * 0.8);
    c.width = w * dpr; c.height = h * dpr; var x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    x.font = "10px JetBrains Mono, monospace"; return { x: x, w: w, h: h };
  }
  function bars(id, labels, values, colours, opts) {
    var g = prep(id), x = g.x, padL = 28, padB = 22, padT = 8, W = g.w - padL - 6, H = g.h - padB - padT;
    var mx = Math.max.apply(null, values.concat([1])), bw = W / values.length;
    x.strokeStyle = css("--line"); x.fillStyle = css("--muted"); x.lineWidth = 1;
    x.beginPath(); x.moveTo(padL, padT + H + 0.5); x.lineTo(padL + W, padT + H + 0.5); x.stroke();
    x.textAlign = "right"; x.textBaseline = "middle"; x.fillText(String(Math.round(mx)), padL - 4, padT + 4); x.fillText("0", padL - 4, padT + H);
    if (opts && opts.vlines) opts.vlines.forEach(function (v) {
      var px = padL + (v[0] - opts.x0) / (opts.x1 - opts.x0) * W;
      x.save(); x.setLineDash([4, 3]); x.strokeStyle = v[1]; x.lineWidth = 2; x.beginPath(); x.moveTo(px, padT); x.lineTo(px, padT + H); x.stroke(); x.restore();
    });
    values.forEach(function (v, i) {
      var bh = v / mx * H; x.fillStyle = Array.isArray(colours) ? colours[i] : colours;
      x.fillRect(padL + i * bw + 1, padT + H - bh, Math.max(1, bw - 2), bh);
    });
    x.fillStyle = css("--muted"); x.textAlign = "center"; x.textBaseline = "top";
    labels.forEach(function (l, i) { if (l !== "") x.fillText(l, padL + (i + 0.5) * bw, padT + H + 5); });
  }
  function charts() {
    var net = S.net, s = net.summary, u = unit(), L = function (v) { return net.ppm ? v / net.ppm : v; };
    // 1. orientation rose (length-weighted, 18 bins over 0–180°, mirrored)
    var g = prep("c1"), x = g.x, cx = g.w / 2, cy = g.h / 2, R = Math.min(g.w, g.h) / 2 - 10, bins = new Array(18).fill(0);
    net.edges.forEach(function (e) { bins[Math.min(17, Math.floor(e.orientation_deg / 10))] += L(e.length); });
    var mx = Math.max.apply(null, bins.concat([1e-9]));
    x.strokeStyle = css("--line"); [0.5, 1].forEach(function (f) { x.beginPath(); x.arc(cx, cy, R * f, 0, 7); x.stroke(); });
    for (var k = 0; k < 36; k++) {
      var b = bins[k % 18], a0 = k * Math.PI / 18, a1 = a0 + Math.PI / 18, rr = R * Math.sqrt(b / mx);
      x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, rr, -a1, -a0); x.closePath();
      x.fillStyle = dirColour((k % 18) * 10 + 5); x.fill(); x.strokeStyle = css("--surface"); x.lineWidth = 0.5; x.stroke();
    }
    $("c1t").innerHTML = "Crack directions (by length)<small>anisotropy " + s.orientation_anisotropy + "</small>";
    // 2. junction angles at 3-way junctions
    var ang = []; net.junctions.forEach(function (j) { if (j.degree === 3) ang = ang.concat(j.angles_deg); });
    var h2 = new Array(24).fill(0); ang.forEach(function (a) { h2[Math.max(0, Math.min(23, Math.floor(a / 10)))]++; });
    bars("c2", h2.map(function (_, i) { return i % 6 === 0 ? String(i * 10) : ""; }), h2, "#7a8b99",
      { x0: 0, x1: 240, vlines: [[90, JCOL.T], [120, JCOL.Y], [180, JCOL.T]] });
    $("c2t").innerHTML = "Angles at 3-way junctions<small>T " + s.T_junctions + " · Y " + s.Y_junctions + " · X " + s.X_junctions + "</small>";
    // 3. corners per cell
    var cc = [0, 0, 0, 0, 0]; net.cellStats.forEach(function (c) { cc[Math.max(3, Math.min(7, c.corners)) - 3]++; });
    bars("c3", ["3", "4", "5", "6", "7+"], cc, [CORNER[3], CORNER[4], CORNER[5], CORNER[6], CORNER[7]]);
    $("c3t").innerHTML = "Corners per closed cell<small>mean " + s.mean_cell_corners + "</small>";
    // 4. cell size
    var areas = net.cellStats.map(function (c) { return net.ppm ? c.area / (net.ppm * net.ppm) : c.area; });
    var h4 = new Array(15).fill(0), amax = Math.max.apply(null, areas.concat([1])), amin = Math.min.apply(null, areas.concat([0]));
    areas.forEach(function (a) { h4[Math.min(14, Math.floor((a - amin) / ((amax - amin) || 1) * 15))]++; });
    bars("c4", h4.map(function (_, i) { return i === 0 ? fmtN(amin) : i === 14 ? fmtN(amax) : ""; }), h4, "#2a9d8f");
    $("c4t").innerHTML = "Cell size<small>median " + s["median_cell_area_" + u + "2"] + " " + u + "²</small>";
  }
  function fmtN(v) { return v >= 10000 ? Math.round(v / 1000) + "k" : v >= 100 ? Math.round(v) : v.toFixed(1); }
  window.addEventListener("resize", function () { clearTimeout(window.__ch); window.__ch = setTimeout(function () { if (S.net) charts(); }, 150); });
  new MutationObserver(function () { if (S.net) charts(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------- exports ---------- */
  function xy(path) { var s = S.net.ppm ? 1 / S.net.ppm : 1; return path.map(function (p) { return [r3(p[1] * s), r3(p[0] * s)]; }); }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function geojson() {
    var net = S.net, u = unit(), L = function (v) { return net.ppm ? v / net.ppm : v; }, feats = [];
    net.edges.forEach(function (e) {
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: xy(e.path) },
        properties: { id: e.id, chord: r3(e.chord), tortuosity: isFinite(e.tortuosity) ? r3(e.tortuosity) : null, orientation_deg: r3(e.orientation_deg),
          from_node: e.u, to_node: e.v, unit: u, length: r3(L(e.length)), width: r3(L(e.width)) } });
    });
    net.junctions.forEach(function (j) {
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: xy([[j.y, j.x]])[0] },
        properties: { node: j.node, junction_type: j.type, degree: j.degree, angles_deg: j.angles_deg } });
    });
    return JSON.stringify({ type: "FeatureCollection", features: feats });
  }
  function csv() {
    var net = S.net, u = unit(), L = function (v) { return net.ppm ? v / net.ppm : v; };
    var rows = ["segment,from_node,to_node,length_" + u + ",width_" + u + ",orientation_deg,tortuosity"];
    net.edges.forEach(function (e) { rows.push([e.id, e.u, e.v, r3(L(e.length)), r3(L(e.width)), Math.round(e.orientation_deg * 10) / 10, isFinite(e.tortuosity) ? r3(e.tortuosity) : "inf"].join(",")); });
    return rows.join("\n") + "\n";
  }
  function graphml() {
    var net = S.net, L = function (v) { return net.ppm ? v / net.ppm : v; }, esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); };
    var o = ['<?xml version="1.0" encoding="UTF-8"?>', '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
      '<key id="y" for="node" attr.name="y" attr.type="double"/>', '<key id="x" for="node" attr.name="x" attr.type="double"/>',
      '<key id="kind" for="node" attr.name="kind" attr.type="string"/>', '<key id="type" for="node" attr.name="type" attr.type="string"/>',
      '<key id="length" for="edge" attr.name="length" attr.type="double"/>', '<key id="width" for="edge" attr.name="width" attr.type="double"/>',
      '<key id="orientation_deg" for="edge" attr.name="orientation_deg" attr.type="double"/>', '<graph edgedefault="undirected">'];
    net.nodes.forEach(function (n) { o.push('<node id="' + n.id + '"><data key="y">' + n.y + '</data><data key="x">' + n.x + '</data><data key="kind">' + esc(n.kind) + '</data><data key="type">' + esc(n.type || "") + "</data></node>"); });
    net.edges.forEach(function (e) { o.push('<edge source="' + e.u + '" target="' + e.v + '"><data key="length">' + L(e.length) + '</data><data key="width">' + L(e.width) + '</data><data key="orientation_deg">' + e.orientation_deg + "</data></edge>"); });
    o.push("</graph>", "</graphml>");
    return o.join("\n");
  }
  function save(name, text, type) {
    var a = document.createElement("a"), url = URL.createObjectURL(new Blob([text], { type: type }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  document.querySelectorAll("[data-dl]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!S.net) return;
      var base = (S.name || "crack_network"), k = b.dataset.dl;
      if (k === "geojson") save(base + ".geojson", geojson(), "application/geo+json");
      else if (k === "csv") save(base + "_segments.csv", csv(), "text/csv");
      else if (k === "graphml") save(base + ".graphml", graphml(), "application/xml");
      else save(base + "_summary.json", JSON.stringify(S.net.summary, null, 2), "application/json");
    });
  });

  pickExample(EXAMPLES[1], document.querySelectorAll(".ng-ex")[1]);
})();
