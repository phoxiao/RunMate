# 1. 产品需求文档

## 1.1. 产品概述

VS Code 插件 **RunMate**，用于自动发现并集中管理项目中的 Shell 脚本（`.sh`），支持实时刷新、快速执行、参数输入、执行状态管理与安全保护。

---

## 1.2. 核心目标

* **开发效率**：统一面板管理脚本，避免频繁手动切换终端目录。
* **安全保障**：执行前确认 + 高危命令检测。
* **易用体验**：实时脚本更新、参数输入支持、双击快速编辑。

---

## 1.3. 功能需求

### 1.3.1 脚本发现与管理

* 实时监听项目目录，脚本新增/删除自动更新列表。
* 默认按文件名排序，支持自定义排序（配置文件中设置）。
* 面板中展示文件名、执行按钮、执行状态。
* 支持搜索（文件名模糊匹配，实时过滤）。
* 面板中双击脚本 → 在编辑器中打开脚本文件。
* 自动目录分组：脚本按所在文件夹分组展示,所有文件夹不分层级放在一级

### 1.3.2 脚本执行

* **执行目录**：默认在脚本所在目录执行；支持通过配置文件指定自定义工作目录。
* **并发执行**：允许多个脚本同时运行。
* **执行状态显示**：

  * 运行中：旋转图标。
  * 成功：绿色标识。
  * 失败：红色标识。
* **终端输出**：在 VS Code 终端中展示脚本运行结果。

  * 每个脚本运行时终端标题增加 `[script-name]` 前缀，便于区分。

### 1.3.3 参数输入

* 执行脚本时，弹出单行输入框（用户输入完整参数字符串）。
* 用户可点击按钮查看脚本内的参数选项（解析 `getopts` 或 usage 注释）。
* 记住上次执行该脚本时输入的参数，下次执行时自动填充。
* 不支持多行参数输入，不提供历史下拉。

### 1.3.4 执行中断

* 面板中提供「停止」按钮，中断正在运行的脚本。
* 默认发送 `SIGINT`（Ctrl+C），若脚本无响应，允许强制 `SIGKILL`。

### 1.3.5 安全与权限

* 执行前弹出确认提示（脚本路径 + 参数）。
* 内置危险命令检测规则（`rm -rf`, `mkfs`, `:(){:|:&};:` 等），触发时弹出二次确认。
* 用户可在配置文件中增删检测规则。
* 若脚本缺少执行权限，插件自动赋予权限（`chmod +x`）。

---

## 1.4. 配置文件（`.vscode/run-mate.json`）

### 配置项

```json
{
  "ignoreDirectories": ["node_modules", ".git"],
  "defaultWorkingDirectory": "./",
  "customSort": ["deploy.sh", "build.sh"], 
  "dangerousCommandsWhitelist": ["rm -rf ./tmp"],
  "dangerousCommandsBlacklist": ["rm -rf /", "mkfs", ":(){:|:&};:"]
}
```

### 配置方式

* 文件手动编辑 + VS Code 设置面板可视化配置。

---

## 1.5. 非功能性需求

* **性能**：支持 ≥1000 脚本，实时更新延迟 < 2 秒。
* **兼容性**：支持 macOS/Linux（bash/zsh/sh），Windows 暂不支持。
* **安全性**：双重确认 + 高危命令检测 + 自动赋权。

---

## 1.6. 测试范围

* **执行权限不足**：验证缺少 `chmod +x` 时插件能自动赋权。
* **高危命令检测**：验证误报/漏报场景，支持规则自定义。
* **并发执行**：多脚本并发运行时，终端输出互不干扰。
* **执行中断**：验证 `SIGINT` 能优雅中止脚本，`SIGKILL` 能强制终止。
* **实时刷新**：脚本文件新增/删除能即时更新到面板。
* **参数复用**：再次执行同一脚本时能自动填充上次输入的参数。

# 2. 插件架构说明

