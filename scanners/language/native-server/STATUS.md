# T08 implementation status

Updated: 2026-09-25. Branch: `feat/t08-native-server-foundation`.

This file is a coordination snapshot for the 24-agent scale plan. It records what T08 has actually implemented and what remains gated by other tracks. It is not a support certificate.

| T08 task | State | Evidence / boundary |
|---|---|---|
| T08-01 language backend ADR | implemented in branch | `ADR.md` compares Go/C#/Rust static pilots vs compiler-backed candidates and freezes promotion criteria |
| T08-02 transport | implemented in branch | `bskel.native-language/1`, fatal UTF-8, LF/CRLF, request ID, response fact validation, byte/route/diagnostic budgets, bounded stdin worker process |
| T08-03 Go/C# pilot | implemented in branch | Gin literal group/routes; ASP.NET Core Minimal + controller literal routes; dynamic/conventional unknowns |
| T08-04 Rust pilot | implemented in branch | Axum literal route/nest/merge subset; Actix direct route/scope subset; raw-string/lifetime/cross-framework/turbofish regressions |
| T08-05 HTTP adapter composition | BLOCKED by planned interface freeze | do not edit `scanners/registry.mjs`, `scanners/index.mjs` or shared contract/capability schemas before T01/T02/T03 integration contract is accepted |
| T08-06 static worker packaging | implemented for Node/static pilot | exact-head macOS + Windows focused/package tests pass; exact-head GitHub Linux CI passes. Compiler-backed Go/.NET/Rust helper packaging remains future work behind an approved runner profile |

## Exact-head evidence before this status-only update

Product-code head: `545a83830f12f6a14c6ef28b52b6c995f8511058`.

- macOS / EOE: native-server focused suite **38/38 PASS**.
- macOS / EOE: T08 npm package regression **1/1 PASS**.
- Windows / Alienware: native-server focused suite **38/38 PASS**.
- Windows / Alienware: T08 npm package regression **1/1 PASS**.
- Linux / GitHub Actions: workflow run **36088649736 / #706** completed **success** for the exact product-code head.
- Linux matrix included Node 22/24 tests, package-install, Java/Python/TypeScript integrations, DB lanes, Rails 8.0/8.1, and the existing cross-feature checks; event-gated macOS/canary jobs were intentionally skipped.

The status document itself may advance the PR head without changing runtime code; the immutable product-code evidence above remains pinned to `545a838...`.

## Current T08 guarantees

The T08 static layer can return deterministic, source-backed literal route facts for its documented Gin, ASP.NET Core, Axum and Actix subsets, with explicit diagnostics rather than invented facts for the covered dynamic cases.

`worker.mjs` provides a real process boundary over the bounded NDJSON protocol. The npm package includes every T08 runtime module and excludes T08 development tests.

These facts are **not** registered bskel HTTP operations yet. They do not carry the shared ProjectRef/Claim/Capability semantics that T01/T02/T03 must freeze, and they are not framework support certificates.

## Known blockers and non-claims

EOE Tailnet short-exec policy currently denies direct `go`, `dotnet`, and `rustc` invocations. T08 treats this as an execution-policy block, not as evidence that the toolchains are absent. No policy bypass is attempted.

The static pilots do not claim Go type resolution, Roslyn semantic analysis, Rust macro expansion, framework runtime metadata, request/response schema, authorization enforcement, persistence binding, or production support.

Compiler-backed helpers need a separately approved runtime profile containing exact toolchain/helper digests, argv/cwd, source/module-cache mounts, environment/network allowlists, resource limits and cleanup ownership.

## Handoff to T01/T02/T03/T12/T13

T08 can provide deterministic per-source route facts and explicit diagnostics. The shared tracks must define the accepted ProjectRef/Claim/Capability envelope before these facts become registered bskel HTTP adapters.

When that interface is accepted, T08-05 should map:

- Go facts -> Gin target adapter;
- C# facts -> ASP.NET Core target adapter;
- Rust facts -> Axum/Actix target adapters;

without changing the existing legacy adapter selection path by default.
