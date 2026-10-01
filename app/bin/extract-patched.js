'use strict';

// 补抽取工具：对因内容拦截/空响应失败的世界书条目，用破甲策略前缀重试。
// 用法：node bin/extract-patched.js <系列名> [系列名2 ...]
// 破甲策略取自 debug-yuae-simulator/patches/system-extra.md（无则不附加）。

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { loadWorks } = require('../lib/corpus');
const { GeminiClient } = require('../lib/gemini');
const { groupBySeries } = require('../lib/build');
const { getConn } = require('../lib/settings-store');

const ROOT = path.resolve(__dirname, '..');
const PATCH_FILE = path.join(ROOT, '..', 'debug-yuae-simulator', 'patches', 'system-extra.md');

function readPatch() {
  try {
    return fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

const EXTRACTOR_SYSTEM =
  '你是世界观与角色档案抽取器。从作者作品片段中提炼：世界观设定（地点/法则/组织/历史）、常驻角色（名字/身份/关系/说话方式）。只列文中实际存在的信息，不要编造。输出 JSON。';

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const optModel = get('--model');
  const optKey = get('--key');
  const names = argv.filter((x) => !x.startsWith('--') && x !== optModel && x !== optKey);
  if (!names.length) {
    console.error('用法：node bin/extract-patched.js <系列名> [...] [--model <id>] [--key <key>]');
    process.exit(1);
  }
  const cfg = loadConfig(ROOT);
  const conn = getConn();
  const apiKey = optKey || conn.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('缺少 API Key：请传入 --key，或在 Web 设置里配置 / 设环境变量 GEMINI_API_KEY');
    process.exit(1);
  }
  const model = optModel || conn.model || cfg.gemini.model;
  const client = new GeminiClient(
    { ...cfg.gemini, model, baseUrl: conn.baseUrl || cfg.gemini.baseUrl, apiKey },
    {}
  );
  console.log(`[extract-patched] 使用模型: ${model}`);
  const patch = readPatch();
  const works = loadWorks(cfg.corpusDir).filter((w) => !w.isNotice);
  const wbPath = path.join(cfg.profileDir, 'worldbook.json');
  if (!fs.existsSync(wbPath)) {
    console.error('缺少 worldbook.json，请先成功跑一次 extract-worldbook');
    process.exit(1);
  }
  const wb = JSON.parse(fs.readFileSync(wbPath, 'utf8'));

  for (const name of names) {
    const keys = [...groupBySeries(works).keys()];
    const matched = keys.find((k) => k === name || k.includes(name));
    if (!matched) {
      console.warn(`跳过（找不到系列）: ${name}`);
      continue;
    }
    const list = works.filter((w) => groupBySeries([w]).keys().next().value === matched);
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
      { role: 'system', content: (patch ? patch + '\n\n' : '') + EXTRACTOR_SYSTEM },
      {
        role: 'user',
        content:
          `系列「${matched}」的作品片段：\n\n` +
          context.slice(0, cfg.generate.maxContextChars || 60000) +
          '\n\n输出 JSON：{"worldPoint":["要点"],"characters":[{"name":"","identity":"","relations":"","style":""}]}'
      }
    ];
    try {
      const out = await client.chatJSON(msgs);
      if (out && !out.worldPoint && !out.characters) throw new Error('返回结构不符: ' + JSON.stringify(out).slice(0, 120));
      wb.series[matched] = out;
      fs.writeFileSync(wbPath, JSON.stringify(wb, null, 2), 'utf8');
      console.log(`✓ ${matched} 补抽取成功（原有条目已替换）`);
    } catch (e) {
      console.error(`✗ ${matched} 仍失败: ${String(e.message || e).slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error('[extract-patched] 失败:', e.message || e);
  process.exit(1);
});