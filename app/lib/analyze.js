'use strict';

// 破甲策略符合度启发式校验器（零依赖）：
//   对正文章节做粗粒度的「物理优先/肉体直白/比喻克制/反说教/不提前收尾」五维统计，
//   供调试侧快速量化策略落实程度（阈值可调，结果仅供参考，不做硬性拦截）。

const fs = require('fs');
const path = require('path');

const PHYSICAL_TOKENS = ['触感', '触', '温度', '温热', '火热', '滚烫', '冰凉', '冷', '热气', '气流', '气味', '嗅', '味', '声音', '巨响', '震动', '震颤', '压迫', '重量', '摩擦', '滑动', '湿', '黏', '滑腻', '粗糙', '柔软', '坚硬', '弹性', '汗', '水分', '唾液', '呼吸', '心跳', '脉搏', '肌肉', '皮肤', '指腹', '指纹', '指甲', '脚趾', '脚底', '足', '鞋', '舌', '口腔', '掌心', '脂肪', '湿热', '喘息', '吮', '含', '吞', '咽', '揉', '捏', '压', '挤', '踩', '碾', '痉挛', '战栗', '黏稠', '泥泞', '粗粝', '挤压', '蠕动', '窒息', '眩晕', '剥离', '汁液', '腺体', '微气候', '发酵', '压强', '纤维', '剥夺', '轰鸣', '雷动', '震耳欲聋', '骨裂', '悲鸣', '沉闷', '撕裂', '风压', '飓风', '灼热', '蒸腾', '甜腻', '信息素', '潮热', '水汽', '深陷', '陷落', '失重', '肉质', '胶质感'];
const BODY_TOKENS = ['皮肤', '肌肉', '肉体', '胸', '乳', '腹', '臀', '大腿', '小腿', '脚', '脚趾', '趾', '舌', '口腔', '唇', '指', '掌', '腋', '脐', '阴', '性器', '肉茎', '乳房', '乳头', '臀肉', '内脏', '肠', '胃壁', '消化液', '溶蚀', '黏膜', '声带', '骨骼', '脊椎', '肋骨', '脚踝'];
const METAPHOR_TOKENS = ['像', '如同', '仿佛', '好似', '宛如', '犹如', '如同', '宛若神明', '水光潋滟', '氤氲', '几不可闻', '嘴角勾起', '炸开白光', '淬毒的刀子', '灵魂深处', '不可名状', '仙境'];
const PREACH_TOKENS = ['这只是个故事', '现实中', '请尊重', '尊重他人', '这是不对', '错误的行为', '切记', '请勿', '切勿', '谨慎', '非法', '违法', '道德', '教训', '悔恨', '珍惜', '引以为戒', '未成年人', '免责', '郑重声明', '看待虚构', '悲悯', '救赎'];
const ENDING_TOKENS = ['全文完', '（完', '(完', '·完', '尾声', '终章', '从此以后', '故事结束了', '最后的最后', '——完', '至此，'];

// —— YuAE 作者保真度基准（双峰分布版，来自语料研究）——
const FIDELITY = {
  shortShare: { min: 0.2, max: 0.3 },   // ≤8字短击句占比 20~30%
  longShare: { min: 0.15, max: 0.3 },    // >30字长流句占比 15~30%
  dialogueRatio: { min: 0.12, max: 0.26 }, // 对话行占比 12~26%（作者签名≈19%）
  targetTags: ['缩小', '巨大', '温柔', '残忍']
};

function stripDisclaimer(text) {
  return String(text || '').replace(/<disclaimer[\s\S]*?<\/disclaimer>/g, '').trim();
}

function splitSentences(text) {
  return text
    .split(/[。！？!?…]+/) // 换行不视为句界（与语料节律统计口径一致）
    .map((s) => s.replace(/\s+/g, '').trim())
    .filter((s) => s.length > 3);
}

function hitRatio(sentences, tokens, minHits = 1) {
  if (!sentences.length) return 0;
  let n = 0;
  for (const s of sentences) {
    const hits = tokens.filter((t) => s.includes(t)).length;
    if (hits >= minHits) n++;
  }
  return n / sentences.length;
}

