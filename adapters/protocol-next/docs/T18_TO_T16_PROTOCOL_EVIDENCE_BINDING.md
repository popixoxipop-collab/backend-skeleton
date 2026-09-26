# T18 → T16 protocol item / execution-evidence binding handoff

Status: **candidate integration handoff only**. This document does not introduce a protocol contract version,
RuntimeBinding, executor, runtime certification, or production registration.

## Frozen T18 side

T18 already emits an exact `sbf.protocol-item-ref/draft-1` whose `contract` is an
`sbf.artifact-ref/1`. Binding the ref re-hashes the exact protocol-contract bytes, parses those bytes,
checks family/plane, and proves `item_id` exists in that exact contract.

The protocol oracle request carries that exact ProtocolItemRef in `assertions[].action_ref` and keeps these
semantics explicit:

- the request itself is not runtime evidence;
- ordering does not imply causation;
- correlation does not imply causation;
- the executor must re-hash referenced bytes;
- the executor must verify protocol item existence.

Those static contracts are unchanged by this handoff.

## First bounded validation profile

`t18-grpc-unary-binding/1` uses the existing protobuf fixture shape:

```proto
syntax = "proto3";
package shop.v1;
message Req { string id = 1; }
message Res { string id = 1; }
service Orders { rpc Get (Req) returns (Res); }
```

T18 resolves `Orders.Get` once from source into an exact ProtocolItemRef. T16 must consume that typed ref;
it must not recover the item later from a display service/method name.

The fixture remains `runtime_execution=not-performed` until the admitted T16 profile executes it.

## Required T16 evidence boundary

The corrected T16 outcome/evidence layer must ensure every item-scoped assertion result is bound to the
**same exact frozen action_ref** carried by the T18 request.

Binding only `assertion.id + assertion.kind` is insufficient: two different gRPC items may share the same
assertion kind, and an opaque evidence hash can otherwise be swapped between them.

An acceptable T16-owned evidence representation must therefore commit cryptographically to the exact
ProtocolItemRef (or a canonical digest that T16 independently recomputes from that exact ref) and verify it
against the frozen request before accepting the result. Merely echoing an unchecked `action_ref` field is
not sufficient.

For an assertion whose frozen `action_ref` is `null`, null must remain exact; no item may be invented.

T18 does **not** prescribe a new RuntimeBinding or executor. T16 should reuse its existing
`beval.runtime-binding/1`, attempt nonce, runner identity, and baseline-first execution path.

## Required cases

| Case | Required result |
|---|---|
| exact contract bytes + exact ProtocolItemRef | eligible for item-scoped execution evidence after actual execution |
| contract bytes changed under the old ArtifactRef | reject: `PROTOCOL_RUNTIME_ARTIFACT_MISMATCH` |
| item id absent from the exact contract | reject: `PROTOCOL_RUNTIME_ITEM_INVALID` |
| evidence from a different RuntimeBinding / attempt | reject via existing runtime evidence binding |
| evidence for a different ProtocolItemRef in the same request | reject; target T16 diagnostic `PROTOCOL_RUNTIME_ASSERTION_ITEM_MISMATCH` |

The diagnostic name in the final row is a T18/T19 test expectation, not a stable public wire contract.

## Scope boundary

This handoff does not:

- infer behavior from protocol declaration names;
- promote temporal ordering or correlation into causality;
- certify GraphQL, event, WebSocket, or arbitrary gRPC implementations;
- claim Runtime-tested status for an unexecuted protocol;
- modify the HTTP adapter registry, stable schemas, package manifest, workflow, or default activation.

Independent golden review belongs to T19. Runtime implementation/evidence belongs to T16. Shared CI/package
integration belongs to T23/T00.
