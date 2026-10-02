# T20 trust/security status

Status date: 2026-09-25. This file describes the T20-owned branch only. It is not a release or Runtime-tested certificate.

## Task status

| Task | T20-owned state | Remaining external dependency |
|---|---|---|
| T20-01 threat model / asset classification | implemented | independent integration review only |
| T20-02 permission manifest / policy | implemented and focused-tested | stable integration/packaging remains T00/T23 |
| T20-03 sandbox enforcement | **BLOCKED on 2026-09-25** (historical). Current (bskel `main` at `ad24e0d8`, checked 2026-10-03): acceptance is not recorded; bskel `release/next/release-plan.json` lists T20-03 as `NOT_ACCEPTED` (required `ACCEPTED`), although enforcement code now exists in `popixoxipop-collab/Backend-evaluation`. See the update below | 2026-09-25 text: admitted T16/T00-04B effective runner/profile + OS/container/network/socket/device enforcement. Current: not re-evaluated for this update; whether the Backend-evaluation slice meets the acceptance criteria is not decided here (see the update below) |
| T20-04 digest/signature/revocation | data plane + Ed25519 verification implemented | production trust-root distribution/revocation freshness + runtime use remain unapproved |
| T20-05 malicious fixture regression | 20-case spec + evidence evaluator implemented | 14 runner/evidence cases require actual external execution evidence |
| T20-06 security closeout | readiness evaluator implemented | cannot be ready until T20-03/T20-05 actual evidence, zero leaks/orphans, downgrade rehearsal, no blockers |

## Update (bskel `main` at `ad24e0d8`, beval `main` at `59ba96cd`, checked 2026-10-03)

The sections below describe the 2026-09-25 T20-owned branch. This update records what changed elsewhere since. It does not accept any T20 task, and this file is still not a release or Runtime-tested certificate.

- Enforcement code for T20-03 now exists in `popixoxipop-collab/Backend-evaluation`. Its PR 72 (merge `73595d4f1fb51fa0e7eb99034d9f534965c068a8`, 2026-09-28) added a hardened Linux container enforcement slice (`lib/next-runtime/linux-container-sandbox.mjs`, `docs/next-runtime/T20_LINUX_CONTAINER_SANDBOX.md`). Its PR 73 (merge `ff392205c60c90fbe1e60ec950015b3942c270da`, 2026-09-29) bound the trust requirements to runtime enforcement and added signed evidence attestation (`lib/next-runtime/t20-trust-binding.mjs`, `lib/next-runtime/t20-evidence-attestation.mjs`).
- Acceptance is not recorded. `release/next/release-plan.json` lists T20-03 with `observed_state` `NOT_ACCEPTED` (required `ACCEPTED`) and its status is `REBASELINED_BLOCKED` with `release_allowed` false. `release/next/evidence-manifest.json` has 0 entries. Whether the beval slice satisfies the T20-03 acceptance criteria is not decided in this file.
- The "Current runtime blocker" section below is a 2026-09-25 observation (T16 rerun `36095298425`). It was not re-evaluated for this update and may no longer hold.

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
- exact normalized permission digest
- exact artifact digest allow/revoke policy and generation
- existing bskel Ed25519 attestation reuse for trust-policy signature
- requested/effective trust-evidence echo
- external adapter package trust handoff
- Unreal/Unity/Godot non-executable trust request
- first-party static-worker / compiler-helper request profiles
- network-command / database-read / database-write / local-server profiles
- adversarial evidence acceptance
- security closeout readiness evaluation

None of the above is an OS sandbox or execution engine.

## Current runtime blocker

T16 rerun `36095298425` produced successful unit jobs for Node 20, 22 and 24.
The integration job successfully created a Docker network and healthy PostgreSQL service, then failed before product integration tests because the Actions credential could not checkout sibling repository `popixoxipop-collab/backend-decoder`:

```
remote: Repository not found.
fatal: repository 'https://github.com/popixoxipop-collab/backend-decoder/' not found
```

This is currently classified as cross-repository checkout authorization/infrastructure, not a T16 product assertion failure.

T20 will not weaken runtime trust or replace the missing repository authorization with an overbroad token. Integration should use an already-approved credential with exact sibling-repository read access or an approved immutable package/artifact.

## Closeout boundary

A real T20 closeout remains blocked until all of these are present for one exact product/runtime revision:

- exact runtime implementation/profile digests;
- requested/effective T20 trust digest equality and enforcement evidence;
- all 14 runner/evidence adversarial cases passing with external evidence refs;
- signed artifact trust policy at or above the required generation;
- zero secret leaks;
- zero orphan resources;
- downgrade rehearsal proving revoked artifact, permission expansion and generation rollback denial;
- zero non-waivable blockers.

Even a T20-ready closeout does not authorize product release. T19/T23/T00 remain responsible for independent QA, packaging/release policy and program promotion.
