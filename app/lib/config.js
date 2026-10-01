'use strict';

const fs = require('fs');
const path = require('path');

function loadConfig(rootDir) {
  // 优先 config.json（用户本地配置），回退 config.example.json
  const candidates = [
    path.join(rootDir, 'config.json'),
    path.join(rootDir, 'config.example.json')
  ];
  let cfg = {};
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    }
  }

  // 环境变量覆盖（便于注入密钥 / 端点 / 模型）
  const env = process.env;
  if (env.GEMINI_BASE_URL) cfg.gemini.baseUrl = env.GEMINI_BASE_URL;
  if (env.GEMINI_MODEL) cfg.gemini.model = env.GEMINI_MODEL;
  if (env.GEMINI_TEMPERATURE) cfg.gemini.temperature = Number(env.GEMINI_TEMPERATURE);
  if (env.GEMINI_MAX_TOKENS) cfg.gemini.maxOutputTokens = Number(env.GEMINI_MAX_TOKENS);

  // 密钥只在环境变量里读，永不落盘
  const keyEnv = cfg.gemini.apiKeyEnv || 'GEMINI_API_KEY';
  cfg.gemini.apiKey = env[keyEnv] || '';

  // 解析相对路径为绝对（相对项目根）
  const resolve = (p) => (p && !path.isAbsolute(p) ? path.join(rootDir, p) : p);
  cfg.corpusDir = resolve(cfg.corpusDir);
  cfg.profileDir = resolve(cfg.profileDir);
  cfg.outDir = resolve(cfg.outDir);

  return cfg;
}

module.exports = { loadConfig };