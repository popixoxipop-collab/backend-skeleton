# T18 → T16 change request: protocol runtime oracle

Status: **proposed cross-track handoff; Draft-only; T18 does not implement or certify runtime execution**.

## T18-owned input

T18 emits a shadow `sbf_protocol_oracle_request: "1"` from `adapters/protocol-next/contracts/protocol-oracle-request.mjs`.

The request binds exact **T01-shaped `sbf.artifact-ref/1`** references for:

- one or more protocol contracts;
- optional protocol flow contract;
- original implementation snapshot;
- candidate implementation snapshot;
- approved runtime profile;
- scenario identity and seed.

Assertions may additionally bind a `sbf.protocol-item-ref/draft-1`, which contains the exact protocol-contract ArtifactRef plus family, plane, and item ID.

Request construction receives exact protocol contract contexts and verifies:

1. every bound contract ref has matching bytes;
2. no unbound contract context is smuggled into the request;
3. each assertion action family/plane is valid;
4. each assertion item ID exists in the exact referenced contract;
5. an assertion cannot point at a protocol contract omitted from the request.

T01 remains owner of ArtifactRef semantics. The T18 validation is a shadow consumer of T01 PR #82's candidate shape, not a competing stable identity definition.

The request digest is a deterministic packet digest only. It is **not runtime evidence** and does not replace beval's immutable RunBinding.

## Required T16 behavior

T16 should consume the request only after it:

1. re-reads and re-hashes every referenced artifact;
2. validates the supported artifact/protocol/flow versions;
3. independently verifies each typed protocol item against the re-hashed exact contract bytes;
4. freezes an immutable beval RunBinding containing the exact request ref, original/candidate refs, runtime profile, scenario/seed, and attempt nonce;
5. executes original and candidate in isolated disposable environments allowed by the runtime profile;
6. evaluates assertions with independent probes rather than candidate self-report;
7. records provider/infrastructure failure separately from product failure;
8. refuses evidence replay across a different run/attempt binding.

The request carries these non-negotiable semantics:

- ordering does not imply causation;
- correlation does not imply causation;
- the request itself is not runtime evidence;
- referenced bytes must be independently re-hashed;
- protocol item existence must be independently re-verified.

## Requested assertion meanings

| kind | T16 runtime meaning | Why T18 static evidence is insufficient |
|---|---|---|
| `grpc-status` | invoke the exact bound RPC and independently observe gRPC status/result | method declarations do not prove a server executes correctly |
| `graphql-result` | execute the exact bound root field and validate returned data/errors | SDL/introspection do not prove resolver behavior |
| `message-observed` | independently observe the bound broker/socket action or expected message | AsyncAPI/WebSocket declarations do not prove delivery |
| `state` | inspect an independent state probe before/after the scenario | names/timestamps do not prove effects |
| `correlation` | compare explicitly named observed field refs | temporal proximity does not prove correlation |
| `idempotency` | replay the approved scenario and test the declared invariant | a declared key does not prove enforcement |
| `timeout` | exercise the exact runtime timeout profile and observe termination/result | a timeout declaration is not enforcement evidence |

## Fail-closed requirements

T16 should return BLOCKED or equivalent, never PASS, when:

- the original baseline cannot execute or cannot satisfy its own required assertions;
- any referenced bytes fail SHA-256/size validation;
- a typed protocol item does not exist in the re-hashed exact contract;
- the protocol family/plane disagrees with the referenced contract;
- runtime profile revision is unknown, revoked, or not approved;
- the selected runner does not support a required assertion kind;
- a required broker/service/runtime dependency is unavailable;
- a scenario tries to infer causation from `after` or correlation alone;
- evidence lacks the exact run/attempt binding;
- candidate code can write the independent probe/pass result directly.

## Expected T16 result binding

The eventual beval result should identify at least:

- exact oracle-request ArtifactRef;
- beval RunBinding/ref and runner implementation digest;
- exact original/candidate ArtifactRefs;
- exact runtime-profile ArtifactRef;
- scenario/seed and attempt nonce;
- per-assertion status plus independent evidence refs;
- original/baseline status;
- candidate verdict;
- cleanup status;
- any BLOCKED reason.

T18 does not prescribe beval's internal DB schema or CLI. T16 should preserve its canonical immutable evidence conventions rather than adopting T18's local storage choices.

## Cross-team acceptance slices

The T18→T16 handoff is not complete until T16 independently proves at least one narrow disposable runtime scenario for each admitted family without changing T18 meaning:

1. unary gRPC request;
2. GraphQL query or mutation;
3. event publish/observe;
4. WebSocket send/observe.

These are integration slices, not full protocol support claims.

## Current dependency state

T18 runtime/certification work remains **BLOCKED** until T00/T01 identity seams are frozen and T16 owns the runtime implementation. This document is the change request; no beval files are modified by PR #70.
