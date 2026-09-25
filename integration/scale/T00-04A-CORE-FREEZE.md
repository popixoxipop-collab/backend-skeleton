# T00-04A Core Interface Freeze Candidate

Generated: 2026-09-25  
Status: **CANDIDATE_BLOCKED_ON_BASELINE**

This is a deliberately narrow first freeze. It does **not** finalize every next-generation IR or framework adapter.

## Why T00-04 is split

The scale program has independent progress across 24 tracks. Several planes are useful but still have correctness, provenance, path-ownership, or runtime-binding blockers. Requiring every plane to become stable at the same instant would serialize the entire program behind unrelated blockers.

T00 therefore separates:

- **T00-04A — Core semantic freeze:** small cross-track invariants that every agent may safely depend on.
- **T00-04B — Plane promotion:** project graph, reconciliation, persistence, game-next, protocol-next, runtime binding, and individual framework profiles are promoted independently after their own gates.

This split reduces dependency fan-in without weakening any existing fail-closed rule.

## 04A frozen semantics

### 1. Existing HTTP identity remains authoritative

The existing:
- `sbf.contract-ref/1`
- `sbf.action-ref/1`
- `sbf.field-ref/1`

remain the authoritative HTTP references.

Rules:
- operation IDs are not repaired, prefixed, renamed, or guessed;
- synthesized operation IDs are not source-authored identities;
- exact legacy readers remain supported during migration.

### 2. Exact artifact identity

Candidate T01 `sbf.artifact-ref/1` semantics are frozen as:

```
family
version
media_type
byte_sha256
size_bytes
```

The reference identifies **exact bytes**, never semantic equivalence.

The T01 HTTP identity envelope is additive:
- version: `sbf.identity-envelope/1`
- v1 family: HTTP only
- reference kinds: contract / action / field
- embedded legacy reference retains its existing meaning

No other plane may mint a competing generic identity envelope during 04A.

### 3. Capability status vocabulary

The following meanings are frozen:

- `supported`
- `partial`
- `unsupported`
- `unknown`
- `not-applicable`

Rules:
- missing evidence does not become supported;
- `unknown` is not silently accepted;
- status is separate from parser confidence or adapter verification basis;
- legacy booleans keep only their existing narrow meaning.

**Not frozen in 04A:** T03's current certification/evidence-record wire shape. Arbitrary string `evidenceRefs` are not yet sufficient for authoritative certification.

### 4. Evidence class rule

A claim of `runtime-tested` must eventually reference verified runtime execution evidence, not merely any non-empty evidence token or source artifact.

The precise cross-tool evidence-ref schema waits for T16/T19 review, but the semantic requirement is frozen now.

### 5. Unknown / ambiguity preservation

All tracks must preserve the distinction among:
- unknown
- partial
- unsupported
- not-applicable
- ambiguous/conflict where applicable
- absent where the source format gives absence a distinct meaning

A downstream layer may narrow uncertainty only with stronger evidence; it may not erase uncertainty by convenience.

### 6. Authority boundaries

- T01: exact artifact/contract/action/field identity
- T02: project/service/facet analysis — draft
- T03: capability state semantics
- T09: reconciliation/provenance promotion — draft
- T10: persistence normalization — draft
- T15: deterministic becoder consumption/rendering
- T16: runtime binding/evidence — draft
- T17: game semantics; legacy webgame/1 stays authority
- T18: non-HTTP protocol semantics — draft
- T19: independent QA/certification
- T20: trust/security/permissions
- T21: freshness/cache invalidation
- T23: package/release/integration

No track may fill unknown information owned by another authority.

### 7. Parallel-write protocol

T00-03 r1 path leases and fencing tokens are part of the core coordination contract:
- exact base SHA;
- actual worker/worktree identity;
- scoped repo-relative paths;
- expiry;
- monotonically increasing fencing token;
- stale/expired/out-of-scope results rejected.

GitHub branch existence alone is not an ACTIVE lease.

## Explicitly not frozen in 04A

The following remain internal/draft:

| Plane | Reason |
|---|---|
| T02 project graph | absolute checkout path still serialized; portable identity not frozen |
| T03 certification record | evidence refs not yet typed to immutable/runtime evidence |
| T09 reconciliation | exact-head semantic regression remains |
| T10 persistence IR | generic source_refs/entity-id validation still incomplete |
| T16 runtime binding | branch must be rebuilt on current beval baseline |
| T17 game-next graph | exact source webgame-contract byte binding missing |
| T18 protocol plane | flow action refs not bound to exact contract items |
| HTTP Wave A/B/C adapters | per-profile certification/registration remains independent |
| external adapter execution | T20 sandbox/enforcement not ready |
| package/test discovery | T23 integration work |

## Activation gates

This candidate becomes **ACTIVE_CORE_FREEZE** only when:

1. T00-01 current baseline is ACCEPTED by exact-head verification + T19 independent review.
2. T01 candidate bytes/goldens remain exact-head green and legacy identity compatibility remains intact.
3. T03 five-state vocabulary remains exact-head green; no certification wire-shape is promoted.
4. T00-03 lease/fencing coordination implementation remains green.
5. No newer main-branch drift invalidates the baseline during activation.

T09, T12, T15, and other plane-specific blockers do **not** block 04A activation; they block only their own 04B promotion.

## What 04A unlocks after activation

Agents may safely design against:
- exact HTTP identity compatibility;
- exact artifact byte identity;
- the five capability states;
- preservation of unknown/ambiguity;
- immutable evidence-class requirements;
- the authority map and path lease/fencing protocol.

Agents still may **not**:
- publish a new stable top-level IR,
- register experimental adapters into the production registry,
- modify stable CLI/schema/package/workflow surfaces without integration lease,
- claim runtime-tested support without verified runtime evidence,
- merge a plane whose own 04B gates are red.
