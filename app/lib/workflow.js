'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { getConn } = require('./settings-store');
const { BM25Index } = require('./retrieve');
const { GeminiClient } = require('./gemini');
const { planningMessages, outlineMessages, chapterMessages, reviewMessages, summaryMessages } = require('./prompt');
const { applyPatches } = require('./patcher');
const {
  defaultMemory,
  normalizeMemory,
  buildWorldStateBlock,
  buildRefreshSystemPrompt,
  buildRefreshUserPrompt,
  executeTableEdit,
  loadMemory,
  saveMemory
} = require('./memory');

const ROOT = path.resolve(__dirname, '..');

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

// ── 结构化记忆：读取/初始化某作品的 world state 表 ──
function getMemoryForSlug(cfg, slug) {
  if (!slug) return null;
  const mem = loadMemory(cfg, slug, normalizeMemory);
  if (!mem) return null;
  return normalizeMemory(mem);
}

// 章节写完后：用轻量提炼把最新正文的持久变化写回记忆表（尽力而为，失败不影响正文）
async function updateMemoryAfterChapter({ cfg, client, slug, chapterText }) {
  if (!slug || !chapterText) return null;
  try {
    let mem = getMemoryForSlug(cfg, slug);
    if (!mem) {
      // 首次：若作品目录已存在但无记忆表，用空结构初始化
      mem = defaultMemory();
    }
    const sys = buildRefreshSystemPrompt();
    const usr = buildRefreshUserPrompt(mem, chapterText);
    const out = await client.chat([
      { role: 'system', content: sys },
      { role: 'user', content: usr }
    ], { temperature: 0.2, maxTokens: 4096 });
    const r = executeTableEdit(mem, out || '');
    if (r.count > 0) {
      saveMemory(cfg, slug, r.memory);
    }
    return r;
  } catch (e) {
    console.warn(`[workflow] 记忆提炼失败（不影响正文）: ${String((e && e.message) || e).slice(0, 140)}`);
    return null;
  }
}

// 缓存 BM25 实例；索引重建后调用 resetIndex() 失效
let _bm25 = null;
function getBM25(cfg) {
  if (_bm25) return _bm25;
  const idxPath = path.join(cfg.profileDir, 'index.json');
  if (!fs.existsSync(idxPath)) throw new Error(`缺少检索索引，请先在“语料维护”里重建（${idxPath}）`);
  _bm25 = new BM25Index(JSON.parse(fs.readFileSync(idxPath, 'utf8')));
  return _bm25;
}
function resetIndex() {
  _bm25 = null;
}

// overrides 来自前端（逐次/会话级），未提供的字段回退到 config.json
function normalizeOverrides(ov) {
  ov = ov || {};
  const cfg = loadConfig(ROOT);
  return {
    model: ov.model || null,           // 临时覆盖生成模型（回归/基准用）
    temperature: numOr(ov.temperature, cfg.gemini.temperature),
    maxOutputTokens: numOr(ov.maxOutputTokens, cfg.gemini.maxOutputTokens),
    topK: numOr(ov.topK, cfg.retrieve.topK),
    maxCharsPerResult: numOr(ov.maxCharsPerResult, cfg.retrieve.maxCharsPerResult),
    lengthTier: ov.lengthTier || '',
    selfCheck: ov.selfCheck !== false,
    rewriteMax: numOr(ov.rewriteMax, 1),
    chapterTarget: ov.chapterTarget !== null && ov.chapterTarget !== undefined ? Number(ov.chapterTarget) : null,
    maxSegments: numOr(ov.maxSegments, 12),
    reviewModel: ov.reviewModel || null, // 评审模型（不固定，缺省跟随生成模型）
    dialOff: !!ov.dialOff,               // 关闭模型拨档（基准对照用）
    patch: ov.patch !== false,           // 破甲层：生产默认开启，只能显式关闭（测试用）
    apiKey: ov.apiKey || cfg.gemini.apiKey
  };
}

