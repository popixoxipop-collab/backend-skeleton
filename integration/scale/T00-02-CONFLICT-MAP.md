# T00-02 Existing-work conflict map

Generated: 2026-09-25  
Baseline epoch: **2**

## Current baseline

| component | pinned main |
|---|---|
| bskel | `5472a8b82655840d1d3ce76cb926987376e37ca6` |
| becoder | `a575679b7d9e6df69c95c6c4f71cfdcf8e67c11e` |
| beval | `5bdecbcbb839ecf3fc6aad3f54b4564906c3e56c` |

T00-01 is **SUBMITTED_REBASELINED**, not ACCEPTED. Browser Oracle PR #39 merged after the initial T00-01 submission, so the baseline was moved to the merge commit. Current T00 PR CI is in progress and beval main push CI #865 is queued.

## Decision rule

A green PR is not automatically mergeable. A LAND candidate must have:
1. exact-head CI success,
2. satisfied dependencies,
3. clean file/semantic ownership,
4. no unresolved overlap with another active or legacy track.

## Conflict classes

| Track / PR | Exact-head CI | T00 class | Required before integration |
|---|---|---|---|
| T01 #82 | success | LAND_CANDIDATE | T00-04 |
| T02 #72 | success | RECONCILE | reconcile #63 project/read-set overlap |
| T03 #81 | success | LAND_CANDIDATE | T00-04 |
| T04 #73 | success | RECONCILE | reconcile #63 parser/provenance overlap |
| T04 #87 | success | HOLD_STACKED | #73 + T00-04 + T02/#63 mapping |
| T05 #86 | success | LAND_CANDIDATE | T00-04 |
| T06 #75 | success | LAND_CANDIDATE | T00-04 |
| T07 #69 | success | LAND_CANDIDATE | T00-04 |
| T08 #76 | success | LAND_CANDIDATE | T00-04/T20 |
| **T09 #83** | **failure** | **HOLD_FIX** | synthesized-ID promotion bug fix |
| T10 #84 | success | LAND_CANDIDATE | T00-04 |
| T11 #77 | success | LAND_CANDIDATE | normalized projection waits T00-04 |
| **T12 #66** | **failure** | **HOLD_FIX** | remove premature stable auto-registration + CI green |
| **T13 #67** | **failure** | **HOLD_FIX** | own Hono regression green |
| T14 #71 | success | LAND_CANDIDATE | T00-04 |
| T15 #8 | success | HOLD_SPLIT | split out-of-scope renderer/package patch |
| T16 #41 | queued | HOLD_STACKED | exact-head CI + T01 replay |
| T17 #68 | success | RECONCILE | #63 + package/security decision |
| T18 #70 | success | LAND_CANDIDATE | T00-04/T16 references |
| T19 #74 | success | LAND_CANDIDATE | independent certification remains separate |
| T20 #79 | success | LAND_CANDIDATE | T00-04 |
| T21 #80 | success | LAND_CANDIDATE | T00-04 |
| T22 #85 | success | LAND_CANDIDATE | T20/T23/T00-04 |
| T23 #78 | success | LAND_CANDIDATE | T19/T20 + integration decision |
| Legacy A #63 | success | FREEZE_RECONCILE | map unique vs duplicate into T02/T04/T17/T18 |
| Legacy C #62 | success | FREEZE_RECONCILE | map unique vs duplicate into T19/T20/T23 |
| becoder #7 | normal CI success / cross-verify failure | VERIFY_ONLY | never merge |
| Browser Oracle #39 | merged | MERGED_BASELINE | epoch-2 baseline revalidation |
| Repair Loop #40 | queued | HOLD_VERIFY | reconstructed on current main; fresh CI + runtime verification |

## Confirmed failure causes

### T12 #66
This is not infrastructure. Node 22 and Node 24 both failed.
- registry ordering regression: `92 !== 90` after the NestJS adapter became auto-loaded;
- conformance failure: no fixture wired for `typescript-nestjs`.

T00 disposition: the adapter must return to an experimental leaf namespace. Do **not** change legacy expectations merely to normalize premature production registration.

### T13 #67
Branch-owned Hono test failed:
`scan emits literal routes and applies a literal chained basePath` expected a scan note containing `only literal routes` and did not get it.

T00 disposition: fix the experimental implementation/test contract; no shared registry/package wiring.

### T09 #83
Semantic correctness regression:
`a synthesized scanner operation id is never promoted as source-authored identity` failed.

T00 disposition: repair provenance/promotion logic before any interface freeze.

## Baseline change discovered during T00-02

Browser Oracle #39 merged to beval main. The final head contains fixes newer than the merge-base used by repair-loop #40. T00 directed #40 to reconstruct on current main. The new head `5ee490f...` now has current main `5bdecbcb...` as its merge-base (ahead 62 / behind 0). Rebase blocker is cleared; CI/runtime verification remains blocking.

## T00-03 inputs

T00-03 must now freeze ownership for the following collision groups:

1. **Project/source graph:** T02 #72 ↔ T04 #73/#87 ↔ Legacy A #63.
2. **Game semantics:** T17 #68 ↔ Legacy A #63 ↔ existing webgame/1.
3. **Evidence/release:** T19 #74 ↔ T20 #79 ↔ T23 #78 ↔ Legacy C #62.
4. **Identity/reconciliation:** T01 #82 ↔ T03 #81 ↔ T09 #83 ↔ T16 #41.
5. **Consumer/game renderer:** T15 #8 ↔ T17 #68 ↔ merged becoder repair surface.
6. **Browser/repair:** merged beval #39 ↔ #40 ↔ T16 #41.

No shared hot-file integration should happen before these ownership decisions are explicit.
