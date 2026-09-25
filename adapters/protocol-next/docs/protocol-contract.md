# T18 protocol-next contract plane

Status: **experimental shadow implementation; Draft-only; not stable CLI/package surface**.

Ownership: T18 non-HTTP protocol semantics. All implementation files stay under `adapters/protocol-next/**`; all tests and seed corpus stay under `test/protocol-next/**`. Stable CLI, registry, package manifests, workflows, and canonical cross-tool identity remain owned by T00/T01/T23.

## Protocol families

`contracts/protocol.mjs` defines the shadow `sbf_protocol_contract: "1"` body for four non-HTTP families:

- gRPC / Protocol Buffers
- GraphQL
- AsyncAPI event contracts
- WebSocket explicit message contracts

The family planes remain separate. A gRPC stream, GraphQL mutation, broker publish/subscribe action, or WebSocket message is never converted into an HTTP `method/path` and cannot satisfy HTTP identity or completeness gates.

## Static/spec importers

`scanners/protocol.mjs` provides conservative source/spec-first importers:

- `.proto`: package, service, RPC, client/server streaming, message and simple top-level fields; proto2/proto3/unknown syntax remain explicit.
- GraphQL SDL: schema roots, types, fields, and root operations. Resolver execution, authorization, federation behavior, and causal effects remain unknown.
- AsyncAPI parsed objects: channel/action/message references for tested 2.x/3.x structural profiles. Broker delivery guarantees are not inferred.
- WebSocket manifest: explicit connection/message identities and directions. Merely discovering a socket endpoint in source is not message-contract certification.

`scanners/protocol-descriptors.mjs` additionally imports:

- JSON-shaped Protobuf `FileDescriptorSet` declarations;
- GraphQL introspection `__schema` metadata.

These structured importers do not interpret generated runtime code, custom option semantics, resolver implementation, or runtime authorization.

## Bounded raw artifact loading

`scanners/protocol-loaders.mjs` loads:

- raw `.proto` source;
- raw GraphQL SDL;
- JSON/YAML AsyncAPI;
- JSON/YAML explicit WebSocket manifests;
- JSON descriptor/introspection objects.

Structured inputs have byte/depth/node/YAML-alias limits. Duplicate YAML keys fail. HTTP(S) remote `$ref` is denied by default; this implementation performs no network fetch.

Raw source parsers report `source_hash_basis: "raw-bytes"`. Parsed object inputs report `source_hash_basis: "canonical-parsed-object"`. Contract snapshot verification binds both the hash and its basis.

## Exact protocol item identity

T00-04 cross-review required protocol actions to be addressable without name repair. The shadow implementation in `contracts/protocol-item-ref.mjs` therefore defines:

`sbf.protocol-item-ref/draft-1 = exact protocol-contract ArtifactRef + family + plane + item_id`.

The embedded contract reference consumes the **T01 draft `sbf.artifact-ref/1` shape** exactly:

- `artifact_ref`
- `family`
- `version`
- `media_type`
- `byte_sha256`
- `size_bytes`

T01 remains the canonical owner of that artifact-reference vocabulary. T18 duplicates only the validation required by this shadow branch and must replace it with the reviewed shared seam after T00-04 final freeze.

A protocol item ref is usable only when:

1. the exact contract bytes match `byte_sha256` and `size_bytes`;
2. the protocol family matches the contract family;
3. the requested family/plane exists;
4. `item_id` exists in that exact contract.

Formatting-only contract byte changes therefore invalidate the reference even when parsed JSON would be semantically equivalent. No display name, operation label, or heuristic repair is consulted.

## Cross-protocol flows

`contracts/protocol-flow.mjs` defines shadow `sbf_protocol_flow: "1"`.

Every step now carries a typed protocol item reference and the builder requires exact contract contexts before emitting a flow. It distinguishes:

- `after`: explicit ordering only;
- `caused_by`: explicit causation only;
- `correlations`: explicit field correlation only.

Ordering and correlation never imply causation. Unknown/self references, duplicate step IDs, family mismatch, missing exact contract context, and ordering/causation cycles fail closed. Retry, timeout, and idempotency remain declarations rather than runtime proof.

## T16 oracle handoff

`contracts/protocol-oracle-request.mjs` defines shadow `sbf_protocol_oracle_request: "1"`.

The request binds T01-shaped exact artifact refs for protocol contracts, optional flow contract, original/candidate snapshots, and runtime profile. Assertions may carry typed protocol item refs. Request construction requires exact protocol contract contexts and verifies assertion item existence before the packet can be emitted.

The packet explicitly says it is **not runtime evidence**. T16/beval must still re-read/re-hash all referenced bytes, freeze its own immutable RunBinding/attempt identity, independently probe behavior, and reject replay. See `docs/T18_TO_T16_PROTOCOL_ORACLE_HANDOFF.md`.

## Conformance seed corpus

`test/protocol-next/fixtures/conformance.json` is a reusable static seed corpus for all four families plus fail-closed remote-ref and WebSocket-reference cases. `test/protocol-next/protocol-conformance.test.mjs` executes it.

Passing this corpus is static/contract evidence only. It does not confer Runtime-tested or production certification.

## T18 task status on this Draft branch

| Task | Branch coverage | Program status |
|---|---|---|
| T18-01 protocol boundary RFC | family separation and trust boundary implemented/docs | covered on Draft; not T00-ACCEPTED |
| T18-02 schema importer contract | source, descriptor, introspection, bounded structured loader | covered on Draft; not T00-ACCEPTED |
| T18-03 protocol importer | gRPC/GraphQL/AsyncAPI/WebSocket static importers + corpus | covered on Draft; integration blocked on common freeze |
| T18-04 flow/correlation | explicit ordering/causation/correlation + exact typed item refs | covered on Draft; identity seam depends on T01/T00 freeze |
| T18-05 isolated protocol oracle | request/handoff contract only | **BLOCKED** on T16 runtime implementation/approved profiles |
| T18-06 protocol certification | no runtime/certification claim | **BLOCKED** on T16 + T19 independent evidence |

## Deliberately not implemented

- stable `bskel` CLI commands;
- stable adapter registry/capability/schema changes;
- package export/default registration;
- protobuf import graph/custom options/runtime server inference;
- GraphQL resolver/auth enforcement inference;
- AsyncAPI broker delivery semantics;
- WebSocket runtime state-machine certification;
- beval runner/oracle implementation;
- support certification.

Those require their canonical owners and T00 integration approval.
