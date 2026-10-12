# T17 integration handoff

Status: draft implementation lane. This file records cross-track dependencies and does not authorize stable schema/CLI/package changes. It describes the base commit 15a38e923cb5e079c6f8e2a4c2a9386406c41f52 that `BASELINE.json` pins; `INTERFACE_RFC.md` states the interface and `README.md` gives the reading order.

## Implemented in T17-owned paths

- data-only exact-byte native export envelope for Unreal / Unity / Godot inputs (`native-export-envelope.mjs`; its shape is in `native-export-envelope.schema.json`)
- bounded JSON intake and producer implementation digest
- runtime/causal/state-transition claims are forced false at the native export intake boundary
- native structure normalizer that keeps declared structure only (`native-structure-normalizer.mjs`)
- no-engine-execution Unity and Godot text source exporters (`native-text-source-exporters.mjs`)
- the baseline record `BASELINE.json` with its test, and the interface RFC with its test

Not implemented at this revision: a bridge from `sbf.webgame-contract/1` documents into a game graph (an earlier version of this file listed one), engine adapter directories, and any call from the scanner, the registry or the command line into these modules. `BASELINE.json` records each of them as a limit.

## Cross-track requests

The requests below were made to the owning tracks in earlier review threads. This file does not track their state, and none of them is a precondition of the modules as they are.

### T23 package/release

At the base commit the npm files allowlist in `package.json` does not ship the top-level `adapters/` directory (limit `shadow-plane-is-not-in-the-published-package` in `BASELINE.json`).

Package certification requires either:
1. package the approved `adapters/game-next/**` files and assert them in packed-install tests, or
2. integration-owned relocation into an already shipped namespace.

Generic package-install success without asserting these files is not T17 package evidence.

### T20 trust/runtime

Actual engine/editor execution is not permitted by T17's data-only envelope.

T20 must provide an enforced target-runtime profile before T17 launches Unreal Editor, Unity Editor, or Godot headless tooling. The profile must bind executable identity, argv, read/write roots, environment, network, resources, devices and cleanup.

### T01 identity

T17's exact-byte artifact shape follows the `sbf.artifact-ref/1` candidate semantics of track T01. T17 does not promote that interface to stable and does not alter legacy HTTP identities.

If T01 changes the candidate ArtifactRef shape before freeze, T17 must replay its exact-byte formatting vectors and update this draft lane before cross-tool use.

### T16 runtime evidence

The native export envelope is not runtime behavior evidence. Engine metadata export cannot set:
- `runtime_behavior_verified`
- `causal_edges_verified`
- `state_transitions_verified`

T16/beval remains the owner of actual runtime binding/oracle evidence.

## Next T17-owned work allowed before runtime enforcement

- strengthen the envelope and normalizer invariants and the exact-byte negative tests
- keep the Three/R3F legacy path (`scanWebgame`, `buildWebgameContract`) pinned by `BASELINE.json` and covered by `test/webgame-contract.test.mjs`
- define engine-specific **pure parsers** for already-produced approved export bytes, provided they do not execute target code and remain draft
- add fixtures for Unreal/Unity/Godot export formats only after a concrete exporter format is pinned

## Work blocked pending other tracks

- launching Unreal/Unity/Godot tools
- claiming native engine support
- runtime behavior or causal certification
- stable/public game-next schema
- packed-package support until T23 integrates the namespace

### Native source provenance

Implemented in native export envelope revision 2:

- exact byte ArtifactRef per input source file;
- repo-relative POSIX path plus source role;
- absolute/parent/backslash paths rejected;
- duplicate source paths rejected;
- `source-export` requires at least one source input;
- verifier can compare provided source bytes to each source ref;
- normalized structure retains source refs unchanged.

This remains aligned with the T01 ArtifactRef candidate shape and does not create a competing global project/path identity. T02 still owns portable project identity once frozen.

Remaining gap: the future actual Unity/Godot/Unreal producer must be reviewed to ensure it calls this boundary with the true input bytes rather than fabricated refs.

### Source-only exporter implementation

T17 has a no-engine-execution first slice for:
- Unity text `.unity` / `.prefab`;
- Godot text `.tscn`.

These producers create exact source refs from the raw source bytes before generating draft JSON and then reuse the native envelope/normalizer. They do not require T20 target-runtime permission because they execute no engine/editor/compiler.

The test counts, exit codes and runner line at the base commit are recorded in `BASELINE.json` and recomputed by `test/game-next/baseline-record.test.mjs`; the CI observations in the record are read once and not recomputed. The few figures in this file are checked against the record by that test. In short: the two focused files hold 16 tests, the legacy web path is covered by 5 legacy tests in `test/webgame-contract.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` runs the T17 files. Generic root CI is not execution proof for these suites, because the root `npm test` runs `test/*.test.mjs` only. The nested runner and the workflow are reserved paths (`scripts/run-next-nested-tests.mjs`, `.github/workflows`) that T17 does not edit.
