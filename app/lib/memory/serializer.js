'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 结构化长期记忆系统：序列化器
// 职责：
//  1. 将内存表（memory）序列化为注入 Prompt 的紧凑表格文本（读表）；
//  2. 生成「表格整理/增量更新」所需的系统/用户提示词（写表/提炼）；
//  3. 提供磁盘读写：out/<slug>/memory_sheets.json 的加载与落盘。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// 将一张表渲染为紧凑的 Markdown 表格字符串（供注入）
function renderTable(table) {
  if (!table) return '';
  const cols = table.columns || [];
  const header = `[${table.tableIndex}:${table.tableName}] 列: ${cols.map((c, i) => `[${i}:${c}]`).join(' ')}`;
  if (!table.content || table.content.length === 0) {
    return `${header}\n（空表）`;
  }
  const lines = table.content.map((row, ri) => {
    const cells = cols.map((c) => String(row && row[c] != null ? row[c] : '').replace(/\|/g, '/'));
    return `[${ri}] ${cells.join(' | ')}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

// 将全部表格渲染为「注入正文前的世界状态块」
function buildWorldStateBlock(memory) {
  if (!memory || !Array.isArray(memory.tables)) return '';
  const active = memory.tables.filter((t) => t.required || (t.content && t.content.length));
  if (!active.length) return '';
  const body = active.map((t) => renderTable(t)).join('\n\n');
  return [
    '## <world_state> 当前结构化记忆表（DataTable）',
    '以下是必须严格遵守的世界状态锚点。写作时必须基于这些事实推进，不得凭空捏造或违背；',
    '涉及表中事实变化时，你无需手工维护，系统会另行处理。',
    '',
    body,
    '</world_state>'
  ].join('\n');
}

// 系统提示词：表格整理/增量更新助手
function buildRefreshSystemPrompt() {
  return '你是专业的结构化记忆整理助手。请根据用户提供的<当前表格>与<最新正文>，遵循<操作规则>，' +
    '使用 <tableEdit> 标签和指定函数（insertRow / updateRow / deleteRow）输出对表格的修改。' +
    '你的回复必须只包含 <tableEdit> 标签及其内容，禁止输出正文、解释或思考过程。';
}

// 用户提示词：要求模型对表格做增量更新
function buildRefreshUserPrompt(memory, chapterText) {
  const flattened = memory.tables
    .map((t) => `### [${t.tableIndex}:${t.tableName}]${t.singleton ? '（单态，恒一行）' : ''}\n${renderTable(t)}`)
    .join('\n\n');
  const tableHeaders = memory.tables
    .map((t) => `[${t.tableIndex}:${t.tableName}] 列: ${(t.columns || []).map((c, i) => `[${i}:${c}]`).join(' ')}`)
    .join('\n');
  return [
    '请根据<当前表格>和<最新正文>，严格遵守<操作规则>和<重要操作原则>，对表格进行必要的增、删、改操作。',
    '你的回复必须只包含 <tableEdit> 标签及其中的函数调用，不要包含任何其他解释或思考过程。',
    '',
    '<最新正文>',
    String(chapterText || '').slice(0, 6000),
    '</最新正文>',
    '',
    '<当前表格>',
    flattened,
    '</当前表格>',
    '',
    '<表头信息>',
    tableHeaders,
    '</表头信息>',
    '',
    '# 增删改 dataTable 操作方法：',
    '<OperateRule>',
    '- 插入新行：insertRow(tableIndex:number, data:{[colIndex:number]:string})',
    '  例如：insertRow(1, {"0":"悠悠","1":"身高150/黑发","2":"内向"})',
    '- 删除行：deleteRow(tableIndex:number, rowIndex:number)',
    '- 更新行：updateRow(tableIndex:number, rowIndex:number, data:{[colIndex:number]:string})',
    '  例如：updateRow(1, 0, {"1":"右臂新增一道疤"})',
    '</OperateRule>',
    '',
    '<重要操作原则>',
    '- 当只有最新正文确实产生了持久变化时才修改表格；禁止捏造信息或填入未知内容。',
    '- 单元格内禁止使用逗号，语义分割请用 / 。',
    '- 字符串中禁止出现双引号。',
    '- <tableEdit> 标签内必须使用 <!-- --> 注释包裹函数调用。',
    '- 时空表格（单态）出现新场景时用 updateRow 覆盖第一行，不得追加多行。',
    '- 若无变化，返回空的 <tableEdit><!-- --></tableEdit>。',
    '</重要操作原则>'
  ].join('\n');
}

// ── 磁盘读写：out/<slug>/memory_sheets.json ──
function memoryFilePath(cfg, slug) {
  return path.join(cfg.outDir, String(slug || ''), 'memory_sheets.json');
}

function loadMemory(cfg, slug, defaultFactory) {
  const p = memoryFilePath(cfg, slug);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return defaultFactory ? defaultFactory(raw) : raw;
  } catch {
    return null;
  }
}

function saveMemory(cfg, slug, memory) {
  const dir = path.join(cfg.outDir, String(slug || ''));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(memoryFilePath(cfg, slug), JSON.stringify(memory, null, 2), 'utf8');
  return memoryFilePath(cfg, slug);
}

module.exports = {
  renderTable,
  buildWorldStateBlock,
  buildRefreshSystemPrompt,
  buildRefreshUserPrompt,
  loadMemory,
  saveMemory,
  memoryFilePath
};