'use strict';

const fs = require('fs');
const path = require('path');

// 分类前缀（标题上的固定标签，用于识别作品类型/系列线索）
const CATEGORY_PREFIXES = ['长篇', '短篇', 'Futa', '外传短篇', '怪文书', '随笔', '随笔集', '同人', '告知', '短篇+'];

function loadWorks(corpusDir) {
  if (!fs.existsSync(corpusDir)) {
    throw new Error(`语料目录不存在: ${corpusDir}`);
  }
  const works = [];
  for (const dir of fs.readdirSync(corpusDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const metaPath = path.join(corpusDir, dir.name, 'meta.json');
    const txtPath = path.join(corpusDir, dir.name, '正文.txt');
    if (!fs.existsSync(metaPath) || !fs.existsSync(txtPath)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    const text = fs.readFileSync(txtPath, 'utf8');
    // 去重 tag（源数据 futa 等可能重复多条）
    const tags = Array.from(new Set(meta.tags || []));
    // 仅「告知/公告/通知」类视为非创作；「其他」tag 可能是随笔集等真实作品，不据此剔除
    const isNotice = /^【(告知|公告|通知|声明)/.test(meta.title || '');
    works.push({
      ...meta,
      tags,
      isNotice,
      slug: sanitizeSlug(`${meta.tid}_${meta.title}`),
      text,
      category: detectCategory(meta.title || '')
    });
  }
  return works;
}

function detectCategory(title) {
  const m = title.match(/^【([^】]+)】/);
  if (!m) return '其他';
  const tag = m[1];
  const found = CATEGORY_PREFIXES.find((p) => tag.startsWith(p));
  return found || tag;
}

function sanitizeSlug(s) {
  return s
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function countChars(text) {
  return text.replace(/\s+/g, '').length;
}

// 段落归一：按空行 / 换行切分，过滤过短空段
function splitParagraphs(text) {
  return text
    .split(/\r?\n\r?\n|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// 滑动窗口切块（供检索）
function chunkText(text, targetChars = 900, overlapChars = 120) {
  const paras = splitParagraphs(text);
  const chunks = [];
  let buf = [];
  let len = 0;
  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf.join('\n'));
    // 保留一定重叠：留最后几个段落
    const keep = [];
    let k = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (k >= overlapChars) break;
      k += buf[i].length;
      keep.unshift(buf[i]);
    }
    buf = keep;
    len = keep.reduce((a, s) => a + s.length, 0);
  };
  for (const p of paras) {
    buf.push(p);
    len += p.length;
    if (len >= targetChars) flush();
  }
  flush();
  return chunks;
}

module.exports = { loadWorks, chunkText, splitParagraphs, countChars, sanitizeSlug, detectCategory };