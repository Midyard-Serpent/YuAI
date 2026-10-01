@echo off
chcp 65001 >nul
title YuAI 创作工作台
cd /d "%~dp0app"
if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install
)
echo 正在启动 YuAI 服务...
start http://127.0.0.1:43130
node server.js
pause
