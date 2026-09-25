# T23 - release, migration, operations

This directory is the isolated T23 implementation surface for the scale plan. It does not change the existing bskel CLI, package manifest, stable schemas, database, package allowlists, release defaults, or GitHub workflows.

Current slice:

- `compatibility-inventory.json` - separates the submitted T00 coordination baseline from observed current repository mains and their exact-head CI state.
- `release-plan.json` - fail-closed staged rollout and rollback policy. `release_allowed` remains false while prerequisites/drift exist.
- `release-policy.mjs` - dependency-free structural verifier plus derived release blockers for unaccepted baseline, coordination drift, and non-green current-main CI.
- `test/release-policy.test.mjs` - regressions for packed-package omission, mutable refs, stale release plans, CI/head mismatch, hidden blockers, premature promotion, migration order, destructive rollback, overwrite, and privileged PR execution.
- `migration-runbook.md` - T23-02 consumer-first -> shadow -> opt-in writer -> per-profile default procedure plus baseline-drift handling.
- `evidence/T23-01/**` - bounded T23 status/test evidence. It is not product release certification.

Run locally:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json
```

T00 has explicitly deferred package/workflow/default-writer integration until T00-04 and later gates. Nested-test discovery and package allowlist requests are recorded only as change requests.

The verifier validates this release-control slice only. It does not prove product suites passed, that T00-01 was accepted, that current-main CI is green, or that a runtime/profile is safe to promote.