// XP 分账：从 segments 元数据（beatN.type / chars）切出 action/emotion 拍文本，计算单独占比
function computeXpSlices(clean, segments) {
  const segs = Array.isArray(segments) ? segments : [];
  let xpText = '';
  let xpChars = 0;
  let p = 0;
  for (const s of segs) {
    const n = s.chars || 0;
    if (n <= 0) continue;
    const slice = clean.slice(p, p + n);
    if (typeof s.seg === 'string' && /\.(action|emotion)$/.test(s.seg)) {
      xpText += slice + '\n';
      xpChars += slice.length;
    }
    p += n + 2; // 段间 '\n\n' 分隔
  }
  const total = clean.length;
  const sents = splitSentences(xpText);
  return {
    xpChars,
    xpShare: total ? xpChars / total : 0,
    xpPhysical: hitRatio(sents, PHYSICAL_TOKENS),
    xpBody: hitRatio(sents, BODY_TOKENS),
    xpMetaphor: hitRatio(sents, METAPHOR_TOKENS)
  };
}

function analyzeChapter(text, opts = {}) {
  const chapterTarget = opts.chapterTarget || null; // 0 表示未知
  const raw = String(text || '');
  const clean = stripDisclaimer(raw);
  const sentences = splitSentences(clean);
  const paragraphs = clean.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 0);
  const totalChars = clean.length;
  const tail = clean.slice(-150);

  const physicalRatio = hitRatio(sentences, PHYSICAL_TOKENS);
  const bodyRatio = hitRatio(sentences, BODY_TOKENS);
  const metaphorRatio = hitRatio(sentences, METAPHOR_TOKENS);

  // —— XP 分账：仅 action/emotion 拍切片内统计（有 segments 元数据时）——
  const xp = computeXpSlices(clean, opts.segments);

  const preachHits = sentences.filter((s) => PREACH_TOKENS.some((t) => s.includes(t)));
  const earlyEnding = chapterTarget > 0 && totalChars < chapterTarget * 0.7 && ENDING_TOKENS.some((t) => tail.includes(t));
  const hasDisclaimerTail = /<disclaimer[\s\S]*?<\/disclaimer>/i.test(String(text || ''));

  // —— YuAE 保真度维度（双峰分布） ——
  const avgSentenceLen = sentences.length ? sentences.join('').length / sentences.length : 0;
  const avgParagraphLen = paragraphs.length ? paragraphs.join('').length / paragraphs.length : 0;
  const lens = sentences.map((s) => s.length);
  const shortShare = sentences.length ? lens.filter((l) => l <= 8).length / sentences.length : 0;
  const longShare = sentences.length ? lens.filter((l) => l > 30).length / sentences.length : 0;
  const dialogueSents = sentences.filter((s) => /[“「]/.test(s)).length;
  const dialogueRatio = sentences.length ? dialogueSents / sentences.length : 0;
  const tagHits = FIDELITY.targetTags.filter((t) => clean.includes(t));

  function inBand(v, b) {
    return v >= b.min && v <= b.max;
  }
  const bandPenalty = (v, b) => {
    if (inBand(v, b)) return 1;
    const mid = (b.min + b.max) / 2;
    const span = (b.max - b.min) / 2;
    const d = Math.abs(v - mid);
    return Math.max(0, 1 - (d - span) / span); // 越出带外越多，扣分越多
  };
  const fShort = bandPenalty(shortShare, FIDELITY.shortShare);
  const fLong = bandPenalty(longShare, FIDELITY.longShare);
  const fDialogue = bandPenalty(dialogueRatio, FIDELITY.dialogueRatio);
  const fTags = Math.min(1, tagHits.length / FIDELITY.targetTags.length);
  const fidelityScore = Math.round((fShort + fLong + fDialogue + fTags) / 4 * 100);

  const thresholds = {
    physicalMin: opts.physicalMin ?? 0.6,
    bodyInPhysicalMin: opts.bodyInPhysicalMin ?? 0.4, // 肉体直白须占“物理描写层”的 40%（嵌套口径 ≈ 全章 24%）
    metaphorMax: opts.metaphorMax ?? 0.25,
    earlyEndRatio: opts.earlyEndRatio ?? 0.7
  };

  // 嵌套口径：肉体直白占物理描写层的比例（原文“60%中的40%”）
  const bodyInPhysical = physicalRatio > 0 ? bodyRatio / physicalRatio : 0;

  const verdict = [];
  // 物理层：软倾向参考，不阻断（用户定调：现水平即可）
  verdict.push(`物理层(参考) ${(physicalRatio * 100).toFixed(1)}%（60 为软层标，不阻断）`);
  if (bodyInPhysical >= thresholds.bodyInPhysicalMin) verdict.push(`肉体直白 占物理层的 ${(bodyInPhysical * 100).toFixed(0)}%（达标 ≥40%，≈全章 24%）`);
  else verdict.push(`肉体直白 占物理层仅 ${(bodyInPhysical * 100).toFixed(0)}%（未达 40% 嵌套口径）`);
  verdict.push(`比喻密度 ${(metaphorRatio * 100).toFixed(1)}%（${metaphorRatio <= thresholds.metaphorMax ? '克制' : '偏高'}）`);
  verdict.push(preachHits.length ? `检出说教 ${preachHits.length} 句` : '未检出说教句式');
  verdict.push(earlyEnding ? `⚠ 疑似过早收尾（实际 ${totalChars} / 目标 ${chapterTarget}）` : '未检出过早收尾');
  if (xp.xpChars > 0) {
    const xpBodyInPhysics = xp.xpPhysical > 0 ? xp.xpBody / xp.xpPhysical : 0;
    verdict.push(`XP拍内(动作/情绪)·物理层 ${(xp.xpPhysical * 100).toFixed(0)}%｜肉体占层 ${(xpBodyInPhysics * 100).toFixed(0)}%｜拍占比 ${(xp.xpShare * 100).toFixed(0)}%（60/40 嵌套口径软倾向）`);
  } else {
    verdict.push('（无 segments 元数据，XP 分账不可用，按全章口径）');
  }
  verdict.push(`作者保真度 ${fidelityScore}/100（短击≤8字 ${(shortShare * 100).toFixed(0)}%·带20-30｜长流>30字 ${(longShare * 100).toFixed(0)}%·带15-30｜对话 ${(dialogueRatio * 100).toFixed(1)}%·带12-26｜tag ${tagHits.join('/')}）`);

  return {
    totalChars,
    sentences: sentences.length,
    physicalRatio: Number(physicalRatio.toFixed(3)),
    bodyRatio: Number(bodyRatio.toFixed(3)),
    bodyInPhysical: Number(bodyInPhysical.toFixed(3)),
    metaphorRatio: Number(metaphorRatio.toFixed(3)),
    preachHits: preachHits.slice(0, 10),
    earlyEnding,
    chapterTarget,
    hasDisclaimerTail,
    xp: {
      xpShare: Number(xp.xpShare.toFixed(3)),
      xpPhysical: Number(xp.xpPhysical.toFixed(3)),
      xpBody: Number(xp.xpBody.toFixed(3)),
      xpBodyInPhysical: Number((xp.xpPhysical > 0 ? xp.xpBody / xp.xpPhysical : 0).toFixed(3)),
      xpMetaphor: Number(xp.xpMetaphor.toFixed(3)),
      xpChars: xp.xpChars
    },
    fidelity: {
      score: fidelityScore,
      shortShare: Number(shortShare.toFixed(3)),
      longShare: Number(longShare.toFixed(3)),
      avgSentenceLen: Number(avgSentenceLen.toFixed(1)),
      avgParagraphLen: Number(avgParagraphLen.toFixed(0)),
      dialogueRatio: Number(dialogueRatio.toFixed(3)),
      tagHits
    },
    verdict,
    pass: bodyInPhysical >= thresholds.bodyInPhysicalMin && !earlyEnding && !preachHits.length
  };
}

// file: 绝对/相对路径或 run/ 下的文件名（chapter_NN.txt）
function loadChapter(file, DEBUG_ROOT) {
  const direct = path.isAbsolute(file) ? file : path.join(DEBUG_ROOT, 'run', file);
  if (!fs.existsSync(direct)) {
    const alt = path.resolve(file);
    if (!fs.existsSync(alt)) throw new Error(`找不到章节文件：${file}`);
    return fs.readFileSync(alt, 'utf8');
  }
  return fs.readFileSync(direct, 'utf8');
}

module.exports = { analyzeChapter, splitSentences, loadChapter };