# AGY Drag Graft

中文 | [English](README.en.md)

面向 **Antigravity Desktop (`agy`)** 的标准插件。将左侧历史会话直接拖入对话输入框，自动生成**原生会话引用胶囊**（`contextScopeItemMention`），并在悬停输入框期间精准隐藏宿主半屏分屏遮罩；同时完整保留对话区分屏、侧边栏排序与原生点击行为，不修改宿主 `app.asar`。

---

## 核心交互分区

| 拖拽起点 | 释放落点 | 结果 |
| --- | --- | --- |
| 左侧历史会话行 | 对话输入框（`[data-testid="agent-input-box"]`） | 仅在悬停输入框时显示蓝色虚线框与「拖拽到此引用」浮标并隐藏宿主半屏蓝罩；松手后取消本次分屏，在输入框插入原生会话引用胶囊 |
| 左侧历史会话行 | 对话正文 / 四周分屏热区 | 立即恢复宿主分屏遮罩并完全放行，保留 Antigravity 原生分屏（Split View） |
| 左侧历史会话行 | 侧边栏内部 | 完全放行，保留原有排序、分组或点击切换 |
| 行内操作按钮 / 短距离点击 | 任意位置 | 不触发拖拽引用，保留原有菜单与切换行为 |

内置保护：
- **自引用拦截**：拖入当前对话自身时弹窗提示并跳过，避免误引用当前会话。
- **草稿去重**：同一条草稿中不重复插入相同会话胶囊，支持连续拖入多条不同历史会话。
- **独立副栏识别**：支持主对话与辅助侧栏（子代理、Side Question）各自独立识别所属会话 ID。
- **插件隔离**：采用标准 AGY 插件目录与独立 Sidecar（`agy-drag-graft/bridge`）及 `window.__agyDragGraft` 命名空间，与 `agy-context-dashboard` 等其他插件互不冲突。

---

## 安装与启用

所有脚本均为零第三方依赖（仅需 **Python 3.10+** 与 **Node.js 20+**）。

### 方式一：发一句话让 Antigravity 自动安装

```text
帮我安装并启用这个 Antigravity 插件：https://github.com/zxzc114514/agy-drag-graft
```

### 方式二：下载 Release 压缩包或克隆后命令行安装

可从 [GitHub Releases](https://github.com/zxzc114514/agy-drag-graft/releases) 下载最新 `agy-drag-graft-<version>.zip`（附带 `.zip.sha256` 校验文件），解压后进入 `agy-drag-graft` 目录运行安装脚本：

```powershell
# Windows（PowerShell）
.\install.ps1

# 如需同时在 ~/.gemini/config/config.json 写入启用配置
.\install.ps1 -RegisterConfig
```

```sh
# macOS / Linux
sh install.sh

# 如需同时写入启用配置
sh install.sh --register-config
```

也可直接调用跨平台管理脚本：

```bash
# 查看当前安装与运行状态（只读）
python manage.py status

# 安装到 ~/.gemini/config/plugins/agy-drag-graft（默认不修改 config.json，可在客户端 Customizations 页面启用）
python manage.py install

# 安装并在 config.json 自动启用插件与 Sidecar
python manage.py install --register-config

# 卸载（加 --clean-config 同步移除 config.json 中的本插件键）
python manage.py uninstall --clean-config
```

### 调试端口前置说明

Antigravity Desktop `2.33.0+` 默认关闭渲染器调试端口，需在启动宿主时携带参数 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`（侧边栏插件通过本机回环 `127.0.0.1` DevTools 端口与页面通信）。若本机已通过 `agy-context-dashboard` 等插件配置好调试启动器，通常无需额外调整。

---

## 技术方案对比

| 维度 | DSH 原生插件模式 | `agy-drag-graft`（Antigravity 插件模式） |
| --- | --- | --- |
| 插件载体 | 依赖宿主公开的客户端模块表与前端插槽 | 标准 `plugin.json` + Sidecar + 本机回环 CDP 注入（不修改 `app.asar`） |
| 拖拽事件来源 | HTML5 `dragstart` / `drop` | React 指针拖拽（`pointerdown` / `pointermove` / `pointerup`）+ `elementsFromPoint` 穿透浮层 |
| 分屏遮罩处理 | 宿主扩展点可控 | 仅在指针命中输入框时动态挂载属性压制宿主半屏蓝罩，移出即刻恢复 |
| 引用插入方式 | 触发 `@` 候选菜单 | 直接调用编辑器挂载的 `__lexicalEditor` 构造 `contextScopeItemMention` 原生节点 |

---

## 自动化测试与离线打包

```bash
npm run check
python -m unittest discover -s tests -p "test_*.py" -v

# 生成离线安装 ZIP 包及 SHA256 校验文件（输出至 dist/）
python manage.py package
```

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
