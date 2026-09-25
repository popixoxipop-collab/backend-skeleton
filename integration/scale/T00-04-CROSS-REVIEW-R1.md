# T00-04 Cross-Interface Review R1

Generated: 2026-09-25  
Status: **BLOCKED_PREFREEZE**  
This document narrows what may become stable. It does not authorize stable CLI/schema/package changes.

## Stable invariants that remain authoritative

1. Existing `sbf.contract-ref/1`, `sbf.action-ref/1`, and `sbf.field-ref/1` remain authoritative for HTTP meaning.
2. Exact artifact identity means exact bytes. Semantic equivalence never substitutes for the byte digest.
3. `beval.binding-json/1` remains unchanged.
4. Unknown, partial, unsupported and not-applicable remain distinct.
5. Project/language/persistence/game/protocol analysis cannot redefine an HTTP operation identity.
6. Runtime evidence cannot repair upstream contract meaning.
7. Game/protocol causality is never inferred from adjacency, naming, temporal order or matching symbols.
8. Shared CLI/schema/package/workflow changes remain T00/T23-owned integration work.

## Cross-track review findings

### T01 identity — candidate semantics, no cutover yet

T01's `sbf.artifact-ref/1` correctly carries exact byte SHA-256 + size + media/family/version and keeps legacy ContractRef/ActionRef/FieldRef readable.

Disposition:
- candidate for vendored cross-tool use after golden review;
- additive only;
- no replacement of legacy HTTP refs;
- no semantic hash aliasing.

### T02 ProjectGraph — internal draft only

Current graph serializes an absolute execution path in `repo_root`.

Risk:
- identical source checked out in two worktrees can produce different serialized bytes;
- those bytes are unsafe as a portable cache/cross-tool identity.

Required before promotion:
- separate execution-only absolute root from portable serialized graph;
- persist repo-relative roots/marker provenance only;
- coordinate the portable fingerprint with T21;
- do not make `project:<relative-root>` globally authoritative.

Disposition: **KEEP_INTERNAL_DRAFT**.

### T03 capabilities/certification — status vocabulary useful, evidence type not trusted yet

The five-state capability model is a good semantic seam:
`supported | partial | unsupported | unknown | not-applicable`.

However, `capabilityRecord()` / `certificationRecord()` currently accept arbitrary non-empty strings in `evidenceRefs`.

Risk:
- a caller can create a superficially `supported` or `runtime-tested` record with a token such as `"proof"`;
- string presence is not proof of an immutable artifact or execution.

Required before authoritative certification:
- evidence references must validate as an exact artifact/evidence reference;
- T01 ArtifactRef may identify immutable files;
- T16/beval binding must identify runtime execution evidence;
- runtime-tested must require the runtime-evidence class, not just any artifact.

Disposition:
- five-state semantics: **CANDIDATE**;
- authoritative support/certification records: **BLOCKED**.

### T09 reconciliation — blocked correctness seam

Exact-head CI remains red on synthesized operation-ID handling.

Required:
- synthesized IDs remain explicitly synthesized and non-source-authored;
- `none / absent / unknown / unsupported / ambiguous` distinctions survive;
- root OpenAPI security inheritance remains distinguishable;
- legacy HTTP v9 writer remains authority until green.

Disposition: **BLOCKED**.

### T10 persistence — internal draft; provenance validation missing

Current `sbf.persistence-ir/1` preserves several important ambiguities, but:
- `source_refs` are passed through without validating each reference;
- a caller-provided entity `id` is accepted without a frozen shape.

Required before trusted consumption:
- validate evidence kind/provider/path/line;
- repo source paths must be portable/repo-relative or explicitly non-portable;
- define allowed entity-ID shape/version;
- do not bind resource→entity by name/table similarity.

Disposition: **KEEP_INTERNAL_DRAFT**.

### T17 game bridge — exact source-contract binding required

The game bridge preserves observed legacy item IDs and correctly leaves causal edges/transitions empty.

Gap:
- the derived graph carries source metadata/hash but not an exact byte ArtifactRef to the input `sbf.webgame-contract/1` document.

Required before cross-tool trusted use:
- bind the graph to exact source-contract bytes;
- preserve legacy webgame item addressability;
- do not infer state transitions or input effects.

Disposition:
- `sbf.webgame-contract/1`: remains authority;
- next game graph: **DERIVED_DRAFT**.

### T18 protocol plane — static family useful; action identity unbound

Protocol contract/flow correctly distinguishes ordering, causation and correlation.

Gap:
- flow `action_ref` is only a non-empty string;
- it does not prove existence of an item in an exact protocol contract.

Required before cross-tool/runtime use:
- typed protocol-item reference;
- bind it to exact source protocol contract bytes;
- validate family + item existence;
- no name-based repair or heuristic resolution.

Disposition: **DRAFT_FAMILY**.

### T16 RuntimeBinding — sound direction, stale branch

Current `beval.runtime-binding/1` binds exact run/profile/contract/runner/artifact/attempt identity and rejects non-canonical/mismatched evidence.

Keep:
- exact `contract_hash`;
- attempt nonce;
- exact runner/profile/artifact hashes.

Required:
- rebase/reconstruct on beval epoch-3 main `7a04cb705ca4cd162091d67fea5589e19fad163f`;
- move tests into owned scope;
- vendor reviewed T01 schema/golden bytes instead of importing bskel;
- any ArtifactRef enrichment is additive.

Disposition: **REBASE_THEN_REVIEW**.

## Current operational blockers

| Track | Current gate |
|---|---|
| T00-01 | epoch-3 beval exact-head CI #868 + independent T19 review |
| T09 #83 | semantic CI failure |
| T12 #66 | live registry boundary violation + CI failure |
| T13 #67 | functional CI green, but root test shim still outside lease |
| T15 #8 | split all-in-one renderer/product/package patch |
| T16 #41 | stale beval base + queued CI + test re-home |
| Legacy A #63 | canonical-owner absorption acknowledgement |
| Legacy C #62 | canonical-owner absorption acknowledgement |

## Final-freeze policy

T00-04 FINAL_FREEZE must **not** try to stabilize every next IR at once.

### Eligible for earliest freeze after blockers clear

- legacy exact-byte HTTP identity remains unchanged;
- T01 additive exact ArtifactRef / HTTP identity envelope;
- T03 five-state capability vocabulary;
- T00 ownership/lease/fencing protocol;
- evidence requirement that runtime-tested means verified runtime evidence, not string presence.

### Remain internal/draft after first freeze

- T02 project graph;
- T09 reconciliation decision graph until green;
- T10 persistence IR;
- T17 next game graph;
- T18 protocol contract/flow cross-tool identity;
- T16 runtime binding until epoch-3 rebase and replay.

This staged freeze lets HTTP/framework expansion continue without prematurely committing all new planes to public compatibility promises.

## Integration order after blockers clear

1. Accept T00-01 epoch 3.
2. Freeze T01 identity compatibility + T03 capability semantics.
3. Keep T02/T10/T17/T18 outputs internal but make their boundaries explicit.
4. Land language-analysis foundations into their isolated namespaces.
5. Land legacy compatibility bridge after re-home.
6. Land HTTP experimental leaves only as non-registered adapters.
7. Add T23-owned package/test discovery changes once all path re-homes are complete.
8. Promote individual framework profiles only after T19 evidence certification.
