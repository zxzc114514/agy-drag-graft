#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1; then
  echo "Node.js 22+ is required to uninstall AGY Drag Graft safely." >&2
  exit 1
fi
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$task_root/manage.mjs" uninstall "$@"
