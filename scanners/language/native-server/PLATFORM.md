# T08 static platform evidence matrix

Status: evidence snapshot for the first-party Node/static native-server pilot. This is not a compiler-backed language support certificate.

Verification revision: `66e804bb2b8fb08fc2c902204a7581f5605fdac1`.

| Platform | Focused analyzer/transport/worker/runner | npm package check | Evidence status |
|---|---:|---:|---|
| macOS ARM64 / EOE | **51/51 PASS** | **1/1 PASS** | direct Tailnet execution at exact revision |
| Windows / Alienware | **51/51 PASS** | **1/1 PASS** | direct Tailnet execution at exact revision |
| Linux / GitHub Actions | exact-head run pending at snapshot time | exact-head run pending | do not infer green from older head |

Additionally on macOS / EOE, the existing registry, adapter/provider conformance and package-manifest regression subset passed **25/25** at the same revision.

An older T08 code revision `545a83830f12f6a14c6ef28b52b6c995f8511058` completed the full GitHub CI matrix successfully. That historical run is useful compatibility evidence but is not an exact-head result for the revision above.

## What the current macOS/Windows evidence proves

- current Go/C#/Rust static analyzers execute under Node on the two listed OS families;
- the real Node child worker and parent runner round-trip correctly;
- zero ambient environment inheritance works on both platforms;
- timeout, response binding, byte/count budgets and request-vs-profile privilege checks follow the focused fixtures;
- npm pack contains the T08 runtime modules and excludes the T08 development tests.

## What it does not prove

- OS-level syscall/network/filesystem sandboxing;
- Go `go/ast`/`go/types`, Roslyn or Rust compiler/proc-macro helper availability;
- every CPU architecture, filesystem, locale or Node release;
- full Gin/ASP.NET/Axum/Actix framework coverage;
- HTTP contract, persistence, auth, codegen or runtime-tested support.

Compiler-backed helper certification is a separate future profile and must not inherit this static-worker evidence automatically.
