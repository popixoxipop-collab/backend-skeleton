# T18 → T16 change request: protocol runtime oracle

Status: proposed handoff. This document does not modify beval and does not certify any runtime execution.

## Input owned by T18

T18 now emits `sbf_protocol_oracle_request: "1"` in `contracts/protocol-oracle-request.mjs`.

The request binds exact artifact references for:

- protocol contract
- optional protocol flow contract
- original implementation snapshot
- candidate implementation snapshot
- approved runtime profile
- scenario identity and seed
- protocol assertions

Every artifact reference carries `family`, `version`, lowercase SHA-256 and byte size. The request digest is only a deterministic packet digest. It is **not** runtime evidence and must not replace beval's existing immutable run binding.

## Requested T16 behavior

T16 should consume the request only after it:

1. re-reads and re-hashes every referenced artifact;
2. verifies the contract/flow families and versions it actually supports;
3. freezes an immutable beval RunBinding containing the exact request ref, original/candidate snapshots, runtime profile, seed and attempt nonce;
4. runs original and candidate in isolated disposable environments under the approved runtime profile;
5. evaluates protocol assertions using independent probes rather than candidate self-report;
6. records provider/infrastructure failure separately from product failure;
7. refuses replay of evidence across a different run/attempt binding.

The request explicitly states:

- ordering does not imply causation;
- correlation does not imply causation;
- the request itself is not runtime evidence;
- referenced bytes must be re-hashed by the executor.

T16 must preserve those semantics.

## Assertion kinds requested

| kind | Runtime meaning expected from T16 | Static T18 evidence is insufficient because |
|---|---|---|
| `grpc-status` | perform an RPC and independently observe gRPC status/result | service/method declarations do not prove a server works |
| `graphql-result` | execute the operation and validate returned data/errors | SDL/introspection does not prove resolver behavior |
| `message-observed` | observe a message at the approved broker/socket probe | AsyncAPI/WebSocket declarations do not prove delivery |
| `state` | query an independently defined state probe before/after | timestamps or names alone do not prove effects |
| `correlation` | compare explicit field refs across observed events | temporal proximity is not correlation proof |
| `idempotency` | replay the approved scenario and test the declared invariant | a declared key does not prove enforcement |
| `timeout` | exercise the exact timeout profile and observe termination/result | a timeout number in a contract is only a declaration |

## Fail-closed requirements

T16 should return BLOCKED or equivalent, not PASS, when:

- the original baseline cannot execute or satisfy its own required assertions;
- any referenced bytes fail the supplied SHA-256/size check;
- runtime profile revision is unknown or no longer approved;
- an assertion kind is unsupported by the chosen runner;
- a required broker/service/engine is unavailable;
- the scenario attempts to infer causation from `after` or correlation alone;
- evidence is missing the exact run/attempt binding;
- the candidate can write the probe result or pass flag directly.

## Requested output binding

The eventual beval result should identify at least:

- exact `sbf_protocol_oracle_request/1` artifact ref;
- beval RunBinding/ref and runner implementation digest;
- original and candidate refs;
- runtime profile ref;
- attempt nonce;
- per-assertion status and independent evidence refs;
- baseline/original status;
- candidate verdict;
- cleanup status;
- any BLOCKED reason.

T18 does not prescribe beval's internal database schema or CLI. The output shape should use T16's existing immutable evidence conventions.

## Cross-team acceptance

T18 considers the handoff complete when T16 can prove one narrow disposable scenario for each admitted protocol family without changing T18 contract meaning:

1. one unary gRPC request;
2. one GraphQL query or mutation;
3. one event publish/observe scenario;
4. one WebSocket send/observe scenario.

These are integration slices, not claims of full protocol support.
