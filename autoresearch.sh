#!/usr/bin/env bash
set -euo pipefail
script_path="${BASH_SOURCE[0]:-$0}"
script_dir="${script_path%/*}"
if [ "$script_dir" = "$script_path" ]; then
	script_dir="."
fi
cd "$script_dir"

bun scripts/autoresearch-effect-ai.ts
