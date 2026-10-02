# T08 implementation status

Updated: 2026-09-25 (snapshot date). Branch at that time: `feat/t08-native-server-foundation`.

Current state (`main` at `ad24e0d8`, checked 2026-10-03): that branch no longer exists on the remote, and its backend-skeleton PR 76 was closed without merge on 2026-09-26 (UTC). The T08 files are on `main`; they arrived with PR 147 (merged 2026-09-26 UTC). Everything below is the 2026-09-25 snapshot unless a section or table column says it is current.

This is a coordination snapshot for the 24-agent scale plan. It records what T08 has actually implemented and what remains gated by other tracks. It is not a framework support certificate.

| T08 task | State on 2026-09-25 (historical) | Evidence / boundary on 2026-09-25 (historical) | On `main` at `ad24e0d8` (checked 2026-10-03) |
|---|---|---|---|
| T08-01 language backend ADR | implemented in branch | Go/C#/Rust static pilots vs compiler-backed candidates; promotion criteria in `ADR.md` | `ADR.md` is on `main`. Not re-evaluated. |
| T08-02 transport + static worker runner | implemented in branch | `bskel.native-language/1`, validated facts, bounded NDJSON worker, real parent-enforced timeout, zero ambient env, fail-closed profile budgets | `protocol.mjs`, `runner.mjs` and `worker.mjs` are on `main`. Not re-run for this update. |
| T08-03 Go/C# pilot | implemented in branch | Gin literal groups/routes; ASP.NET Core Minimal + controller literal routes; computed/conventional cases abstain | `go.mjs` and `csharp.mjs` are on `main`. Not re-run for this update. |
| T08-04 Rust pilot | implemented in branch | Axum literal route/nest/merge subset; Actix direct route/scope subset; ownership/cross-framework/raw-string/lifetime regressions | `rust.mjs` is on `main`; there is no Rust consumer (see the update below). Not re-run for this update. |
| T08-05 HTTP adapter composition | **BLOCKED on 2026-09-25** | T00-04A is not active; T01/T02/T03 interfaces are draft. No registry/CLI/shared-schema mutation from T08 | Partly superseded, see the update below: T00-04A is recorded as `ACTIVE_CORE_FREEZE` (its evidence was not re-verified). The state of the T01/T02/T03 interfaces was not re-checked. |
| T08-06 static worker packaging | implemented for current Node/static slice | macOS + Windows focused/package verification; package includes runtime files, excludes T08 tests. Compiler-backed helper packaging remains future work | `test/language-native-server/package.test.mjs` is on `main`. The macOS/Windows results quoted below are from 2026-09-25 and were not repeated. |

## Update (`main` at `ad24e0d8`, checked 2026-10-03)

The first three columns of the table above are the 2026-09-25 state; its last column and the list below are the state on `main`. Current facts on `main`:

- `release/next/release-plan.json` (lines 46-48) records the prerequisite T00-04A with
  `observed_state` `ACTIVE_CORE_FREEZE`. Its `coordination_ref` names evidence that exists only on the
  branch `scale/T00/bootstrap-baseline`, not on `main`; this update did not re-verify that evidence.
- `bskel.native-language/1` has two consumers: Go Gin (`adapters/http-wave-a/gin.mjs`) and ASP.NET Core
  (`adapters/http-wave-a/aspnet-core.mjs`), with tests under `test/http-wave-a/`.
- There is no Rust consumer. `rust-axum` and `rust-actix-web` exist only as catalog entries
  (`adapters/http-wave-bc/catalog.mjs:9-10`).
- No scanner registry or CLI code imports these adapters. A source search of `main` found them referenced
  only by tests, the nested-test runner (`scripts/run-next-nested-tests.mjs`, T12) and the CI step
  `T12 http-wave-a`.
- This is not a framework support certificate and changes no acceptance state.

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
- 2026-09-25 text: T20 review requested on PR 79; details in `T20_HANDOFF.md`;
  - Current state (checked 2026-10-03): the handoff documents name no repository, so which PR is meant is inferred from title, head branch and creation date (2026-09-25), not stated. The inferred PR is backend-skeleton PR 79 ("feat(t20): add fail-closed trust permission foundation", head branch `scale/T20/trust-boundary-foundation`); it was closed without merge on 2026-09-26 (UTC), and the reason is not recorded in this file. The same-numbered Backend-evaluation PR was merged on 2026-10-01, was created after this snapshot and is a different item. No review outcome is recorded here.
- 2026-09-25 text: T19 independent QA requested on PR 74; details in `T19_HANDOFF.md`;
  - Current state (checked 2026-10-03): same inference as above. The inferred PR is backend-skeleton PR 74 ("test(t19): seed independent QA corpus and negative-vector foundation", head branch `scale/t19-qa-corpus-foundation`); it was closed without merge on 2026-09-25 (UTC), and the reason is not recorded in this file. The same-numbered Backend-evaluation PR was merged on 2026-09-28, was created after this snapshot and is a different item. No QA outcome is recorded here.
- T08 remains HOLD_SCOPE under the T00 04B matrix;
- no public scanner registration is attempted before T00/T23 integration lease and active shared interfaces.

## Known non-claims

T08 does not claim Go type resolution, Roslyn semantic analysis, Rust macro expansion, framework runtime metadata, request/response schema, authorization enforcement, persistence binding, code generation or runtime-tested framework support.

The exposed Tailnet short-exec policy denies direct `go`, `dotnet` and `rustc` invocation. This is recorded as an execution-policy block, not evidence those toolchains are absent, and no bypass is attempted.
