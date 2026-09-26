# T19 independent review — T16 runtime core post-04B

Status: **PASS for immutable binding / process-policy core only**

Reviewed target:

- repository: `popixoxipop-collab/Backend-evaluation`
- T16 PR: #52
- exact PR head: `7a7ec02e0e765bb9c7367b737ce1fc44e5fcb93b`
- merge commit on beval main: `795c11bc78a6cfd9ce0d40392a564bb3ffc542e4`
- standard exact-head CI: #978 / `36144204390` = **SUCCESS**
- stacked focused validator: #53
- validator head: `82424b49e23cb236827ac39396278a75197b5b3d`
- validator CI: #979 / `36144318319` = **SUCCESS**

## Scope review

T16 clean split changed only:

- `lib/next-runtime/**`
- `test/next-runtime/**`
- `docs/next-runtime/**`

It did not modify existing shared product hooks, stable schemas, migrations,
Browser Oracle, DockerRunner, repair-loop files, package metadata or workflows.
Shared CI/package integration was separated into T23 validation.

## Exact execution evidence

The required T23 next-runtime matrix completed successfully:

- Node 20: **28 tests / 28 pass / 0 fail / 0 skip**
- Node 22: **28/28 PASS**
- Node 24: **28/28 PASS**
- package install smoke: SUCCESS on all three lanes
- existing unit Node 20/22/24: SUCCESS
- existing integration: SUCCESS

The Node 20/22/24 runs independently replayed the exact reviewed T01 identity
conformance bytes:

`2df0d860428cb8b6bcc1bcdb560f06ccd1257b3937af65448011a1f0d0c1ec42`

Each emitted `sbf.identity-consumer-result/1` with:

- 12 / 12 reviewed cases PASS
- `bskel_runtime_imported:false`
- `bskel_runtime_spawned:false`
- exact operation ID preserved without repair
- compact/pretty ArtifactRefs preserving distinct exact-byte hashes

## Semantic findings

1. `beval.runtime-binding/1` freezes exact case/profile/contract/candidate/original,
   runner implementation, execution-policy and attempt identity.
2. Display names are not execution identity.
3. Runtime evidence must bind both the RuntimeBinding hash and attempt nonce.
4. Cross-attempt/stale evidence replay fails closed.
5. Process execution verifies executable SHA-256, keeps cwd inside the approved
   realpath root, disables shell, bounds input/output/time and uses a POSIX process
   group for termination where supported.
6. Ambient child environment is allowlist-only.
7. Inherited code-loader/interpreter injection variables are explicitly rejected,
   including `NODE_OPTIONS`, `PYTHONPATH`, `LD_PRELOAD`,
   `DYLD_INSERT_LIBRARIES`, `JAVA_TOOL_OPTIONS` and related variables.
8. T16's identity consumer is dependency-safe: reviewed T01 bytes are vendored and
   replayed locally without importing or spawning bskel.
9. The clean split does not activate a stable product runtime path by itself.

## Boundary / non-claims

This PASS does **not** certify:

- OS/container/network/socket isolation;
- Windows descendant-tree cleanup;
- gRPC/GraphQL/event/WebSocket runtime behavior;
- real FastAPI/Spring/Chromium behavior certification;
- production runtime activation;
- any capability as `runtime-tested`.

Those require later T16 runtime execution evidence plus T19 verification under the
exact immutable binding.

## Verdict

**PASS** for the T16 immutable runtime-binding / evidence / process-policy core.

Do not reinterpret this review as a Runtime-tested or production-support verdict.