// 归一化模型返回的大纲：兼容 顶层数组 / 数字键对象 {0:{},1:{}} / 标准 {chapters:[]}
function normalizeOutline(o) {
  if (Array.isArray(o)) return { chapters: o };
  if (o && typeof o === 'object') {
    if (Array.isArray(o.chapters)) return { ...o, chapters: o.chapters };
    const numKeys = Object.keys(o).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    if (numKeys.length) {
      const rest = {};
      for (const k of Object.keys(o)) if (!/^\d+$/.test(k)) rest[k] = o[k];
      return { ...rest, chapters: numKeys.map((k) => o[k]) };
    }
  }
  return { chapters: [] };
}

// beats 归一化：兼容旧版纯字符串节拍；新版为 {t, type:[narr|dialog|action|emotion]}
function normalizeBeats(ch) {
  const raw = (ch.beats || [])
    .map((b) => {
      if (typeof b === 'string') return { t: b, type: 'narr' };
      if (b && typeof b === 'object') {
        return { t: b.t || b.text || '', type: ['narr', 'dialog', 'action', 'emotion'].includes(b.type) ? b.type : 'narr' };
      }
      return { t: '', type: 'narr' };
    })
    .filter((b) => b.t);
  return raw.length ? raw : [{ t: ch.hook || '继续推进', type: 'narr' }];
}

// —— 参数化节拍许可（模型拨档）——
// 基准 = LICENSE v3.3 的硬配额；dial 提供相对增减（百分点，幅度限制 ±10）。
const BASE_DIAL = { short: 0, long: 0, dialog: 0 };

