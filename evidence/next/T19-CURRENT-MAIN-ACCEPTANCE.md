# T19 current-main independent QA acceptance slice

Observed: 2026-09-29 KST  
Branch: `t00/t19-current-main-qa-r1`  
Post-A restack base: `backend-skeleton@80002a1e6536c007d9daaf8e2180fe82f14971e4`

## Scope

This branch is a post-A restack of T19-owned QA surfaces only:

- `test/conformance-next/**`
- `test/corpus-next/**`
- this status document

The branch was rebuilt on the post-#155 main baseline instead of carrying the historical
coordination ancestry. PR #150 must remain mergeable with **0 commits behind main** before
this packet is used.

## Exact-head validation contract

Historical per-request counts are deliberately not reused as current evidence. The current
T19 nested lane contains these test inventories:

- harness: **14 tests**
- certification / holdout semantics: **32 tests**
- harness mutation-runner regressions: **8 tests**
- product mutation-runner regressions: **10 tests**
- product security invariants: **4 tests**
- existing release-acceptance guard suite: **9 tests**

Total exact-head T19 nested inventory: **77 tests**.

The authoritative execution evidence is the terminal GitHub required CI run attached to the
**exact current PR #150 head**, specifically both `nested-next (22.x)` and
`nested-next (24.x)` jobs. This document intentionally does not hardcode an older run/request
identifier: doing so made the previous record stale as the suite grew. A nonterminal, cancelled,
or older-head run is not acceptance evidence.

## Mutation provenance

The executable mutation catalogs remain:

- T19 harness mutants: **7**
- product-core mutants: **13**
- total executable mutation fixtures: **20**
- planned negative-vector catalog: **79**

Both mutation runners now bind their reports to the tested Git commit. Mutation inputs are
materialized from that commit with `git archive`, not copied from live ignored/untracked
worktree bytes. Product dependencies are installed from the archived commit's tracked
`package-lock.json` using `npm ci --ignore-scripts`; the report records the lock digest,
and certification re-reads `package-lock.json` from the certified commit and requires an
exact digest match.

A baseline failure is never counted as a killed mutant, and `equivalent` results are excluded
only when the committed catalog explicitly authorizes equivalence.

## Release-certification boundary

The checked-in public reference corpus deliberately has **no holdout entries**.

The certifier therefore remains fail-closed:

- fully passing reference-corpus validation with default release behavior => **BLOCKED**
- `--allow-no-holdout` => internal/reference validation only
- a non-public independent `sbf.qa-holdout/1` must be injected at certification time
- private holdout evidence must be signed by a separately trusted Ed25519 attestor whose public
  key is present in the committed `holdout-attestors.json` registry
- caller-generated/self-attested keys cannot authorize release certification
- holdout evidence is bound to the exact release source commit

Issue #119 / the TypeScript Express implementation blocker has been closed by the post-A main
line, and T20 implementation has landed separately. Those facts remove the historical blockers
but do **not** manufacture the missing independent holdout/attestor evidence.

## Current disposition

- T19 QA engine on post-A main: **INTEGRATION CANDIDATE**
- exact-head test inventory: **77 tests**
- executable mutation inventory: **20 (7 harness + 13 product)**
- negative-vector catalog: **79**
- independent/private holdout: **MISSING**
- trusted independent holdout attestor: **MISSING** (`holdout-attestors.json` has no active keys)
- T19-03 release certification: **BLOCKED(PRIVATE_HOLDOUT_AND_TRUSTED_ATTESTOR_REQUIRED)**
- product release/default activation: **NOT AUTHORIZED**

PR #150 may be merged as the fail-closed QA/certification engine only after exact-head CI is
terminal green and latest-head review has no blocking finding. T19-03 itself must remain blocked
until a genuinely independent holdout and attestor packet exists.
