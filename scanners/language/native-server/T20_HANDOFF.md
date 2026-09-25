# T08 → T20 trust-boundary handoff

Status: review request, not an enforcement certificate.

T08 verification revision for this handoff: `66e804bb2b8fb08fc2c902204a7581f5605fdac1`.

T08 intentionally does not import or vendor T20's draft trust implementation. This document maps the current static native-language worker to the T20 candidate trust vocabulary so T20 can review the boundary before T08 ever asks T00/T23 for executable-path promotion.

## Execution surface

The current T08 executable path is a **first-party static metadata worker**, not target-runtime introspection and not a compiler helper.

`runner.mjs` launches exactly:

- executable: absolute `process.execPath` selected by the already-running trusted bskel process;
- argv: one absolute path to the packaged first-party `worker.mjs`;
- stdin: one validated `bskel.native-language/1` analyze request;
- stdout: one validated response/error envelope;
- shell: none;
- target source: transferred in the request body, not opened by the child;
- inherited environment: **none**.

The worker imports only packaged T08 JavaScript modules and executes the conservative static Go/C#/Rust analyzers. It does not execute target initializers, compilers, package managers, build scripts or framework runtime code.

## Effective privilege shape

| T20 permission concept | T08 static worker behavior |
|---|---|
| filesystem read | no target/project reads by child; Node loads runner-owned packaged JS modules |
| filesystem write | none requested |
| network | no network API/command in worker/analyzers; **no OS-level egress enforcement is claimed** |
| process | parent launches one Node child; child launches no descendants |
| environment | empty null-prototype map; no ambient host variables |
| secret refs | none |
| wall limit | parent `spawnSync` timeout |
| stdout/output | protocol byte bound + process buffer bound |
| route/diagnostic counts | bounded before response acceptance |
| request authority | may narrow profile; expansion throws `WORKER_BUDGET_EXPANSION` |
| input bootstrap | profile cannot exceed current 4 MiB bootstrap reader; otherwise `WORKER_PROFILE_UNSUPPORTED` |

The 30 second / 4 MiB / 20,000-route / 1,000-diagnostic defaults are internal T08 defaults, not a T20 manifest or production recommendation.

## Alignment already implemented

1. Ambient host environment is not inherited.
2. Child executable and worker path are not selected by repository/request input.
3. No shell command is evaluated.
4. Request-side resource expansion is fail-closed.
5. A profile cannot advertise an input size the worker bootstrap cannot honor.
6. Request ID and language must match the response.
7. Malformed route/group/diagnostic/framework facts fail closed.
8. Worker errors are typed and nonzero.
9. Compiler/runtime paths remain disabled.

## Deliberate gaps requiring T20/T16

This static worker is **not an OS sandbox**. T08 does not claim enforcement against a compromised first-party worker/Node runtime making direct syscalls.

Compiler-backed helpers or target-runtime profiles require frozen and independently enforced:
- permission-manifest identity and effective-policy evidence;
- artifact/helper/toolchain digest and revocation generation;
- read-only source/module-cache mounts and isolated scratch;
- network/process/filesystem enforcement;
- stdout/stderr/PID/wall limits;
- symlink/socket/device/Docker-socket adversarial fixtures;
- cleanup ownership;
- runner/profile/attempt identity;
- T20 enforcement echo bound into T16 evidence.

## Questions for T20

1. Represent absolute runner-owned `process.execPath` as basename `node` plus separately attested artifact/path identity?
2. Treat package-module loading as runner-owned code outside repository read_roots while target source reads stay denied?
3. Keep empty inherited environment as static-helper default, with any compiler bootstrap values runner-owned?
4. Keep route/diagnostic counts protocol-specific while T20 independently binds wall/stdout/stderr/PID limits?
5. Which exact T20 requirement/evidence artifact should gate future compiler helper promotion?

Until reviewed and T00-04 is active, T08 will not wire this executable path into the public scanner registry/CLI.
