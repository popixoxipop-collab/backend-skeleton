#!/usr/bin/env bash
# Rebuilds docs/demo.gif for real: fresh fixture repo, real `bskel` binary, real vhs recording.
# Requires `vhs` (https://github.com/charmbracelet/vhs) on PATH -- `brew install vhs`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE=/tmp/bskel-demo-fixture
BIN_SHIM=$(mktemp -d)

rm -rf "$FIXTURE"
mkdir -p "$FIXTURE"
cp -r "$REPO_ROOT/test/fixtures/java-spring/." "$FIXTURE/"

cd "$FIXTURE"
git init --quiet --initial-branch=main
git config user.email "demo@example.com"
git config user.name "demo"
printf 'specs/\n.sbf/\nbuild/\n.gradle/\n' > .gitignore
git add -A
git commit --quiet -m "chore: fixture"
BARE_ORIGIN=$(mktemp -d)
git init --quiet --bare --initial-branch=main "$BARE_ORIGIN"
git remote add origin "$BARE_ORIGIN"
git push --quiet origin main
git remote set-head origin main

cat > "$BIN_SHIM/bskel" <<EOF
#!/bin/sh
exec node "$REPO_ROOT/bin/bskel.mjs" "\$@"
EOF
chmod +x "$BIN_SHIM/bskel"

cd "$REPO_ROOT"
PATH="$BIN_SHIM:$PATH" vhs docs/demo.tape

rm -rf "$BIN_SHIM" "$BARE_ORIGIN" "$FIXTURE"
echo "docs/demo.gif regenerated."
