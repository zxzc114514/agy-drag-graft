# AGY Drag Graft

[中文](README.md) | English

A standard plugin for **Antigravity Desktop (`agy`)**. Drag any historical conversation from the sidebar—or files and folders from the right-side file index (Workspace file tree, local Artifacts, directory viewer, and path breadcrumb menus)—directly into the composer input box to insert native reference chips (`contextScopeItemMention`), while suppressing the host split-view overlay only over the input box and preserving native split view, sidebar reordering, and clicks without modifying `app.asar`.

---

## Interaction Zones

| Drag Source | Drop Target | Behavior |
| --- | --- | --- |
| Sidebar conversation row | Composer input box (`[data-testid="agent-input-box"]`) | Shows a subtle dashed blue guide outline and "拖拽到此引用" badge across visible input boxes once dragging begins (>= 8 px), then intensifies the highlight and hides the host split overlay when hovering over the target input box; releasing cancels the host split drag and inserts a native session-reference chip |
| Right-side file index (file tree / local Artifact / directory viewer / breadcrumb dropdown) | Composer input box (`[data-testid="agent-input-box"]`) | Displays a width-adaptive drag preview card following the pointer and guides across visible input boxes, inserting a native `file` or `directory` reference chip on drop (and automatically dismissing breadcrumb popovers) |
| Sidebar conversation row | Conversation body / edge split hotzones | Immediately restores the host split overlay and passes events through for native Split View |
| Sidebar conversation row | Inside the sidebar | Passes events through to keep native reordering, grouping, and navigation |
| Inline row buttons / short clicks | Any target | Ignored by drag interception to preserve menus and session switching |

Built-in safeguards:
- **Self-reference guard**: Prevents dropping the currently active conversation into its own composer.
- **Draft deduplication**: Skips duplicate conversation, file, or directory chips in the same draft while allowing multiple distinct references to be dragged in sequentially.
- **Independent side-pane resolution**: Resolves target cascade IDs separately for the main window, subagent tabs, and Side Question panes.
- **Plugin isolation**: Runs via standard AGY `plugin.json` + isolated sidecar (`agy-drag-graft/bridge`) and `window.__agyDragGraft` namespace without conflicting with `agy-context-dashboard` or other plugins.

---

## Installation

All scripts have zero third-party dependencies (**Node.js 22+** only).

### Option 1: Ask Antigravity directly

```text
Please install and enable this Antigravity plugin: https://github.com/zxzc114514/agy-drag-graft
```

### Option 2: Download a Release Archive or Install from Source

Download the latest `agy-drag-graft-<version>.zip` (with `.zip.sha256` checksum) from [GitHub Releases](https://github.com/zxzc114514/agy-drag-graft/releases), extract it, and run the installer inside `agy-drag-graft`:

```bat
:: Windows (installs and enables automatically)
.\install.cmd

:: Uninstall (removes plugin directory, config entries, and active window hooks)
.\uninstall.cmd
```

```sh
# macOS / Linux (installs and enables automatically)
sh install.sh

# Uninstall
sh uninstall.sh
```

Cross-platform CLI via `manage.mjs`:

```bash
# Inspect installation and runtime status (read-only)
node manage.mjs status

# Install to ~/.gemini/config/plugins/agy-drag-graft and enable in config.json by default
node manage.mjs install

# Copy plugin files only without modifying config.json
node manage.mjs install --no-register-config

# Uninstall (cleans plugin directory, active window hooks, and config.json entries; pass --keep-config to keep config)
node manage.mjs uninstall
```

### Remote Debugging Port Requirement

Starting with Antigravity Desktop `2.33.0+`, the renderer remote debugging port is disabled by default. Launch Antigravity with `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` so the sidecar can attach over loopback DevTools. If you already use `agy-context-dashboard` with its debug launcher, this is typically already configured.

---

## Verification & Packaging

```bash
npm run check

# Build offline release ZIP and SHA256 checksum into dist/
node manage.mjs package
```

---

## License

Released under the [MIT License](LICENSE).
