'use strict';

// 结构化长期记忆系统统一入口：聚合 schema / executor / serializer。

const { defaultMemory, normalizeMemory, TABLE_SCHEMA } = require('./schema');
const { executeTableEdit } = require('./executor');
const {
  buildWorldStateBlock,
  buildRefreshSystemPrompt,
  buildRefreshUserPrompt,
  loadMemory,
  saveMemory
} = require('./serializer');

module.exports = {
  TABLE_SCHEMA,
  defaultMemory,
  normalizeMemory,
  executeTableEdit,
  buildWorldStateBlock,
  buildRefreshSystemPrompt,
  buildRefreshUserPrompt,
  loadMemory,
  saveMemory
};