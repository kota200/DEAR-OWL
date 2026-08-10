#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
port=${1:-8766}

case "$port" in
  *[!0-9]*|'')
    echo "Usage: sh start-local.sh [port]" >&2
    exit 2
    ;;
esac

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$script_dir/scripts/serve-local.py" "$port"
fi

if command -v python >/dev/null 2>&1 &&
   python -c 'import sys; raise SystemExit(0 if sys.version_info.major >= 3 else 1)' >/dev/null 2>&1; then
  exec python "$script_dir/scripts/serve-local.py" "$port"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$script_dir/scripts/serve-local.mjs" "$port"
fi

echo "DEAR-OWL needs Python 3 or Node.js to start its local web server." >&2
echo "Install either runtime, then run: sh start-local.sh" >&2
exit 1
