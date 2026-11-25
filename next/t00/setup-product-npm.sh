#!/usr/bin/env bash
set -euo pipefail

toolchain=$(mktemp -d "$RUNNER_TEMP/t00-npm.XXXXXXXX")
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 40 \
  https://registry.npmjs.org/npm/-/npm-11.19.0.tgz --output "$toolchain/npm.tgz"
expected='SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw=='
actual=$(openssl dgst -sha512 -binary "$toolchain/npm.tgz" | openssl base64 -A)
test "$actual" = "$expected"
tar --extract --gzip --file "$toolchain/npm.tgz" --directory "$toolchain" --no-same-owner
mkdir "$toolchain/bin"
ln -s "$toolchain/package/bin/npm-cli.js" "$toolchain/bin/npm"
rm "$toolchain/npm.tgz"
printf '%s\n' "$toolchain/bin" >> "$GITHUB_PATH"
