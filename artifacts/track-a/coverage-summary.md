# Track A static coverage summary

## Implemented

- Nested package-root project discovery with deterministic read-set.
- Active/reference/generated/vendor/template/test-fixture source-role separation, including package-level provenance.
- Read-only JS/TS/Svelte analysis with original source line/column and SHA-256 source/package digests.
- Three.js import provenance: named aliases and namespace imports are recognized; same-named local classes are not.
- Renderer-instance binding: an unrelated object `.render()` cannot complete a Three.js runtime proof.
- Three.js/WebGPU/TSL renderer, scene, material, loader and render-loop evidence.
- Asset, browser worker, network client/server and API evidence.
- HTTP server and WebSocket/multiplayer server capabilities are separate.
- Multi-domain graph composition through `scanMultiplane()` without changing legacy `runScan()`.
- Explicit unresolved findings for syntax damage, non-literal dynamic imports, template interpolations the conservative lexer cannot analyze, and malformed Svelte comments.
- JSON Schema validation for project, plane and multiplane outputs.

## Automated acceptance

Validation commit: `cb6049d68ba0049a4fe7fef6975c2beaab157174`  
GitHub Actions: run **#300** / id `36027868011`

A temporary Integrator-style root shim imported `test/webgame-scan/**` into the repository's existing `npm test` solely for validation. It is removed in the final Track A diff to preserve parallel path ownership.

Verified on both CI Node lines:

- Node 22 job `107728957374`: **success**
- Node 24 job `107728957377`: **success**
- Full workflow run #300: **success**
- Full suite on each Node line: **1,909 tests / 1,899 pass / 0 fail / 10 expected real-repo skips**
- Baseline before Track A: **1,879 tests**
- Track A owned suite: **30 tests**
- The Track A schema validation test is the final test, `ok 1909`, in the Node 22 log; the corresponding test is also present and passing in Node 24.

## False-PASS and uncertainty guards covered

- comments and ordinary template-string text do not manufacture Three.js evidence
- regex literal text does not manufacture constructor/render evidence
- Svelte HTML-commented fake `<script>` is inert
- unclosed Svelte HTML comment remains inert and reports unresolved syntax
- reference-only runtime evidence cannot become an active playable runtime
- nested example/test package dependencies remain reference-only
- syntax damage and non-literal dynamic imports remain explicit unresolved evidence
- executable template interpolation not analyzed by the fallback lexer is explicit unresolved evidence
- Three.js dependency alone is only partial
- generator templates cannot become playable runtime evidence
- unrelated object `.render()` cannot satisfy renderer runtime proof
- Three.js namespace/named aliases retain import provenance
- same-named local `WebGLRenderer`/`Scene` cannot masquerade as Three.js
- WebSocket client-only evidence cannot claim a multiplayer server
- `ws` plus an unrelated `http.Server` cannot claim a WebSocket server
- plain HTTP server evidence is distinct from WebSocket/multiplayer proof
- `ws` dependency-only network state remains partial
- source tree remains unchanged by analysis and repeated scans are deterministic
- project/plane/multiplane output validates against the committed schemas

## Integration boundary

Final Track A diff intentionally does not modify:

- `bin/bskel.mjs`
- `lib/cli.mjs`
- `package.json` / `package-lock.json`
- existing gate/workflow files
- legacy scanner arbitration / `runScan()`

Shared-file work is documented in `integration/track-a.patch-request.md`.

## Real-repo acceptance status

- **Poseidon**: remote source inspection at commit `671053b812fcbffe8ecc4668eaa6ab7ffeb63287` confirms active `three/webgpu`, `three/tsl`, `Scene`, `WebGPURenderer`, and `renderer.render(...)` evidence. This is explicitly remote source inspection, not represented as a local `scanMultiplane()` run.
- **img2threejs**: remote source inspection at commit `6e60b5e22419464b4853e01ddb6c0e6f6659a733` confirms Three.js oracle material under `forge/tests/fixtures/reference_target_oracle.ts`; Track A classifies such test/fixture paths as reference and prevents promotion to active runtime.
- **Messenger-copy / Messenger-local**: private/local checkouts are not exposed to this conversation's available tools, so their artifacts remain explicitly `not-run`; no result is fabricated.

## Remaining cross-boundary integration blockers

1. **Foundation freeze** — the parallel Master calls for common runtime/execution-plan/receipt/probe schemas plus ID/verdict helpers before integration. Those common Foundation artifacts are not currently present as one frozen shared layer across A/B/C. Integrator must freeze them and provide compatibility mapping before merging tracks.
2. **TypeScript compiler API** — the Master calls for the TypeScript compiler API, but the shared package declares no `typescript` dependency and Track A is not allowed to edit shared package files. The current implementation is a conservative fail-closed lexical fallback behind the Track A parser interface.
3. **Shared CLI/test wiring** — the final `bskel webgame analyze` route and permanent inclusion of `test/webgame-scan/**` belong to the Integrator.
4. **Messenger real-checkout acceptance** — remains pending until an authorized local/remote workspace exposing those repositories is available.

Track A static implementation is therefore **code-complete and CI-validated inside its owned paths**, with the four integration items above deliberately left as explicit handoff work.
