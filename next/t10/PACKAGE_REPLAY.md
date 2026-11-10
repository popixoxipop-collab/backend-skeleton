# T10-06 bounded package replay candidate

This opt-in rehearsal fills only the local package rollback/replay evidence gap.
It does not modify root commands, package files, provider defaults, historical
receipts, the release inventory or the official task ledger. T00-04 remains a
separate prerequisite. No MET, promotion approval, publication, DB runtime,
independent attestation or operational release is awarded by this tool.

## Exact source and retained packages

Use trusted, reviewed Git objects and a reviewed harness. Build performs no fetch.
The recorded rehearsal uses actual previous commit
`0ed446344c36ec500d54a59c41ecd8ca72cfc842` (tree
`92ce05bb6c6a291bdd18c6d9ea5a2b1538d29bf9`), the parent of the genuine T10-05
consumer introduction, and the later historical candidate snapshot
`9117a6f3f5dd03fdbb5dbd6221f5315971e66af7` (tree
`71a934fac01ef05835d235e36fcbc71c671a4919`). The previous is an ancestor of
current main. Both identify package version 1.9.0 but different actual bytes.
They are exact existing repository snapshots, not manufactured release history
or proof that either archive was publicly published.

In the original author environment, the previous archive SHA-256 was
`11937358d56ba43cf298796d94444edca3296d65139bc185bffa9da52b631f98`.
The original candidate archive SHA-256 was
`e9ca7fddd795a0bc7d86d42d4e8a4d826ea67dd584ef6095cb80c1cdc18c7b95`.
These are observations from that packer, not portable byte pins: Bob's Node
26.7.0/npm 11.19.0 produced a candidate archive hash of
`f1969d2e528bdd3fbecc8ecb051b76e8d5e0411fa4770e38fc0f42698d04025a`
while the pinned Git-derived member inventory and installed 416/418/416
path/byte/mode comparison passed. Every replay still requires an external pin
for its own complete bundle manifest and checks each retained archive against
that manifest before installation. A different compressed archive hash alone
does not establish a source or installed-package difference.

## Reproduce

```sh
npm_config_cache=/path/to/warm/cache node next/t10/package-replay.mjs build \
  --repo /trusted/repo \
  --previous 0ed446344c36ec500d54a59c41ecd8ca72cfc842 \
  --candidate 9117a6f3f5dd03fdbb5dbd6221f5315971e66af7 \
  --output /new/bundle

npm_config_cache=/path/to/warm/cache node next/t10/package-replay.mjs replay \
  --bundle /new/bundle --manifest-sha256 <independently-retained-digest> \
  --output /new/run

T10_REPLAY_BUNDLE=/new/bundle T10_TEST_OUTPUT=/new/test-output \
  npm_config_cache=/path/to/warm/cache node --test next/t10/package-replay.test.mjs
```

The replay CLI requires an external manifest digest. The editable digest file
inside the bundle is not an independent trust anchor. The acceptance test reads
that file as a development fixture; it is not an approval mechanism. Existing
output directories are refused, and command stdout/stderr, exits and signals are
retained. Build/replay failures exit 2; failing node tests exit 1.

## What runs

All npm operations use offline and ignore-scripts. Every source package member
is compared to its exact Git blob, size and POSIX mode. Full installed inventory
includes every path, byte hash, size and mode, not only expected paths. npm marks
package.json-declared bins executable; the manifest records both source/packed
mode and the separately derived installed mode. In this snapshot the T11 bin is
0644 in Git/archive and 0755 after npm installation. This expected npm change is
not hidden or treated as source byte drift.

Replay installs previous, current, then reinstalls previous in one disposable
consumer. The 416/418/416 inventories prove that both current-only T10 files
(observe-cli.mjs and T10_05_CROSS_INTEGRATION.md) disappear on rollback.
Installed first-party APIs exercise registry scanning, physical key mapping,
unknown provider rejection and source-only certification refusal. The current
installed consumer also runs all eight T10-05 modes: three registry providers,
three real legacy adapters and the actual Rails/Eloquent T07 fact producers.
The authored T10-05 fixtures are reused, not represented as independent holdout.
Each fixture's full path/type/mode/byte inventory is unchanged afterward.

Negative tests reject missing/wrong pins, corrupt archives, unsafe and duplicate
paths, invalid modes, substituted harnesses, authority flags and symlink archive
inputs. Real installed-inventory hash/mode/extra-member mismatch triggers actual
baseline reinstall but preserves failed status. The controlled fault mode
`candidate-probe-sigterm` terminates the actual installed-API probe after its first
Prisma scan. A living parent catches that child failure and restores baseline;
it does not simulate an interrupted npm transaction or a killed parent.

## Limits and remaining gates

This is package reinstall, not atomic running-service rollback, DB rollback,
zero-downtime deployment, process crash durability or power-loss recovery.
No live DB, remote service, public-network test, external SDK or install script
runs. Cached transitive dependencies and host Git/Node/npm are trusted; there is
no hermetic dependency closure. All child commands are bounded by timeouts.
Node-version execution evidence describes these exact hosts only; npm engine
warnings, if any, are retained and are not a general compatibility certificate.

Independent review, required exact-head CI, protected merge, merged-tree replay,
T00-04 dependency resolution and official scoped adjudication remain separate.
The missing official T10 release-inventory admission and historic STATUS staleness
are not edited here. Unsupported/unknown targets stay unsupported. Every bundle
and replay receipt keeps release_authorized=false, runtime_certified=false and
publication_performed=false.