function clampPct(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function buildLicenses(dial = {}) {
  const d = {
    short: Math.max(-10, Math.min(10, Number(dial.short) || 0)),
    long: Math.max(-10, Math.min(10, Number(dial.long) || 0)),
    dialog: Math.max(-10, Math.min(10, Number(dial.dialog) || 0))
  };
  const narrShort = clampPct(20 + d.short, 10, 40);
  const actionShort = clampPct(50 + d.short, 30, 70);
  const dialogShort = clampPct(50 + d.short, 30, 70);
  const narrLong = clampPct(15 + d.long, 5, 40);
  const emotionLong = clampPct(33 + d.long, 15, 60);
  const dialogPct = clampPct(40 + d.dialog, 25, 70);
  return {
    narr: `节奏许可（含硬配额）：叙述行以 10~18 字中句为主；≤8字短击占本拍句数约 ${narrShort}%，且至少 ${narrLong}% 的句子 ≥16 字，长短交错，禁连续三行同构句长；动词名词叙事，克制比喻。`,
    dialog: `节奏许可（含硬配额）：本拍对话行占比必须 ≥${dialogPct}%；台词里至少 ${dialogShort}% 是 ≤8 字的短句断口（口语化），夹叙行不超过两行；温柔表层下藏刀刃。`,
    action: `节奏许可（动作峰）：短句阶梯，约 ${actionShort}% 句子 ≤8 字、一行一个动作/物理事实；每 3~5 行留一行 10~20 字中句换气；本拍内保留 2~3 句 15 字以上的收束句；禁止长段比喻。`,
    emotion: `节奏许可（情绪峰）：长句独白流，硬配额：本拍至少 ${emotionLong}% 的句子超过 30 字；可单句成段留白；情绪顶到头后用一句短句收锋。`
  };
}

// 读取模型拨档：profile/model-dial.json 子串匹配，首条命中生效；未命中=基准
function loadModelDial(model) {
  const cfg = loadConfig(ROOT);
  const file = path.join(cfg.profileDir, 'model-dial.json');
  let list = null;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    list = null;
  }
  const m = String(model || '').toLowerCase();
  const hit = Array.isArray(list) ? list.find((r) => r && r.match && m.includes(String(r.match).toLowerCase())) : null;
  return (hit && hit.dial) || {};
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 章节自动续写引擎 v3：按节拍逐拍生成，随 beat.type 切换节奏许可；目标字数按权重分配（action/emotion ×1.5）。
// 输入触发平台内容拦截（PROHIBITED）时，自动降级为 baseMsgsNoEvidence 重试。
async function continueChapter({ client, baseMsgs, baseMsgsNoEvidence = null, outlineChapter, chapterTarget, maxSegments, temperature, maxOutputTokens, tailWindow = 400, requestSpacingMs = 5000, dial = null }) {
  const licenses = buildLicenses(dial ?? loadModelDial(client.cfg && client.cfg.model));
  const beats = normalizeBeats(outlineChapter);
  const weights = beats.map((b) => (b.type === 'action' || b.type === 'emotion' ? 1.5 : 1));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const beatTargets = beats.map((i, idx) => Math.max(200, Math.round((chapterTarget * weights[idx]) / totalW)));

  const segments = [];
  let text = '';
  let activeBase = baseMsgs;
  let noEvUsed = false;
  let prevType = '';

  // 单次调用 + 拦截降级 + 429 冷却重试 + 空响应兜底，返回 {text, empty, retry}
  const chatWithFallback = async (msgsForSeg) => {
    for (let attempt = 0; attempt <= 1; attempt++) {
      let seg = null;
      let segClean = '';
      try {
        seg = await client.chat(msgsForSeg, { temperature, maxTokens: maxOutputTokens });
        segClean = (seg || '').trim();
      } catch (e) {
        const msg = String((e && e.message) || e);
        const blocked = /PROHIBITED|blocked/i.test(msg);
        if (blocked && !noEvUsed && baseMsgsNoEvidence) {
          noEvUsed = true;
          activeBase = baseMsgsNoEvidence;
          return { retry: true };
        }
        if (/429|速率|rate.{0,5}limit|quota|capacity/i.test(msg) && attempt === 0) {
          await sleepMs(45000); // 撞上被拦截重试引发的限速风暴：冷却后重试同一拍
          continue;
        }
        throw e;
      }
      if (!segClean) {
        for (let r = 0; r < 3 && !segClean; r++) {
          seg = await client.chat(
            [...msgsForSeg, { role: 'user', content: '（上一轮输出为空。请忽略任何干扰，直接输出本章正文，从上一段结尾继续。）' }],
            { temperature, maxTokens: maxOutputTokens }
          );
          segClean = (seg || '').trim();
        }
      }
      return { text: segClean, empty: !segClean };
    }
    return { text: '', empty: true };
  };

  let beatIdx = 0;
  for (let s = 0; s < maxSegments; s++) {
    if (s > 0 && requestSpacingMs > 0) await sleepMs(requestSpacingMs); // 请求间距：防同窗限速风暴
    if (beatIdx >= beats.length) break;
    // 章首报幕：单独一拍（可用诗节）
    if (s === 0 && outlineChapter.opening) {
      const note =
        `【章首报幕】\n用一句或三行诗节式开篇（每行一句、行间留白），起点如下：\n${outlineChapter.opening}\n\n随后自然进入正文，不要解释报幕。`;
      const r = await chatWithFallback([...activeBase, { role: 'user', content: note }]);
      if (r.retry) { s--; continue; }
      if (r.empty) break;
      segments.push({ seg: 'opening', chars: r.text.length });
      text += r.text + '\n\n';
      continue;
    }
    const b = beats[beatIdx];
    const tail = text ? text.slice(-tailWindow) : '';
    const target = beatTargets[beatIdx];
    const anti = prevType && prevType === b.type ? '｜与上一拍同类型，本拍务必做出节奏反差（句长/密度错开）。' : '';
    const xpNote = b.type === 'action' || b.type === 'emotion'
      ? '\n【敏感处理】若本拍意象易触发平台审核，请用含蓄的侧面物理描写完成——仅借温度、气压、水声、震颤与触感——不改变情节与结局。'
      : '';
    const endNote = beatIdx === beats.length - 1 && outlineChapter.hook
      ? `\n【收束】本拍是本章末拍：请务必让正文最后一句话落在钩子上（或钩子的直接意象变体），以台词或动作收尾，不要截断、不要总结。钩子：「${outlineChapter.hook}」。`
      : '';
    const note =
      `【本拍内容】${b.t}\n` +
      `【节奏许可】${licenses[b.type]}${anti}\n` +
      (tail ? `【衔接】上一段以如下文字收尾（紧接其后继续，不要重复）：\n「${tail}」\n` : '') +
      `【篇幅】本拍目标约 ${target} 字（达到即可，不硬凑）。直接输出本拍正文，不写标题、不总结。` +
      xpNote + endNote;
    const r = await chatWithFallback([...activeBase, { role: 'user', content: note }]);
    if (r.retry) { s--; continue; }
    if (r.empty) { segments.push({ seg: `beat${beatIdx + 1}`, chars: 0, empty: true }); break; }
    segments.push({ seg: `beat${beatIdx + 1}.${b.type}`, chars: r.text.length });
    text += r.text + '\n\n';
    prevType = b.type;
    beatIdx++;
  }

  // 节拍全部完成仍不足目标字数：补足式自由续写（至多两拍）
  let extra = 0;
  while (text.length < chapterTarget && extra < 2) {
    if (requestSpacingMs > 0) await sleepMs(requestSpacingMs);
    extra++;
    const remaining = chapterTarget - text.length;
    const note = `【补足续写】本章还差约 ${remaining} 字。请在不跳章、不收尾的前提下，用与最近一段不同的节奏再推进一小段情节。直接输出正文。`;
    const r = await chatWithFallback([...activeBase, { role: 'user', content: note }]);
    if (r.retry) continue;
    if (r.empty || r.text.length < 100) break;
    segments.push({ seg: `extra${extra}`, chars: r.text.length });
    text += r.text + '\n\n';
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, segments, totalChars: text.length, noEvUsed };
}

function numOr(v, fallback) {
  return (v === undefined || v === null || v === '') ? fallback : Number(v);
}

function makeClient(ov, mock) {
  const cfg = loadConfig(ROOT);
  const conn = getConn();
  const geminiCfg = {
    ...cfg.gemini,
    model: ov.model || conn.model || cfg.gemini.model,
    baseUrl: conn.baseUrl || cfg.gemini.baseUrl,
    apiKey: ov.apiKey || conn.apiKey || cfg.gemini.apiKey
  };
  return new GeminiClient(geminiCfg, { mock });
}

function evidenceFor(bm25, query, ov) {
  const top = bm25.search(query, ov.topK);
  return top.map((r) => `【${r.doc.title}】${r.doc.text.slice(0, ov.maxCharsPerResult)}`).join('\n\n');
}

function getContext(cfg) {
  const styleMeta = readJSON(path.join(cfg.profileDir, 'style.json'));
  const styleText = styleMeta?.summary || readText(path.join(cfg.profileDir, 'style.json'));
  const tropesText = readText(path.join(cfg.profileDir, 'tropes.txt'));
  const worldbookJson = readJSON(path.join(cfg.profileDir, 'worldbook.json'));
  const worldbookText = worldbookJson ? JSON.stringify(worldbookJson) : '';
  const anchorsText = readText(path.join(cfg.profileDir, 'style-anchors.txt'));
  const avoidText = readText(path.join(cfg.profileDir, 'style-avoid.txt'));
  return { styleText, tropesText, worldbookText, anchorsText, avoidText };
}

function resolveSeries(input) {
  const cfg = loadConfig(ROOT);
  const names = (readJSON(path.join(cfg.profileDir, 'series.json'))?.series || []).map((s) => s.name);
  if (!input) return input;
  return names.find((n) => n.includes(input) || input.includes(n)) || input;
}

async function doPlan({ topic = '', series = '', mock = false, overrides } = {}) {
  const ov = normalizeOverrides(overrides);
  const cfg = loadConfig(ROOT);
  const client = makeClient(ov, mock);
  const ctx = getContext(cfg);

  const planMsgs0 = planningMessages({ topic, styleText: ctx.styleText, tropeText: ctx.tropesText, lengthTier: ov.lengthTier, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText });
  const planMsgs = ov.patch ? applyPatches(planMsgs0, 'planning', { topic, lengthTier: ov.lengthTier, styleText: ctx.styleText, tropeText: ctx.tropesText }) : planMsgs0;
  const plan = await client.chatJSON(planMsgs, { temperature: ov.temperature, maxTokens: ov.maxOutputTokens });
  if (series) plan.series = resolveSeries(series);
  return plan;
}

async function doOutline({ plan, mock = false, overrides } = {}) {
  const ov = normalizeOverrides(overrides);
  const cfg = loadConfig(ROOT);
  const client = makeClient(ov, mock);
  const ctx = getContext(cfg);
  const bm25 = getBM25(cfg);

  const planQuery = [plan.title, plan.series, plan.premise, ...(plan.tags || [])].filter(Boolean).join(' ');
  const seriesEvidence = evidenceFor(bm25, planQuery, ov);
  const outlineMsgs0 = outlineMessages({ plan, seriesEvidence, styleText: ctx.styleText, worldbookText: ctx.worldbookText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText });
  const outlineMsgs = ov.patch ? applyPatches(outlineMsgs0, 'outline', { plan, seriesEvidence, styleText: ctx.styleText, worldbookText: ctx.worldbookText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText }) : outlineMsgs0;
  const outlineMsgsNoEv0 = outlineMessages({ plan, seriesEvidence: '', styleText: ctx.styleText, worldbookText: ctx.worldbookText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText });
  const outlineMsgsNoEv = ov.patch ? applyPatches(outlineMsgsNoEv0, 'outline', { plan, seriesEvidence: '', styleText: ctx.styleText, worldbookText: ctx.worldbookText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText }) : outlineMsgsNoEv0;
  let outline = null;
  try {
    outline = normalizeOutline(await client.chatJSON(outlineMsgs, { temperature: ov.temperature, maxTokens: ov.maxOutputTokens }));
  } catch (e) {
    const blocked = /PROHIBITED|blocked/i.test(String((e && e.message) || e));
    if (blocked) {
      outline = normalizeOutline(await client.chatJSON(outlineMsgsNoEv, { temperature: ov.temperature, maxTokens: ov.maxOutputTokens }));
    } else {
      throw e;
    }
  }
  return outline;
}

async function doChapter({ plan, outline, chapterIndex, prevSummaries = [], mock = false, overrides, slug } = {}) {
  const ov = normalizeOverrides(overrides);
  const cfg = loadConfig(ROOT);
  const client = makeClient(ov, mock);
  const ctx = getContext(cfg);
  const bm25 = getBM25(cfg);

  outline = normalizeOutline(outline);
  const ch = outline.chapters[chapterIndex];
  if (!ch) throw new Error(`章节索引越界：${chapterIndex}`);
  const beatText = (ch.beats || []).map((b) => (typeof b === 'string' ? b : b.t || b.text || '')).join(' ');
  const query = [plan.title, plan.series, plan.premise, ch.title, beatText, ch.scene].filter(Boolean).join(' ');
  const evidence = evidenceFor(bm25, query, ov);

  // —— 结构化记忆注入：读取该作品的世界状态表，作为刚性事实注入上下文 ——
  const memory = slug ? getMemoryForSlug(cfg, slug) : null;
  const worldStateText = memory ? buildWorldStateBlock(memory) : '';

  const chCtx = { plan, outline, chapterIndex, prevSummaries, styleText: ctx.styleText, worldbookText: ctx.worldbookText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText };
  const baseMsgs0 = chapterMessages({ ...chCtx, evidence, worldStateText });
  const baseMsgs = ov.patch ? applyPatches(baseMsgs0, 'chapter', { ...chCtx, evidence }) : baseMsgs0;
  const baseMsgsNoEvidence0 = chapterMessages({ ...chCtx, evidence: '', worldStateText });
  const baseMsgsNoEvidence = ov.patch ? applyPatches(baseMsgsNoEvidence0, 'chapter', { ...chCtx, evidence: '' }) : baseMsgsNoEvidence0;

  // —— 章节自动续写 v3：按节拍逐拍生成，目标字数 = 显式 chapterTarget 或 策划总字数/章数 ——
  const numCh = Math.max(1, outline.chapters.length);
  const planTarget = Number(plan.targetLength) || 6000;
  const chapterTarget = ov.chapterTarget || Math.max(1500, Math.round(planTarget / numCh));
  let { text, segments, totalChars, noEvUsed } = await continueChapter({
    client,
    baseMsgs,
    baseMsgsNoEvidence,
    outlineChapter: ch,
    chapterTarget,
    maxSegments: ov.maxSegments || 12,
    temperature: ov.temperature,
    maxOutputTokens: ov.maxOutputTokens,
    dial: ov.dialOff ? {} : undefined
  });

  if (ov.selfCheck === false) {
    // 无自检也照常执行记忆提炼（异步不阻塞返回）
    if (slug) updateMemoryAfterChapter({ cfg, client, slug, chapterText: text });
    return { text, review: null, rewritten: false, segments, totalChars, noEvUsed, chapterTarget };
  }

  const reviewOpts = { temperature: 0.3, maxTokens: 1200 };
  const makeReview = () => {
    const base = reviewMessages({ plan, outline, chapterIndex, chapterText: text, worldbookText: ctx.worldbookText, styleText: ctx.styleText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText });
    return ov.patch ? applyPatches(base, 'review', { plan, outline, chapterIndex, chapterText: text, worldbookText: ctx.worldbookText, styleText: ctx.styleText, anchorsText: ctx.anchorsText, avoidText: ctx.avoidText }) : base;
  };
  // 评审模型可配置：ov.reviewModel 指定（如 3.1 Pro），缺省用当前生成模型
  const reviewClient = ov.reviewModel ? new GeminiClient({ ...client.cfg, model: ov.reviewModel }, { mock }) : client;

  let review = null;
  let rewritten = false;
  try {
    review = await reviewClient.chatJSON(makeReview(), reviewOpts);
    let attempts = 0;
    while (review && review.ok === false && Array.isArray(review.issues) && review.issues.length && attempts < ov.rewriteMax) {
      rewritten = true;
      attempts++;
      const fixNote = `上一版存在以下问题，请修正后重写本章（仍直接输出正文）：\n${review.issues.join('\n')}`;
      // 重写同样走节拍引擎（保留节奏许可与续写兜底），证据可从缺省
      const rr = await continueChapter({
        client,
        baseMsgs: [...baseMsgs, { role: 'user', content: fixNote }],
        baseMsgsNoEvidence: [...baseMsgsNoEvidence, { role: 'user', content: fixNote }],
        outlineChapter: ch,
        chapterTarget,
        maxSegments: ov.maxSegments || 12,
        temperature: ov.temperature,
        maxOutputTokens: ov.maxOutputTokens,
        dial: ov.dialOff ? {} : undefined
      });
      text = rr.text;
      segments = rr.segments;
      totalChars = rr.totalChars;
      noEvUsed = rr.noEvUsed;
      review = await reviewClient.chatJSON(makeReview(), reviewOpts);
    }
  } catch (e) {
    console.warn(`[workflow] 自检失败已跳过（不回滚本章）: ${String((e && e.message) || e).slice(0, 140)}`);
    review = null;
  }

  // —— 生成完成后：用最终正文提炼持久变化，增量写回记忆表（尽力而为）——
  if (slug) updateMemoryAfterChapter({ cfg, client, slug, chapterText: text });

  return { text, review, rewritten, segments, totalChars: text.length, noEvUsed, chapterTarget };
}

function summarizeChapter(outlineChapter) {
  const beatsText = (outlineChapter.beats || [])
    .map((b) => (typeof b === 'string' ? b : b.t || b.text || ''))
    .filter(Boolean)
    .join(' / ');
  return `${outlineChapter.title}：${beatsText}${outlineChapter.hook ? ' → ' + outlineChapter.hook : ''}`;
}

module.exports = { doPlan, doOutline, doChapter, summarizeChapter, resetIndex, resolveSeries, normalizeOutline, continueChapter, normalizeBeats, loadModelDial, buildLicenses, updateMemoryAfterChapter };