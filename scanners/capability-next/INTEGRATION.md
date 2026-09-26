# T03 integration handoff

Branch: `scale/T03/capability-policy-next`
PR: #81

This is defect correction / verification / integration preparation. T03 owns only
`scanners/capability-next/**` and `test/capability-next/**`. Shared hot files are not modified.

## Approved inputs consumed

### T01 exact artifact identity

T03 consumes `sbf.artifact-ref/1` from T01 PR #82 head
`e499073aaa7fe9c116e30fbff0536cccecb6eb69`.

Pinned test source:

- schema blob: `d69366533844c4d002de8746140776edfdccbb25`
- exact fixture SHA-256: `9c23e23d76937476752b3a3ddc72ee0b0ce24c23ff4b00cf6f18f174400ac8bd`
- size: 880 bytes.

A T01 ArtifactRef is exact-byte identity, not semantic proof. T03 therefore requires both the typed
ref and matching bytes before creating an internal evidence receipt.

### T16/T19 current runtime core

T16 PR #52 introduced `beval.runtime-binding/1` and runtime-evidence binding. T19 PR #136
independently reviewed that core and returned PASS **for immutable binding/process-policy core
only**.

Pinned T19 review:

- exact review head: `21cf8e519addcbe56dbf093967816e47a35ee2cf`
- blob: `6990553e297b493c3a4a480b1b7bec03b822a6b8`
- exact SHA-256: `4d7fd6d5e234282715f35e01f0da2760ea3c1be28cdeb4dd78caf4feaf2d998f`
- size: 3270 bytes.

That review explicitly excludes real FastAPI/Spring/Chromium behavior and any
`runtime-tested` capability certification. T03 encodes that as a blocker; it is not upgraded by a
RuntimeBinding object, profile string, mock result, or generic CI.

## Current defect correction

The old draft accepted arbitrary non-empty `evidenceRefs` strings. That is no longer accepted:

1. `verifyArtifactEvidence({ref, bytes})` validates exact T01 ArtifactRef shape, SHA-256 and size.
2. It returns an in-process opaque receipt.
3. `capabilityRecord()`, external legacy satisfiers, and discovery/contract candidate records
   accept only those verified receipts.
4. `normalizeCapabilityMap()` accepts only records created by the T03 builder/legacy bridge, so a
   serialized hand-built `supported` record cannot be injected into policy evaluation.
5. runtime-tested and behavior-tested remain blocked pending the T16/T19 runtime-execution verifier.

The five-state 04A vocabulary and legacy boolean meanings are unchanged.

## Request to T00

After the final exact-head tests and T19 review, integrate by shadow comparison only. Do not replace
stable `requireCapabilitiesOrExit()`, adapter schema, CLI, registry or package surfaces from T03.
No default activation is requested.

## Request to T15 and T22

Consume exactly the same fixture:

`test/capability-next/fixture-status-diagnostics.json`

Consumer rules:

- typed ArtifactRef values are display/provenance data, not paths/URLs;
- `supported` is not inferred from a nonempty ref array;
- `partial`, `unknown`, `unsupported`, `not-applicable` stay distinct;
- `conflict` exists only at aggregation/reconciliation level and is never collapsed to supported;
- `certification:null` must remain uncertified;
- support level and codegen state remain independent.

T15/T22 should update their current string-ref shadow fixtures rather than T03 weakening its evidence
boundary.

## Request to T19

Independently review the final T03 code head and direct dedicated test output. A future positive
runtime-tested record needs a T19-owned machine-verifiable runtime-execution verdict bound to the
same target/profile/combination and exact T16 runtime evidence. The current runtime-core review is
deliberately insufficient.

## Root-test boundary

The existing `test/capability-next.test.mjs` bridge remains byte-identical to the T00 lease blob
`544b8bcc9f83738fb6dc10c4767e12ac90e3d7c5`. T03 creates no new root shim and does not modify that
file.

## Stable surfaces intentionally untouched

- `scanners/capabilities.mjs`
- `schemas/adapter.schema.json`
- `scanners/registry.mjs`
- `handles/registry.mjs`
- `bin/bskel.mjs`
- `package.json` / lockfile
- workflows
- existing adapter/provider descriptors
