(function () {
  "use strict";
  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- theme ---------- */
  function store(k, v) { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var saved = load("theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  document.querySelector(".theme-toggle").addEventListener("click", function () {
    var current = root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store("theme", next);
  });

  /* ---------- seeded RNG so the pattern is stable ---------- */
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var NS = "http://www.w3.org/2000/svg";
  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---------- hero: branching crack network ---------- */
  function drawCracks() {
    var svg = document.getElementById("crackField");
    if (!svg) return;
    var w = svg.clientWidth, h = svg.clientHeight;
    if (!w || !h) return;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var r = rng(1998);
    var paths = [];

    function crack(x, y, angle, len, width, depth) {
      var pts = [[x, y]];
      var steps = Math.max(4, Math.round(len / 14));
      for (var i = 0; i < steps; i++) {
        angle += (r() - 0.5) * 0.7;
        x += Math.cos(angle) * (len / steps);
        y += Math.sin(angle) * (len / steps);
        pts.push([x, y]);
        if (depth < 3 && r() < 0.09) {
          var dir = r() < 0.5 ? 1 : -1;
          crack(x, y, angle + dir * (0.6 + r() * 0.7), len * (0.35 + r() * 0.3), width * 0.65, depth + 1);
        }
      }
      var d = "M" + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" L");
      paths.push({ d: d, w: width, depth: depth });
    }

    // seeds mostly on the right side so text stays readable
    var seeds = Math.max(3, Math.round(w / 260));
    for (var s = 0; s < seeds; s++) {
      var sx = w * (0.45 + r() * 0.6);
      var sy = h * r();
      var a = r() * Math.PI * 2;
      crack(sx, sy, a, Math.min(w, h) * (0.5 + r() * 0.5), 2.2, 0);
      crack(sx, sy, a + Math.PI + (r() - 0.5) * 0.6, Math.min(w, h) * (0.3 + r() * 0.4), 2.2, 0);
    }

    paths.forEach(function (p, i) {
      var path = el("path", { d: p.d, "stroke-width": p.w.toFixed(2) });
      svg.appendChild(path);
      if (!reduceMotion) {
        var L = path.getTotalLength();
        path.style.strokeDasharray = L;
        path.style.strokeDashoffset = L;
        path.style.transition = "stroke-dashoffset " + (1.6 + p.depth * 0.4) + "s ease-out " + (0.15 + p.depth * 0.5 + (i % 5) * 0.08) + "s";
        requestAnimationFrame(function () { requestAnimationFrame(function () { path.style.strokeDashoffset = 0; }); });
      }
    });
  }
  drawCracks();
  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(drawCracks, 200); });

  /* ---------- thesis figure: a small crack graph with junction nodes ---------- */
  (function thesisFig() {
    var svg = document.getElementById("thesisFig");
    if (!svg) return;
    var nodes = [
      [20, 40], [90, 70], [150, 50], [220, 90], [300, 60],
      [120, 140], [60, 200], [180, 180], [260, 210], [300, 150], [30, 120], [230, 20]
    ];
    var edges = [[0,1],[1,2],[2,3],[3,4],[1,5],[5,6],[5,7],[7,8],[3,9],[7,3],[10,1],[2,11]];
    var deg = nodes.map(function () { return 0; });
    edges.forEach(function (e) { deg[e[0]]++; deg[e[1]]++; });
    var r = rng(42);
    edges.forEach(function (e, i) {
      var a = nodes[e[0]], b = nodes[e[1]];
      var mx = (a[0] + b[0]) / 2 + (r() - 0.5) * 22, my = (a[1] + b[1]) / 2 + (r() - 0.5) * 22;
      var p = el("path", { class: "edge", d: "M" + a + " Q" + mx + " " + my + " " + b });
      svg.appendChild(p);
      if (!reduceMotion) {
        var L = p.getTotalLength();
        p.style.strokeDasharray = L; p.style.strokeDashoffset = L;
        p.dataset.delay = i * 0.08;
      }
    });
    nodes.forEach(function (n, i) {
      svg.appendChild(el("circle", { cx: n[0], cy: n[1], r: deg[i] > 1 ? 5 : 3.2, class: deg[i] > 1 ? "node" : "end" }));
    });
    if (reduceMotion || !("IntersectionObserver" in window)) {
      svg.querySelectorAll(".edge").forEach(function (p) { p.style.strokeDashoffset = 0; });
      return;
    }
    new IntersectionObserver(function (entries, obs) {
      if (!entries[0].isIntersecting) return;
      svg.querySelectorAll(".edge").forEach(function (p) {
        p.style.transition = "stroke-dashoffset 0.9s ease-out " + p.dataset.delay + "s";
        p.style.strokeDashoffset = 0;
      });
      obs.disconnect();
    }, { threshold: 0.4 }).observe(svg);
  })();

  /* ---------- nav state + reveal ---------- */
  var nav = document.querySelector(".nav");
  var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if ("IntersectionObserver" in window) {
    var links = {};
    document.querySelectorAll(".nav-links a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && links[en.target.id]) {
          Object.keys(links).forEach(function (k) { links[k].classList.remove("active"); });
          links[en.target.id].classList.add("active");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main section[id]").forEach(function (s) { spy.observe(s); });

    if (!reduceMotion) {
      var rev = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add("in"); rev.unobserve(en.target); }
        });
      }, { threshold: 0.12 });
      document.querySelectorAll(".section h2, .feature, .card, .timeline > li, .edu-item, .skill, .contact-links li")
        .forEach(function (n) { n.classList.add("reveal"); rev.observe(n); });
    }
  }

  document.getElementById("year").textContent = new Date().getFullYear();
})();
