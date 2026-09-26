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

The old arbitrary-string `evidenceRefs` defect is closed.

T03 now separates two questions:

1. **Identity** — does a T01 `sbf.artifact-ref/1` match the exact supplied bytes?
2. **Authority** — do those reviewed bytes actually authorize the specific capability/status or
   certification being requested?

`verifyArtifactEvidence()` answers only the first question. Its receipt carries **no semantic
authority** and cannot create `supported`, discovery certification, or contract certification.

Current reviewed semantic bindings are intentionally narrow:

- exact T01 ArtifactRef schema bytes authorize only
  `identity.artifact-ref = supported`;
- exact T19 review of the merged T16 runtime core authorizes only
  `runtime.certification = partial`.

The T01 schema source is PR #82 head
`e499073aaa7fe9c116e30fbff0536cccecb6eb69`, schema blob
`d69366533844c4d002de8746140776edfdccbb25`.

A raw string, raw ArtifactRef object, stale/forged bytes, identity-only receipt, serialized
caller-built capability record, or caller-spoofed `source:'legacy-adapter-boolean'` cannot mint
supported state.

## Runtime and certification boundary

`runtime-tested` and `behavior-tested` remain fail-closed.

The reviewed T16/T19 evidence proves the immutable RuntimeBinding/evidence/process-policy core only.
T19 explicitly states that this does **not** certify any capability as runtime-tested.

Pinned negative boundary:

- T16 PR #52 merge `795c11bc78a6cfd9ce0d40392a564bb3ffc542e4`;
- runtime-binding source blob `6af4770dbc31ca64dd94ac8ec83ae570bb00104d`;
- T19 PR #136 head `21cf8e519addcbe56dbf093967816e47a35ee2cf`;
- T19 review blob `6990553e297b493c3a4a480b1b7bec03b822a6b8`;
- T19 review SHA-256
  `4d7fd6d5e234282715f35e01f0da2760ea3c1be28cdeb4dd78caf4feaf2d998f`.

A RuntimeBinding object, profile string, generic CI success, build success, or mock success cannot
create runtime-tested or behavior-tested status. A future positive runtime-tested path must consume
exact T16 runtime-execution evidence plus independent T19 acceptance for the same
target/profile/combination.

Discovery/contract certification is also not granted by identity-only artifact evidence. Until an
independently reviewed certification artifact is wired into T03, authoritative support-matrix rows
remain fail-closed.

## Legacy compatibility bridge

`compatibility.mjs` reads stable `COMMAND_CAPABILITIES` and satisfier metadata without changing
them. A legacy satisfier such as `--openapi-file` remains a hint in the next lane. Exact-byte
identity of an OpenAPI-looking artifact is not sufficient to mint `api.operations=supported`;
semantic capability evidence must come from the reviewed reconciliation/certification boundary.

`buildLegacyCompatibilityView()` remains `certified:false`; it is a migration/drift view, not
public certified support.

## Consumer fixture

`test/capability-next/fixture-status-diagnostics.json` is the shared T15/T22 consumer fixture.
It keeps all five T03 states distinct, keeps conflict as an aggregation-only state, leaves
certification null, and explicitly records that RuntimeBinding/mock success is not runtime-tested.
Serialized fixture evidence is display/provenance data; consumers must not replay it as an in-process
T03 evidence receipt.

## Cross-track integration

See [INTEGRATION.md](INTEGRATION.md). Shared CLI, registry, stable schema, package/lock/workflow and
release tables are intentionally not modified on the T03 branch.
