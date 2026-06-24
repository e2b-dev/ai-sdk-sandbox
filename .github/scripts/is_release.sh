#!/usr/bin/env bash
# Prints "true" when there are pending changesets to release, "false" otherwise.
# Used by the Release workflow's preflight job to gate the publish.
set -euo pipefail

count=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')

if [ "$count" -gt 0 ]; then
  echo "true"
else
  echo "false"
fi
