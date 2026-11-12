# T11-06 bounded installed-package replay

`node --test next/t11/package-replay.test.mjs` rehearses one historical
installed-package transition without activating the HTTP modernization. It
changes only newly allocated, disposable consumers. It does not publish a
package, change a production service, edit the official ledger, or authorize
any release.

The exact previous Git commit is
`db29fc35d1bfc37b1a948b4be2df8517a230aa95` (tree
`cc0e96f5e4ac11def5077ebfdef6b7dc4a96f8ef`), before the T11 observation
CLI. The exact candidate is merged main commit
`1e73710d5672f1f01d76dcf0f9d6fc19d2a529b6` (tree
`8b91df6b2df309afd3fd91102d324685e6d78ea6`). They are authentic
ancestor/descendant snapshots, both package version 1.9.0 but with different
bytes. Neither is asserted to be a public npm release. Their full lockfile
SHA-256 values are hard-coded in the test, and all 21 transitive lock entries
must agree. npm is run offline with scripts disabled and locked overrides;
its warmed cache remains a trusted prerequisite, not a hermetic closure.

For each snapshot the test checks every packed member against its exact Git
blob, size and mode. It pins both tarballs in a complete manifest, then
installs previous, candidate and previous again in one disposable consumer.
Every installed first-party path, byte hash, size and mode is compared with the
source-derived inventory. npm's executable-mode change for declared bins is
accounted for. The installed scanner runs the five committed legacy adapter
fixtures. The candidate's installed observation CLI is exercised on each
report, with baseline, semantic-digest and fail-closed authority assertions.
The CLI must be absent again after rollback. A second run sends `SIGTERM` to
the candidate probe after its first adapter and verifies that the surviving
parent reinstalls the previous package. The injected failure is retained as a
failed receipt, not passed off as a successful promotion.

To retain the exact rehearsal artifacts, choose a **new** absolute directory:

```sh
T11_REPLAY_OUTPUT_DIR=/new/evidence-directory \
  node --test next/t11/package-replay.test.mjs
```

The directory contains `previous.tgz`, `candidate.tgz`, `manifest.json`,
`manifest.sha256`, `normal-receipt.json` and `fault-receipt.json`. The manifest
hash is useful only when retained independently of the editable directory;
the in-directory digest is not an external trust anchor. Tarball SHA-256 can
vary across npm packers; the Git-bound full member and installed inventories
are the portable comparison. The test requires local historical Git objects,
Node, npm and a warmed cache and never fetches missing packages.

## Support and authority boundary

The package declares Node `>=18`. Required GitHub CI runs the nested T11 suite
on Linux Node 22 and 24. This rehearsal also records its actual host Node/npm
identity. Those are observations, not a certification of every declared Node
version or of Java/Spring, Ruby/Rails, Python/FastAPI, TypeScript/Express or
JavaScript/Express application runtimes. The five committed fixtures are
authored regression data, not an independent external corpus. The existing
T11 integration record still has no framework support/certification record.
No target app dependencies, server, DB or public network are exercised.

This proves only package-level reinstall and replay with a surviving parent.
It does not prove atomic live-service rollback, crash/power-loss recovery,
interrupted npm transaction handling or zero-downtime cutover. The existing
legacy scanner remains authoritative; `apply_allowed`, `promotion_allowed`,
`release_authorized`, `runtime_certified` and `publication_performed` stay
false. A broader interpretation of T11-06 or a T23 release still requires
separate evidence and must not be promoted by this test.
