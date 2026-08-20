#!/usr/bin/env bash
# P3 (D-fixture-corpus): "package-install tests" from CATALOG.md's own concrete approach for this
# item. `npm pack` -> install the real tarball into a throwaway scratch dir -> run the installed
# `bskel` binary from PATH, not `node bin/bskel.mjs` -- every other test in this suite invokes the
# CLI by path, so this is the only place a missing `bin` entry, a broken shebang, or a runtime
# asset left out of the published tarball (schemas/*.json, handles/providers/*/templates/*.tmpl,
# scripts/preflight-base-ref.sh, stack/catalog/*.yml) would ever actually surface.
#
# WHY bash, matching scripts/preflight-base-ref.sh's own precedent: no package deps, runs
# identically in CI and locally, and this needs nothing this project's Node code doesn't already
# assume (git/node -- npm itself is a Node-ships-with-it dependency, not a new one).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "pack-install-smoke: npm pack..."
cd "$REPO_ROOT"
TARBALL="$(npm pack --silent --pack-destination "$SCRATCH")"
TARBALL_PATH="$SCRATCH/$TARBALL"

echo "pack-install-smoke: installing $TARBALL into a scratch project (never the global npm store)..."
INSTALL_DIR="$SCRATCH/install"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm init --yes --silent >/dev/null
npm install --silent "$TARBALL_PATH"

BSKEL="$INSTALL_DIR/node_modules/.bin/bskel"
if [ ! -x "$BSKEL" ]; then
	echo "pack-install-smoke: FAIL -- $BSKEL was not created or is not executable (bin entry / shebang problem)" >&2
	exit 1
fi

echo "pack-install-smoke: bskel --version..."
VERSION_OUT="$("$BSKEL" --version --json)"
echo "$VERSION_OUT" | grep -q '"name":"bskel"' || { echo "pack-install-smoke: FAIL -- --version --json missing expected shape: $VERSION_OUT" >&2; exit 1; }

echo "pack-install-smoke: bskel doctor --json inside a throwaway git repo (exercises the installed schemas/templates/scripts)..."
WORKDIR="$SCRATCH/workdir"
mkdir -p "$WORKDIR"
cd "$WORKDIR"
git init --quiet --initial-branch=develop
git config user.email test@example.com
git config user.name Test
DOCTOR_OUT="$("$BSKEL" doctor --json)"
echo "$DOCTOR_OUT" | grep -q '"checks"' || { echo "pack-install-smoke: FAIL -- doctor --json produced unexpected output: $DOCTOR_OUT" >&2; exit 1; }

echo "pack-install-smoke: PASS -- installed tarball's bskel binary runs and its runtime assets resolve."
