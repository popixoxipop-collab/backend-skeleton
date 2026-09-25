# T20 execution-surface inventory

Captured from `backend-skeleton` main commit `5472a8b82655840d1d3ce76cb926987376e37ca6`.
Status: T20-01/T20-02 implementation evidence. This is an inventory for later enforcement, not a claim that current code is sandboxed.

## Classification

| Class | Current examples | Trust implication | T20-03 treatment |
|---|---|---|---|
| First-party local metadata helper | `lib/repo.mjs` invokes `git`; `scanners/text-util.mjs` and framework scanners invoke `rg` | Executes known local binaries but should not initialize target applications | dedicated local-helper profile; explicit executable identity/path policy |
| First-party write/codegen helper | `handles/_engine.mjs` invokes `git status` while protecting generated writes | Has write-adjacent authority; failure must stay fail-closed | repository-write profile and staged output boundary |
| Explicit network command | `new/spring.mjs` calls `fetch(start.spring.io)`; preflight shell may call remote git/`gh api` | Network is intentional but command-specific | exact destination/profile, no ambient egress |
| Bundled compiler/parser helper | `handles/providers/java-spring/ast-bridge.mjs` invokes Java/Gradle and documents Maven Central download on first use | May execute build tooling and network; not equivalent to a pure parser | opt-in compiler-helper sandbox, pinned helper/dependency identity |
| Target runtime introspection | `scanners/adapters/ruby-rails.mjs::introspectRailsRoutes` runs target `bin/rails routes --expanded` | Executes repository-controlled code and currently inherits `process.env` | untrusted-target sandbox; filtered environment; deny-by-default network; bounded output/time |
| Database-connected tool | CLI/http/DDL/introspection paths consume connection strings from named environment variables | Can reach stateful external systems and expose credentials/data | dedicated DB permission + secret reference + read/write mode; never inherit general process env |
| Local HTTP server | `lib/http-server.mjs` imports `node:http` and may consume DB credentials | Opens a listening surface and can bridge DB access | bind-address/port permission and network namespace policy |

## Concrete findings

### Static scanners are not all pure functions

The normal FastAPI/Spring/Express discovery paths use `rg` through `child_process`. That is a trusted helper invocation, not target-code execution. T20 must therefore avoid a blanket rule such as “any `child_process` import means untrusted runtime.” The future runner needs capability classes.

### Rails runtime routes are a separate trust boundary

The default Rails scanner is static, but explicit runtime route introspection executes:

```text
<projectRoot>/bin/rails routes --expanded
```

with `cwd=projectRoot`, a 60 second timeout, 16 MiB output buffer, and `env: process.env`. Because `bin/rails` and application initialization are target-controlled, this belongs to the untrusted-target profile. T20-03 must replace ambient environment inheritance with an explicit approved environment map before this path can be called sandbox-enforced.

### Java AST helper is explicit but can acquire dependencies

The Java AST bridge is only used on explicit AST paths. It executes the bundled Gradle wrapper and warns that first use can download dependencies from Maven Central. This belongs to a compiler-helper profile with pinned wrapper/helper identity and an explicit network policy. A successful parse is not evidence that unrestricted network/process access was safe.

### Preflight and greenfield network are first-party, command-scoped

`bskel preflight` can refresh Git remotes and optionally call `gh api`; `new spring` calls Spring Initializr. These are not target runtime introspection, but they still require command-specific network permissions. “bskel needs network” is too broad a permission.

### Database credentials are a separate secret domain

Several existing CLI/DB/server paths read a connection string from an environment variable named by a flag/config. This is preferable to loading arbitrary `.env` files, but T20 should still model the value as a scoped secret reference. A future external adapter or target runtime must never inherit it merely because bskel itself can access it.

## Required profile classes for T20-03

1. `local-metadata`: read-only repository access; only pinned local helpers such as git/rg; no target initialization and no network.
2. `compiler-helper`: approved bundled helper; scratch write; bounded children/output; network deny unless a pinned dependency acquisition phase is explicitly approved.
3. `target-runtime`: repository code is untrusted; read-only source mount, isolated scratch, filtered env, no secrets by default, network deny by default.
4. `network-command`: first-party command with exact destination and protocol/port grant.
5. `database-read` / `database-write`: separate secret ref and database destination; read and mutation permissions cannot collapse into one boolean.
6. `local-server`: explicit bind address/port and lifetime/cleanup ownership.

## Hard requirements before T20-03 can be called enforced

- T00-04 common interface freeze is accepted.
- permission manifest is bound to an immutable runner/profile revision.
- OS/container/VM enforcement is tested independently from the in-process `canRead/canConnect/canExecute` decisions.
- symlink/path traversal, inherited environment, socket/Docker socket access, subprocess escape and cleanup fixtures exist.
- target runtime and compiler helper do not receive provider/user secrets unless a named secret reference is explicitly granted.
- evidence records the actual enforced profile, not only the requested manifest.

This inventory intentionally does not modify existing execution paths yet. Doing so before T00-04 would create cross-track interface drift.
