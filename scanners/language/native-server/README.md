# T08 native-server language backend (pilot)

Status: isolated foundation; not registered as a bskel scanner adapter yet.

This directory implements the T08-owned language boundary without modifying `scanners/registry.mjs`, `scanners/index.mjs`, schemas, package locks, or CLI entrypoints. The pilot is intentionally conservative: it emits source-backed literal routes and explicit diagnostics for paths it cannot prove.

## T08-01 parser/backend decision

| Language | Pilot backend | Why this first | Explicit non-claim |
|---|---|---|---|
| Go | deterministic static JS scanner over Go source | Gin group/route registration is enough to validate the common route fact boundary without installing Go | not `go/ast`/`go/types` parity; build tags, generated code and helper factories are not resolved |
| C# | deterministic static JS scanner over C# source | ASP.NET Minimal APIs and controller attributes exercise group composition plus declarative metadata | not Roslyn semantic parity; inherited attributes and ApiExplorer metadata are not resolved |
| Rust | protocol slot only | proc-macro/build-script behavior needs a separate approved compiler/runtime profile | no Axum/Actix support is claimed in this batch |

Next comparison work should run the same frozen fixtures through Go `go/ast`/`go/types`, Roslyn syntax/semantic models, and a Rust syntax/compiler metadata candidate. Installing a compiler or successfully executing `--version` is environment evidence, not parser correctness.

## T08-02 transport boundary

`protocol.mjs` defines `bskel.native-language/1`, a one-message-per-line JSON/NDJSON envelope with fatal UTF-8 decoding and bounded input/output/route/diagnostic/wall-time budgets. It deliberately does not spawn helpers. A later runner must bind an exact helper digest, argv, cwd, environment allowlist and OS sandbox profile before execution.

Messages use a caller-supplied `requestId`; helper output must echo it. Protocol, message kind and language are validated before a response can be consumed. Oversized input, malformed UTF-8, multiline payloads and unsupported versions fail closed.

## T08-03 current analyzers

`go.mjs` resolves:

- `r := gin.Default()` / `gin.New()` roots;
- nested literal `Group("/prefix")` assignments;
- literal `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/Any` calls on resolved routers/groups;
- simple identifier/selector handlers when visible.

`csharp.mjs` resolves:

- nested ASP.NET Core `MapGroup("/prefix")` variables rooted at `app`;
- literal Minimal API `MapGet/MapPost/MapPut/MapPatch/MapDelete` paths;
- controller `[Route("...")]` plus direct `[HttpGet/.../HttpOptions]` attributes;
- `[controller]` replacement from the controller class name.

Computed paths are diagnostics, not guessed routes. `MapMethods`, inherited route metadata, build/runtime convention discovery and generated registrations remain unproved. No target code, compiler plugin, build script or framework initializer is executed.

## Output boundary

The pilot result is a language fact object, not an HTTP contract and not a supported-framework certificate. T08-05 will map approved facts into the future HTTP adapter envelope only after shared T01/T02/T03 interfaces are frozen.
