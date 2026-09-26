# T00-05 Execution Board

Observed: 2026-09-26 11:32 KST  
Coordinator: T00  
Mode: integration / evidence closure; no new framework fan-out

## Rules

1. A green generic CI is not enough when focused/nested tests did not run.
2. Static analysis, runtime evidence, independent certification, merge, and release are separate states.
3. Shared hot files remain T00/T23-owned. Track workers submit change requests instead of editing them concurrently.
4. Exact-head SHA and terminal CI are required at every integration step.
5. Do not weaken failures with skip/waive/golden rewrites. Infrastructure retry is allowed only for explicitly classified infrastructure faults.
6. Heavy jobs sharing one Docker daemon are serialized by T23.

## Completed integration this round

| Repo | PR | Exact candidate | Result |
|---|---:|---|---|
| Backend-evaluation | #65 | `14671926d55446b2491854b3f39b80ea5002f56d` | MERGED to main as `1dbdafdcdfe4acb3a15f7e9ca89ce62795f1124a` after CI #1003 SUCCESS |

#65 is the Docker cache lifecycle hardening:
- cleanup removes only the unique final image with `docker image rm --force --no-prune`;
- only recognized Docker cache/snapshot corruption retries once with `--no-cache`;
- candidate compile/build failures are not retried.

## Priority queue

| Order | Owner | Target | Current evidence | Gate before integration |
|---:|---|---|---|---|
| 1 | T23 | beval #66 | head `7ff35ec...`, CI #1005 SUCCESS | expand policy to PR smoke vs webgame-related full vs main/nightly full; path-detection fail-closed; re-run exact-head CI |
| 2 | T23 | beval #58 | head `364df37...`, CI #987 SUCCESS but mergeable=false | restack on current main after #65/#66 while preserving benchmark/package changes; exact-head CI |
| 3 | T16 | beval #59-#62 | #62 head `accce80...`, CI #1002 SUCCESS | restack the chain on accepted #58 base; focused next-runtime + package + integration evidence |
| 4 | T16/T23 | chord-forward-right | T19 review `d6fd24a...`: historical attempt = execution-layer BLOCKED/unknown; #66 real Docker/browser smoke = `repaired_and_passed` | preserve runtime_state + bounded/redacted Docker logs on future failure; rerun after #65 + completed #66 restack |
| 5 | T02 | bskel #72 | head `989e7d3...`; locale-order defect reproduced; ACTIVE lease token 2 | replace localeCompare-based ordering with explicit locale-independent ordering; cross-locale + two-worktree + stale evidence; return invariant to T21 |
| 6 | T21 | bskel #80 | head `efd1eec...`, CI #799 FAILURE | resolve project-cache plan ordering contract without deleting meaningful ordering checks; Node 22/24 exact-head pass |
| 7 | T01 | bskel #82 + becoder #10 + beval consumer | both consumer implementations exist | validate exact 12-vector pack with consumer-set aggregation; bind package/code SHAs |
| 8 | T19 | bskel #118 | head `cacf60a...`, CI #1199 SUCCESS | review deltas from T21/T16/T01; do not call 79 catalog cases executable |
| 9 | T20 | bskel #79 | policy foundation green | produce actual externally-observed enforcement evidence for admitted runner profile; policy validity alone is insufficient |

## Green candidates not yet authorized for merge

| Track | PR | Current status | Why not merged yet |
|---|---:|---|---|
| T17 | bskel #138 | head `dee914d...`, CI #1192 SUCCESS | follow-up Unity/Godot source-only exporter still needs delta-focused T19 review; no native engine runtime claim |
| T13 | bskel #67 | head `322e808...`, CI #1201 SUCCESS | profile-by-profile T19 review + scope cleanup; no live registry activation |
| T19 | bskel #118 | latest head moving under active review; prior #1199 SUCCESS; new T21 + Docker/chord review evidence added | latest exact-head full CI must be terminal before coordination merge; executable mutation coverage remains partial |
| T16 | beval #62 | CI #1002 SUCCESS | stacked on unmerged #61/#60/#59/#58, so current green run is not a mainline integration proof |
| T23 | beval #58 | CI #987 SUCCESS | mergeable=false / stale integration base |
| T23 | beval #66 | CI #1005 SUCCESS | current branch only distinguishes generic PR vs main; requested webgame-related-PR/full and nightly policy still pending |

