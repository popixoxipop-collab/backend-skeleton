# game-next adapter bridge

This directory is an opt-in, draft bridge for the T17 game-plane expansion. It does not replace or mutate `sbf.webgame-contract/1`.

## First slice

`legacy-webgame-bridge.mjs` projects an existing `sbf.webgame-contract/1` document into a conservative draft game graph:

- source-backed scene/entity/input/system/loop/renderer/network/asset declarations become typed graph nodes;
- literal `scene.hierarchy` observations become `hierarchy-symbolic` relations;
- physics package declarations become deterministic physics nodes;
- legacy `behavior.triggers` and `behavior.systems` are *not* converted to edges, because those planes are projections of separately observed input/system facts;
- causal edges, state transitions, dynamic hierarchy and runtime state remain unresolved.

The draft graph is deliberately not a public replacement contract. It is an internal migration surface for future engine adapters such as Unreal, Unity and Godot while legacy consumers keep reading the exact v1 webgame contract.

## Invariants

The bridge fails closed on another webgame contract version and rejects duplicate derived node/relation IDs. `verifyLegacyBridgeInvariants()` also rejects any causal edge or transition claim in this static-only bridge output.

Run the focused test with:

```bash
node --test test/game-next-bridge.test.mjs
```
