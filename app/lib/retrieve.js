'use strict';

// 轻量 BM25 检索（字符 bigram + 拉丁词），零依赖。
// 中文不做词典分词：用连续 CJK 字符的 bigram 作为索引项，足够支撑“按角色名/世界观词/题材词召回”。

function tokenize(text) {
  const tokens = [];
  const latin = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
  tokens.push(...latin);
  // 连续 CJK 段落做 bigram
  const cjk = text.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

function freqMap(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

class BM25Index {
  constructor(docs) {
    // docs: {id, text, ...payload}
    this.docs = docs;
    this.docFreq = new Map();
    this.docTokens = docs.map((d) => freqMap(tokenize(d.text)));
    this.avgLen = this.docTokens.reduce((a, m) => a + m.size, 0) / Math.max(1, docs.length);
    this.N = docs.length;
    for (const m of this.docTokens) {
      for (const t of m.keys()) this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
    }
  }

  search(query, topK = 14) {
    const qf = freqMap(tokenize(query));
    if (qf.size === 0) return [];
    const k1 = 1.5;
    const b = 0.75;
    const scored = [];
    for (let i = 0; i < this.N; i++) {
      const m = this.docTokens[i];
      let score = 0;
      for (const [term, qn] of qf) {
        const df = this.docFreq.get(term);
        if (!df) continue;
        const f = m.get(term) || 0;
        if (f === 0) continue;
        const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
        const denom = f + k1 * (1 - b + (b * m.size) / Math.max(1, this.avgLen));
        score += idf * ((f * (k1 + 1)) / denom) * qn;
      }
      if (score > 0) scored.push({ doc: this.docs[i], score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

module.exports = { tokenize, BM25Index };