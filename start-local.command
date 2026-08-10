#!/bin/sh
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /bin/sh "$script_dir/start-local.sh" "$@"
