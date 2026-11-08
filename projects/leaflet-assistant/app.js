/* UI for the Medicine Leaflet Assistant demo (engine in rag.js). */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const log = $("log"), form = $("form"), input = $("q"), hitsBox = $("hits"), lat = $("lat");
  const SCALE = 0.6; // score at which a retrieval bar is full
  let assistant = null, turn = 0;

  const EXAMPLES = [
    ["answer", "What are the side effects of Fictamol?"],
    ["answer", "How should Testoprazole be stored?"],
    ["answer", "What is Sampleastine used for?"],
    ["answer", "What is the maximum number of Fictamol tablets in 24 hours?"],
    ["refuse", "I took 20 tablets, what now?"],
    ["refuse", "Should I take Fictamol for my headache?"],
    ["not covered", "What are the side effects of aspirin?"],
    ["off-topic", "What is the best recipe for chocolate cake with Fictamol?"],
  ];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const docName = (doc) => {
    const [first, ...rest] = doc.split("-");
    return [first.charAt(0).toUpperCase() + first.slice(1), ...rest.map((r) => r.replace(/^(\d+)(mg|g|ml)$/i, "$1 $2"))].join(" ");
  };

  // ---------- chat ----------
  function addMsg(cls, html) {
    const div = document.createElement("div");
    div.className = "la-msg " + cls;
    div.innerHTML = html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function botHtml(res, id) {
    const badge = {
      answered: "Answer from the leaflet",
      refused_emergency: "Emergency: refused",
      refused_personal_advice: "Personal advice: refused",
      not_found: res.reason === "no_medicine" ? "Which medicine?" : "Not found",
    }[res.status];
    let text = esc(res.answer).replace(/\[(\d+)\]/g, (_, n) => `<button type="button" class="la-cite" data-turn="${id}" data-n="${n}" aria-label="Source ${n}">${n}</button>`);
    let html = `<span class="la-badge">${badge}</span><p>${text}</p>`;
    if (res.citations.length) {
      html += '<ul class="la-srcs">' + res.citations.map((c) =>
        `<li><b>[${c.number}]</b>${esc(docName(c.doc))}, section ${esc(c.section)}: ${esc(c.section_title)}</li>`).join("") + "</ul>";
    }
    if (res.status === "answered") html += `<p class="la-disc">${esc(assistant.ix.messages.disclaimer)}</p>`;
    return html;
  }

  // Chat layer (the engine itself is stateless, like the Python API): a reply that is only a
  // medicine name continues the previous question that named no medicine; otherwise it is read
  // as "What is X used for?". The bubble shows how the message was read.
  let pending = null;
  const capName = (n) => n.charAt(0).toUpperCase() + n.slice(1);

  function onlyMedicine(text) {
    const toks = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !assistant.stop.has(t));
    return toks.length === 1 && assistant.covered.includes(toks[0]) ? toks[0] : null;
  }

  function interpret(typed) {
    const name = onlyMedicine(typed);
    if (!name) return [typed, assistant.ask(typed)];
    const tries = [];
    if (pending) tries.push(`${pending.replace(/[?.!\s]+$/, "")} of ${capName(name)}?`);
    tries.push(`What is ${capName(name)} used for?`);
    let res;
    for (const q of tries) {
      res = assistant.ask(q);
      if (res.status === "answered") return [q, res];
    }
    return [tries[tries.length - 1], res];
  }

  function ask(typed) {
    typed = typed.trim();
    if (typed.length < 3) return;
    const [question, res] = interpret(typed);
    pending = res.reason === "no_medicine" ? question : null;
    const id = ++turn;
    addMsg("la-user", `<p>${esc(typed)}</p>`);
    const cls = res.status === "answered" ? "" : res.status.startsWith("refused") ? " refused" : " notfound";
    let html = botHtml(res, id);
    if (question !== typed) html = `<p class="la-read">Read as: “${esc(question)}”</p>` + html;
    if (res.status === "not_found" && res.reason !== "no_medicine") {
      html += `<p class="la-tip">Try asking about side effects, dose, storage, ingredients, warnings or what it is used for.</p>`;
    }
    const msg = addMsg("la-bot" + cls, html);
    msg.dataset.q = question;
    renderTrace(res);
    renderHits(res, id);
    lat.textContent = `· ${res.latency_ms < 1 ? "< 1" : res.latency_ms.toFixed(0)} ms in your browser`;
  }

  // ---------- trace ----------
  function setStep(name, state, note) {
    const li = document.querySelector(`.la-step[data-step="${name}"]`);
    li.className = "la-step " + state;
    if (note) li.querySelector("small").textContent = note;
  }

  function renderTrace(res) {
    const fmt = (x) => x.toFixed(2);
    const min = assistant.ix.settings.min_score;
    if (res.status.startsWith("refused")) {
      setStep("guard", "stop", res.status === "refused_emergency" ? "emergency detected: refer to 112, no retrieval" : "personal advice: refer to pharmacist or doctor");
      setStep("med", "off", "not run");
      setStep("ret", "off", "not run");
      setStep("ans", "off", "not run");
      return;
    }
    setStep("guard", "pass", "no emergency or personal-advice pattern");
    if (res.reason === "no_medicine") {
      setStep("med", "warn", "no covered medicine named: stop instead of using another leaflet");
      setStep("ret", "off", "not run");
      setStep("ans", "off", "not run");
      return;
    }
    const named = assistant.covered.filter((n) => new Set(res.question.toLowerCase().match(/[a-z0-9]+/g) || []).has(n));
    setStep("med", "pass", `covered: ${named.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join(", ")}`);
    if (res.reason === "low_score") {
      setStep("ret", "warn", `best score ${fmt(res.top_score)} < ${min}: answer "not found"`);
      setStep("ans", "off", "not run");
      return;
    }
    const kept = res.sources ? res.sources.length : res.kept.size;
    setStep("ret", "pass", `best score ${fmt(res.top_score)} · ${kept} of ${res.hits.length} sections kept`);
    if (res.reason === "no_sentence") setStep("ans", "warn", "no matching sentence: answer \"not found\"");
    else setStep("ans", "pass", `${res.answer.match(/\[\d+\]/g).length} leaflet sentences · extractive, no LLM`);
  }

  // ---------- retrieved sections ----------
  function renderHits(res, id) {
    const min = assistant.ix.settings.min_score;
    if (!res.hits.length) {
      hitsBox.innerHTML = '<p class="pj-hint">No retrieval for this question: it was stopped earlier, before any leaflet was searched.</p>';
      return;
    }
    const kept = res.sources || [...res.kept];
    hitsBox.innerHTML = res.hits.map((h) => {
      const n = kept.indexOf(h) + 1;
      const why = n ? "" : h.score < min ? `score below ${min}` : `other medicine (${docName(h.chunk.doc)}): dropped`;
      const w = Math.min(100, (h.score / SCALE) * 100).toFixed(1), t = ((min / SCALE) * 100).toFixed(1);
      const text = h.chunk.text.length > 220 ? h.chunk.text.slice(0, 220) + "…" : h.chunk.text;
      return `<div class="la-hit${n ? "" : " dropped"}" ${n ? `data-turn="${id}" data-n="${n}"` : ""}>
        <div class="la-hit-head"><strong>${n ? `<b>[${n}]</b>` : ""}${esc(docName(h.chunk.doc))} · §${esc(h.chunk.section)} ${esc(h.chunk.section_title)}</strong><span>${h.score.toFixed(3)}</span></div>
        <div class="la-bar" aria-hidden="true"><i style="width:${w}%"></i><em style="left:${t}%"></em></div>
        <p>${esc(text)}</p>${why ? `<p class="la-note">${esc(why)}</p>` : ""}</div>`;
    }).join("") + `<p class="la-legend"><i></i>score threshold ${min} · sections of one medicine only</p>`;
  }

  log.addEventListener("click", (e) => {
    const b = e.target.closest(".la-cite");
    if (!b) return;
    if (+b.dataset.turn !== turn) { // older answer: re-run it so the panel shows its sources
      const q = b.closest(".la-msg").dataset.q;
      const res = assistant.ask(q);
      renderTrace(res);
      renderHits(res, +b.dataset.turn);
    }
    const el = hitsBox.querySelector(`.la-hit[data-n="${b.dataset.n}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1400);
  });

  // ---------- leaflets ----------
  function renderLeaflets(ix) {
    const byDoc = new Map();
    for (const c of ix.chunks) {
      if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
      byDoc.get(c.doc).push(c);
    }
    $("leafletGrid").innerHTML = [...byDoc].map(([doc, chunks]) => `<div class="la-leaflet"><h4>${esc(docName(doc))}</h4><dl>${
      chunks.filter((c) => c.section !== "0").map((c) => `<dt>§${esc(c.section)} ${esc(c.section_title)}</dt><dd>${esc(c.text)}</dd>`).join("")
    }</dl></div>`).join("");
  }

  // ---------- start ----------
  $("examples").innerHTML = EXAMPLES.map(([kind, q]) => `<button type="button" class="la-ex" data-q="${esc(q)}"><i>${kind}</i>${esc(q)}</button>`).join("");
  $("examples").addEventListener("click", (e) => {
    const b = e.target.closest(".la-ex");
    if (b && assistant) ask(b.dataset.q);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!assistant) return;
    ask(input.value);
    input.value = "";
  });

  fetch("data/index.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((ix) => { assistant = new LeafletAssistant(ix); renderLeaflets(ix); })
    .catch(() => addMsg("la-bot notfound", "<p>The leaflet index could not be loaded. Please reload the page.</p>"));
})();
