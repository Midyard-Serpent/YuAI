'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { loadWorks } = require('./corpus');
const { analyzeStyle, summarizeStyle, extractSamples, buildIndex, detectSeries } = require('./profile');
const { GeminiClient } = require('./gemini');

const ROOT = path.resolve(__dirname, '..');

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function groupBySeries(works) {
  const map = new Map();
  for (const w of works.filter((x) => !x.isNotice)) {
    const s = detectSeries(w.title || '');
    const key = s ? s.label : `单篇·${w.title}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  return map;
}

function buildTropeText(style) {
  const tags = style.tagFreq.slice(0, 12).map((t) => `${t.name}`).join('、');
  return `高频题材 tag：${tags}。作者常写：压迫与温柔并存的支配关系、缩小者视角的权力反差、日常场景中的非日常关系、系列化世界观、结局常带余味。`;
}

async function extractWorldbook(client, works, cfg) {
  const groups = groupBySeries(works);
  const worldbook = { series: {} };
  for (const [series, list] of groups) {
    const context = list
      .map((w) =>
        [
          `## 《${w.title}》（tid=${w.tid}，${w.totalChars}字，tags:${w.tags.join('/')}）`,
          '【开头】' + w.text.replace(/\s+/g, '').slice(0, 700),
          '【结尾】' + w.text.replace(/\s+/g, '').slice(-500)
        ].join('\n')
      )
      .join('\n\n');

    const msgs = [
      {
        role: 'system',
        content:
          '你是世界观与角色档案抽取器。从作者作品片段中提炼：世界观设定（地点/法则/组织/历史）、常驻角色（名字/身份/关系/说话方式）。只列文中实际存在的信息，不要编造。输出 JSON。'
      },
      {
        role: 'user',
        content:
          `系列「${series}」的作品片段：\n\n` +
          context.slice(0, cfg.generate.maxContextChars || 60000) +
          '\n\n输出 JSON：{"worldPoint":["要点"],"characters":[{"name":"","identity":"","relations":"","style":""}]}'
      }
    ];
    try {
      worldbook.series[series] = await client.chatJSON(msgs);
    } catch (e) {
      worldbook.series[series] = { error: String(e.message || e) };
    }
  }
  return worldbook;
}

// 核心：跑一遍语料研究（可被 CLI 与 Web 共用）
async function runBuild({ extract = false, mock = false, chunk = null, apiKey = '', log = console.log } = {}) {
  const cfg = loadConfig(ROOT);
  if (chunk) {
    if (chunk.targetChars) cfg.chunk.targetChars = Number(chunk.targetChars);
    if (chunk.overlapChars) cfg.chunk.overlapChars = Number(chunk.overlapChars);
  }
  log('[profile] 读取语料:', cfg.corpusDir);
  const works = loadWorks(cfg.corpusDir);
  log(`[profile] 共 ${works.length} 个目录，有效小说 ${works.filter((w) => !w.isNotice).length} 篇`);

  const style = analyzeStyle(works);
  const samples = extractSamples(works);
  const index = buildIndex(works, cfg);

  writeJSON(path.join(cfg.profileDir, 'style.json'), { style, summary: summarizeStyle(style) });
  writeJSON(path.join(cfg.profileDir, 'works.json'), samples);
  writeJSON(path.join(cfg.profileDir, 'index.json'), index);
  // 修复：tropes.txt 是纯文本，不能用 JSON.stringify（之前被写成带引号+字面量\n，污染提示词）
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.profileDir, 'tropes.txt'), buildTropeText(style) + '\n', 'utf8');
  writeJSON(path.join(cfg.profileDir, 'series.json'), {
    series: Array.from(groupBySeries(works).entries()).map(([name, list]) => ({
      name,
      count: list.length,
      titles: list.map((w) => w.title)
    }))
  });

  log('[profile] 风格画像：');
  log(summarizeStyle(style));
  log(`[profile] 检索索引 ${index.length} 块`);

  if (extract) {
    const client = new GeminiClient({ ...cfg.gemini, apiKey: apiKey || cfg.gemini.apiKey }, { mock });
    log('[profile] 抽取世界观/角色卡（--extract）...');
    const worldbook = await extractWorldbook(client, works, cfg);
    const outName = mock ? 'worldbook.mock.json' : 'worldbook.json';
    writeJSON(path.join(cfg.profileDir, outName), worldbook);
    log(`[profile] 已写 profile/${outName}`);
  }

  return { style, index, works: works.length, fiction: works.filter((w) => !w.isNotice).length };
}

module.exports = { runBuild, extractWorldbook, groupBySeries };