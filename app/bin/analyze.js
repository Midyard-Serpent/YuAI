'use strict';

// 破甲策略符合度 CLI（主版本）：node bin/analyze.js <chapter文件路径> [chapter文件2 ...]
// 若同目录存在 chapter_NN.segments.json，自动启用 XP 分账口径与过早收尾判定。

const fs = require('fs');
const path = require('path');
const { analyzeChapter } = require('../lib/analyze');

function main() {
  const files = process.argv.slice(2).map((f) => path.resolve(f));
  if (!files.length) {
    console.error('用法：node bin/analyze.js <chapter_01.txt> [更多文件...]');
    process.exit(1);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`跳过（不存在）: ${f}`);
      continue;
    }
    const text = fs.readFileSync(f, 'utf8');
    let chapterTarget = 0;
    let segments = null;
    const sfile = f.replace(/\.txt$/, '.segments.json');
    if (fs.existsSync(sfile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sfile, 'utf8'));
        chapterTarget = Number(meta.chapterTarget || 0);
        segments = meta.segments || null;
      } catch {}
    }
    console.log(`===== ${path.basename(f)} =====`);
    console.log(JSON.stringify(analyzeChapter(text, { chapterTarget, segments }), null, 2));
  }
}

if (require.main === module) main();

module.exports = { main };