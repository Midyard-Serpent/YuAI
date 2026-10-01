'use strict';

// 主版本补丁层（酒馆式分块注入）：
//   - systemAppend（破甲层）作为**独立 system 消息**插在风格层之后；
//   - cfg.excludeTags 可对风格层（第一条 system）做段切除；
//   - stageOverrides[stage] 文件替换该 stage 第一条 user 内容（支持 {{key}} 模板）。
// 生产默认开启破甲（patch=false 仅用于测试/对照）。

const fs = require('fs');
const path = require('path');
const PATCHES_DIR = path.resolve(__dirname, '..', 'patches');

function readPatch(name) {
  if (!name) return '';
  const p = path.join(PATCHES_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function loadPatchConfig() {
  const c = path.join(PATCHES_DIR, 'patches.json');
  try {
    return fs.existsSync(c) ? JSON.parse(fs.readFileSync(c, 'utf8')) : {};
  } catch {
    return {};
  }
}

// {{key}} 模板替换：字符串原样，其余 JSON 序列化
function render(tpl, ctx) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    if (!(k in ctx)) return `{{${k}}}`;
    const v = ctx[k];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}

// 移除某标签段（"## <tag>..." 到下一个 "## " 或文末）
function stripTagSection(content, tag) {
  const esc = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## ${esc}[^\\n]*\\n[\\s\\S]*?(?=\\n## |$)`);
  return content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 应用补丁（分块注入）
function applyPatches(messages, stage, ctx = {}) {
  const cfg = loadPatchConfig();
  const systemAppend = readPatch(cfg.systemAppend || '').trim();
  const overrideFile = (cfg.stageOverrides && cfg.stageOverrides[stage]) || '';
  const overrideText = overrideFile ? readPatch(overrideFile) : '';

  const out = [];
  let jailbreakInjected = !systemAppend;
  let userReplaced = false;

  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
      if (!jailbreakInjected) {
        out.push({ role: 'system', content: systemAppend });
        jailbreakInjected = true;
      }
      continue;
    }
    if (m.role === 'user' && overrideText && !userReplaced) {
      userReplaced = true;
      out.push({ role: 'user', content: render(overrideText, ctx) });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }

  if (!jailbreakInjected) {
    out.unshift({ role: 'system', content: systemAppend });
  }

  const excludes = Array.isArray(cfg.excludeTags) ? cfg.excludeTags : [];
  const styleIdx = out.findIndex((x) => x.role === 'system');
  if (excludes.length && styleIdx >= 0) {
    let c = out[styleIdx].content;
    for (const t of excludes) c = stripTagSection(c, t);
    out[styleIdx].content = c;
  }
  return out;
}

module.exports = { applyPatches, loadPatchConfig, readPatch, stripTagSection };