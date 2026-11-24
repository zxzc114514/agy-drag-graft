# AGY Drag Graft

[中文](README.md) | English

A standard plugin for **Antigravity Desktop (`agy`)**. Drag any historical conversation from the sidebar directly into the composer input box to insert a native session-reference chip (`contextScopeItemMention`), while suppressing the host split-view overlay only over the input box and preserving native split view, sidebar reordering, and clicks without modifying `app.asar`.

---

## Interaction Zones

| Drag Source | Drop Target | Behavior |
| --- | --- | --- |
| Sidebar conversation row | Composer input box (`[data-testid="agent-input-box"]`) | Shows a subtle dashed blue guide outline and "拖拽到此引用" badge across visible input boxes once dragging begins (>= 8 px), then intensifies the highlight and hides the host split overlay when hovering over the target input box; releasing cancels the host split drag and inserts a native session-reference chip |
| Sidebar conversation row | Conversation body / edge split hotzones | Immediately restores the host split overlay and passes events through for native Split View |
| Sidebar conversation row | Inside the sidebar | Passes events through to keep native reordering, grouping, and navigation |
| Inline row buttons / short clicks | Any target | Ignored by drag interception to preserve menus and session switching |

Built-in safeguards:
- **Self-reference guard**: Prevents dropping the currently active conversation into its own composer.
- **Draft deduplication**: Skips duplicate session chips in the same draft while allowing multiple distinct sessions to be dragged in sequentially.
- **Independent side-pane resolution**: Resolves target cascade IDs separately for the main window, subagent tabs, and Side Question panes.
- **Plugin isolation**: Runs via standard AGY `plugin.json` + isolated sidecar (`agy-drag-graft/bridge`) and `window.__agyDragGraft` namespace without conflicting with `agy-context-dashboard` or other plugins.

---

## Installation

All scripts have zero third-party dependencies (**Python 3.10+** and **Node.js 20+** required).

### Option 1: Ask Antigravity directly

```text
Please install and enable this Antigravity plugin: https://github.com/zxzc114514/agy-drag-graft
```

### Option 2: Download a Release Archive or Install from Source

Download the latest `agy-drag-graft-<version>.zip` (with `.zip.sha256` checksum) from [GitHub Releases](https://github.com/zxzc114514/agy-drag-graft/releases), extract it, and run the installer inside `agy-drag-graft`:

```powershell
# Windows (PowerShell)
.\install.ps1

# Also enable plugin & sidecar in ~/.gemini/config/config.json
.\install.ps1 -RegisterConfig
```

```sh
# macOS / Linux
sh install.sh

# Also enable plugin & sidecar in config.json
sh install.sh --register-config
```

Cross-platform CLI via `manage.py`:

```bash
# Inspect installation and runtime status (read-only)
python manage.py status

# Install to ~/.gemini/config/plugins/agy-drag-graft (does not modify config.json by default)
python manage.py install

# Install and enable in config.json
python manage.py install --register-config

# Uninstall (add --clean-config to also remove entries from config.json)
python manage.py uninstall --clean-config
```

### Remote Debugging Port Requirement

Starting with Antigravity Desktop `2.33.0+`, the renderer remote debugging port is disabled by default. Launch Antigravity with `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` so the sidecar can attach over loopback DevTools. If you already use `agy-context-dashboard` with its debug launcher, this is typically already configured.

---

## Verification & Packaging

```bash
npm run check
python -m unittest discover -s tests -p "test_*.py" -v

# Build offline release ZIP and SHA256 checksum into dist/
python manage.py package
```

---

## License

Released under the [MIT License](LICENSE).
