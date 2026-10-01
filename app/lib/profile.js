'use strict';

const { countChars, splitParagraphs, chunkText } = require('./corpus');

// 系列归属规则：命中即归入该系列（用于加载对应世界观与角色卡）
const SERIES_RULES = [
  { key: '失格', label: '失格系列', test: (t) => /失格/.test(t) },
  { key: '寄住女仆', label: '寄住女仆', test: (t) => /寄住女仆/.test(t) },
  { key: '人造城区', label: '某人造城区系列', test: (t) => /人造城区|在逃人员|管理人员|归属系手环|欺凌者/.test(t) },
  { key: '特雷森学院', label: '特雷森学院怪文书', test: (t) => /特雷森/.test(t) },
  { key: '精灵小姐', label: '精灵小姐', test: (t) => /精灵小姐/.test(t) },
  { key: '志异', label: '志异随笔集', test: (t) => /志异/.test(t) },
  { key: '学妹', label: '学妹收入囊中', test: (t) => /学妹/.test(t) },
  { key: 'Futa恋爱', label: '这样的恋爱会不会有些奇怪', test: (t) => /这样的恋爱/.test(t) }
];

function detectSeries(title) {
  for (const r of SERIES_RULES) if (r.test(title)) return r;
  return null;
}

function analyzeStyle(works) {
  const fiction = works.filter((w) => !w.isNotice);
  let sentences = 0;
  let dialogueChars = 0;
  let totalChars = 0;
  let paragraphs = 0;
  let firstPerson = 0; // 我
  let thirdPerson = 0; // 他/她
  const tagFreq = {};
  const seriesFreq = {};

  for (const w of fiction) {
    const text = w.text;
    totalChars += countChars(text);
    const paras = splitParagraphs(text);
    paragraphs += paras.length;
    // 句数
    const s = text.match(/[。！？…；\n]/g);
    sentences += s ? s.length : 1;
    // 对话占比：引号内或单独成行的「……」台词
    const dq = text.match(/[「“『].*?[」”』]/gs) || [];
    for (const q of dq) dialogueChars += countChars(q);
    firstPerson += (text.match(/我/g) || []).length;
    thirdPerson += ((text.match(/她/g) || []).length + (text.match(/他/g) || []).length);
    for (const t of w.tags) if (t !== '其他') tagFreq[t] = (tagFreq[t] || 0) + 1;
    const sr = detectSeries(w.title || '');
    const skey = sr ? sr.label : `单篇·${(w.title || '').slice(0, 10)}`;
    seriesFreq[skey] = (seriesFreq[skey] || 0) + 1;
  }

  const n = Math.max(1, fiction.length);
  const avgSentence = sentences > 0 ? Math.round(totalChars / sentences) : 0;
  const dialogueRatio = totalChars > 0 ? Math.round((dialogueChars / totalChars) * 100) : 0;
  const avgPara = paragraphs > 0 ? Math.round(totalChars / paragraphs) : 0;
  const narrativePerson = firstPerson >= thirdPerson * 1.2 ? '第一人称（我）' : '第三人称';

  return {
    works: n,
    totalChars,
    avgSentenceLen: avgSentence,
    avgParagraphLen: avgPara,
    dialoguePct: dialogueRatio,
    narrativePerson,
    tagFreq: sortFreq(tagFreq),
    seriesFreq: sortFreq(seriesFreq)
  };
}

function sortFreq(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: k, count: v }));
}

function summarizeStyle(style) {
  const tags = style.tagFreq.slice(0, 8).map((t) => `${t.name}×${t.count}`).join('、');
  const series = style.seriesFreq.slice(0, 8).map((s) => `${s.name}(${s.count}篇)`).join('、');
  return [
    `共 ${style.works} 篇有效小说，约 ${Math.round(style.totalChars / 10000)} 万字。`,
    `叙事人称倾向：${style.narrativePerson}；平均句长约 ${style.avgSentenceLen} 字、段落 ${style.avgParagraphLen} 字、对话占比约 ${style.dialoguePct}%。`,
    `高频 tag：${tags}。`,
    `主要系列线：${series}。`
  ].join('\n');
}

// 每篇作品挑选开头/结尾样例，作为 few-shot 风格证据
function extractSamples(works, head = 260, tail = 220) {
  return works
    .filter((w) => !w.isNotice)
    .map((w) => ({
      slug: w.slug,
      title: w.title,
      category: w.category,
      series: detectSeries(w.title || '')?.label || '单篇',
      tags: w.tags,
      totalChars: w.totalChars,
      opening: w.text.replace(/\s+/g, '').slice(0, head),
      closing: w.text.replace(/\s+/g, '').slice(-tail)
    }));
}

function buildIndex(works, cfg) {
  const chunks = [];
  for (const w of works.filter((x) => !x.isNotice)) {
    const parts = chunkText(w.text, cfg.chunk.targetChars, cfg.chunk.overlapChars);
    parts.forEach((text, i) => {
      chunks.push({
        id: `${w.slug}#${i}`,
        workId: w.slug,
        title: w.title,
        series: detectSeries(w.title || '')?.label || '单篇',
        tags: w.tags,
        text
      });
    });
  }
  return chunks;
}

module.exports = { analyzeStyle, summarizeStyle, extractSamples, buildIndex, detectSeries, SERIES_RULES };