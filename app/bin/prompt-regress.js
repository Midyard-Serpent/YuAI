'use strict';

// 门禁 2（在线跑分回归）：固定卦面 3 章（冷/温/热）x N 次，锁定模型 + dial-off；对照基线 release 出灯。
// 用法：
//   node bin/prompt-regress.js --stamp --model <id> --key <k> [--n 3]  → 跑分并盖章为新基线
//   node bin/prompt-regress.js --model <id> --key <k>                 → 跑分对照当前基线出灯
// 卦面夹具：fixtures/regress/{plan.json, outline.json} 的第 2/4/9 章（0 起索引 1/3/8）。

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { doChapter, summarizeChapter } = require('../lib/workflow');
const { analyzeChapter } = require('../lib/analyze');

const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'regress');
const RELEASE_PATH = path.join(ROOT, 'profile', 'prompt-releases.json');
const FACE_INDEXES = [1, 3, 8]; // ch02 冷 / ch04 温 / ch09 热

function args() {
  const a = process.argv.slice(2);
  const get = (f) => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null;
  };
  return {
    stamp: a.includes('--stamp'),
    model: get('--model') || 'deepseek-ai/Deepseek-V4-Flash',
    key: get('--key') || process.env.GEMINI_API_KEY || '',
    n: Number(get('--n') || 3)
  };
}

function readReleases() {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_PATH, 'utf8'));
  } catch {
    return { releases: [], cursor: null };
  }
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries(fn, attempts = 3, cooldownMs = 60000) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (/429|速率|rate|quota/i.test(msg) && i < attempts) {
        console.log(`    [retry] ${msg.slice(0, 40)} → 冷却 ${cooldownMs / 1000}s 后第 ${i + 1}/${attempts} 次`);
        await sleepMs(cooldownMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const A = args();
  if (!A.key) throw new Error('需要 --key 或环境变量 GEMINI_API_KEY');
  const plan = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'plan.json'), 'utf8'));
  const outline = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'outline.json'), 'utf8'));
  const chapters = outline.chapters || [];

  const results = {}; // { chIdx: {scores:[], means:{...}} }
  for (const ci of FACE_INDEXES) {
    const ch = chapters[ci];
    if (!ch) throw new Error('卦面章缺失: ' + ci);
    const prevSummaries = chapters.slice(0, ci).map((c, i) => ({ idx: c.idx ?? i + 1, summary: summarizeChapter(c) }));
    const scores = [];
    for (let r = 1; r <= A.n; r++) {
      console.log(`[regress] 章${ch.idx}(${ch.temp}) 第 ${r}/${A.n} 次 …`);
      const res = await withRetries(() => doChapter({
        plan,
        outline: { chapters },
        chapterIndex: ci,
        prevSummaries,
        overrides: { mock: false, model: A.model, apiKey: A.key, dialOff: true, selfCheck: false, patch: true }
      }));
      const rep = analyzeChapter(res.text, { chapterTarget: res.chapterTarget, segments: res.segments });
      scores.push(rep);
      const f = rep.fidelity;
      console.log(`        保真 ${f.score}｜短击${Math.round(f.shortShare * 100)}% 长流${Math.round(f.longShare * 100)}% 对话${(f.dialogueRatio * 100).toFixed(1)}%`);
      if (r < A.n) await sleepMs(20000); // 运行间隔，防共享池碰撞
    }
    results[ci] = {
      chapter: ch.idx, temp: ch.temp,
      fscore: Math.round(scores.reduce((s, x) => s + x.fidelity.score, 0) / scores.length),
      short: scores.reduce((s, x) => s + x.fidelity.shortShare, 0) / scores.length,
      long: scores.reduce((s, x) => s + x.fidelity.longShare, 0) / scores.length,
      dialogue: scores.reduce((s, x) => s + x.fidelity.dialogueRatio, 0) / scores.length,
      preach: scores.reduce((s, x) => s + x.preachHits.length, 0),
      earlyEnd: scores.filter((x) => x.earlyEnding).length
    };
  }

  // 命灯判定
  const rel = readReleases();
  const base = rel.releases.find((x) => x.model === A.model);
  const verdicts = [];
  if (A.stamp || !base) {
    verdicts.push({ chapter: 'ALL', verdict: 'stamp' });
  } else {
    for (const ci of FACE_INDEXES) {
      const b = (base.scores || []).find((s) => s.chapter === results[ci].chapter);
      const r = results[ci];
      let verdict = 'green';
      let why = '';
      if (b) {
        const dScore = b.fscore - r.fscore;
        const dBand = Math.max(
          Math.abs((b.short - r.short) * 100),
          Math.abs((b.long - r.long) * 100),
          Math.abs((b.dialogue - r.dialogue) * 100)
        );
        if (dScore > 10 || dBand > 10) { verdict = 'red'; why = `保真降${dScore} 带漂${dBand.toFixed(1)}pp`; }
        else if (dScore > 5) { verdict = 'yellow'; why = `保真降${dScore}`; }
      }
      verdicts.push({ chapter: results[ci].chapter, verdict, why });
    }
  }

  console.log('\n===== 回归跑分（模型 ' + A.model + '）=====');
  for (const ci of FACE_INDEXES) {
    const r = results[ci];
    console.log(`章${r.chapter}(${r.temp}) 保真${r.fscore} 短击${Math.round(r.short * 100)}% 长流${Math.round(r.long * 100)}% 对话${(r.dialogue * 100).toFixed(1)}% 说教${r.preach} 过早收尾${r.earlyEnd}`);
  }
  console.log('命灯:', JSON.stringify(verdicts));

  // 更新 release
  const scoresArr = FACE_INDEXES.map((ci) => ({
    chapter: results[ci].chapter, temp: results[ci].temp,
    fscore: results[ci].fscore,
    short: Number(results[ci].short.toFixed(3)),
    long: Number(results[ci].long.toFixed(3)),
    dialogue: Number(results[ci].dialogue.toFixed(3))
  }));
  const hasRed = verdicts.some((v) => v.verdict === 'red');
  if (A.stamp || !base) {
    rel.releases.push({ v: 'v' + (rel.releases.length + 1), model: A.model, scores: scoresArr, ts: new Date().toISOString(), verdict: 'stamp' });
    rel.cursor = rel.releases[rel.releases.length - 1].v;
  }
  fs.writeFileSync(RELEASE_PATH, JSON.stringify(rel, null, 2), 'utf8');
  process.exit(hasRed ? 1 : 0);
}

main().catch((e) => {
  console.error('[regress] 失败:', e.message || e);
  process.exit(2);
});