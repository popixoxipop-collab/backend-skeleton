# React Three Fiber target-01: static scope, fixtures, and evidence plan

This is the `GAME-r3f-01` target-owned **static source-scope** record. It describes what the existing `scanners/webgame.mjs` can observe in React Three Fiber source and what it cannot conclude. It is not an R3F renderer, a browser/runtime oracle, a glTF decoder or exporter certificate, or the `GAME-r3f-02/-03` bridge/certification. The adjacent Three.js target-01 record does not award R3F credit.

## Exact upstream boundary

`RELEASE_PINS.json` fixes the two source-release identities checked on 2026-10-30:

| Component | Exact package release | Upstream source identity |
|---|---|---|
| React Three Fiber | `@react-three/fiber@9.0.0` | [tag `v9.0.0`](https://github.com/pmndrs/react-three-fiber/tree/v9.0.0), commit `95500b437af0403a1f822388a661b15f508c5627`, [`packages/fiber/package.json`](https://github.com/pmndrs/react-three-fiber/blob/v9.0.0/packages/fiber/package.json) Git blob `ec267b80c8b05c28504d0b1b97cf1ba63de543d1` |
| Three.js | `three@0.180.0` | [tag `r180`](https://github.com/mrdoob/three.js/tree/r180), annotated tag object `9e8635e2031c25859dc47ba07e72230dccb2682a`, commit `0af9729d0c143a86a1d725d6e2c3ad83301f3f34`, [`package.json`](https://github.com/mrdoob/three.js/blob/r180/package.json) Git blob `fb4fe9d2224cffaf922f006cbff4b4adda87ecf5` |

The pinned R3F package declares `three >=0.156` and `react ^19.0.0` as peer ranges; the chosen Three.js `0.180.0` satisfies the former. These are upstream source facts, not an installed dependency tree. The fixture specifications materialize a temporary `package.json` with exact Three/R3F versions, but they are **not a lockfile** or an install/runtime attestation. The test does not load React, Three, a browser, or a real asset. The source scanner does not enforce the pins. A version change needs new adjudication. The pinned Three.js `GLTFExporter.js` blob `2da060f940b591fa0a461a34b936d94c80a0cebd` identifies upstream code, not the exporter version of any observed asset.

## Static observations and counterexamples

The fixture JSON stays under `adapters/game/r3f/fixtures` and is materialized only in a temporary project during tests. No fixture `package.json` lives in the repository, so scanning this repository does not accidentally detect the example as an R3F application.

| Fixture | What the scanner records | What remains unknown |
|---|---|---|
| `static-declaration.fixture.json` | `@react-three/fiber` and `three` package declarations, a `<Canvas>` scene/renderer, a named JSX `<mesh>`, and an `onClick` listener. | `<Canvas>` or `<mesh>` rendering, input-to-effect, `useFrame` callback execution, and the `useLoader(GLTFLoader, literal)` asset are **not** established. The v1 scanner does not parse `useFrame` or `useLoader`; its status is `partial` for this example. |
| `counterexamples.fixture.json`: asset indirection | `<Canvas>` and a conditional JSX mesh syntax are still visible. | A computed `assetUri` passed to `useLoader` produces no resolved asset URI. Even the direct `useLoader` example above is outside the current scanner's literal asset recognizer. No missing asset should be inferred from an empty `assets` list. |
| `counterexamples.fixture.json`: lifecycle | The conditional mesh is recorded as a declaration regardless of the `mounted` prop and `dispose={null}`. | Whether the mesh exists at a frame, whether R3F disposes it, or whether `useFrame` runs is unknown. Source syntax is not current hierarchy or lifecycle state. |
| `counterexamples.fixture.json`: exporter version | The synthetic glTF file is outside the scanner's source/package read set. | Changing its bytes leaves `source_hash` unchanged. Installed Three/R3F declarations and an upstream exporter blob cannot prove the actual asset exporter release. |

The counterexamples constrain **claim inference**, not actual R3F behavior or an upstream defect. In particular, scanner `completeness.status` only expresses the scanner's narrow scene-and-loop rule; it is not target certification. R3F documentation describes runtime Canvas, hooks, and disposal behavior, but this static scanner does not execute that behavior.

## Reproduction and remaining gates

Run `node --test test/game-next/r3f-target-scope.test.mjs`, `node --test test/webgame-contract.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact reviewed source revision. Record commands, exit codes, TAP totals, source revision, and SHA-256 for all target-owned files in `GAME_R3F_01_VALIDATION.json`. Check T17 ownership and diff cleanliness, then repeat on Bob against the exact protected merge. Independent review and exact-head required CI are separate prerequisites for a one-row official MET adjudication.

`GAME-r3f-02` still needs a bridge into common claims and production wiring; `GAME-r3f-03` needs independent cross-verification and bounded certification or an explicit blocked result. `GAME-threejs-02/-03`, T00/T19/T20, signed independent attestation, and `release=BLOCKED` remain unchanged by this target-01 record.
