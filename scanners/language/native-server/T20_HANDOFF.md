# T08 → T20 trust-boundary handoff

Status: review request, not an enforcement certificate.

T08 product-code revision for this handoff: `974fd99374722d9cdb931c3fed8f2b086010039a`.

T08 intentionally does not import or vendor T20's draft trust implementation. This document maps the current static native-language worker to the T20 candidate trust vocabulary so T20 can review the boundary before T08 ever asks T00/T23 for executable-path promotion.

## Execution surface

The current T08 executable path is a **first-party static metadata worker**, not target-runtime introspection and not a compiler helper.

`runner.mjs` launches exactly:

- executable: absolute `process.execPath` selected by the already-running trusted bskel process;
- argv: one absolute path to the packaged first-party `worker.mjs`;
- stdin: one validated `bskel.native-language/1` analyze request;
- stdout: one validated response/error envelope;
- shell: none;
- working directory dependency: none;
- target source: transferred in the request body, not opened by the child.

The worker imports only the packaged T08 JavaScript modules and executes the conservative static Go/C#/Rust analyzers. It does not execute target initializers, compilers, package managers, build scripts or framework runtime code.

## Current effective privilege shape

| T20 permission concept | T08 static worker behavior |
|---|---|
| filesystem read | no target/project file reads by the child; Node necessarily loads its runner-owned packaged JS modules |
| filesystem write | none requested by T08 code |
| network | no network API or network command exists in the worker/analyzers; **no OS-level egress sandbox is claimed** |
| process | parent launches one Node child; the child does not spawn descendants |
| environment | explicit empty, null-prototype environment; no PATH, NODE_OPTIONS, credentials, SystemRoot or WINDIR inherited |
| secret refs | none |
| wall limit | enforced by parent `spawnSync(..., timeout=...)` |
| stdout/output | bounded by protocol bytes and child maxBuffer |
| route/diagnostic counts | bounded before response acceptance |
| request authority | request may only **narrow** the runner profile; expansion throws `WORKER_BUDGET_EXPANSION` |

Default T08 static limits are 30 seconds, 4 MiB input, 4 MiB output, 20,000 route facts and 1,000 diagnostics. These are internal T08 defaults, not a T20 manifest or a production resource recommendation.

## T20 alignment already implemented

1. Ambient host environment is not inherited.
2. The child executable is not selected by the repository or request.
3. No shell command string is evaluated.
4. A request cannot increase runner-profile resource limits.
5. Request ID and language must match the child response.
6. Malformed route/group/diagnostic/framework facts fail closed at the transport boundary.
7. Worker errors are typed and nonzero.
8. Compiler/runtime paths remain disabled; direct `go`, `dotnet`, `rustc` execution is not attempted through an unapproved route.

## Deliberate gaps requiring T20/T16 ownership

The static worker is **not an OS sandbox**. T08 does not claim enforcement against a compromised first-party worker or Node runtime making syscalls directly.

Before a compiler-backed helper or target-runtime profile is enabled, T08 needs T20/T16 to freeze and enforce:

- normalized permission-manifest identity and exact effective-policy evidence;
- artifact/helper/toolchain digest binding and revocation generation;
- read-only source/module-cache mounts and isolated scratch;
- actual network denial/allowlisting;
- actual child-process/PID enforcement;
- stdout and stderr limits under the effective runner;
- symlink/socket/device/Docker-socket escape tests;
- cleanup ownership;
- runner/profile/attempt identity and T20 enforcement echo in T16 evidence.

## Review questions for T20

1. Should the runner-owned absolute `process.execPath` be represented to T20 as executable basename `node` plus a separately attested artifact/path identity?
2. Should package-module loading be outside repository `read_roots` as runner-owned code, while target-source reads remain denied for this stdin-only profile?
3. Is an empty inherited environment the expected static-helper default, with any future compiler bootstrap values supplied by the runner rather than inherited?
4. Should the T08 route/diagnostic count limits remain protocol-specific while wall/stdout/stderr limits are additionally bound by the T20 permission manifest?
5. What exact T20 evidence artifact should T08 require before calling a future compiler helper `trust-enforced`?

Until those questions are resolved and T00-04 is active, T08 will not wire this runner into the public scanner registry/CLI as an executable framework-support path.
