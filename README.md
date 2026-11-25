# AGY Drag Graft

中文 | [English](README.en.md)

面向 **Antigravity Desktop (`agy`)** 的标准插件。支持将**左侧历史会话**、**右侧文件索引栏（Workspace 文件树、本地 Artifacts、目录视图与路径面包屑下拉菜单）**直接拖入对话输入框，自动生成原生引用胶囊（`contextScopeItemMention`）；悬停输入框期间精准隐藏宿主半屏分屏遮罩，同时保留对话区分屏、侧边栏排序与原生点击行为，不修改宿主 `app.asar`。

---

## 核心交互分区

| 拖拽起点 | 释放落点 | 结果 |
| --- | --- | --- |
| 左侧历史会话行 | 对话输入框（`[data-testid="agent-input-box"]`） | 起拖会话（位移 ≥ 8 px）即在所有可见输入框显示淡色蓝框引导与「拖拽到此引用」提示；悬停进入目标输入框后加深高亮并隐藏宿主半屏蓝罩，松手取消本次分屏并插入原生会话引用胶囊 |
| 右侧文件索引（文件树 / 本地 Artifact / 目录视图 / 面包屑下拉） | 对话输入框（`[data-testid="agent-input-box"]`） | 显示跟随鼠标指针的自适配拖拽预览卡与所有可见输入框引导框，松手插入原生 `file` 或 `directory` 引用胶囊（若来自面包屑下拉弹窗则自动收起弹窗） |
| 左侧历史会话行 | 对话正文 / 四周分屏热区 | 立即恢复宿主分屏遮罩并完全放行，保留 Antigravity 原生分屏（Split View） |
| 左侧历史会话行 | 侧边栏内部 | 完全放行，保留原有排序、分组或点击切换 |
| 行内操作按钮 / 短距离点击 | 任意位置 | 不触发拖拽引用，保留原有菜单与切换行为 |

内置保护：
- **自引用拦截**：拖入当前对话自身时弹窗提示并跳过，避免误引用当前会话。
- **草稿去重**：同一条草稿中不重复插入相同会话、文件或文件夹胶囊，支持连续拖入多项引用。
- **独立副栏识别**：支持主对话与辅助侧栏（子代理、Side Question）各自独立识别所属会话 ID。
- **插件隔离**：采用标准 AGY 插件目录与独立 Sidecar（`agy-drag-graft/bridge`）及 `window.__agyDragGraft` 命名空间，与 `agy-context-dashboard` 等其他插件互不冲突。

---

## 安装与启用

所有脚本均为零第三方依赖，仅需 **Node.js 22+**。

### 方式一：发一句话让 Antigravity 自动安装

```text
帮我安装并启用这个 Antigravity 插件：https://github.com/zxzc114514/agy-drag-graft
```

### 方式二：下载 Release 压缩包或克隆后命令行安装

可从 [GitHub Releases](https://github.com/zxzc114514/agy-drag-graft/releases) 下载最新 `agy-drag-graft-<version>.zip`（附带 `.zip.sha256` 校验文件），解压后进入 `agy-drag-graft` 目录运行安装脚本：

```bat
:: Windows（安装并自动启用）
.\install.cmd

:: 卸载（清理插件目录、配置与当前窗口内存钩子）
.\uninstall.cmd
```

```sh
# macOS / Linux（安装并自动启用）
sh install.sh

# 卸载
sh uninstall.sh
```

也可直接调用跨平台管理脚本：

```bash
# 查看当前安装与运行状态（只读）
node manage.mjs status

# 安装到 ~/.gemini/config/plugins/agy-drag-graft 并默认在 config.json 启用插件与 Sidecar
node manage.mjs install

# 仅复制插件文件，不修改 config.json
node manage.mjs install --no-register-config

# 卸载（清理插件目录、已打开窗口内的拖拽钩子及 config.json 本插件条目；加 --keep-config 可保留配置）
node manage.mjs uninstall
```

### 调试端口前置说明

Antigravity Desktop `2.33.0+` 默认关闭渲染器调试端口，需在启动宿主时携带参数 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`（侧边栏插件通过本机回环 `127.0.0.1` DevTools 端口与页面通信）。若本机已通过 `agy-context-dashboard` 等插件配置好调试启动器，通常无需额外调整。

---

## 语法检查与离线打包

```bash
npm run check

# 生成离线安装 ZIP 包及 SHA256 校验文件（输出至 dist/）
node manage.mjs package
```

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
