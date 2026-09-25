# T00-04 Interface pre-freeze

Status: **BLOCKED_PREFREEZE** — this is a coordination freeze, not a stable public schema release.

## What is frozen now

- Existing `sbf.contract-ref/1`, `sbf.action-ref/1`, `sbf.field-ref/1` exact-byte identity stays authoritative.
- `beval.binding-json/1` canonical serialization is unchanged.
- `unknown`, `partial`, `unsupported`, and `not-applicable` remain distinct.
- Project/language/persistence/game/protocol analysis cannot redefine HTTP operation identity.
- Game/protocol causality is never inferred from adjacency, names, or matching symbols.
- Runtime evidence binds execution; it does not repair upstream contract meaning.
- Stable CLI/schema/package/workflow surfaces remain T00/T23 integration-owned.

## Candidate seams

| Seam | Current candidate | T00 disposition |
|---|---|---|
| Artifact/identity refs | T01 `sbf.artifact-ref/1`, `sbf.identity-envelope/1` | candidate stable after review; HTTP-only v1 |
| Project graph | T02 `sbf.project-graph/draft-1` | keep internal draft |
| Capability states | T03 five-state model | semantics candidate; public schema later |
| Reconciliation | T09 decision graph | **blocked by correctness failure** |
| Persistence | T10 `sbf.persistence-ir/1` | internal candidate |
| Game | existing `sbf.webgame-contract/1` + T17 draft bridge | legacy public + draft next |
| Protocol | T18 independent protocol family | separate family; cross-tool identity later |
| Runtime binding | T16 `beval.runtime-binding/1` | rebase then review |

## Required invariants

1. Artifact identity means exact bytes, never semantic equivalence.
2. Existing ContractRef/ActionRef/FieldRef remains readable throughout migration.
3. Project IDs are repo-local planning identity until T01 explicitly defines otherwise.
4. Legacy adapter booleans bridge only their current narrow meaning.
5. `supported` next-capabilities require evidence except an explicit legacy bridge.
6. Synthesized operation IDs are never source-authored identity.
7. Persistence binding is explicit; name/table similarity never silently binds resources.
8. `sbf.webgame-contract/1` remains authoritative until a reviewed game-family migration exists.
9. T17 game graph may derive observed nodes but leaves causal edges/transitions empty by default.
10. RuntimeBinding is beval-owned and must match the exact attempt/evidence hashes.

## Blocking gates before FINAL_FREEZE

- T00-01 epoch-2 exact-head baseline checks/review complete.
- T09 #83 exact-head semantic regression fixed.
- T12 #66 removed from premature stable auto-registration and green.
- T13 #67 exact-head regression green.
- T16 #41 rebased on current beval main and green.
- T15 #8 split into dependency-safe baseline/reader vs later renderer/package patch.
- Legacy A/C absorption acknowledged by canonical owners.

Until these are satisfied, no track may publish a new competing top-level IR or widen stable schemas.
