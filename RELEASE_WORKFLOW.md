# YuAI 开源发布规范：剥离与外挂打包工作流 (RELEASE_WORKFLOW.md)

> **文档定位**：本指南用于指导后续维护者或接手模型将主开发仓（`yuae-simulator`）的代码与资产**安全合规**地剥离并同步至开源发布仓（`YuAI-Git`），同时将敏感的专有资产（第三方版权小说原文、倒排检索大文本、越狱/破甲策略等）封装为独立可注入的非开源外挂包（`YuAE-Profile-Addon`）。

---

## 一、 核心铁律（发布三原则）

1. **单向流动原则（One-Way Flow）**
   * `yuae-simulator` 是 **唯一的开发真源（Single Source of Truth）**。
   * `YuAI-Git` 仅作为发布导出目标（Target），任何业务逻辑更新、Bug 修复均须在 `yuae-simulator` 中进行，**严禁在 `YuAI-Git` 内反向编辑代码后回拷**。
2. **零泄漏红线（Zero Leakage）**
   * 严禁将任何第三方受版权保护的小说全文（`data/YuAE/` 及其衍生切块）、真实 API 密钥（`config.json`）、生成草稿（`out/`）或露骨策略明文推送到 GitHub 公开仓库。
3. **确定性自动化（Script First）**
   * 人工逐一挑选复制极易漏带敏感文件。发布流程由专用导出脚本（`tools/export-release.js`）完成，人工按 Checklist 执行双重复核。

---

## 二、 资产隔离与剥离矩阵 (Isolation Matrix)

在同步时，各资产的处理规则如下：

| 资产路径 | 资产性质 | GitHub 开源版 (`YuAI-Git`) | 私有外挂包 (`YuAE-Profile-Addon`) | 规则说明 |
|---|---|---|---|---|
| `app/lib/` (全量) | 核心管线与算法 | **完整保留** | 不包含 | 包含工作流、记忆系统、BM25 算法、提示词模板等 |
| `app/bin/` (CLI 工具) | 命令行运行入口 | **完整保留** | 不包含 | 包含 generate, build-profile, prompt-verify 等 |
| `app/web/dist` | 前端单页编译产物 | **完整保留** | 不包含 | 生产静态资源，开箱即用 |
| `app/server.js` | 后端服务 | **完整保留** | 不包含 | 静态托管 + API |
| `app/package.json` | 依赖定义 | **完整保留** | 不包含 | 仅 express, cors |
| `data/YuAE/` | 29 篇小说原文 | **绝对禁止** | **完整包含** | 替换为空目录模板 `app/data/sample_corpus/` |
| `app/profile/index.json` | 1572 块原文全文索引 (4.9MB) | **绝对禁止** | **完整包含** | Git 版生成一个结构合法的空索引 `[]` |
| `app/profile/works.json` | 29 篇小说开篇与结尾样例 | **绝对禁止** | **完整包含** | Git 版替换为空数组 `[]` 或合成样例 |
| `app/profile/worldbook.json` | 真实作品人物与世界观卡 | **剔除敏感设定** | **完整包含** | Git 版仅保留通用示例卡 |
| `app/profile/style*.txt/json` | 统计画像、锚点词、回避词 | **去敏感化保留** | **完整包含** | 保留文风结构模板，剔除露骨词汇 |
| `app/patches/system-extra.md` | 越狱/破甲策略 (VOID_WRITER) | **剥离** | **完整包含** | Git 版替换为标准风格指南与格式约束占位符 |
| `app/patches/patches.json` | 阶段覆盖开关模板 | **保留结构** | **保留结构** | 开关默认关闭 |
| `app/config.json` | 本地真实配置 (含 Key/代理) | **绝对禁止** | 不包含 | 仅分发 `config.example.json` |
| `out/` | 生成作品与草稿 | **绝对禁止** | 不包含 | Git 版通过 `.gitignore` 排除 |
| `_archive/` & `logs/` | 历史调优与调试日志 | **绝对禁止** | 不包含 | 属于本地分析痕迹，不公开 |

---

## 三、 私有外挂包 (Private Addon) 规范与注入协议

剥离出来的私有资产被打包为独立压缩包（如 `YuAE-Profile-Addon-v0.1.0.zip`），供授权用户或圈内使用者本地挂载。

### 1. 外挂包目录结构
```text
YuAE-Profile-Addon/
├── inject.bat                # Windows 一键注入脚本
├── inject.js                 # 跨平台注入脚本 (Node.js)
├── README.md                 # 外挂包使用说明与免责
├── 外置警告.md                # 圈内传播强制守则与版权警告
└── payload/                  # 待覆盖的私有资产
    ├── data/
    │   └── YuAE/             # 29 篇小说原始语料
    ├── profile/
    │   ├── index.json        # 4.9MB 检索倒排索引
    │   ├── works.json        # 真实开篇/结尾 sample
    │   ├── worldbook.json    # 完整世界观与角色卡
    │   ├── style.json        # 完整风格画像
    │   ├── style-anchors.txt # 专属特征锚点词
    │   └── style-avoid.txt   # 专属回避词库
    └── patches/
        ├── system-extra.md   # 完整破甲策略与输出对齐提示词
        └── patches.json      # 补丁配置
```

