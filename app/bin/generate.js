'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { sanitizeSlug } = require('../lib/corpus');
const { BM25Index } = require('../lib/retrieve');
const { GeminiClient } = require('../lib/gemini');
const {
  planningMessages,
  outlineMessages,
  chapterMessages,
  reviewMessages
} = require('../lib/prompt');
const { normalizeOutline, continueChapter } = require('../lib/workflow');
const { applyPatches } = require('../lib/patcher');

const ROOT = path.resolve(__dirname, '..');

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function parseArgs(argv) {
  const args = { topic: '', series: '', mock: false, resume: false, out: '', chapterTarget: 0, maxSegments: 12, reviewModel: '', dialOff: false, noPatch: false, resumeAt: -1, minTarget: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--dial-off') args.dialOff = true;
    else if (a === '--no-patch') args.noPatch = true;
    else if (a === '--topic' || a === '-t') args.topic = argv[++i] || '';
    else if (a === '--series' || a === '-s') args.series = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--review-model') args.reviewModel = argv[++i] || '';
    else if (a === '--chapter-target') args.chapterTarget = Number(argv[++i] || 0);
    else if (a === '--max-segments') args.maxSegments = Number(argv[++i] || 12);
    else if (a === '--min-target') args.minTarget = Number(argv[++i] || 0);
    else if (a === '--resume-at') args.resumeAt = Number(argv[++i] ?? -1);
    else if (!a.startsWith('-')) args.topic = args.topic ? args.topic + ' ' + a : a;
  }
  return args;
}

function buildIndex(cfg) {
  const idxPath = path.join(cfg.profileDir, 'index.json');
  if (!fs.existsSync(idxPath)) {
    throw new Error(`缺少检索索引 ${idxPath}，请先运行 node bin/build-profile.js`);
  }
  const docs = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  return new BM25Index(docs);
}

function evidenceFor(bm25, query, cfg) {
  const top = bm25.search(query, cfg.retrieve.topK);
  return top
    .map((r) => `【${r.doc.title}】${r.doc.text.slice(0, cfg.retrieve.maxCharsPerResult)}`)
    .join('\n\n');
}

