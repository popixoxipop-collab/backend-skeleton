# T09-06 bounded installed-package replay

`node --test test/reconciliation-next/package-replay.test.mjs` rehearses a
historical T09 package transition. It is opt-in and changes only freshly
allocated disposable consumers. It does not modify stable scanner dispatch,
publish npm bytes, activate the T09 policy, or approve a release.

The previous snapshot is exact Git commit
`271d5d747d7ef99fb7ce990a95db32fbdf4e46bd` (tree
`c5f1da277f3858cc93cefa8b6c3c0d5956b23e07`), immediately before the
merge that introduced `contracts/reconciliation-next/**`. The candidate is
merged main `632e0a7012180274d2205f4f69e0fc3e41b003f6` (tree
`05e7403a9967c75f7e9a40d4633786e06a03ee58`). Both declare package
version 1.9.0, but are different actual package bytes. Neither is claimed to
be a public npm release. The test pins each full historical lockfile and
requires identical 21 transitive lock entries. npm pack and install are
offline with scripts disabled and transitive versions overridden from the
lock. A warmed cache, Git history, Node and npm are prerequisites.

Every packed member is compared with its exact Git blob, size and POSIX mode.
The consumer installs previous → candidate → previous and checks the full
installed first-party path, byte, size and mode inventory after each stage.
Both versions run the installed stable Spring scanner. The candidate also
imports the **installed** T09 ArtifactRef, binding and readiness modules. Its
source/spec readiness is true for exact artifacts, false for a revision
mismatch, and runtime readiness stays false. `advisoryOnly=true` and
`stableCapabilityWire=false` are asserted. The previous package lacks that
module again after rollback.

A second run sends `SIGTERM` to the candidate probe after it has checked the
readiness boundary. A surviving parent reinstalls the previous package and
retains a failed interruption receipt. This tests the rollback orchestration,
not an interrupted npm transaction or parent crash.

To retain the exact artifacts, use a **new** absolute directory:

```sh
T09_REPLAY_OUTPUT_DIR=/new/evidence-directory \
  node --test test/reconciliation-next/package-replay.test.mjs
```

The directory contains `previous.tgz`, `candidate.tgz`, `manifest.json`,
`manifest.sha256`, `normal-receipt.json` and `fault-receipt.json`. Retain the
complete manifest SHA-256 independently; its editable in-directory digest
file is not an external trust anchor. Compressed tarball hashes can vary with
npm packer, so the Git-bound member and installed inventories are the portable
comparison.

## Limits

This is package reinstall, not atomic running-service rollback, deployment,
process-crash or power-loss durability. The fixture inputs are authored
regression data, not independent source/OpenAPI/runtime observations. The
runtime evidence path is intentionally unbound, and T09 does not feed T03
capability certification. No target framework, server, DB, external corpus or
network service runs. The package declares Node `>=18`; CI execution on Node
22/24 and any additional replay host records only those exact environments,
not the complete declared range. T09 remains shadow/advisory, and
`release_authorized`, `runtime_certified`, and `publication_performed` remain
false. A strict interpretation requiring policy activation or live service
rollback remains PARTIAL, and T00/T23 release gates remain separate.