### 2. 注入协议与执行机制
注入脚本通过相对路径寻址目标 `YuAI` 根目录或直接解压覆盖：
* **文件合并机制**：脚本将 `payload/*` 下的文件直接拷贝并覆盖到目标项目 `app/` 对应子目录下。
* **配置自动激活**：
  若检测到目标环境存在 `app/config.json`，自动确保 `corpusDir` 指向 `"data/YuAE"`；若不存在，基于 `config.example.json` 生成一份默认启用外挂的配置。
* **自检与验证**：注入完成后自动执行 `node bin/prompt-verify.js`，核验指纹是否完整就绪。

---

## 四、 自动化剥离与同步流程 (SOP)

后续发版时，请按以下 5 个步骤执行：

### 步骤 1：主开发仓门禁回归（在 `yuae-simulator`）
必须在主开发版本全绿状态下才能触发导出：
```powershell
cd D:\Work\DSH\YUAI\yuae-simulator\app

# 1. 离线体检（必须 0 错误）
node bin/prompt-verify.js

# 2. 离线 Mock 跑通冒烟
node bin/generate.js --mock --topic "发布前冒烟测试"
```

### 步骤 2：执行自动化导出与打包脚本
运行自动化导出工具（`tools/export-release.js`），指定输出目录：
```powershell
cd D:\Work\DSH\YUAI\yuae-simulator
node tools/export-release.js --git-dest "..\YuAI-Git" --addon-dest "..\YuAE-Addon-Dist"
```

> **该脚本自动完成以下动作**：
> 1. 清理 `YuAI-Git`（保留 `.git/` 版本历史）；
> 2. 白名单复制 `app/lib/`, `app/bin/`, `app/web/dist/`, `app/package.json` 等源码；
> 3. 生成 Git 专属的脱敏占位文件（空的 `index.json`、中性化的 `system-extra.md`、通用的 `config.example.json`）；
> 4. 生成标准开源三件套（`README.md`、`LICENSE`、`.gitignore`）；
> 5. 提取 `data/YuAE/`、真实 `profile/`、真实 `patches/` 并打包为 `YuAE-Profile-Addon-<version>.zip`；
> 6. 在外挂包中自动写入 `inject.js` 与 `inject.bat`。

### 步骤 3：开源版独立性检验 (Stand-alone Smoke Test)
进入导出的 `YuAI-Git` 目录，验证**开源版本在完全不依赖私有语料的情况下能否独立运行**：
```powershell
cd D:\Work\DSH\YUAI\YuAI-Git\app

# 1. 验证没有私有语料时的体检（预期：语法与架构通过）
node bin/prompt-verify.js

# 2. 验证开源默认状态下的 Mock 运行
node bin/generate.js --mock --topic "测试开源管线连通性"
```

### 步骤 4：外挂包挂载复原检验 (Addon Integration Test)
新建一个临时测试目录，解压 `YuAI-Git` 并运行外挂包的 `inject.bat`，验证外挂能否一键将开源版还原为 100% 全功能的完整状态。

### 步骤 5：人工发布终审 Checklist
在执行 `git push` 前，逐项核对并打勾：
- [ ] **敏感词与原文排查**：在 `YuAI-Git` 目录运行敏感词检索（如已知系列名、作品标题、角色名等真实语料专有词），无真实小说片段命中。
- [ ] **索引大小核查**：确认 `YuAI-Git/app/profile/index.json` 小于 10KB（禁止 4.9MB 真实切块入库）。
- [ ] **密钥排查**：确认 `YuAI-Git/app/` 下不存在 `config.json`，仅有 `config.example.json`。
- [ ] **构建产物排查**：确认 `out/` 目录为空，没有残存生成的小说 txt。
- [ ] **Git 暂存区检查**：
  ```powershell
  cd D:\Work\DSH\YUAI\YuAI-Git
  git status
  git diff --cached
  ```
  确认变更仅包含引擎逻辑与文档，无多余未跟踪文件。

---

## 五、 异常排查与回滚方案

1. **若意外将敏感数据加入 Git 暂存区（未 Push）**：
   ```powershell
   git reset HEAD
   git clean -fd
   ```
2. **若已 Push 敏感数据到远程公开仓库**：
   * 立即将 GitHub 仓库设为 Private（私有）；
   * 使用 `git-filter-repo` 或 BFG Repo-Cleaner 彻底抹除该文件在所有历史 Commit 中的记录；
   * 强制推送覆盖：`git push origin --force --all`；
   * 若涉及 API Key 泄漏，立即前往服务商控制台撤销并重新生成密钥。
