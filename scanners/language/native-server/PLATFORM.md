# T08 platform matrix

Status: evidence snapshot for the static Node-based native-server pilot. This is not a compiler-backed language support certificate.

| Platform | Exact product-code revision | Static analyzer/worker | npm package inclusion | Evidence |
|---|---|---|---|---|
| macOS ARM64 (EOE) | `545a83830f12f6a14c6ef28b52b6c995f8511058` | 38/38 focused tests PASS | 1/1 package test PASS | direct Tailnet execution on EOE |
| Windows (Alienware) | `545a83830f12f6a14c6ef28b52b6c995f8511058` | 38/38 focused tests PASS | 1/1 package test PASS | fresh branch clone + direct Tailnet execution |
| Linux GitHub runner | `545a83830f12f6a14c6ef28b52b6c995f8511058` | included in `npm test` through root shim | package-install job PASS | GitHub CI run 36088649736 (#706), conclusion success |

## What this proves

- the current static Go/C#/Rust analyzers and NDJSON worker execute on the three listed OS families under Node;
- LF/CRLF framing, process-boundary worker behavior, deterministic facts, route/diagnostic/output budgets and the documented static fixtures pass;
- `npm pack` includes the T08 runtime modules and excludes T08 development tests;
- existing repository tests and integrations remain green on the exact product-code revision through the repository CI matrix.

## What this does not prove

- Go `go/ast`/`go/types`, Roslyn, or Rust compiler/proc-macro helper availability;
- every CPU architecture, filesystem, locale or Node release;
- framework runtime metadata correctness;
- full Gin/ASP.NET/Axum/Actix framework support;
- HTTP contract, persistence, auth or codegen support.

Compiler-backed helper certification is a separate future profile and must not inherit this static-worker evidence automatically.
