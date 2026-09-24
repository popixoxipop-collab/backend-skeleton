# Web-game contract plane

The web-game plane is independent from the existing HTTP feature contract. It exists so a browser
game can freeze source-backed runtime structure without pretending a Scene, input handler, or
animation loop is an HTTP operation.

## v1 scope

The scanner recognizes projects whose package.json declares `three` or `@react-three/fiber` and
extracts only statically observed facts:

- scene declarations: `new Scene()`, namespace `new THREE.Scene()`, and React Three Fiber
  `<Canvas>`
- entities: Mesh / SkinnedMesh / InstancedMesh / Group / Object3D / Sprite plus common R3F JSX
  entity tags
- hierarchy: literal `parent.add(child)` edges
- input: DOM listener registrations, R3F JSX event handlers, and literal `event.code` /
  `event.key` checks
- simulation: named update/tick/step/animate/render/physics/simulate/move functions and
  `requestAnimationFrame` / `setAnimationLoop` registrations
- render: WebGLRenderer, WebGPURenderer, and R3F Canvas renderer presence
- network: literal WebSocket / socket.io endpoints
- assets: literal useGLTF/useTexture/load/loadAsync references
- physics package presence for Rapier, cannon-es, Ammo, and Havok packages

The scanner deliberately does **not** infer input-to-effect causality, arbitrary state transitions,
dynamic scene hierarchy, shader semantics, or runtime-only values. Those remain warnings/evidence
gaps for a browser/game oracle to resolve later.

## Commands

```bash
bskel webgame scan --json
bskel webgame contract emit --feature 001-gameplay --json
bskel webgame contract verify --feature 001-gameplay --json
```

The feature-scoped command writes:

- `specs/<feature>/contracts/<feature>.webgame.scan.json`
- `specs/<feature>/contracts/<feature>.webgame.json`

The contract schema is `sbf.webgame-contract/1` and contains independent scene, entity, input,
simulation, render, network, asset, and behavior planes. The behavior plane copies only observed
triggers and systems; it does not invent causal edges between them.

This plane does not satisfy, mutate, or weaken the existing HTTP `contract` gate.


## Freshness

`webgame contract verify` re-runs the source-backed scan and compares the persisted contract's
feature identity, scanner revision, and source hash. A source/package.json change or a future
scanner-semantics revision returns the normal stale exit code instead of silently treating the old
game contract as current. This remains separate from the HTTP contract gate.
