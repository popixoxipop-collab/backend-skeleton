# capability-next

This directory is an opt-in capability policy layer. It deliberately does **not** change
`sbf.adapter/2`, `scanners/capabilities.mjs`, the CLI, or any existing adapter descriptor.

The current adapter booleans keep their existing narrow meanings. `fromLegacyCapabilities()` only
bridges those exact meanings into the five-state model and marks the source as
`legacy-adapter-boolean`; it is not evidence that a broader future capability has been certified.

The axes stay separate:

- adapter `confidence`: how sure detection is that a repository uses a framework;
- adapter `verificationBasis`: how the adapter implementation itself was checked historically;
- capability `status`: supported / partial / unsupported / unknown / not-applicable for one scope;
- support `level`: discovery / contract / runtime-tested for an explicit target/profile;
- codegen state: none / scaffold / build-tested / behavior-tested, independent of support level.

Policy evaluation is fail-closed. Missing capability becomes `unknown`; `unknown` can never be an
accepted status. `partial` and `not-applicable` can be accepted only by an explicit policy and
their status is never rewritten to `supported`.

## Evidence boundary

The arbitrary-string `evidenceRefs` defect is closed in this branch.

New supported/candidate-certification state requires evidence receipts produced by
`verifyArtifactEvidence()`. That function validates a T01 `sbf.artifact-ref/1` **and the exact
artifact bytes** (SHA-256 + size) before a receipt can be consumed by T03. A string, a raw
ArtifactRef object, stale bytes, a forged digest, or a serialized hand-built capability record is
not accepted as verified evidence.

The frozen T01 schema source used by the regression is PR #82 head
`e499073aaa7fe9c116e30fbff0536cccecb6eb69`, schema blob
`d69366533844c4d002de8746140776edfdccbb25`.

## Runtime boundary

`runtime-tested` and `behavior-tested` remain fail-closed. The reviewed T16/T19 evidence currently
proves the immutable RuntimeBinding/process-policy core, but T19 explicitly says that review does
**not** certify any capability as runtime-tested. A RuntimeBinding existing, a profile string, mock
success, or generic CI success therefore cannot create runtime-tested support.

The direct integration test pins:

- T16 runtime-binding source from Backend-evaluation PR #52 / merge
  `795c11bc78a6cfd9ce0d40392a564bb3ffc542e4`;
- T19 review PR #136 head `21cf8e519addcbe56dbf093967816e47a35ee2cf`;
- T19 review exact SHA-256
  `4d7fd6d5e234282715f35e01f0da2760ea3c1be28cdeb4dd78caf4feaf2d998f`.

A future positive runtime-tested path requires exact T16 runtime-execution evidence plus an
independently accepted T19 verdict for the **same target/profile/combination**. Until that verifier
contract is frozen, T03 rejects runtime verification/combination inputs instead of guessing.

## Legacy compatibility bridge

`compatibility.mjs` reads stable `COMMAND_CAPABILITIES` and satisfier metadata without changing
them. A legacy satisfier such as `--openapi-file` can become a next `supported` record only after
its exact bytes have been verified against a T01 ArtifactRef. Merely seeing the flag or passing a
reference-looking string is not evidence.

`buildLegacyCompatibilityView()` remains `certified:false`; it is a migration/drift view, not
public certified support.

## Consumer fixture

`test/capability-next/fixture-status-diagnostics.json` is the shared T15/T22 consumer fixture.
It keeps all five T03 states distinct, keeps conflict as an aggregation-only state, leaves
certification null, and explicitly records that RuntimeBinding/mock success is not runtime-tested.

## Cross-track integration

See [INTEGRATION.md](INTEGRATION.md). Shared CLI, registry, stable schema, package/lock/workflow and
release tables are intentionally not modified on the T03 branch.