* **运行环境**：VS Code 插件，基于 TypeScript + VS Code Extension API
* **模块划分**：

  * `scriptScanner.ts` → 负责脚本发现（文件扫描 + chokidar 监听）
  * `scriptTreeView.ts` → TreeView 面板展示脚本
  * `executor.ts` → 调用 `child_process.spawn` 执行脚本，绑定终端
  * `config.ts` → 读取/解析 `.vscode/run-mate.json`
  * `security.ts` → 高危命令检测 + 自动赋权逻辑
* **依赖库**：

  * `chokidar`：文件变动监听
  * `child_process`：脚本执行
  * `fs-extra`：配置文件读写

---

# 3. API 与接口说明

## VS Code API

* `window.createTreeView` → 插件侧边栏面板
* `window.showInputBox` → 参数输入
* `window.showWarningMessage` → 执行前确认 / 高危命令二次确认
* `window.createTerminal` → 执行脚本
* `workspace.onDidChangeConfiguration` → 配置刷新

## Node.js API

* `fs.readdir` + `fs.stat` → 文件扫描
* `fs.chmod` → 自动赋权
* `child_process.spawn` → 脚本执行

---

# 4. 配置文件规范（JSON Schema）

```json
{
  "ignoreDirectories": {
    "type": "array",
    "items": { "type": "string" }
  },
  "defaultWorkingDirectory": {
    "type": "string"
  },
  "customSort": {
    "type": "array",
    "items": { "type": "string" }
  },
  "dangerousCommandsWhitelist": {
    "type": "array",
    "items": { "type": "string" }
  },
  "dangerousCommandsBlacklist": {
    "type": "array",
    "items": { "type": "string" }
  }
}
```

---

# 5. UI & 交互文档

* **Shell Manager 面板**

  * TreeView：目录分组 → 脚本列表 → 执行按钮
  * 状态图标：

    * Idle → 灰色
    * Running → 旋转动画
    * Success → 绿色 ✔
    * Failed → 红色 ✘
* **交互流程图**

  1. 用户点击脚本 → 弹出参数输入框
  2. 用户输入参数 → 弹出确认框（显示脚本路径 + 参数）
  3. 用户确认 → 新终端执行脚本（终端标题加 `[script-name]` 前缀）
  4. 运行中可点「停止」 → 发送 `SIGINT`，必要时 `SIGKILL`
  5. 执行结束 → 更新状态标记

---

# 6. 错误处理 & 异常场景

* **权限不足**：捕获 `EACCES` → 自动执行 `chmod +x` → 重试执行
* **高危命令检测**：匹配黑名单 → 二次确认提示
* **执行失败**：状态标记为红色，终端显示错误信息
* **文件新增/删除**：TreeView 自动刷新

---

# 7. 工程结构（推荐）

```
run-mate/
  ├── src/
  │   ├── extension.ts         // 插件入口
  │   ├── scriptScanner.ts     // 脚本扫描与监听
  │   ├── scriptTreeView.ts    // TreeView UI
  │   ├── executor.ts          // 执行与终端交互
  │   ├── config.ts            // 配置文件解析
  │   └── security.ts          // 安全检测与自动赋权
  ├── package.json             // 插件元数据
  ├── run-mate.json       // 配置示例
  └── README.md                // 插件说明
```

# 8. 测试用例

1. **执行权限不足**：脚本无 `+x` 权限时自动赋权并成功运行。
2. **高危命令**：包含 `rm -rf /` → 二次确认 → 用户取消执行。
3. **并发执行**：同时运行两个脚本，两个终端输出互不干扰。
4. **执行中断**：运行中的脚本点击「停止」→ 成功中止。
5. **实时刷新**：新增一个脚本文件 → 面板自动出现；删除脚本 → 面板自动移除。
6. **参数复用**：执行同一脚本时自动填充上次输入的参数。

---

# 9. 开发约束

* **语言**：TypeScript（必须）
* **代码风格**：ESLint + Prettier
* **打包工具**：`vsce`
* **兼容性**：macOS/Linux（bash/zsh/sh）
