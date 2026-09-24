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

## Automated acceptance

Validation commit: `b2e7255907b3cf0ccb945930772ae706bfbfeeec`  
GitHub Actions: run `#278` / id `36024180096`

The owned suite contains **30 Track A tests**. For validation only, a temporary root shim imported `test/webgame-scan/**` into the repository's existing `npm test`; that shim is removed in the final Track A diff to preserve parallel path ownership.

Verified in both supported CI Node lines:

- Node 22 job `107717117644`: **success**
- Node 24 job `107717117773`: **success**
- Full suite on each line: **1,898 tests / 1,888 pass / 0 fail / 10 expected real-repo skips**
- The Track A schema validation test is the final test (`ok 1898`) on Node 22, and the corresponding named test is present and passing on Node 24.

Negative cases covered:

- comment/template string contains `new Scene()`
- reference-only renderer
- nested example package dependency/runtime remains reference-only
- syntax error
- non-literal dynamic import
- WebSocket client without server
- Three.js dependency without runtime entry
- generator template containing Three.js runtime code
- template interpolation is explicit unresolved evidence
- output validates against project/plane/multiplane JSON schemas
- source-tree digest mutation check
- `forge/tests/fixtures/**` is classified as reference

## Integration boundary

Track A intentionally does not edit `bin/bskel.mjs`, `lib/cli.mjs`, `package.json`, legacy scan adapters, or gate/workflow files. Required shared-file wiring is documented in `integration/track-a.patch-request.md`.

## Real-repo acceptance status

- Poseidon: remote source inspection at commit `671053b812fcbffe8ecc4668eaa6ab7ffeb63287` confirms `three/webgpu`, `three/tsl`, `Scene`, `WebGPURenderer`, and active `renderer.render(...)` evidence in `src/main.js`. A full filesystem scan remains a separate acceptance step because this session does not have a local Poseidon checkout.
- img2threejs: remote source inspection at commit `6e60b5e22419464b4853e01ddb6c0e6f6659a733` confirms the strongest Three.js oracle source is under `forge/tests/fixtures/reference_target_oracle.ts`. Track A now explicitly classifies `test/tests/fixture/fixtures` paths as reference, so this material cannot promote itself to an active playable runtime.
- Messenger-copy / Messenger-local: not included in the public Track A fixture corpus; they remain local acceptance inputs and are intentionally not copied into this repository.

## Remaining integration blockers

1. **TypeScript compiler API dependency** — the parallel master calls for the TypeScript compiler API, but the current shared `package.json/package-lock.json` contains no `typescript` dependency and Track A is forbidden from editing those shared hot files. The implemented parser is a conservative fail-closed fallback; `PATCH-A-03` asks the Integrator to add the dependency and swap the backend behind the same parser interface.
2. **Messenger-copy / Messenger-local real checkout acceptance** — those private/local trees are not exposed in this session, so their artifacts remain explicitly `not-run`.
3. **Shared CLI wiring** — `scanMultiplane()` is implemented independently; `PATCH-A-01` requests the final CLI route without modifying legacy `runScan()`.

Track A static code is therefore **implemented and CI-validated within its owned paths**, while the three cross-boundary items above remain integration work rather than being silently claimed complete.
