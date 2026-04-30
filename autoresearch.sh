#!/usr/bin/env bash
set -euo pipefail

bun --version >/dev/null
export NO_COLOR=1
export PI_NO_PTY=1

bun autoresearch/agent-latency-bench.ts
