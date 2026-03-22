#!/bin/bash
# Copies latest sales.json to docs/ and pushes to GitHub.
# Called after the collector runs to keep the live site fresh.

cd "$(dirname "$0")/.." || exit 1

cp data/sales.json docs/data/sales.json

# Only push if data actually changed
if git diff --quiet docs/data/sales.json 2>/dev/null; then
  echo "[push-data] No changes to push"
  exit 0
fi

git add docs/data/sales.json docs/data/img/
git commit -m "update sales data $(date '+%Y-%m-%d %H:%M')"
git push origin main
echo "[push-data] Pushed updated sales data"
