'use strict';

// P3-2 微调语料建设：原文(profile/index.json 1572 分块) + 生成成品(out/*/chapter_*.txt)
// → data/training/style-corpus.jsonl（300~800 字段落，四类 beat 标注 + 风格特征 + 双签名占位）。
// 用法：node bin/build-corpus.js [--limit N]

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { analyzeChapter } = require('../lib/analyze');

const OUT_DIR = path.join(ROOT, 'data', 'training');
const META_PATTERNS = [
  /^(大家好|这里是|第一次|烦请大家|先行谢过|建议食用|警告|内容预警|开篇废话|前言)/,
  /^[《【]?开启.*?但.*?请随缘|^如不喜欢请退出|^某日/
];

function isMetaLike(text) {
  const t = String(text || '').trim();
  return (t.length < 200 && /谢谢|批评指正|多多支持|更新|征稿|请多包含/i.test(t)) || META_PATTERNS.some((re) => re.test(t));
}

function splitToChunks(text, minChars = 300, maxChars = 800) {
  const sentences = String(text || '').split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur.length >= minChars) out.push(cur);
      out.push(s.slice(0, maxChars));
      cur = '';
    } else if ((cur + s).length > maxChars) {
      if (cur.length >= minChars) out.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.length >= minChars) out.push(cur);
  return out;
}

function classifyBeat(h) {
  const dialogue = h.fidelity.dialogueRatio;
  const short = h.fidelity.shortShare;
  const long = h.fidelity.longShare;
  const physical = h.physicalRatio;
  if (dialogue >= 0.28) return 'dialog';
  if (physical >= 0.4 && short >= 0.25) return 'action';
  if (long >= 0.25 && dialogue < 0.12) return 'emotion';
  if (short >= 0.3 && physical >= 0.35) return 'action';
  return 'narr';
}

function features(h) {
  return {
    shortShare: Number(h.fidelity.shortShare.toFixed(3)),
    longShare: Number(h.fidelity.longShare.toFixed(3)),
    dialogueRatio: Number(h.fidelity.dialogueRatio.toFixed(3)),
    avgSentenceLen: h.fidelity.avgSentenceLen,
    physicalRatio: Number(h.physicalRatio.toFixed(3)),
    bodyInPhysical: Number(h.bodyInPhysical.toFixed(3)),
    metaphorRatio: Number(h.metaphorRatio.toFixed(3)),
    fidelity: h.fidelity.score
  };
}

async function main() {
  const limit = Number(process.argv.find((x, i, a) => a[i - 1] === '--limit') || 0);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'style-corpus.jsonl');
  const rows = [];
  let metaSkipped = 0;

  // 1) 原文分块
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile', 'index.json'), 'utf8'));
  let nOrig = 0;
  for (const d of idx) {
    if (isMetaLike(d.text)) { metaSkipped++; continue; }
    for (const chunk of splitToChunks(d.text)) {
      const h = analyzeChapter(chunk, {});
      rows.push({
        id: `orig-${nOrig++}`,
        source: 'original',
        title: d.title,
        series: d.series || '',
        tags: Array.isArray(d.tags) ? d.tags : [],
        text: chunk,
        beatType: classifyBeat(h),
        features: features(h),
        judgeScore: null,
        likelihood: null
      });
    }
  }

  // 2) 生成成品章节（主 out/ + 可选 --gen-dir 附加合成源，如调试层 run/）
  const outRoot = path.join(ROOT, 'out');
  const debugRunDir = path.join(ROOT, '..', '..', 'debug-yuae-simulator', 'run');
  const extraDirs = [
    process.argv.find((x, i, a) => a[i - 1] === '--gen-dir'),
    fs.existsSync(debugRunDir) ? debugRunDir : null
  ].filter(Boolean);
  const allDirs = [];
  if (fs.existsSync(outRoot)) {
    allDirs.push(...fs.readdirSync(outRoot).filter((s) => fs.statSync(path.join(outRoot, s)).isDirectory()).map((s) => ({ base: outRoot, slug: s })));
  }
  for (const ed of extraDirs) {
    if (fs.existsSync(ed)) {
      const slugTitles = fs.readdirSync(ed).filter((s) => /^(chapter_\d+\.txt|.*\.txt)$/.test(s) && !s.startsWith('作品'));
      const dirIsFlat = slugTitles.length && path.extname(slugTitles[0]) === '.txt' && !fs.statSync(path.join(ed, slugTitles[0])).isDirectory();
      if (dirIsFlat) {
        allDirs.push({ base: path.dirname(ed), slug: path.basename(ed), flat: true });
      }
    }
  }
  let nGen = 0;
  for (const { base, slug, flat } of allDirs) {
    const dir = path.join(base, slug);
    const files = flat
      ? fs.readdirSync(dir).filter((f) => /^chapter_\d+\.txt$/.test(f)).sort()
      : (fs.readdirSync(dir) || []).filter((f) => /^chapter_\d+\.txt$/.test(f)).sort();
    for (const cf of files) {
      const text = fs.readFileSync(path.join(dir, cf), 'utf8');
      if (!text || text.length < 200) continue;
      if (/^（本章/.test(text.trim())) continue;
      for (const chunk of splitToChunks(text)) {
        const h = analyzeChapter(chunk, {});
        rows.push({
          id: `gen-${nGen++}`,
          source: 'generate',
          title: slug,
          series: '',
          tags: [],
          text: chunk,
          beatType: classifyBeat(h),
          features: features(h),
          judgeScore: null,
          likelihood: null
        });
      }
    }
  }

  if (limit > 0) rows.length = Math.min(rows.length, limit);
  fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const byBeat = {};
  const bySource = {};
  for (const r of rows) {
    byBeat[r.beatType] = (byBeat[r.beatType] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }
  const stats = {
    total: rows.length,
    bySource,
    byBeat,
    avgLen: Math.round(rows.reduce((s, r) => s + r.text.length, 0) / (rows.length || 1)),
    generateTime: new Date().toISOString()
  };
  fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'README.md'),
    '# 微调语料 style-corpus.jsonl\n\n## 字段字典\n'
      .concat(['| 字段 | 类型 | 说明 |', '|---|---|---|', '| id | str | 段 id |', '| source | original\\|generate | 来源 |', '| title/series/tags | str/arr | 元数据 |', '| text | str | 300~800 字段落 |', '| beatType | narr\\|dialog\\|action\\|emotion | 启发式标注 |', '| features | obj | 句长双峰/对话/物理/肉体嵌套/比喻/保真 |', '| judgeScore / likelihood | null | 双签名占位（P3-1 已封存，暂空） |'].join('\n'))
      .concat(`\n\n## 当前统计\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n`)
      .concat('\n> 生成方式：`node bin/build-corpus.js`；元数据来自 profile/index.json（1572 原文分块）+ out/ 生成章节。\n'),
    'utf8'
  );

  console.log('语料建设完成 → ' + outPath);
  console.log(JSON.stringify(stats, null, 2));
  console.log(`跳过元信息段（前言/致谢等）: ${metaSkipped}`);
}

main().catch((e) => {
  console.error('[build-corpus] 失败:', e.message || e);
  process.exit(1);
});