#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install or upgrade Node.js, then run this script again." >&2
  exit 1
fi
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$task_root/manage.mjs" install "$@"
