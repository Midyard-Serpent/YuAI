# YuAI: 结构化长篇叙事生成管线与作家风格模拟系统

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

YuAI 是一个面向长篇连续小说创作的**分阶段结构化生成系统**与**作家风格还原工作台**。
系统通过将创作流程解构为「策划 → 节拍大纲 → 逐拍正文 → 多维自检」四阶流水线，结合 BM25 上下文检索、多层提示词注入与结构化六表记忆持久层，有效解决大语言模型在超长篇叙事中的“遗忘”、“设定漂移”与“风格同质化”问题。

---

## 🌟 核心特性

- 🎯 **四阶段叙事流水线**：
  - **策划 (Planning)**：确立主题、基调、主线冲突与情感落点。
  - **节拍大纲 (Outline v3)**：将章节分解为「叙事 / 对话 / 动作 / 心理」精准节奏节拍。
  - **逐拍正文 (Chapter)**：结合节拍配额许可与自适应状态推进正文生成。
  - **自检与符合度度量 (Review & Compliance)**：针对物理层描写、对话比例与词频特征执行多维量化核验。
- 🧠 **结构化六表记忆系统 (`lib/memory`)**：
  - 角色表、实体表、状态演进、世界观约束等结构化表单，随章节推进自动更新与一致性校验。
- 🔍 **语料风格检索与画像分析**：
  - 内置 BM25 分块检索器，支持根据情节走向动态调取样本库中的笔法与语感切片。
- 🖥️ **一体化工作台**：
  - 基于 Vue 3 + Tailwind CSS 构建的创作控制台，提供大纲可视化、记忆看板与参数实时拨档。

---

## 🚀 快速上手

### 1. 环境准备
确保已安装 [Node.js](https://nodejs.org/) (v18+ 或更高版本)。

```bash
# 克隆仓库
git clone https://github.com/your-username/YuAI.git
cd YuAI/app

# 安装依赖
npm install
```

### 2. 基础配置
基于 `config.example.json` 创建运行时配置文件 `config.json`：
```bash
cp config.example.json config.json
```
编辑 `app/config.json`，填入你的模型 API 访问端点（兼容 OpenAI/Gemini 格式）与 API Key。

### 3. 运行工作台
```bash
# 启动后端服务与前端工作台（单端口 43130）
node server.js
```
在浏览器中打开：`http://127.0.0.1:43130` 即可进入创作工作台。

### 4. 命令行一键生成 (CLI)
```bash
# 离线模拟跑通测试
node bin/generate.js --mock --topic "测试篇章：初秋的信使"

# 使用真实 API 生成
node bin/generate.js --topic "自定义主题" --min-target 4000
```

---

## 🧩 扩展与自定义风格包 (Addon)

YuAI 采用 **Open-Core（开源内核）** 设计：
- 本开源仓库仅提供通用算法引擎、空白模板与安全示例。
- 如需导入特定作家的私有语料库、高密度倒排索引或特定流派的增强策略包，请将外挂包（如 `YuAE-Profile-Addon`）放置于本目录下并运行其附带的 `inject.bat`（或 `node inject.js`）进行一键挂载。

---

## 🛡️ 安全合规与开源协议

- 本仓库遵循 [MIT 开源协议](LICENSE)。
- 本项目不附带任何受版权保护的第三方专有文学语料；用户在使用本项目分析、训练或生成文本时，应严格遵守所在地区的法律法规及数据版权许可。
