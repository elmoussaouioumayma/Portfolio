/* Medicine Leaflet Assistant: in-browser port of the leaflet-rag Python pipeline (extractive mode).
 * guardrails -> covered-medicine check -> TF-IDF retrieval (word + char n-grams) -> one medicine
 * only -> extractive answer with [n] citations. The index (vocabulary, idf, normalised chunk
 * vectors) is exported from the Python package, so scores match the Python reference. */
(function (root) {
  "use strict";

  const SUFFIXES = ["ings", "ing", "ies", "ed", "es", "s", "e"];

  function stem(w) {
    for (const s of SUFFIXES) {
      if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length) + (s === "ies" ? "y" : "");
    }
    return w;
  }

  function words(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  // Ports of the Python regexes (exported verbatim) use the same syntax in JavaScript.
  const compile = (list) => list.map((p) => new RegExp(p));

  class LeafletAssistant {
    constructor(index) {
      this.ix = index;
      this.stop = new Set(index.stop_words);
      this.g = {
        emergency: compile(index.guardrails.emergency),
        personal: compile(index.guardrails.personal_advice),
        faq: compile(index.guardrails.faq),
      };
      this.covered = [...new Set(index.chunks.map((c) => medicineName(c.doc)))].sort();
    }

    stemTokens(text) {
      return words(text).filter((w) => !this.stop.has(w)).map(stem);
    }

    // sklearn TfidfVectorizer(tokenizer=_stem_tokens, ngram_range=(1, 2))
    wordTerms(text) {
      const t = this.stemTokens(text.toLowerCase());
      const out = t.slice();
      for (let i = 0; i + 1 < t.length; i++) out.push(t[i] + " " + t[i + 1]);
      return out;
    }

    // sklearn TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5))
    charTerms(text) {
      const doc = text.toLowerCase().replace(/\s\s+/g, " ");
      const out = [];
      for (const raw of doc.split(/\s+/).filter(Boolean)) {
        const w = Array.from(" " + raw + " ");
        for (let n = 3; n <= 5; n++) {
          let offset = 0;
          out.push(w.slice(offset, offset + n).join(""));
          while (offset + n < w.length) {
            offset += 1;
            out.push(w.slice(offset, offset + n).join(""));
          }
          if (offset === 0) break;
        }
      }
      return out;
    }

    // sublinear tf * idf, l2-normalised, as a Map(term index -> weight)
    vectorize(terms, vec) {
      const counts = new Map();
      for (const t of terms) {
        const j = vec.vocab[t];
        if (j !== undefined) counts.set(j, (counts.get(j) || 0) + 1);
      }
      let norm = 0;
      for (const [j, c] of counts) {
        const v = (1 + Math.log(c)) * vec.idf[j];
        counts.set(j, v);
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (const [j, v] of counts) counts.set(j, v / norm);
      return counts;
    }

    search(query, k) {
      const qw = this.vectorize(this.wordTerms(query), this.ix.word);
      const qc = this.vectorize(this.charTerms(query), this.ix.char);
      const ww = this.ix.settings.word_weight;
      const dot = (row, q) => row.reduce((s, [j, v]) => s + (q.get(j) || 0) * v, 0);
      const scored = this.ix.chunks.map((chunk, i) => ({
        chunk,
        score: ww * dot(this.ix.word_rows[i], qw) + (1 - ww) * dot(this.ix.char_rows[i], qc),
      }));
      return scored.sort((a, b) => b.score - a.score).slice(0, k);
    }

    checkQuestion(question) {
      const text = question.toLowerCase().trim();
      const any = (list) => list.some((re) => re.test(text));
      const gm = this.ix.guardrails;
      if (any(this.g.emergency)) return { allowed: false, category: "emergency", message: gm.emergency_message };
      if (any(this.g.faq) && !/\b(double|my \w+ (is|has))\b/.test(text)) return { allowed: true, category: "ok" };
      if (any(this.g.personal)) return { allowed: false, category: "personal_advice", message: gm.personal_advice_message };
      return { allowed: true, category: "ok" };
    }

    extractive(question, hits) {
      const nameTerms = new Set(hits.flatMap((h) => this.stemTokens(h.chunk.doc.replace(/-/g, " "))));
      const qTerms = new Set(this.stemTokens(question).filter((t) => !nameTerms.has(t)));
      const scored = [];
      hits.forEach((hit, idx) => {
        const i = idx + 1;
        if (hit.chunk.section === "0") return;
        const hint = new Set(this.stemTokens(this.ix.section_hints[hit.chunk.section] || ""));
        const bonus = [...qTerms].some((t) => hint.has(t)) ? 0.5 : 0.0;
        hit.chunk.text.split(/(?<=[.!?])\s+/).forEach((sentence, pos) => {
          const st = new Set(this.stemTokens(sentence));
          const overlap = [...qTerms].filter((t) => st.has(t)).length;
          if (overlap || bonus) scored.push([overlap + 2 * hit.score + bonus + 0.1 / (pos + 1), i, sentence.trim()]);
        });
      });
      if (!scored.length) return null;
      scored.sort((a, b) => b[0] - a[0]);
      const best = scored.slice(0, 3).sort((a, b) => a[1] - b[1]);
      return best.map(([, i, s]) => `${s} [${i}]`).join(" ");
    }

    ask(question) {
      const t0 = performance.now();
      const res = this._ask(question.trim());
      res.latency_ms = performance.now() - t0;
      return res;
    }

    _ask(question) {
      const m = this.ix.messages;
      const base = { question, citations: [], hits: [], top_score: 0 };
      const guard = this.checkQuestion(question);
      base.guard = guard.category;
      if (!guard.allowed) return { ...base, status: "refused_" + guard.category, answer: guard.message };

      const qWords = new Set(words(question));
      if (!this.covered.some((n) => qWords.has(n))) {
        const names = this.covered.map(cap).join(", ");
        return { ...base, status: "not_found", reason: "no_medicine", answer: `${m.no_medicine} Medicines covered: ${names}.` };
      }

      const all = this.search(question, this.ix.settings.top_k);
      const top = all.length ? all[0].score : 0;
      const kept = all.filter((h) => h.score >= this.ix.settings.min_score);
      const hits = focusOnMedicine(qWords, kept);
      const trace = { ...base, hits: all, kept: new Set(hits), top_score: top };
      if (!hits.length) return { ...trace, status: "not_found", reason: "low_score", answer: m.no_answer };

      const text = this.extractive(question, hits);
      if (text === null) return { ...trace, status: "not_found", reason: "no_sentence", answer: m.no_answer };
      const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((x) => +x[1]))]
        .filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
      const citations = used.map((n) => ({ number: n, ...hits[n - 1].chunk, score: hits[n - 1].score }));
      return { ...trace, status: "answered", answer: text, citations, sources: hits };
    }
  }

  function medicineName(doc) {
    return doc.toLowerCase().split(/[-_ ]/)[0];
  }

  function focusOnMedicine(qWords, hits) {
    if (!hits.length) return hits;
    const named = new Set(hits.filter((h) => qWords.has(medicineName(h.chunk.doc))).map((h) => h.chunk.doc));
    const keep = named.size ? named : new Set([hits[0].chunk.doc]);
    return hits.filter((h) => keep.has(h.chunk.doc));
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  root.LeafletAssistant = LeafletAssistant;
  root.leafletMedicineName = medicineName;
  if (typeof module !== "undefined") module.exports = { LeafletAssistant, medicineName };
})(typeof window !== "undefined" ? window : globalThis);