function summarizeChapter(outlineChapter) {
  const beatsText = (outlineChapter.beats || [])
    .map((b) => (typeof b === 'string' ? b : b.t || b.text || ''))
    .filter(Boolean)
    .join(' / ');
  return `${outlineChapter.title}：${beatsText}${outlineChapter.hook ? ' → ' + outlineChapter.hook : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(ROOT);
  const client = new GeminiClient(cfg.gemini, { mock: args.mock });

  if (!args.mock && !client.hasKey()) {
    console.error('未检测到 API Key。请设置环境变量 GEMINI_API_KEY（或先用 --mock 试跑）。');
    process.exit(1);
  }

  const styleMeta = readJSON(path.join(cfg.profileDir, 'style.json'));
  const styleText = styleMeta?.summary || readText(path.join(cfg.profileDir, 'style.json'));
  const tropesText = readText(path.join(cfg.profileDir, 'tropes.txt'));
  const worldbookText = readJSON(path.join(cfg.profileDir, 'worldbook.json'))
    ? JSON.stringify(readJSON(path.join(cfg.profileDir, 'worldbook.json')))
    : '';
  const anchorsText = readText(path.join(cfg.profileDir, 'style-anchors.txt'));
  const avoidText = readText(path.join(cfg.profileDir, 'style-avoid.txt'));

  const bm25 = buildIndex(cfg);

  // 系列名模糊匹配到 profile/series.json 里的规范名（--series 输入会被规范化为 profile 中的系列名）
  const seriesNames = (readJSON(path.join(cfg.profileDir, 'series.json'))?.series || []).map((s) => s.name);
  const resolveSeries = (input) => {
    if (!input) return input;
    return seriesNames.find((n) => n.includes(input) || input.includes(n)) || input;
  };

  const P = (msgs, stage, ctx) => (args.noPatch ? msgs : applyPatches(msgs, stage, ctx));

  // ── 1. 策划 / 断点续跑 ──
  let plan;
  let outline;
  let outDir;
  let startIdx = 0;
  if (args.resumeAt >= 0 && args.out) {
    outDir = path.join(cfg.outDir, args.out);
    plan = readJSON(path.join(outDir, 'plan.json'));
    outline = normalizeOutline(readJSON(path.join(outDir, 'outline.json')));
    if (!plan || !outline || !outline.chapters.length) throw new Error(`断点续跑缺少 ${outDir} 下的 plan.json/outline.json`);
    startIdx = args.resumeAt;
    console.log(`[generate] 断点续跑：从第 ${startIdx + 1} 章继续（共 ${outline.chapters.length} 章）`);
  } else {
    if (args.resumeAt >= 0) throw new Error('--resume-at 必须配合 --out <已存在的作品目录>');
    console.log('[generate] ① 创作策划…');
    const planMsgs = P(planningMessages({ topic: args.topic, styleText, tropeText: tropesText, anchorsText, avoidText }), 'planning', { topic: args.topic, styleText, tropeText: tropesText, anchorsText, avoidText });
    plan = await client.chatJSON(planMsgs);
    if (args.series) plan.series = resolveSeries(args.series);
    if (args.minTarget && Number(plan.targetLength) < args.minTarget) {
      plan.targetLength = args.minTarget;
      plan.note = `${plan.note || ''}（篇幅已按用户要求上调至 ${args.minTarget} 字）。`.trim();
    }
    const slug = args.out || sanitizeSlug(`${Date.now()}_${plan.title || 'untitled'}`);
    outDir = path.join(cfg.outDir, slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    console.log('[generate] 策划:', plan.title, '｜', plan.series, '｜', (plan.tags || []).join('/'));

    console.log('[generate] ② 拟定大纲…');
    const planQuery = [plan.title, plan.series, plan.premise, ...(plan.tags || [])].filter(Boolean).join(' ');
    const seriesEvidence = evidenceFor(bm25, planQuery, cfg);
    const oCtx = { plan, seriesEvidence, styleText, worldbookText, anchorsText, avoidText };
    const outlineMsgs = P(outlineMessages(oCtx), 'outline', oCtx);
    const outlineMsgsNoEv = P(outlineMessages({ ...oCtx, seriesEvidence: '' }), 'outline', { ...oCtx, seriesEvidence: '' });
    try {
      outline = normalizeOutline(await client.chatJSON(outlineMsgs));
    } catch (e) {
      const blocked = /PROHIBITED|blocked/i.test(String((e && e.message) || e));
      if (blocked) {
        console.warn('[generate] 输入被拦截，已降级为无检索证据模式重试大纲');
        outline = normalizeOutline(await client.chatJSON(outlineMsgsNoEv));
      } else throw e;
    }
    fs.writeFileSync(path.join(outDir, 'outline.json'), JSON.stringify(outline, null, 2), 'utf8');
    console.log(`[generate] 大纲 ${outline.chapters.length} 章`);
  }

  // ── 3. 逐章写作（单章隔离故障，不株连全书） ──
  const prevSummaries = [];
  const chapterTexts = [];
  const failed = [];
  for (let i = startIdx; i < outline.chapters.length; i++) {
    const ch = outline.chapters[i];
    try {
      console.log(`[generate] ③ 第 ${i + 1}/${outline.chapters.length} 章《${ch.title || ''}》…`);
      const beatText = (ch.beats || []).map((b) => (typeof b === 'string' ? b : b.t || b.text || '')).join(' ');
      const query = [plan.title, plan.series, plan.premise, ch.title, beatText, ch.scene].filter(Boolean).join(' ');
      const evidence = evidenceFor(bm25, query, cfg);
      const cCtx = { plan, outline, chapterIndex: i, prevSummaries, styleText, worldbookText, anchorsText, avoidText };
      const baseMsgs = P(chapterMessages({ ...cCtx, evidence }), 'chapter', { ...cCtx, evidence });
      const baseMsgsNoEvidence = P(chapterMessages({ ...cCtx, evidence: '' }), 'chapter', { ...cCtx, evidence: '' });

      const numCh = Math.max(1, outline.chapters.length);
      const planTarget = Number(plan.targetLength) || 6000;
      const chapterTarget = args.chapterTarget || Math.max(1500, Math.round(planTarget / numCh));
      let { text, segments } = await continueChapter({
        client,
        baseMsgs,
        baseMsgsNoEvidence,
        outlineChapter: ch,
        chapterTarget,
        maxSegments: args.maxSegments,
        temperature: cfg.gemini.temperature,
        maxOutputTokens: cfg.gemini.maxOutputTokens,
        dial: args.dialOff ? {} : undefined
      });
      if (!text) text = '（本章模型返回为空，已自动跳过。可重跑本命令续该章。）';
      console.log(`[generate]   本章 ${text.length} 字（${segments.length} 段续写，目标 ${chapterTarget}）`);

      // 一致性自检，不通过则带问题重写一次；评审模型可配置（--review-model，缺省=生成模型）
      const reviewClient = args.reviewModel ? new GeminiClient({ ...client.cfg, model: args.reviewModel }, { mock: args.mock }) : client;
      const makeReview = () => P(reviewMessages({ ...cCtx, chapterText: text }), 'review', { ...cCtx, chapterText: text });
      let review = await reviewClient.chatJSON(makeReview());
      if (review && review.ok === false && review.issues && review.issues.length) {
        console.log('[generate]   自检不通过，重写一次:', review.issues.join('；'));
        const fixNote = `上一版存在以下问题，请修正后重写本章（仍直接输出正文）：\n${review.issues.join('\n')}`;
        const rr = await continueChapter({
          client,
          baseMsgs: [...baseMsgs, { role: 'user', content: fixNote }],
          baseMsgsNoEvidence: [...baseMsgsNoEvidence, { role: 'user', content: fixNote }],
          outlineChapter: ch,
          chapterTarget,
          maxSegments: args.maxSegments,
          temperature: cfg.gemini.temperature,
          maxOutputTokens: cfg.gemini.maxOutputTokens,
          dial: args.dialOff ? {} : undefined
        });
        text = rr.text;
        segments = rr.segments;
        review = await reviewClient.chatJSON(makeReview());
      }

      chapterTexts.push(text);
      prevSummaries.push({ idx: ch.idx ?? i + 1, summary: summarizeChapter(ch) });
      fs.writeFileSync(path.join(outDir, `chapter_${String(i + 1).padStart(2, '0')}.txt`), text, 'utf8');
      fs.writeFileSync(path.join(outDir, `chapter_${String(i + 1).padStart(2, '0')}.segments.json`), JSON.stringify({ chapterTarget, segments }, null, 2), 'utf8');
    } catch (e) {
      console.error(`[generate] 第 ${i + 1} 章失败: ${String((e && e.message) || e).slice(0, 160)}`);
      failed.push({ chapter: i + 1, error: String((e && e.message) || e) });
      const ph = `（本章生成失败，可续跑：node bin/generate.js --resume-at ${i} --out ${path.basename(outDir)}）`;
      chapterTexts.push(ph);
      fs.writeFileSync(path.join(outDir, `chapter_${String(i + 1).padStart(2, '0')}.txt`), ph, 'utf8');
    }
  }
  if (failed.length) console.error(`[generate] 共 ${failed.length} 章失败: ${failed.map((f) => f.chapter).join(',')}`);

  // ── 4. 汇总成稿（题头 + 目录 + 正文） ──
  const totalChars = chapterTexts.reduce((s, t) => s + t.length, 0);
  const header = [
    `# ${plan.title}`,
    '',
    `> 系列：${plan.series || '原创'}｜tags：${(plan.tags || []).join('、')}｜字数：${totalChars}｜模型：${cfg.gemini.model}｜生成时间：${new Date().toISOString()}`,
    `> ${plan.premise || ''}`,
    '',
    '## 目录',
    ...outline.chapters.map((ch, i) => `- ${i + 1}. ${ch.title || `第${i + 1}章`}`)
  ];
  const md = header
    .concat([''])
    .concat(outline.chapters.map((ch, i) => `## ${ch.title || `第${i + 1}章`}\n\n${chapterTexts[i] || ''}\n`))
    .join('\n');
  fs.writeFileSync(path.join(outDir, '作品.md'), md, 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'state.json'),
    JSON.stringify({ done: true, plan, outline, chapters: chapterTexts.length, totalChars, model: cfg.gemini.model }, null, 2),
    'utf8'
  );

  // ── 作品索引 out/index.json（按系列分组；双签名分占位 null） ──
  const idxPath = path.join(cfg.outDir, 'index.json');
  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(idxPath, 'utf8')) || [];
  } catch {
    index = [];
  }
  const entry = {
    slug: path.basename(outDir),
    title: plan.title,
    series: plan.series || '原创',
    chapters: outline.chapters.length,
    totalChars,
    model: cfg.gemini.model,
    ts: Date.now(),
    judgeScore: null,
    likelihood: null
  };
  const idx = index.findIndex((e) => e.slug === entry.slug);
  if (idx >= 0) index[idx] = entry;
  else index.push(entry);
  index.sort((a, b) => b.ts - a.ts);
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 2), 'utf8');

  console.log(`[generate] 完成 → ${path.join(outDir, '作品.md')}`);
  console.log(`[generate] 索引已更新 out/index.json（${index.length} 条）`);
}

main().catch((e) => {
  console.error('[generate] 失败:', e.message || e);
  process.exit(1);
});