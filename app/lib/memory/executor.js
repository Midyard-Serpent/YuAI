'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 结构化长期记忆系统：指令执行器（对齐 st-memory-enhancement 的原版操作协议）
// 模型通过 <tableEdit> 标签输出原子操作函数，本模块负责安全解析并执行增量更新。
// 协议：insertRow / updateRow / deleteRow（均以 tableIndex + colIndex 数字寻址）。
// ─────────────────────────────────────────────────────────────────────────────

const { normalizeMemory } = require('./schema');

// 从模型输出中提取 `<tableEdit>...</tableEdit>` 内部指令（兼容带注释块）
// 协议约定：函数调用写在 <!-- ... --> 注释块内部，故从注释块中解析指令。
function extractTableEdit(text) {
  if (typeof text !== 'string') return [];
  const block = text.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i);
  if (!block) return [];
  const body = block[1];
  // 优先提取所有 <!-- ... --> 注释块内部的函数调用
  const comments = Array.from(body.matchAll(/<!--([\s\S]*?)-->/g)).map((m) => m[1]);
  const source = comments.length ? comments.join('\n') : body;
  return source
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter((s) => /\b(insertRow|updateRow|deleteRow)\s*\(/.test(s));
}

// 安全执行一条指令（mv = memory value，含 tables 数组）
function applyInstruction(memory, instruction) {
  const str = String(instruction || '').trim();
  let m = str.match(/\b(insertRow|updateRow|deleteRow)\s*\(\s*(.*)\s*\)\s*$/);
  if (!m) {
    // 尝试宽松匹配（允许末尾有多余内容）
    m = str.match(/\b(insertRow|updateRow|deleteRow)\s*\(\s*([\d]+\s*,.*)\)/);
  }
  if (!m) return { ok: false, error: '无法解析指令: ' + str.slice(0, 60) };

  const op = m[1];
  const argsRaw = m[2];
  const tables = memory.tables;

  // 解析 tableIndex（首参数必须为数字）
  const firstIdxMatch = argsRaw.match(/^\s*(\d+)\s*,/);
  if (!firstIdxMatch) return { ok: false, error: '缺少 tableIndex: ' + str.slice(0, 60) };
  const tableIndex = Number(firstIdxMatch[1]);
  const table = tables.find((t) => t.tableIndex === tableIndex);
  if (!table) return { ok: false, error: '非法 tableIndex: ' + tableIndex };

  const rest = argsRaw.slice(firstIdxMatch[0].length).trim();

  if (op === 'insertRow') {
    const data = parseDataObject(rest);
    if (!data) return { ok: false, error: 'insertRow 缺少合法 data 对象' };
    const row = columnsToRow(table.columns, data);
    if (table.singleton && table.content.length) {
      // 单态表：插入即替换（保持一行）
      table.content = [row];
    } else {
      table.content.push(row);
    }
    return { ok: true };
  }

  const rowIdxMatch = rest.match(/^\s*(\d+)\s*(?:,(.*))?$/);
  if (!rowIdxMatch) return { ok: false, error: '缺少 rowIndex: ' + str.slice(0, 60) };
  const rowIndex = Number(rowIdxMatch[1]);

  if (op === 'deleteRow') {
    if (rowIndex < 0 || rowIndex >= table.content.length) return { ok: false, error: 'rowIndex 越界: ' + rowIndex };
    table.content.splice(rowIndex, 1);
    return { ok: true };
  }

  if (op === 'updateRow') {
    const dataRaw = rowIdxMatch[2] || '';
    const data = parseDataObject(dataRaw);
    if (!data) return { ok: false, error: 'updateRow 缺少合法 data 对象' };
    if (rowIndex < 0 || rowIndex >= table.content.length) return { ok: false, error: 'rowIndex 越界: ' + rowIndex };
    const patch = columnsToPatch(table.columns, data);
    // 只覆盖提供的列（且忽略空字符串），保留未提供的列
    const row = table.content[rowIndex];
    Object.keys(patch).forEach((k) => { if (patch[k] !== '') row[k] = patch[k]; });
    return { ok: true };
  }

  return { ok: false, error: '未知操作: ' + op };
}

// 解析 { colIndex: 值 } 对象（容忍 "0" 数字键、双引号字符串）
function parseDataObject(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    // 回退：极简单的键值手工解析（{"0":"a","1":"b"}）
    const out = {};
    const pairRe = /"?(\d+)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = pairRe.exec(t))) {
      out[m[1]] = m[2].replace(/\\"/g, '"');
    }
    return Object.keys(out).length ? out : null;
  }
}

// 将 colIndex -> value 映射转为「按列名对齐的整行对象」
function columnsToRow(columns, data) {
  const row = {};
  columns.forEach((col, i) => { row[col] = ''; });
  Object.keys(data).forEach((k) => {
    const idx = Number(k);
    if (!Number.isNaN(idx) && idx >= 0 && idx < columns.length) {
      row[columns[idx]] = String(data[k] == null ? '' : data[k]);
    }
  });
  return row;
}

// 将 colIndex -> value 映射转为「只含被提供列的稀疏补丁」对象（用于 updateRow 局部覆盖）
function columnsToPatch(columns, data) {
  const patch = {};
  Object.keys(data).forEach((k) => {
    const idx = Number(k);
    if (!Number.isNaN(idx) && idx >= 0 && idx < columns.length) {
      patch[columns[idx]] = String(data[k] == null ? '' : data[k]);
    }
  });
  return patch;
}

// 对一段模型输出整体执行所有 tableEdit 指令，返回执行结果与更新后的 memory
function executeTableEdit(memory, outputText) {
  const mem = normalizeMemory(memory);
  const instructions = extractTableEdit(outputText);
  const applied = [];
  const errors = [];
  for (const ins of instructions) {
    const r = applyInstruction(mem, ins);
    if (r.ok) applied.push(ins);
    else errors.push(r.error);
  }
  return { memory: mem, applied, errors, count: applied.length };
}

module.exports = {
  extractTableEdit,
  applyInstruction,
  executeTableEdit
};