#!/usr/bin/env bash
set -euo pipefail

docker_bin="$(command -v docker || true)"
if [[ -z "$docker_bin" && -x /opt/homebrew/bin/docker ]]; then
  docker_bin=/opt/homebrew/bin/docker
fi

if [[ -z "$docker_bin" ]]; then
  echo "docker CLI is not installed or not on PATH" >&2
  exit 1
fi

if "$docker_bin" info >/dev/null 2>&1; then
  echo "docker daemon is ready"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "docker daemon is unavailable; automatic recovery is only configured for the macOS self-hosted runner" >&2
  exit 1
fi

colima_bin="$(command -v colima || true)"
if [[ -z "$colima_bin" && -x /opt/homebrew/bin/colima ]]; then
  colima_bin=/opt/homebrew/bin/colima
fi

if [[ -z "$colima_bin" ]]; then
  echo "colima is not installed or not on PATH" >&2
  exit 1
fi

# launchd-started GitHub runners do not source the user's shell profile. Keep Homebrew's
# directory available both to Colima itself (for limactl) and to later workflow steps.
colima_dir="$(dirname "$colima_bin")"
export PATH="$colima_dir:$PATH"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$colima_dir" >> "$GITHUB_PATH"
fi

echo "docker daemon is unavailable; starting Colima"
"$colima_bin" start

for _ in $(seq 1 30); do
  if "$docker_bin" info >/dev/null 2>&1; then
    echo "docker daemon recovered through Colima"
    exit 0
  fi
  sleep 2
done

echo "docker daemon did not become ready within 60 seconds after starting Colima" >&2
exit 1
