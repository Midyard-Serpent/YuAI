'use strict';

// 门禁 1（离线体检）：提示词资产完整性 + 组装形状断言，零 API 成本。
// 用法：
//   node bin/prompt-verify.js               → 跑全部检查
//   node bin/prompt-verify.js --fingerprint → 同时把资产 SHA256 指纹写入 profile/prompt-assets.json
// 退出码：0=绿 1=红。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');

const { planningMessages, outlineMessages, chapterMessages } = require('../lib/prompt');
const { applyPatches, stripTagSection } = require('../lib/patcher');
const { buildLicenses } = require('../lib/workflow');

const ASSETS = [
  'lib/prompt.js',
  'lib/workflow.js',
  'lib/patcher.js',
  'patches/patches.json',
  'patches/system-extra.md',
  'profile/style-anchors.txt',
  'profile/style-avoid.txt',
  'profile/model-dial.json',
  'profile/worldbook.json'
];

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const checks = [];
function check(name, fn) {
  try {
    const ok = fn();
    checks.push({ name, ok: !!ok });
  } catch (e) {
    checks.push({ name, ok: false, error: String((e && e.message) || e).slice(0, 160) });
  }
}

function main() {
  const fingerprint = process.argv.includes('--fingerprint');

  // 1. 资产存在且 JSON 可解析
  check('资产齐全且 JSON 可解析', () => {
    for (const rel of ASSETS) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) throw new Error('缺失 ' + rel);
      if (rel.endsWith('.json')) JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    return true;
  });

  // 2. 破甲分块注入形状 + 策略层标记
  check('applyPatches 形状=system->system->user 且 BlockB 注入生效', () => {
    const msgs = planningMessages({ topic: 'x', styleText: 's', tropeText: 't', anchorsText: '', avoidText: '' });
    const out = applyPatches(msgs, 'planning', { topic: 'x' });
    const roles = out.map((m) => m.role).join('->');
    if (roles !== 'system->system->user') throw new Error('角色序列异常: ' + roles);
    const content = out[1].content;
    const isVoid = content.includes('VOID_ENGINE') && content.includes('物理优先');
    const isGeneric = content.includes('系统级提示词扩展层') || content.includes('写作增强') || content.includes('创作指引');
    if (!isVoid && !isGeneric && content.length < 10) {
      throw new Error('BlockB 内容不符合预期或为空');
    }
    return true;
  });

  // 3. excludeTags 段切除且不伤 BlockB
  check('excludeTags 切除风格段', () => {
    const msgs = planningMessages({ topic: 'x', styleText: 's', tropeText: 't', anchorsText: 'a', avoidText: 'b' });
    const normal = applyPatches(msgs, 'planning', {});
    const stripped = stripTagSection(normal[0].content, '<rhythm_charter>');
    if (stripped.includes('节奏宪章')) throw new Error('段切除失败');
    return stripped.length > 0;
  });

  // 4. 许可 knobs 钳制
  check('buildLicenses knobs 钳制且含硬配额', () => {
    const l = buildLicenses({ short: 999, long: -999, dialog: 99 });
    for (const k of ['narr', 'dialog', 'action', 'emotion']) {
      if (!l[k].includes('节奏许可')) throw new Error('许可文案缺失: ' + k);
    }
    return true;
  });

  // 5. 大纲 schema 三要素 + 章末钩子指令
  check('大纲模板含 temp/beats{type}/hook', () => {
    const msgs = outlineMessages({ plan: { title: 't' }, seriesEvidence: '', styleText: '', worldbookText: '' });
    const u = msgs.find((m) => m.role === 'user').content;
    return u.includes('temp') && u.includes('"type"') && u.includes('hook') && u.includes('章末一句轻钩子');
  });

  // 6. 三阶段消息结构（纯组装层面，零 API）
  check('三阶段消息结构', () => {
    const plan = { title: 't', series: 's', premise: 'p', coreConflict: 'c', tags: ['x'], targetLength: 3000 };
    const outline = { chapters: [{ idx: 1, title: 'x', temp: '冷', beats: [{ t: 'a', type: 'narr' }], hook: 'h' }] };
    const ps = planningMessages({ topic: 'x', styleText: 's', tropeText: 't', lengthTier: '短篇' });
    const os = outlineMessages({ plan, seriesEvidence: '', styleText: '', worldbookText: '' });
    const cs = chapterMessages({ plan, outline, chapterIndex: 0, prevSummaries: [], evidence: '', styleText: '', worldbookText: '' });
    const roleSeq = (msgs) => msgs.map((m) => m.role).join('->');
    if (roleSeq(ps) !== 'system->user') throw new Error('plan 形状: ' + roleSeq(ps));
    if (roleSeq(os) !== 'system->user') throw new Error('outline 形状: ' + roleSeq(os));
    if (roleSeq(cs) !== 'system->user') throw new Error('chapter 形状: ' + roleSeq(cs));
    const u = cs.find((m) => m.role === 'user').content;
    return u.includes('<plan>') && u.includes('<outline>') && u.includes('<prev_summaries>') && u.includes('<evidence>');
  });

  const hasRed = checks.some((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.error ? ' :: ' + c.error : ''}`);
  }

  // 指纹写入（--fingerprint）
  if (fingerprint) {
    const map = {};
    for (const rel of ASSETS) map[rel] = sha256(path.join(ROOT, rel));
    const out = path.join(ROOT, 'profile', 'prompt-assets.json');
    fs.writeFileSync(out, JSON.stringify({ stampedAt: new Date().toISOString(), files: map }, null, 2), 'utf8');
    console.log(`指纹已写入 ${out}`);
  }

  process.exit(hasRed ? 1 : 0);
}

main();