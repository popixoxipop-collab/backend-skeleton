# Legacy C PR #62 -> T23 reconciliation

Status: **read-only ownership reconciliation**. No file from draft PR #62 is cherry-picked by this T23 branch.

T00 assigns Legacy C by semantic ownership, not by file history. The draft PR contains:

| PR #62 file | Canonical owner | T23 disposition |
|---|---|---|
| `webgame/fingerprint.mjs` | T21 | freshness/cache input; do not duplicate in T23 |
| `webgame/receipts.mjs` | T19 + T21 | evidence validity/freshness; T23 consumes approved result only |
| `webgame/performance.mjs` | T19 | conformance/performance evidence; T23 does not own the metric evaluator |
| `schemas/webgame-performance-profile.schema.json` | T19 | no T23 copy |
| `webgame/release-policy.mjs` | **T23** | semantic input: fresh required runtime, newer failure/incomplete attempt, profile digest, performance/gate result can block release |
| `schemas/webgame-release-policy.schema.json` | **T23** after T00-04 | vocabulary candidate only; do not publish stable schema yet |
| `webgame/gate-definitions.mjs` | T23/T00 integration surface | candidate gate naming only; no stable global gate wiring before lease |
| `lib/gate-profiles.mjs` | **T23/T00 shared hot file** | never cherry-pick directly; requires exact-file integration lease |
| `test/webgame-evidence.test.mjs` | split by semantics | evidence/freshness/performance assertions go T19/T21; release blocking cases inform T23 regressions |

## What T23 already absorbed semantically

The current `release/next/release-policy.mjs` already enforces the release-level properties needed by the scale program:

- a release cannot proceed while required prerequisites/blockers remain;
- exact current repository heads and exact-head CI are release inputs;
- T00 coordination-baseline drift blocks release instead of being silently normalized;
- migration order is consumer-first -> shadow -> opt-in writer -> per-profile default;
- destructive DB rollback/evidence deletion and old-writer overwrite are rejected;
- privileged untrusted PR execution is rejected;
- packed-package installation checks are mandatory.

These rules are broader than Legacy C's webgame-only release helper and are intentionally kept in T23's isolated `release/next/**` namespace until integration approval.

## Unique Legacy C behavior to preserve for later T23 profile design

When a concrete webgame release profile is admitted after T00-04, preserve these ideas from PR #62 without copying evidence ownership:

- require a fresh runtime attestation when the profile requires runtime;
- block if a newer assertion failure exists than the last valid attestation;
- treat a newer blocked/unsupported/not-run attempt as incomplete verification;
- bind approval to the exact profile digest;
- require performance evidence only when the profile declares it required;
- consume an approved gate-profile result rather than recomputing T19/T21 evidence semantics inside T23.

T23 must consume immutable evidence references produced by canonical owners. It must not make a stale receipt fresh, calculate T19 performance truth, or redefine T21 fingerprints.

## Deferred integration

No `lib/gate-profiles.mjs`, stable schema, package manifest, CLI, workflow or default flag is modified here. The next implementation step requires T00-04 final freeze plus an exact-file lease.
