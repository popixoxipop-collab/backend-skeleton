# Track A static coverage summary

## Implemented

- Project discovery with nested package-root ownership.
- Read-only JS/TS/Svelte parsing with original source line/column evidence and SHA-256 source digests.
- Active/reference/generated/vendor/template source-role separation.
- Test/fixture directories are reference inputs, so oracle code cannot become a playable-runtime claim.
- Three.js/WebGPU/TSL renderer, scene, material, loader and render-loop evidence.
- Asset, browser worker, network client/server and API evidence.
- Multi-domain graph composition without changing legacy `runScan()`.
- Explicit unresolved findings for syntax damage and non-literal dynamic imports.

## Local acceptance

`node --test test/webgame-scan/*.test.mjs`

- 16 tests
- 16 passed
- 0 failed

Negative cases covered:

- comment/template string contains `new Scene()`
- reference-only renderer
- syntax error
- non-literal dynamic import
- WebSocket client without server
- Three.js dependency without runtime entry
- generator template containing Three.js runtime code
- source-tree digest mutation check
- `forge/tests/fixtures/**` is classified as reference

## Integration boundary

Track A intentionally does not edit `bin/bskel.mjs`, `lib/cli.mjs`, `package.json`, legacy scan adapters, or gate/workflow files. Required shared-file wiring is documented in `integration/track-a.patch-request.md`.

## Real-repo acceptance status

- Poseidon: remote source inspection at commit `671053b812fcbffe8ecc4668eaa6ab7ffeb63287` confirms `three/webgpu`, `three/tsl`, `Scene`, `WebGPURenderer`, and active `renderer.render(...)` evidence in `src/main.js`. A full filesystem scan remains a separate acceptance step because this session does not have a local Poseidon checkout.
- img2threejs: remote source inspection at commit `6e60b5e22419464b4853e01ddb6c0e6f6659a733` confirms the strongest Three.js oracle source is under `forge/tests/fixtures/reference_target_oracle.ts`. Track A now explicitly classifies `test/tests/fixture/fixtures` paths as reference, so this material cannot promote itself to an active playable runtime.
- Messenger-copy / Messenger-local: not included in the public Track A fixture corpus; they remain local acceptance inputs and are intentionally not copied into this repository.
