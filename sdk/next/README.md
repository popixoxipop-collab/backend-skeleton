# bskel adapter SDK preview

This directory is the T22 source-tree SDK preview. It is **not shipped by npm yet** because the
current package allowlist does not include `sdk/`.

The SDK is deliberately data-first. Importing it does not load an external adapter, execute target
repository code, spawn a process, read environment variables, or grant network access.

## Quick start

```js
import {
  createAdapterSdkManifest,
  createAdapterTaskPacket,
  createSupportExplanation,
  diagnosticsToSarif,
  planExternalAdapterActivation,
  reviewAdapterSubmission,
  runAdapterSdkConformance,
} from './sdk/next/index.mjs';

const manifest = createAdapterSdkManifest({
  adapter: {
    id: 'typescript-nestjs',
    title: 'NestJS',
    version: '0.1.0',
  },
  bskel: {
    minInclusive: '1.9.0',
    maxExclusive: '2.0.0',
  },
  entrypointPath: 'adapter-worker.mjs',
  fixtures: ['fixtures/minimal'],
  verificationBasis: 'synthetic-only',
});

// Validation is not execution approval.
console.log(planExternalAdapterActivation(manifest));
// => executable:false, requiresApproval:true, autoInstall:false, autoImport:false

const task = createAdapterTaskPacket({
  taskId: 'HTTP-typescript-nestjs-02',
  targetId: 'HTTP-typescript-nestjs',
  baseSha: '<40-character git SHA>',
  writeScope: ['adapters/http-wave-a/typescript-nestjs/**'],
  fixtures: ['test/fixtures/typescript-nestjs/minimal'],
  mandatoryTests: ['node --test test/typescript-nestjs.test.mjs'],
});
```

## Exports

| Module | Purpose |
|---|---|
| `manifest.mjs` | safe manifest builder, validation, compatibility checks, activation plan |
| `protocol.mjs` | versioned request/response envelope; no transport implementation |
| `task-packet.mjs` | copyable scope/test/constraint handoff |
| `explain.mjs` | capability and field support states with provenance/conflicts/next actions |
| `sarif.mjs` | diagnostic projection to SARIF 2.1.0 |
| `testkit.mjs` | caller-injected protocol conformance; no spawning/import |
| `package-inventory.mjs` | pre-execution regular-file inventory/reference review; never trusts archive bytes |
| `support-evidence-matrix.mjs` | deterministic support-evidence matrix projection and diagnostics |
| `submission-review.mjs` | composes manifest/package/support evidence into a pre-execution readiness verdict |
| `schema-catalog.mjs` | stable IDs and package-relative locations for nine JSON schemas |

## Schema vs runtime validation

The JSON Schemas cover shape and conditional state invariants that editors/CI can evaluate.
Runtime validation remains authoritative for semantic relationships that JSON Schema cannot
naturally compare, such as `minInclusive < maxExclusive` under SemVer precedence.

A schema-valid manifest therefore still does not authorize code execution.

## Trust boundary

The existing first-party `scanners/adapters/*.mjs` registry is repository-owned trusted code.
Do not point it at external directories or packages. External adapter execution needs a separate
T20-approved isolation/permission/revocation path. This SDK only supplies data contracts and
conformance helpers for that later boundary.

## T22-01 baseline record

`BASELINE.json` pins what this SDK does today, and where it fails, for one exact revision: the base commit
`15a38e923cb5e079c6f8e2a4c2a9386406c41f52`. It changes no module. Its schema, `bskel.track-baseline-record/2`, is provisional.

Recorded: every pinned file (the SDK sources and JSON Schemas in this directory, the test files, the fixture adapter package the
tests call, `package-lock.json`, and the nested runner) with size, git blob id and sha256; two real commands run in an extracted
copy of the base commit, with exit codes and counts (`node --test` on the eleven original test files, and
`node scripts/run-next-nested-tests.mjs T22`, with its first line); named fixtures that call the pinned modules, each with its
expected values and the sha256 of its output, split into normal fixtures and negative fixtures (cases the SDK rejects by design,
and observed gaps, whose ids start with `observed-gap-`: cases the SDK accepts although a reader would expect a refusal); and limits,
each with a status and the fixtures, the `git grep` reference list or the absence check that binds its statement.

