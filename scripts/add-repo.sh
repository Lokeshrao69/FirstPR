#!/usr/bin/env bash
# Add any public GitHub repo to FirstPR.
# Requires: git, Python 3.10+, graphify (pip install graphifyy), Node 18+
# Usage: ./scripts/add-repo.sh https://github.com/owner/repo "Short description"
set -euo pipefail

URL="$1"
DESC="${2:-}"
SLUG="$(basename "$URL" .git)"
TMP="$(mktemp -d)"

echo ">> Cloning $URL"
git clone --depth 1 "$URL" "$TMP/$SLUG"

echo ">> Building Graphify knowledge graph (AST only, no LLM cost)"
(cd "$TMP/$SLUG" && graphify update .)

echo ">> Preparing FirstPR bundle"
node "$(dirname "$0")/prepare.mjs" "$TMP/$SLUG" "$SLUG" "$URL" "$DESC"

rm -rf "$TMP"
echo ">> Done. Commit data/$SLUG and data/repos.json, then redeploy."
