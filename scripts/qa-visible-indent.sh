#!/usr/bin/env bash
# Run automated checks and print a manual checklist for NotePlan-style visible indent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Vitest: leading whitespace must not use replace widgets =="
npm test -- --run src/live-preview-indent-visible.test.ts

echo ""
echo "== Manual pass (npm run dev) =="
echo "Paste the block from scripts/indent-manual-fixtures.txt into a note, then verify:"
echo "  1. You see literal tab/space width at the start of each non-top-level line."
echo "  2. Caret can move into that leading whitespace and edit it."
echo "  3. ArrowUp/ArrowDown preserves column through indented and wrapped lines."
echo "  4. Tab: with a multi-line selection, every line gains leading \\t; on one list/heading line, Tab nests at line start (or at caret if caret is inside the indent run). Shift-Tab dedents similarly."
echo "  5. List markers (icons / ordered label) still show; blockquote bar still shows."
echo ""