| limit status | meaning |
|---|---|
| `UNSUPPORTED` | the SDK does not do this at the base commit; nothing is marked supported |
| `UNKNOWN` | the SDK reports it as unknown, or the record cannot decide it |
| `BLOCKED` | cannot be observed here; the reason is stated (no real adapter is executed, the fixture adapter package is synthetic) |
| `NOT_RECORDED` | not measured; it names what the record does not contain |

`baseline-record.test.mjs` recomputes every size, hash, count, exit code, expected value, fixture output, reference list and
absence check from the working tree, from the pinned commit and from an extracted copy of it. It also compares the table, the test
counts, the `NESTED_SUITE` line and the base commit named in this README with the record. The extracted copy runs against the
`node_modules` of the checkout only after the version of every package the pinned files import (and of the packages those
require) equals the version the base commit's `package-lock.json` states; the record lists them as `environment.loaded_packages`,
and a different or missing version fails the test. Not recomputed: the CI observation (read once through the read-only CI API), the
machine description, the files inside the installed packages (only their versions are compared with the lockfile), the synthetic
fixture inputs, and the explanatory prose of the record and of this README. `artifact_digest` seals the whole record except its
own value, so an edit that is not re-sealed is reported; an editor who re-seals the record is caught only by the recomputed values
and by review of the diff.

```bash
npm ci
node --test test/sdk-next/baseline-record.test.mjs
```

A commit that is not available (for example in a shallow checkout that cannot fetch it) fails the test;
`BASELINE_ALLOW_UNVERIFIED=1` turns only that case into a visible skip, and never the dependency version check. A later
dependency update that changes one of the loaded packages therefore fails the test until the baseline is replaced. A changed
baseline is a new record for a new commit, reviewed as a diff, not an edit in place.

The record does not put the SDK into the npm package, does not wire a command line for it and does not record promotion or
rollback; its limits say so, and package and CI integration belong to the package-integration track.

## Tests

Run the whole T22 slice through the nested runner, exactly as the required `nested-next` CI job does, or run the files directly:

```bash
node scripts/run-next-nested-tests.mjs T22
node --test test/sdk-next/*.test.mjs
```

The legacy root `npm test` pattern (`node --test test/*.test.mjs`) does not discover nested tests, and this track does not own
package or workflow wiring. At the pinned base commit `15a38e923cb5e079c6f8e2a4c2a9386406c41f52` the eleven original test files
contain **65 tests** (the total both commands report there) and the nested runner prints `NESTED_SUITE T22 RUN 11 files`. The
directory holds one more test file now, `baseline-record.test.mjs`, so the runner line of a current checkout names one more file than
the baseline's. The original files:

| file | tests | covers |
|---|---|---|
| `capability-projection.test.mjs` | 8 | five-state capability projection, conflict only from disagreeing evidence, the legacy boolean bridge |
| `explain-sarif.test.mjs` | 7 | support explanation states, SARIF projection, Markdown escaping |
| `manifest.test.mjs` | 10 | manifest validation, SemVer ranges, deny-by-default permissions |
| `onboarding-e2e.test.mjs` | 1 | the pre-execution onboarding path of the minimal external adapter |
| `package-review.test.mjs` | 8 | package inventory and reference review |
| `protocol.test.mjs` | 8 | request/response envelope bounds and binding |
| `schema-parity.test.mjs` | 6 | the JSON Schemas against the runtime validators |
| `submission-review.test.mjs` | 5 | submission readiness verdicts |
| `support-evidence-matrix.test.mjs` | 6 | support-evidence matrix, diagnostics and Markdown escaping |
| `task-packet.test.mjs` | 2 | task packet ownership and base revision |
| `testkit-boundary.test.mjs` | 4 | the caller-injected conformance harness and the source boundary |
