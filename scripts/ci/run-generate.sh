#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ]; then
  set -- node scripts/generate.mjs --baseline-dir . --out .tmp/out
fi
set +e
"$@"
code=$?
set -e
echo "exit_code=$code" >> "$GITHUB_OUTPUT"
if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
  echo "::error::generator failed with exit code $code"
  exit "$code"
fi
