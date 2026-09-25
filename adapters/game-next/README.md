# game-next adapter bridge

This directory is an opt-in, draft bridge for the T17 game-plane expansion. It does not replace or mutate `sbf.webgame-contract/1`.

## Legacy webgame bridge

`legacy-webgame-bridge.mjs` projects the exact bytes of an existing `sbf.webgame-contract/1` document into a conservative draft game graph:

- the bridge accepts UTF-8 contract bytes, parses those bytes, and derives an exact-byte `sbf.artifact-ref/1`-shaped reference for the input artifact;
- formatting-only JSON changes therefore produce a different source artifact identity even when the parsed game meaning is equivalent;
- source-backed scene/entity/input/system/loop/renderer/network/asset declarations become typed graph nodes;
- literal `scene.hierarchy` observations become `hierarchy-symbolic` relations;
- physics package declarations become deterministic physics nodes;
- legacy `behavior.triggers` and `behavior.systems` are *not* converted to edges, because those planes are projections of separately observed input/system facts;
- causal edges, state transitions, dynamic hierarchy and runtime state remain unresolved.

The exact-byte artifact shape follows the current T01 candidate boundary so T17 can preserve source-contract bytes, but the game graph itself remains an internal draft and does not promote or replace T01 or legacy HTTP identity contracts.

### Authority boundary

`sbf.webgame-contract/1` remains the authoritative game contract. The draft graph records:

```text
exact webgame contract bytes
        |
        +-- byte_sha256 + size_bytes --> source_contract.artifact
        |
        +-- parsed v1 items ----------> draft game graph nodes/relations
```

A persisted graph can be checked against the exact source bytes with `verifyLegacyBridgeInvariants(graph, { sourceBytes })`. Different bytes fail the artifact check even if they parse to the same JSON value.

## Native engine export intake

`native-export-envelope.mjs` is a **data-only intake boundary** for future Unreal, Unity and Godot exporters. It does not launch an editor, compiler or engine.

It currently accepts exact UTF-8 JSON export bytes with a bounded size and binds:

- engine;
- evidence class;
- engine version and platform;
- producer ID/version plus a declared implementation SHA-256 field (metadata only; not attestation);
- exact export byte SHA-256 and byte length;
- a non-authoritative payload descriptor containing only declared schema and top-level keys.

The allowed evidence classes deliberately stop short of runtime certification:

| Engine | Accepted draft evidence classes |
|---|---|
| Unreal | `source-export`, `editor-export` |
| Unity | `source-export`, `editor-export` |
| Godot | `source-export`, `headless-export` |

The envelope hard-codes these claims to false:

```text
producer_identity_verified = false
runtime_behavior_verified  = false
causal_edges_verified       = false
state_transitions_verified  = false
```

Therefore the presence of an Unreal/Unity/Godot export artifact is never enough to claim producer attestation, runtime behavior or causality. T20/T16 must supply those evidence classes separately.

Actual engine/editor execution remains a separate T20 target-runtime isolation task and future T17 engine-specific exporter task. T08 language facts may feed source-export producers, but this module does not import or execute T08 code.

## Invariants

The legacy bridge fails closed on:

- invalid UTF-8 or malformed JSON;
- another webgame contract version;
- duplicate derived node/relation IDs;
- invented causal edges or state transitions;
- a mismatched source artifact when exact bytes are supplied to the invariant checker.

The native export envelope fails closed on:

- unsupported engine/evidence-class combinations;
- invalid UTF-8/non-object JSON;
- byte-budget overflow;
- malformed producer implementation digest;
- mismatched exact export bytes;
- mutation of runtime/causal/transition claims to true.

These draft files are not public replacement contracts. They are internal migration surfaces while legacy consumers keep reading the exact v1 webgame contract.

## Focused tests

```bash
node --test test/game-next/game-next-bridge.test.mjs
node --test test/game-next/game-native-export-envelope.test.mjs
node --test test/game-next/game-next-schema.test.mjs
```

The bridge suite also runs a real `scanWebgame -> buildWebgameContract -> bridgeLegacyWebgameContract` pipeline and verifies that a discovered `KeyW` and `movePlayer` never become a causal edge.

## Test discovery integration

T17 tests intentionally live under `test/game-next/**`, the T17-owned test namespace. The current root `npm test` glob only expands `test/*.test.mjs`, so a generic green root CI job does **not** prove these nested suites ran until T23/T00 integrates nested discovery. T17 runs the three commands above explicitly for focused evidence.


## Native structure normalization

`native-structure-normalizer.mjs` consumes the exact bytes already bound by a native export envelope and accepts only three pinned internal payload profiles:

- `sbf.game-unreal-structure-export/draft-1`
- `sbf.game-unity-serialized-export/draft-1`
- `sbf.game-godot-scene-export/draft-1`

The normalized result is `sbf.game-native-structure/draft-1` with status `declared-structure-only`.

It preserves only structural declarations:

- Unreal reflection type/property/function declarations plus explicit replication/RPC specifiers;
- Unity serialized object `class_id`/`file_id`, component/parent links and GUID/fileID references;
- Godot scene/node/resource declarations and signal connection declarations.

It does not convert those declarations into runtime behavior. All verification/causality/state claims remain false. Unknown payload fields, engine/schema mismatches, duplicate derived identities, conflicting Unreal network specifiers, and exact-byte mismatches fail closed.

See `NATIVE_STRUCTURE_FORMATS.md` for the source semantics and official engine documentation used to constrain the draft formats.

### Source provenance for source-only exporters

Native export envelope revision 2 now carries `source_inputs[]`. Each item contains a repo-relative POSIX path, a source role, and an exact-byte `sbf.artifact-ref/1`-shaped reference with family `game-native-source`.

`source-export` is rejected when this list is empty. The envelope verifier can additionally receive the actual source bytes by path and rejects missing or mismatched bytes. Absolute paths, parent traversal, backslashes and duplicate source paths fail closed.

The normalized native structure retains the same source refs unchanged. This establishes byte identity/provenance, but does not set `source_structure_verified`; independent verification remains a separate evidence step.
