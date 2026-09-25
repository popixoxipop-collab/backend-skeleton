# T08 implementation status

Updated: 2026-09-25. Branch: `feat/t08-native-server-foundation`.

This file is a coordination snapshot for the 24-agent scale plan. It records what T08 has actually implemented and what remains gated by other tracks. It is not a support certificate.

| T08 task | State | Evidence / boundary |
|---|---|---|
| T08-01 language backend ADR | implemented in branch | `ADR.md` compares Go/C#/Rust pilot vs compiler-backed candidates and freezes promotion criteria |
| T08-02 transport | implemented in branch | `bskel.native-language/1`, fatal UTF-8, LF/CRLF, request ID, fact validation, byte/route/diagnostic budgets, bounded stdin worker process |
| T08-03 Go/C# pilot | implemented in branch | Gin literal group/routes; ASP.NET Core Minimal + controller literal routes; dynamic/conventional unknowns |
| T08-04 Rust pilot | implemented in branch | Axum literal route/nest/merge subset; Actix direct route/scope subset; raw-string/lifetime/cross-framework regressions |
| T08-05 HTTP adapter composition | BLOCKED by planned interface freeze | do not edit `scanners/registry.mjs`, `scanners/index.mjs` or shared contract/capability schemas before T01/T02/T03 integration contract is accepted |
| T08-06 platform packaging | partial | npm package inclusion (including `worker.mjs`) has a dedicated regression; compiler/toolchain backend availability is not yet certified |

## Verified on EOE

At branch head before this status-only update:

- focused native-server suite: 35/35 PASS (including real Node worker process round-trips);
- registry/conformance/package/native integration batch: 26/26 PASS;
- `npm pack --dry-run --json`: native-server runtime modules present;
- previous foundation head `a32d44b...`: full GitHub CI matrix PASS, with intentionally event-gated jobs skipped.

The current head must still receive its own GitHub CI result before this branch is called repository-wide green.

## Known blockers and non-claims

EOE Tailnet short-exec policy currently denies direct `go`, `dotnet`, and `rustc` invocations. T08 treats this as an execution-policy block, not as evidence that the toolchains are absent. No policy bypass is attempted.

The static pilots do not claim Go type resolution, Roslyn semantic analysis, Rust macro expansion, framework runtime metadata, request/response schema, authorization enforcement, persistence binding, or production support.

## Handoff to T01/T02/T03/T12/T13

T08 can provide deterministic per-source route facts and explicit diagnostics. The shared tracks must define the accepted ProjectRef/Claim/Capability envelope before these facts become registered bskel HTTP adapters.

When that interface is accepted, T08-05 should map:

- Go facts -> Gin target adapter;
- C# facts -> ASP.NET Core target adapter;
- Rust facts -> Axum/Actix target adapters;

without changing the existing legacy adapter selection path by default.
