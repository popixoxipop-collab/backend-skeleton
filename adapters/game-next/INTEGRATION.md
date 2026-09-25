# T17 integration handoff

Status: draft implementation lane. This file records cross-track dependencies and does not authorize stable schema/CLI/package changes.

## Implemented in T17-owned paths

- exact-byte `sbf.webgame-contract/1` -> internal game graph bridge
- preserved legacy item addressability via exact source artifact + plane + item_id
- no causal edge or state-transition inference
- data-only exact-byte native export envelope for Unreal / Unity / Godot inputs
- bounded JSON intake and producer implementation digest
- runtime/causal/state-transition claims are forced false at the native export intake boundary

## Cross-track requests

### T23 package/release

Current npm `files` allowlist does not ship the top-level `adapters/` directory.

Request filed on PR #78, comment 5825831481.

Package certification requires either:
1. package the approved `adapters/game-next/**` files and assert them in packed-install tests, or
2. integration-owned relocation into an already shipped namespace.

Generic package-install success without asserting these files is not T17 package evidence.

### T20 trust/runtime

Actual engine/editor execution is not permitted by T17's data-only envelope.

Request filed on PR #79, comment 5825857021.

T20 must provide an enforced target-runtime profile before T17 launches Unreal Editor, Unity Editor, or Godot headless tooling. The profile must bind executable identity, argv, read/write roots, environment, network, resources, devices and cleanup.

### T01 identity

T17's exact-byte artifact shape follows the current `sbf.artifact-ref/1` candidate semantics from T01 PR #82. T17 does not promote that interface to stable and does not alter legacy HTTP identities.

If T01 changes the candidate ArtifactRef shape before freeze, T17 must replay its exact-byte formatting vectors and update this draft lane before cross-tool use.

### T16 runtime evidence

The native export envelope is not runtime behavior evidence. Engine metadata export cannot set:
- `runtime_behavior_verified`
- `causal_edges_verified`
- `state_transitions_verified`

T16/beval remains the owner of actual runtime binding/oracle evidence.

## Next T17-owned work allowed before runtime enforcement

- strengthen draft graph invariants and exact-byte negative tests
- keep Three/R3F legacy bridge regression coverage
- define engine-specific **pure parsers** for already-produced approved export bytes, provided they do not execute target code and remain draft
- add fixtures for Unreal/Unity/Godot export formats only after a concrete exporter format is pinned

## Work blocked pending other tracks

- launching Unreal/Unity/Godot tools
- claiming native engine support
- runtime behavior or causal certification
- stable/public game-next schema
- packed-package support until T23 integrates the namespace
