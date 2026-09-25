# T23 - release, migration, operations

This directory is the isolated T23 implementation surface for the scale plan. It does not change the existing bskel CLI, package manifest, stable schemas, database, or GitHub workflows.

Current slice:

- `compatibility-inventory.json` - pinned three-repository install/schema/generated-app/DB-reader inventory for T23-01.
- `release-plan.json` - fail-closed staged rollout and rollback policy. `release_allowed` is deliberately false while prerequisites remain unaccepted.
- `release-policy.mjs` - dependency-free verifier for the inventory and plan.
- `test/release-policy.test.mjs` - negative regressions for packed-package omission, mutable refs, premature promotion, migration order, destructive rollback, overwrite, and privileged PR execution.
- `migration-runbook.md` - T23-02 consumer-first -> shadow -> opt-in writer -> per-profile default procedure.

Run locally:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json
```

The verifier validates this release-control slice only. It does not prove the product suites passed, that PR #65 was accepted, or that a runtime/profile is safe to promote.