## T21 known failure

CI #799 fails at `test/perf-next/t21-project-cache.test.mjs:69`.

Observed:
- implementation sorts project-cache plan by `project_root`, then `adapter_id`;
- test expects FastAPI before Spring;
- both projects are present, so this is an ordering-contract mismatch, not missing work.

T19 independently checked T02 head `989e7d332761ab8bcda453b2af9e84a5102b1281` and confirmed T02 also serializes/plans by `project.root` / `project_root`. T19 verdict at `7770378890e541c831c65be865be09649a196fc5` is `BLOCKED(TEST_ORACLE_MISMATCH)`: T21 should update only its own expected order to the T02 `project_root` order, then rerun focused + Node 22/24 CI. Product semantics must not be changed to satisfy the stale test. DAG scheduling order and serialized plan order remain explicitly distinct.

## Merge / restack order for beval

1. #65 — DONE, main = `1dbdafdcdfe4acb3a15f7e9ca89ce62795f1124a` at this integration point.
2. T23 updates #66 on current main and completes the requested changed-path/nightly policy.
3. Merge #66 only after its new exact-head CI succeeds.
4. Restack #58 on the then-current main and resolve workflow/package conflicts without dropping benchmark changes.
5. After #58 exact-head CI succeeds, restack #59 -> #60 -> #61 -> #62 in order.
6. Run the single `chord-forward-right` repair case on the accepted Docker/CI base before relying on full-corpus results.
7. Only after single-case classification run PR smoke/full as defined by #66 policy.

## Promotion reminders

- T03 may not promote runtime-tested from the presence of a RuntimeBinding alone.
- T14 may not produce behavior-tested from build/mock evidence.
- T17/T18 static/package-shadow success is not native/protocol runtime certification.
- T20 signed permission data is not proof the OS actually enforced it.
- T22 remains data-only unless T20/T23 separately approve execution/package integration.

## T00 acceptance packet

Every track result submitted back to T00 must contain:
- repo, branch, actual worktree identity;
- base SHA and final code HEAD;
- changed paths;
- exact focused test commands and pass/fail/skip counts;
- exact CI run/job IDs;
- artifact/evidence path + SHA-256 where applicable;
- independent T19 status;
- unresolved blockers and owner.

T00 will integrate only the smallest candidate that satisfies the above at its exact head.


## T19 Docker/chord decision

Latest T19 evidence classifies the observed failure boundary as follows:
- historical `chord-forward-right` attempt: execution-layer failure before behavior comparison; exact sub-cause is not recoverable from the old summary because runtime_state/log were not persisted;
- Docker `No such image: sha256:...` / missing parent snapshot signatures: verified infrastructure failure class;
- #65 retry policy: approved as narrow infrastructure hardening;
- #66 selected real integration smoke: chord passed as `repaired_and_passed`;
- this does not grant broad Runtime-tested certification.

T00 therefore removes "possible chord behavior bug" from the primary blocker list. The remaining requirement is diagnostic preservation on failure and a post-#65/#66-restack exact-head rerun.


## Active write leases

- T17 PR #138 defect fix: `T17-pr138-defect-fix-20260926`, fencing token 2, exact two-file scope, expires 2026-09-26T08:47:13Z.
- T21 PR #80 corrective slice: `T21-pr80-defect-fix-20260926`, fencing token 2, T21-owned cache/perf scopes only, expires 2026-09-26T08:47:13Z. Root shim cleanup explicitly excluded.
- T02 PR #72 locale-order fix: `T02-pr72-locale-fix-20260926`, fencing token 2, project-graph/test scopes only, expires 2026-09-26T08:49:08Z.

T21 final ordering/cache acceptance is dependent on the corrected T02 invariant; T21 may work in parallel on other in-scope defects but must not freeze an oracle against the known locale-sensitive T02 producer head.
