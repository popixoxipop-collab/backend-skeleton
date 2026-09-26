# T19 independent review — T21 project-cache ordering failure

**Verdict: BLOCKED**

Reviewed: 2026-09-26

## Target

- T21 PR: #80
- branch: `scale/t21/incremental-store`
- head: `efd1eecec81a1a16556da685dde4d892114f7b5b`
- base: `5472a8b82655840d1d3ce76cb926987376e37ca6`
- CI run: #799 / `36093320002` — **failure**

Failing jobs:
- Node 22: `107940159124`
- Node 24: `107940159027`

Exact failing test:
- `test/perf-next/t21-project-cache.test.mjs:66`
- `T21 project cache plan consumes T02 draft shape without treating aggregate fallback as a first-class scan`

Observed mismatch:

```text
actual:
  project:spring  / java-spring
  project:fastapi / python-fastapi

expected:
  project:fastapi / python-fastapi
  project:spring  / java-spring
```

## Independent semantic check

T21 implementation at this head:

- `lib/scan-scheduler-next/project-cache-plan.mjs`
- blob `4fa1458cfb42230179fb1220c0ce4d5588a45eab`

The implementation sorts the project cache plan by `project_root`, then adapter id.

T19 independently checked the current T02 draft implementation:
- T02 PR #72
- head `989e7d332761ab8bcda453b2af9e84a5102b1281`
- `scanners/project-graph/index.mjs`
- blob `b1ef0d6bdb018a913b02011215251fd4b0c6cf0b`

T02 also serializes/project-plans by `project.root` / `project_root`, not by `project_id`.

Therefore the observed T21 output order is consistent with the independent producer semantics. The red test is a **stale/incorrect expected-order oracle**, not evidence that the cache-plan implementation reordered T02 incorrectly.

## Decision

```text
BLOCKED(TEST_ORACLE_MISMATCH)
```

T19 does not approve T21 while its exact-head CI is red.

Required T21-owned correction:
1. update only the T21-owned test expectation to the T02 `project_root` order;
2. do not change T02 or shared product semantics to satisfy this test;
3. rerun the focused T21 test at the new exact head;
4. obtain terminal exact-head CI green on Node 22/24;
5. return the new code SHA, test command/output, and CI job IDs for delta review.

Changing this expected value is not accepted merely because the implementation produced it; it is justified by independent T02 producer semantics at the exact referenced T02 head/blob above.

No T21 product code was modified by T19.
