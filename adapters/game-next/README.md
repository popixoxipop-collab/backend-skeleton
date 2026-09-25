# game-next adapter bridge

This directory is an opt-in, draft bridge for the T17 game-plane expansion. It does not replace or mutate `sbf.webgame-contract/1`.

## First slice

`legacy-webgame-bridge.mjs` projects the exact bytes of an existing `sbf.webgame-contract/1` document into a conservative draft game graph:

- the bridge accepts UTF-8 contract bytes, parses those bytes, and derives an exact-byte `sbf.artifact-ref/1`-shaped reference for the input artifact;
- formatting-only JSON changes therefore produce a different source artifact identity even when the parsed game meaning is equivalent;
- source-backed scene/entity/input/system/loop/renderer/network/asset declarations become typed graph nodes;
- literal `scene.hierarchy` observations become `hierarchy-symbolic` relations;
- physics package declarations become deterministic physics nodes;
- legacy `behavior.triggers` and `behavior.systems` are *not* converted to edges, because those planes are projections of separately observed input/system facts;
- causal edges, state transitions, dynamic hierarchy and runtime state remain unresolved.

The exact-byte artifact shape follows the current T01 candidate boundary so T17 can preserve source-contract bytes, but the game graph itself remains an internal draft and does not promote or replace T01 or legacy HTTP identity contracts.

## Authority boundary

`sbf.webgame-contract/1` remains the authoritative game contract. The draft graph records:

```text
exact webgame contract bytes
        |
        +-- byte_sha256 + size_bytes --> source_contract.artifact
        |
        +-- parsed v1 items ----------> draft game graph nodes/relations
```

A persisted graph can be checked against the exact source bytes with `verifyLegacyBridgeInvariants(graph, { sourceBytes })`. Different bytes fail the artifact check even if they parse to the same JSON value.

## Invariants

The bridge fails closed on:

- invalid UTF-8 or malformed JSON;
- another webgame contract version;
- duplicate derived node/relation IDs;
- invented causal edges or state transitions;
- a mismatched source artifact when exact bytes are supplied to the invariant checker.

The draft graph is deliberately not a public replacement contract. It is an internal migration surface for future engine adapters such as Unreal, Unity and Godot while legacy consumers keep reading the exact v1 webgame contract.

Run the focused test with:

```bash
node --test test/game-next-bridge.test.mjs
```

The focused suite also runs a real `scanWebgame -> buildWebgameContract -> bridgeLegacyWebgameContract` pipeline and verifies that a discovered `KeyW` and `movePlayer` never become a causal edge.
