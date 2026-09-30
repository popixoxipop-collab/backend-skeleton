# T19 post-A exact-source QA acceptance slice (T00-E rebind)

Observed: 2026-09-30 (every lane below re-run on the exact source head)  
Branch: `docs/t00-e-rebind-release-heads`  
Exact source head tested: `1cdd848a5aa97ff558c0574da70fedb899131ff7` (backend-skeleton main)

## Scope

This packet rebinds the T19/T23 release-control evidence to the three observed main heads and
re-observes the executable checks at the exact bskel source head. It changes evidence only.

Release heads recorded (`release_heads`, and the `release/next` inventory and plan):

| Repo | Head |
|---|---|
| backend-skeleton | `1cdd848a5aa97ff558c0574da70fedb899131ff7` |
| backend-decoder | `0f0abcea1337335fc44b943932ad3c5f3fbaad6c` |
| Backend-evaluation | `020668cdc2f5a836e78dfe05fd845ea58769a0e9` |

The mutation runners remain fail-closed on source provenance (source commit bound in reports,
catalog SHA-256, `git archive <source_commit>` materialization, `npm ci --ignore-scripts` from the
archived lockfile, live ignored files not accepted).

## Evidence-head convention

`1cdd848a5aa97ff558c0574da70fedb899131ff7` is the **tested source head**. It is a commit on main and
an **ancestor** of the commit that records this packet, so the packet commit is a real
evidence-only descendant. It may modify only this file, `evidence/next/T19-RELEASE-ACCEPTANCE.json`,
the constants in `test/t19-release-acceptance/t19-release-acceptance.test.mjs`, and the
release-control evidence `release/next/compatibility-inventory.json`, `release/next/release-plan.json`
`release/next/README.md` and the fixture helper in `release/next/test/release-policy.test.mjs` (no test added or removed; the T19 count stays 75, release-policy stays 29). Verify with
`git merge-base --is-ancestor 1cdd848a5aa97ff558c0574da70fedb899131ff7 <packet head>` and
`git diff --name-only 1cdd848a5aa97ff558c0574da70fedb899131ff7..<packet head>`.
A packet cannot name its own commit or its own CI run.

Superseded source heads:

- `3ba5afd8025a04c918e45fd0ca0b137683da9355` (PR #159 head, CI run 1576): #159 was squash-merged as
  the single-parent commit `d80a711c4e99ba63c94d3c813b402a5a77ec4f38`. That head is **not an
  ancestor of main** and its tree differs from main (27 files differ from main at 1cdd848), so
  an "evidence-only descendant" claim could not hold for it. It is no longer the exact-source authority.
- `a84530b51eb33341173adb0278cc8c5cb6c9eeea` and `6acc4bfcb06e53bac511763c9892df4372ecebe9`
  predate later certifier/supervisor/mutation-runner changes and are stale.

## Exact-source GitHub validation

Workflow run (push to main, conclusion success): id **36652996212**, run number **1583**,
head_sha `1cdd848a5aa97ff558c0574da70fedb899131ff7`.

T19 nested lane (`node scripts/run-next-nested-tests.mjs T19`, job `nested-next`):

- Node 22 job **109691446081** - **75/75 PASS**, 0 fail, 0 skip
- Node 24 job **109691446000** - **75/75 PASS**, 0 fail, 0 skip

Seven test files, 75 tests (bounded-process 1, certify 32, harness 14, mutation-runner 7,
product-mutation-runner 8, product-security-invariants 4, release-acceptance 9).

## Local clean-checkout reproduction at the same head

Fresh clone detached at `1cdd848a5aa97ff558c0574da70fedb899131ff7`, `git status` empty before
and after each lane, `npm ci`:

- T19 nested suite, Node v22.23.3 - **75/75 PASS**
- T19 nested suite, Node v24.19.0 - **75/75 PASS**
- harness mutation campaign (`--source-commit` pinned) - **7/7 killed** on both Node versions,
  catalog digest `16ebc6d2344e...`
- product mutation campaign (`--source-commit` pinned) - **13/13 killed** on both Node versions,
  catalog digest `7a89c0472d38...`
- the other nested suites were not re-run locally at this head; only the CI run above covers them

Total executable mutation fixtures: **20/20**; the planned negative-vector catalog is **79** and
is not represented as 79 executed fixtures.

## Newly observed executable checks (partial, unsigned)

- **Historical replay** (backend-skeleton PR #161): `npm run test:historical-replay` on
  `1cdd848...` - `38/38 checks passed`, 10/10 node tests, on Node v22.23.3 and v24.19.0. Scope: pinned
  historical contract/run/evidence records read through the current readers, inside backend-skeleton only.
- **Same-ID / different-content rejection** (PR #161): regression tests in
  `test/reconciliation-next/evidence-binding.test.mjs`, part of the plain `npm test` lane.
- **Release rehearsal** (Backend-evaluation PR #75, main `020668cdc2f5a836e78dfe05fd845ea58769a0e9`):
  `npm run test:release-rehearsal` against a throwaway `postgres:17` container - PASS, 6 steps,
  59 checks, 12 migrations, 6/6 negative self-tests, 0 undetected. It covers only the case-revision /
  Oracle-profile-approval pointer set (activate, activate candidate with an additive migration,
  roll back on the migrated DB, historical runs readable, forward again). It does **not** cover npm
  package version switching, backend-skeleton or backend-decoder release artifacts, or container images,
  and it is not release-grade or signed evidence.

## Resolved upstream dependencies

- TypeScript Express holdout blocker (#119/#154/#155 family): resolved upstream
- T20 trust implementation PR #72 merged; PR #73 (`ff392205c60c...`) and PR #75 also merged on beval main.
  This packet does not evaluate T20-03 acceptance.

## Release-certification boundary

The committed public reference corpus contains no private holdout entries and
`test/conformance-next/holdout-attestors.json` contains no approved independent attestor key.

Current disposition:

- post-A T19 QA implementation, exact-source Node 22/24 nested QA (75/75 each, head 1cdd848): **PASS**
- executable mutation fixtures: **20/20**
- release heads re-pinned to observed mains: **DONE**; declared final-frozen: **NO**
  (`FINAL_RELEASE_HEADS_NOT_FROZEN` stays: T19-03 and T20-03 are not accepted, this packet's own
  merge moves bskel main, and no signed release-evidence artifact exists)
- independent/private holdout: **MISSING**
- trusted independent holdout attestor: **MISSING**
- T19 release certificate: **BLOCKED(PRIVATE_HOLDOUT_AND_TRUSTED_ATTESTOR_REQUIRED)**
- final release rehearsal: **NOT_RUN** (a partial DB pointer-set rehearsal exists, see above)
- product release/default activation: **NOT AUTHORIZED**
