# T08 implementation status

Updated: 2026-09-25. Branch: `feat/t08-native-server-foundation`.

This is a coordination snapshot for the 24-agent scale plan. It records what T08 has actually implemented and what remains gated by other tracks. It is not a framework support certificate.

| T08 task | State | Evidence / boundary |
|---|---|---|
| T08-01 language backend ADR | implemented in branch | Go/C#/Rust static pilots vs compiler-backed candidates; promotion criteria in `ADR.md` |
| T08-02 transport + static worker runner | implemented in branch | `bskel.native-language/1`, validated facts, bounded NDJSON worker, real parent-enforced timeout, zero ambient env, fail-closed profile budgets |
| T08-03 Go/C# pilot | implemented in branch | Gin literal groups/routes; ASP.NET Core Minimal + controller literal routes; computed/conventional cases abstain |
| T08-04 Rust pilot | implemented in branch | Axum literal route/nest/merge subset; Actix direct route/scope subset; ownership/cross-framework/raw-string/lifetime regressions |
| T08-05 HTTP adapter composition | **BLOCKED** | T00-04A is not active; T01/T02/T03 interfaces are draft. No registry/CLI/shared-schema mutation from T08 |
| T08-06 static worker packaging | implemented for current Node/static slice | macOS + Windows focused/package verification; package includes runtime files, excludes T08 tests. Compiler-backed helper packaging remains future work |

## Verification revision

Exact checkout tested for the current static slice:

`66e804bb2b8fb08fc2c902204a7581f5605fdac1`

Evidence collected directly:

- macOS / EOE: native-server focused suite **51/51 PASS**.
- Windows / Alienware: native-server focused suite **51/51 PASS**.
- macOS / EOE: T08 npm package test **1/1 PASS**.
- Windows / Alienware: T08 npm package test **1/1 PASS**.
- macOS / EOE: existing registry + adapter/provider conformance + package-manifest batch **25/25 PASS**.
- The exact-head GitHub CI for this rapidly updated branch was still queued when this snapshot was prepared. A queued/cancelled run is not recorded as green.
- Earlier product-code revision `545a83830f12f6a14c6ef28b52b6c995f8511058` did complete the repository GitHub CI matrix successfully; that older success is not substituted for current exact-head CI.

## Current trust boundary

The static runner launches one absolute `process.execPath` child with one absolute packaged `worker.mjs`; no shell is used.

The child receives an empty, null-prototype environment. It does not inherit PATH, NODE_OPTIONS, provider credentials, project configuration, SystemRoot or WINDIR. This exact arrangement passed the current focused suite on both macOS and Windows.

A request may narrow runner resource limits, but may not expand them. A trusted caller may supply a wider profile for supported limits. `maxInputBytes` currently cannot exceed the worker's 4 MiB bootstrap reader; a profile attempting to advertise a larger input ceiling is rejected as `WORKER_PROFILE_UNSUPPORTED` instead of pretending the worker can honor it.

This remains a first-party static helper boundary, **not an OS sandbox**. T20/T16 own eventual permission-manifest enforcement, artifact/toolchain trust and runtime evidence.

## Scope cleanup / cross-track handoff

- the out-of-lease root shim `test/native-server-language.test.mjs` has been removed;
- T08 tests stay under `test/language-native-server/**`;
- T20 review requested on PR #79; details in `T20_HANDOFF.md`;
- T19 independent QA requested on PR #74; details in `T19_HANDOFF.md`;
- T08 remains HOLD_SCOPE under the T00 04B matrix;
- no public scanner registration is attempted before T00/T23 integration lease and active shared interfaces.

## Known non-claims

T08 does not claim Go type resolution, Roslyn semantic analysis, Rust macro expansion, framework runtime metadata, request/response schema, authorization enforcement, persistence binding, code generation or runtime-tested framework support.

The exposed Tailnet short-exec policy denies direct `go`, `dotnet` and `rustc` invocation. This is recorded as an execution-policy block, not evidence those toolchains are absent, and no bypass is attempted.
