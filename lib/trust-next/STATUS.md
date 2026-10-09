# T20 trust/security status

Status date: 2026-10-09. This file describes the T20-owned code only. It is not a release or Runtime-tested certificate, and no signed attestation backs anything in it.

## How this file was refreshed

Facts below marked "checked 2026-10-09" were read that day: the bskel `main` commit and `release/next/release-plan.json` from a fresh clone of `origin/main`, and the two Backend-evaluation merge commits through the read-only GitHub API. Text carried over from the 2026-09-25 file is labelled as such and was not re-checked.

## Task status

| Task | T20-owned state | Remaining dependency |
|---|---|---|
| T20-01 threat model / asset classification | implemented | independent integration review only |
| T20-02 permission manifest / policy | implemented and focused-tested | stable integration/packaging remains T00/T23 |
| T20-03 enforcement | **partly closed** by `enforcement-gate.mjs`: a shadow/next, host-injected, in-process gate that mediates file, network, listener, process, environment, secret and device requests through one manifest, with a hash-chained audit. It is not an OS sandbox, is not wired into the scan/registry path, and produces no attestation. Limits record: `ENFORCEMENT_GATE.md` | scan/registry adoption (other tracks), OS-level confinement, unsupported budgets (`cpu_ms`, `memory_bytes`, `pids`, `scratch_bytes`), affirming `permission.enforced` in the evidence echo, externally observed acceptance |
| T20-04 digest/signature/revocation | data plane + Ed25519 verification implemented (carried over from 2026-09-25) | production trust-root distribution/revocation freshness + runtime use remain unapproved |
| T20-05 malicious fixture regression | spec + evidence evaluator implemented (carried over from 2026-09-25) | runner/evidence cases require actual external execution evidence |
| T20-06 security closeout | readiness evaluator implemented (carried over from 2026-09-25) | cannot be ready until T20-03/T20-05 actual evidence, zero leaks/orphans, downgrade rehearsal, no blockers |

## Acceptance state (checked 2026-10-09)

- bskel `main` is `24fe7e59e96fb98b18c1319e8a81da86e93e43dc`. `release/next/release-plan.json` there lists T20-03 with `observed_state` `NOT_ACCEPTED` (required `ACCEPTED`). This change does not alter that file and does not accept any T20 task.
- Enforcement code for T20-03 also exists in `popixoxipop-collab/Backend-evaluation`: its PR 72 (merge `73595d4f1fb51fa0e7eb99034d9f534965c068a8`) added a Linux container enforcement slice, and its PR 73 (merge `ff392205c60c90fbe1e60ec950015b3942c270da`) bound the trust requirements to runtime enforcement and added signed evidence attestation. Both merge commits exist (checked through the GitHub API). Whether that slice meets the T20-03 acceptance criteria is not decided in this file.
- The gate in this directory is independent of that slice. It does not import it and does not replace it.

## Current owned capabilities

- fail-closed permission model:
  - repository read/write roots
  - outbound connect
  - separate loopback listen
  - executable + child-count grants
  - environment inheritance
  - secret references
  - device classes
  - wall/CPU/memory/PID/stdout/stderr/scratch budgets
- privilege expansion detection and rejection boundary
- exact normalized permission digest (covers the whole manifest)
- exact artifact digest allow/revoke policy and generation
- existing bskel Ed25519 attestation reuse for trust-policy signature
- requested/effective trust-evidence echo
- external adapter package trust handoff
- Unreal/Unity/Godot non-executable trust request
- first-party static-worker / compiler-helper request profiles
- network-command / database-read / database-write / local-server profiles
- adversarial evidence acceptance
- security closeout readiness evaluation
- cooperative enforcement gate (shadow/next) with canonical-path checks, pinned addresses and executables, approved-environment rebuild, enforced wall and output limits, and an audit chain

None of the above is an OS sandbox or execution engine. The gate controls what is started and with what; a started child is not confined by it.

## Tests that back the gate

All under `test/trust-next/`: `enforcement-gate.test.mjs` (decisions), `enforcement-gate-limits.test.mjs` (limits, audit, report), `enforcement-gate-addresses.test.mjs` (address classes checked against pinned IANA registry files in `iana-registries/`), `enforcement-gate-output.test.mjs` (cumulative output cap), `enforcement-gate-real.test.mjs` (real links, loopback sockets and children), `enforcement-gate-mutations.test.mjs` (guards the mutation catalog `enforcement-gate-mutations.json`). The catalog is applied by `test/conformance-next/product-mutation-runner.mjs`; a campaign result is a local run, recorded in the pull request that introduced it, not an attestation.

## Historical note

A 2026-09-25 observation said a T16 rerun failed when its integration job could not check out a sibling repository. It was never re-evaluated here, it is not part of the current status, and nothing in this change depends on it.

## Closeout boundary (carried over from 2026-09-25)

A real T20 closeout remains blocked until all of these are present for one exact product/runtime revision:

- exact runtime implementation/profile digests;
- requested/effective T20 trust digest equality and enforcement evidence;
- all runner/evidence adversarial cases passing with external evidence refs;
- signed artifact trust policy at or above the required generation;
- zero secret leaks;
- zero orphan resources;
- downgrade rehearsal proving revoked artifact, permission expansion and generation rollback denial;
- zero non-waivable blockers.

Even a T20-ready closeout does not authorize product release. T19/T23/T00 remain responsible for independent QA, packaging/release policy and program promotion.
