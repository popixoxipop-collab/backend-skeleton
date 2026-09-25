# T23 release / migration runbook

Status: **prepared, blocked for promotion**. T00-01 is currently submitted and the T00-04 interface is still pre-freeze. This runbook may be reviewed and tested, but it does not authorize a default-writer change, production DB migration, package allowlist change, workflow change, or release.

## Invariants

1. Contract/action/field meaning comes from immutable bskel contract bytes; runtime approval comes from the beval profile/run binding. Display names do not repair either side.
2. Existing HTTP v9/webgame contract bytes and historical beval evidence remain readable throughout migration.
3. A package is tested from its packed artifact, not only from repository source.
4. New readers land before new default writers. Shadow output never becomes trusted execution input merely because it exists.
5. DB evolution is additive for evidence/history. Destructive down migrations are not a rollback mechanism.
6. Exact integration SHAs and exact-head checks are required; an older green workflow run cannot approve a newer head.
7. A T00 coordination baseline and current repository main are different concepts. T23 records drift but never silently rewrites T00's accepted/submitted baseline.

## M0 - compatibility inventory

Record exact SHAs, package versions, Node floors, published files, CLI names, vendored schemas, generated-app assets, DB migration/read paths, package-install smoke commands, and exact-head CI state. Re-run this inventory whenever any input changes.

Current snapshot is `compatibility-inventory.json`. A queued/in-progress current-head CI run is a valid observation but is not a release pass. The inventory therefore remains structurally valid while `release-policy.mjs` derives `CURRENT_MAIN_CI_NOT_GREEN`.

### Coordination baseline drift

T23 stores both:
- the T00 coordination baseline, which only T00 can accept/rebaseline;
- observed current `main` for each repository.

If any current head differs from the coordination baseline, `COORDINATION_BASELINE_DRIFT` blocks release. T23 does not update the coordination baseline to make the blocker disappear. T00 must issue/accept a new epoch.

At the current snapshot, becoder main advanced from T00 epoch-3 `a575679b...` to `37ffb1d8...`; its exact-head push CI is green. beval main is `7a04cb70...` but its current exact-head push CI was queued when captured. These are observations, not promotion approvals.

## M1 - consumer first

Before a next writer is enabled, becoder and beval must read the new family/revision without weakening old readers. A new reader may ship disabled or additive. Old artifacts are replayed byte-for-byte and their existing hash/ref meaning must remain unchanged.

Rollback: disable the next reader path. Do not rewrite historical contract/evidence bytes.

## M2 - shadow producer

The producer may emit a separately named shadow artifact in addition to stable output. Shadow artifacts are not silently selected for codegen or runtime. Compare stable and shadow semantics with explicit diagnostics; unresolved critical conflicts keep the next path blocked.

Rollback: stop producing shadow artifacts. Keep existing shadow bytes as audit evidence if already referenced by a submitted result.

## M3 - explicit opt-in writer

Enable the next writer only for an explicitly admitted profile and exact package matrix. Generation must use approved framework/persistence combinations only. Historical readers stay installed or available for rollback.

Rollback: turn the profile off; return the affected path to the previous writer and make any next-only data read-only. An old writer must not overwrite next artifacts.

## M4 - per-profile default

A next writer becomes default only for a profile with evidence-backed certification. Other profiles remain on their previous writer. A global switch is not implied by one framework passing.

Rollback: restore the previous package combination and profile switch, invalidate the semantic cache namespace/revision, retain all historical artifacts, and leave DB history intact.

## Packed-package release checks

Run the package-declared installation smoke for each exact candidate package:

```text
bskel:   npm run test:pack
becoder: npm run test:pack
beval:   npm run test:pack
```

Then run the relevant compatibility/integration commands from checked-in package scripts. Do not replace these with source-entrypoint execution as the sole release proof because that misses npm files, executable bits, vendored schemas, templates, renderers, migrations, and other runtime assets.

## Database rules

beval migrations and historical run/evidence rows are audit state. Add new revision/snapshot columns or tables additively, keep old readers until replay is proven, and mark evidence lacking historical bytes as legacy/unbound rather than manufacturing a current binding for it. Test migrations on disposable DBs with old and new readers.

Rollback is feature-off/read-only/old-reader first. A destructive down migration that deletes or reinterprets historical evidence is prohibited by `release-plan.json` and rejected by `release-policy.mjs`.

## CI lane activation

T23-01/T23-02 deliberately do **not** modify `.github/workflows`. T23-03 may add or reshape PR-cheap, crossrepo, nightly, runtime, native, and release lanes only after T00-04 final freeze plus T19/T20 prerequisites.

Untrusted pull-request code must not gain privileged self-hosted secrets via `pull_request_target`. Every release decision binds checks to exact final integration SHAs. Queued/skipped/missing jobs are not successes; a green result from an older head is not reusable after code changes.

## Recorded cross-track change requests

The following requests are acknowledged but intentionally not implemented before T00-04 / an integration lease:

- common nested-test discovery so T02 `test/project-graph/**/*.test.mjs` and T19 `test/conformance-next/**/*.test.mjs` do not require root shims;
- package allowlist additions requested by T15/T17/T22;
- any stable workflow or package/default writer integration.

Until the lease is issued, tracks continue to run their nested suites explicitly and must not represent a pre-existing root CI success as proof that those suites executed.

## Rehearsal checklist

- install previous and candidate packed packages in separate scratch consumers;
- replay at least one historical HTTP contract and webgame contract through old/new readers;
- replay an existing historical beval run/report without consulting mutable current-case meaning;
- produce shadow next artifacts into a separate namespace;
- switch an admitted profile to next and back without rewriting previous artifacts;
- invalidate next semantic caches during rollback;
- confirm old writer cannot overwrite next artifacts;
- confirm database history survives rollback unchanged;
- force one missing/failed required lane and verify release remains blocked;
- advance one repository main beyond the T00 coordination baseline and verify drift blocks release without mutating the baseline.

Record exact commands, exit codes, hashes, package tarball names, run IDs, and cleanup results. A narrative "rollback worked" is insufficient evidence.
