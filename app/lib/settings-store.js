'use strict';

// 运行时连接设置（内存态）。分层优先级：
//   前端 POST /api/settings（最高） > 环境变量 > config.json 默认值
// apiKey 只存内存、永不落盘；GET 只返回“是否已配置”，不回明文。

const path = require('path');
const { loadConfig } = require('./config');

const ROOT = path.resolve(__dirname, '..');

const runtime = {
  model: null,
  baseUrl: null,
  apiKey: null
};

// 获取当前生效的连接参数（model / baseUrl / apiKey）
function getConn() {
  const cfg = loadConfig(ROOT);
  const keyEnv = cfg.gemini?.apiKeyEnv || 'GEMINI_API_KEY';
  return {
    model: runtime.model || process.env.GEMINI_MODEL || cfg.gemini?.model || '',
    baseUrl: runtime.baseUrl || process.env.GEMINI_BASE_URL || cfg.gemini?.baseUrl || '',
    apiKey: runtime.apiKey || process.env[keyEnv] || cfg.gemini?.apiKey || ''
  };
}

// 前端写入运行时设置。空字符串/undefined 视为“不改该项”。
function setConn({ model, baseUrl, apiKey } = {}) {
  if (typeof model === 'string' && model.trim()) runtime.model = model.trim();
  if (typeof baseUrl === 'string' && baseUrl.trim()) runtime.baseUrl = baseUrl.trim();
  // apiKey 允许显式清空（传空字符串）
  if (typeof apiKey === 'string') runtime.apiKey = apiKey;
  return getConn();
}

// 对外安全视图：不回明文 apiKey，只报是否已配
function publicConn() {
  const c = getConn();
  return {
    model: c.model,
    baseUrl: c.baseUrl,
    keyConfigured: !!c.apiKey
  };
}

module.exports = { getConn, setConn, publicConn };