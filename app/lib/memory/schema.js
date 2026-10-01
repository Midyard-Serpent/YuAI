'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 结构化长期记忆系统：数据表 Schema（对齐 st-memory-enhancement 原版六表标准）
// 目标：为长篇连载提供跨章节稳定、可扩展、可手工精修的世界状态持久层。
// 每张表为「列定义 + 行内容」，由 executor.js 以 insert/update/deleteRow 原子更新，
// 由 serializer.js 序列化为注入 Prompt 的紧凑文本。
// ─────────────────────────────────────────────────────────────────────────────

// 原版六大记忆表 Schema（表名、列、职责、触发条件、初始/更新规则）
const TABLE_SCHEMA = [
  {
    tableIndex: 0,
    tableName: '时空表格',
    columns: ['日期', '时间', '地点（当前描写）', '此地角色'],
    required: true,
    singleton: true,          // 时空表永远只保留一行（当前物理锚点），场景转移 = updateRow
    note: '记录当前时空与物理锚点，应保持在一行',
    initNode: '本轮需要记录当前时间、地点、人物信息，使用 insertRow 函数',
    updateNode: '当描写的场景、时间、人物变更时',
    deleteNode: '此表大于一行时应删除多余行',
    content: []
  },
  {
    tableIndex: 1,
    tableName: '角色特征表格',
    columns: ['角色名', '身体特征', '性格', '职业', '爱好', '喜欢的事物', '住所', '其他重要信息'],
    required: true,
    singleton: false,
    note: '角色天生或不易改变的特征（含体型比例、伤痕等持久状态）',
    initNode: '本轮必须从上文寻找已知的所有角色使用 insertRow 插入，角色名不能为空',
    insertNode: '当本轮出现表中没有的新角色时，应插入',
    updateNode: '当角色的身体出现持久性变化（如伤痕/服装破损）时/当角色有新的爱好、职业、喜欢的事物时/角色更换住所时/提到重要信息时',
    deleteNode: '',
    content: []
  },
  {
    tableIndex: 2,
    tableName: '角色关系与态度表格',
    columns: ['角色名', '与主角关系', '对主角态度', '对主角支配度/好感'],
    required: true,
    singleton: false,
    note: '角色与主角的动态关系、心理与权力态势',
    initNode: '本轮必须从上文寻找已知的所有角色使用 insertRow 插入，角色名不能为空',
    insertNode: '当本轮出现表中没有的新角色时，应插入',
    updateNode: '当角色和主角的交互不再符合原有记录时/关系与权力态势改变时',
    deleteNode: '',
    content: []
  },
  {
    tableIndex: 3,
    tableName: '任务命令约定表格',
    columns: ['角色', '任务/约定', '地点', '持续时间/状态'],
    required: false,
    singleton: false,
    note: '未履行的命令、悬而未决的伏笔、契约时限',
    initNode: '',
    insertNode: '当某角色收到做某事的命令或任务时/当约定特定时间一起做某事时',
    updateNode: '当任务或约定的状态推进时',
    deleteNode: '当任务或命令完成时/任务被取消时/约定已履行时',
    content: []
  },
  {
    tableIndex: 4,
    tableName: '重要事件历史表格',
    columns: ['角色', '事件简述', '日期/章次', '地点', '情绪/后果'],
    required: true,
    singleton: false,
    note: '记录主角或角色经历的重要事件（编年史，不可变）',
    initNode: '本轮必须从上文寻找可以插入的事件并使用 insertRow 插入',
    insertNode: '当某个角色经历让自己印象深刻的事件时（例如受伤、失势、转折、告白、对峙）',
    updateNode: '',
    deleteNode: '',
    content: []
  },
  {
    tableIndex: 5,
    tableName: '重要物品道具表格',
    columns: ['拥有人', '物品描述', '物品名', '重要原因/当前位置'],
    required: false,
    singleton: false,
    note: '对某人贵重或有特殊意义的物品，及关键约束物的位置归属',
    initNode: '',
    insertNode: '当某人获得了贵重或有特殊意义的物品时/当某个已有物品有了特殊意义时',
    updateNode: '当物品的归属或位置发生转移时',
    deleteNode: '当物品被永久损毁或彻底失去意义时',
    content: []
  }
];

// 默认冻结（供无历史作品初始化时使用）：空结构
function defaultMemory() {
  return {
    version: 3,
    tables: TABLE_SCHEMA.map((t) => ({
      tableIndex: t.tableIndex,
      tableName: t.tableName,
      columns: t.columns.slice(),
      required: !!t.required,
      singleton: !!t.singleton,
      content: []
    }))
  };
}

// 按 index 查找表定义（建模辅助）
function getTableByIndex(index) {
  return TABLE_SCHEMA.find((t) => t.tableIndex === index);
}

// 校验并归一化外部/前端传入的表结构（防溢出、防列缺失）
function normalizeMemory(input) {
  const base = defaultMemory();
  if (!input || typeof input !== 'object') return base;
  const tables = Array.isArray(input.tables) ? input.tables : base.tables;
  for (const src of tables) {
    const t = base.tables.find((b) => b.tableIndex === src.tableIndex);
    if (!t) continue;
    if (Array.isArray(src.columns)) t.columns = src.columns.slice();
    if (Array.isArray(src.content)) t.content = src.content;
  }
  return base;
}

module.exports = {
  TABLE_SCHEMA,
  defaultMemory,
  normalizeMemory,
  getTableByIndex
};