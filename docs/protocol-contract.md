# Protocol contract plane (T18 first slice)

Status: experimental implementation slice. It is deliberately not wired into the stable CLI or HTTP adapter registry yet.

## Boundary

`contracts/protocol.mjs` defines `sbf_protocol_contract: "1"` for four non-HTTP protocol families:

- gRPC / Protocol Buffers
- GraphQL SDL
- AsyncAPI event contracts
- WebSocket explicit message manifests

The contract keeps family-specific planes instead of translating every action into an HTTP `method/path`. This prevents a gRPC stream, GraphQL mutation, broker publish/subscribe action, or stateful WebSocket message from silently satisfying HTTP contract gates.

The first static importers live in `scanners/protocol.mjs` and intentionally abstain from runtime conclusions:

- `.proto`: package, service, RPC streaming direction, messages and simple fields. Imports/options/generated server behavior are not resolved.
- GraphQL SDL: type and root-operation declarations. Resolver binding, federation execution and authorization are not inferred.
- AsyncAPI: parsed object only. Broker delivery semantics and consumer behavior are not inferred.
- WebSocket: explicit manifest only. Finding `new WebSocket()` in source is not message-contract certification.

## Why no stable CLI wiring yet

T18 owns a leaf namespace in the parallel plan. Stable CLI dispatch, global schemas and cross-family identity are shared integration surfaces owned by the coordinator/contract tracks. This slice can therefore be reviewed and tested without racing those files. A later integration change may add commands/import dispatch after the common interface freeze.

## Required next work

1. Add descriptor-set import for protobuf and bounded import resolution.
2. Add GraphQL introspection import and explicit resolver-binding evidence as a separate claim.
3. Add YAML/JSON file loading for supported AsyncAPI dialects with remote `$ref` disabled by default.
4. Define the JSON Schema for an explicit WebSocket manifest, including handshake/auth and state-machine references.
5. Add disposable runtime oracle profiles in beval; static declarations alone must never become `Runtime-tested`.
6. Add independent protocol conformance corpus and message/retry/idempotency negative tests.


## Explicit cross-protocol flow relations

`contracts/protocol-flow.mjs` adds a separate `sbf_protocol_flow: "1"` artifact for scenario-level relationships. It deliberately distinguishes:

- `after`: an explicit execution ordering dependency only
- `caused_by`: an explicit causation claim
- `correlations`: an explicit field-to-field correlation claim

Ordering and correlation never imply causation. Unknown/self references, duplicate step IDs, and ordering/causation cycles fail closed. Retry, timeout, and idempotency declarations are preserved as declarations; they are not runtime proof that a broker/service enforces them.

`action_ref` remains an opaque exact reference in this first slice so T18 does not pre-empt the shared cross-family identity work. A later integration revision must bind it to the common immutable action reference rather than adding name-based repair.
