# Three.js target-01: source scope, fixtures, and evidence plan

This is the `GAME-threejs-01` **static source-scope** record. It is not a Three.js runtime implementation, asset decoder, exporter certification, or `GAME-threejs-02/-03` bridge/certificate. The existing `scanners/webgame.mjs` and `docs/webgame-contract.md` are the source of scanner behavior; this file narrows what a target-01 result may mean. The companion React Three Fiber version is pinned to make the overlapping scanner surface explicit, but this record awards no `GAME-r3f-01` credit.

## Immutable upstream version boundary

`RELEASE_PINS.json` records the exact upstream identities read on 2026-10-30:

| Component | Exact version | Upstream identity | Source file identity |
|---|---|---|---|
| Three.js | `three@0.180.0` | [tag `r180`](https://github.com/mrdoob/three.js/tree/r180), annotated tag object `9e8635e2031c25859dc47ba07e72230dccb2682a`, peeled commit `0af9729d0c143a86a1d725d6e2c3ad83301f3f34` | [`package.json`](https://github.com/mrdoob/three.js/blob/r180/package.json) Git blob `fb4fe9d2224cffaf922f006cbff4b4adda87ecf5`; [`GLTFExporter.js`](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/exporters/GLTFExporter.js) Git blob `2da060f940b591fa0a461a34b936d94c80a0cebd` |
| React Three Fiber companion | `@react-three/fiber@9.0.0` | [tag `v9.0.0`](https://github.com/pmndrs/react-three-fiber/tree/v9.0.0), commit `95500b437af0403a1f822388a661b15f508c5627` | [`packages/fiber/package.json`](https://github.com/pmndrs/react-three-fiber/blob/v9.0.0/packages/fiber/package.json) Git blob `ec267b80c8b05c28504d0b1b97cf1ba63de543d1` |

The fixture specification materializes a temporary `package.json` with the **exact** Three.js version, not a semver range. No fixture `package.json` lives in this repository, so a scan of the repository itself cannot accidentally discover it as an application project. The existing webgame contract test's `^0.180.0` and `^9.0.0` are historical scanner examples, not installed-version or exporter-version proof. A package declaration is not a lockfile, installation receipt, runtime attestation, or proof of the version that generated an asset. Version drift requires a new target-scope adjudication; the scanner itself does not enforce this pin.

## Supported observation and counterexamples

| Fixture | Static observation | Required limit |
|---|---|---|
| `fixtures/static-declaration.fixture.json` | The test materializes a temporary project. Imported `THREE.Scene`, `Mesh`, `WebGLRenderer`, literal `scene.add(actor)`, named animation loop, and direct `loader.load('/assets/direct.glb')` are recorded by the scanner. | Only syntax and literal URI are observed. No renderer execution, scene membership at a frame, asset load success, or input-to-effect claim. |
| `fixtures/counterexamples.fixture.json`: asset indirection | The test materializes `loader.load(assetUri)` with a computed URI. | The scanner returns no asset URI. Dynamic asset resolution is unknown, not an absent asset. |
| `fixtures/counterexamples.fixture.json`: lifecycle | `scene.add(actor)` is followed by `scene.remove(actor)` and geometry disposal. | The scanner still records the `add` edge; it does not model removal, disposal, current hierarchy, or runtime-only state. Even a scanner `completeness.status='complete'` cannot override this limit. |
| `fixtures/counterexamples.fixture.json`: exporter version | The synthetic `assets/model.gltf` is materialized outside the JS/package source set and says its exporter release is unknown. | The scanner does not read or hash this file. Neither the installed `three` package nor the upstream `GLTFExporter.js` blob proves the asset's actual exporter version. Asset changes leave the scanner source hash unchanged. |

The negative fixture is deliberately synthetic; it is a counterexample to *claim inference*, not evidence of a specific real engine or exporter defect. The fixture/test must not replace a runtime browser oracle. The scanner's `complete` status only means its narrow scene-and-loop detection criteria passed. It is not a target certification or a claim that every unsupported construct generated a diagnostic.

## Reproducible evidence and next gates

Run `node --test test/game-next/threejs-target-scope.test.mjs`, `node --test test/webgame-contract.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact reviewed source revision. Record the commands, exit codes, TAP totals, source revision, and SHA-256 of every target-owned file in `GAME_THREEJS_01_VALIDATION.json`. The scope test asserts the positive observations, all three counterexamples, exact fixture package pin, upstream pin record structure, and that a changed asset does not change the scanner source hash. Run T17 ownership validation over the branch diff and repeat the tests on the protected merge on Bob.

`GAME-threejs-02` still needs a bridge into common claims and production wiring. `GAME-threejs-03` needs independent fixture/cross-verification and limited certification or an explicit blocked decision. T00/T19/T20 release and signed independent attestation remain separate gates. This target-01 record cannot change `RELEASE_GATE=NOT_PASS` or `release=BLOCKED`.
