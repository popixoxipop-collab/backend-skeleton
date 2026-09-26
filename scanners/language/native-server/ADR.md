# T08 ADR: native-server language analysis backends

Status: proposed pilot decision. This file does not certify a framework or compiler runtime.

## Decision

The native-server layer has one transport/fact boundary but does **not** force every language through one parser implementation. Go, C# and Rust now all have conservative static pilots behind that boundary. T08 will validate language-native analyzers behind the same deterministic fact envelope.

| Language | Phase 1 | Phase 2 candidate | Semantic/runtime candidate | Stop/upgrade rule |
|---|---|---|---|---|
| Go | current conservative source pilot | standard-library `go/parser` + `go/ast` | `go/types` with an explicitly pinned module/build context | replace/augment the pilot only when frozen route fixtures reduce false positives/unknowns without executing arbitrary build hooks |
| C# | current conservative source pilot | Roslyn syntax trees | Roslyn semantic model plus an explicitly approved ASP.NET endpoint metadata exporter | semantic mode stays optional; unresolved references/attributes remain unknown rather than falling back to regex guesses |
| Rust | current conservative Axum/Actix source pilot | syntax parser candidate | compiler metadata only in a sandboxed, pinned toolchain profile | proc-macro/build-script execution is never implicit; target adapter/runtime certification remains separate |
| other native/server languages | no implementation claim | language-owned parser RFC | approved helper profile if needed | must add fixtures and a maintainer before admission |

## Why not Tree-sitter-only

A common concrete syntax tree can improve source spans and error recovery, but it does not by itself resolve Go types, C# attributes/inheritance, Rust macro expansion, generated registrations or framework runtime metadata. T08 therefore standardizes the helper **boundary**, not one parser engine.

## Why a static pilot exists first

The Go/Gin and C#/ASP.NET slices exercise the two important shapes the shared boundary must preserve:

1. imperative route/group registration and prefix composition;
2. declarative controller/attribute metadata.

The pilot intentionally accepts only literal facts. It gives the later native parser implementations an independent, frozen expected-output corpus rather than letting the new compiler-backed analyzer create its own oracle.

## Trust boundary

Static analysis must not run target module initializers, build scripts, annotation processors, compiler plugins, proc macros, package install hooks or network fetches. If a later helper needs compilation or framework metadata, a separate runner must bind:

- exact helper/toolchain digest and supported protocol revision;
- argv and working directory;
- read-only source/module-cache mounts and dedicated scratch/output roots;
- environment-variable and network allowlists;
- CPU, memory, PID, wall-time and output limits;
- cleanup ownership and an immutable result artifact.

Successful `go version`, `dotnet --version`, compiler exit 0 or package installation is environment evidence only. It is not framework coverage or semantic correctness.

## Fact contract for the pilot

A route fact is accepted only when the analyzer can bind at least an HTTP method, a composed literal path, framework label and source location. A visible simple handler may be attached but is not required. Dynamic/computed paths generate diagnostics and no invented route. Unknown conventional routing, inherited metadata and generated registrations are never silently replaced with a default.

The language fact is not an SBF HTTP contract. Project identity, operation identity, request/response schema, security semantics, persistence binding and runtime verification remain later layers owned by their respective shared tracks.

## Frozen comparison cases

Go comparison must preserve: nested group prefix composition; `:=` and `var ... =`; comments; unrelated methods; computed path abstention; deterministic ordering.

C# comparison must preserve: nested Minimal API groups; controller/action literal routes; `[controller]`/`[action]`; braces inside string literals; comments; computed path abstention; no invented conventional route; `MapMethods` method-set abstention.

Transport comparison must preserve: protocol mismatch rejection; fatal UTF-8; LF/CRLF; one-message-per-line framing; request ID echo; byte/route/diagnostic budget rejection.

## Promotion criteria

A native parser backend can replace the source pilot for a target only after:

1. the frozen cases above are byte-stable or have an explicitly reviewed semantic delta;
2. new real-repository fixtures have independent expected route facts;
3. unsupported/dynamic constructs increase explicit diagnostics instead of silent false facts;
4. repeated input is deterministic;
5. helper absence/failure degrades to a scoped diagnostic, not a different guessed analyzer result;
6. packaged-install tests prove the helper or optional dependency is actually shipped/resolvable;
7. no target code executes in the static profile.

T08-05 will consume approved language facts only after the shared project/capability/contract interfaces are frozen. Until then these modules stay unregistered from the main scanner CLI.


## T08-04 pilot result

The Rust source pilot is now implemented behind the same unregistered native-language boundary. Its purpose is to freeze source-backed facts and abstention behavior before any compiler/proc-macro execution is considered.

The local comparison corpus now covers Axum chained methods, nested routers, turbofish constructors, computed-path abstention, raw-string false-positive resistance, Rust lifetimes, Actix direct routes/scopes, unsupported method builders, and mixed-framework isolation. This is still Discovery-level evidence only; no Rust framework adapter has been registered with the main bskel scanner.
