# T19 post-A exact-source QA acceptance slice

Observed: 2026-09-29 KST (re-run of every lane at the tested head, 15:40 KST)  
Branch: `t00/t19-final-integration-20260929`  
Restack base: `backend-skeleton@80002a1e6536c007d9daaf8e2180fe82f14971e4`  
Exact source head tested: `3ba5afd8025a04c918e45fd0ca0b137683da9355`

## Scope

This packet records the final post-A T19 QA integration candidate in PR #159 after
restacking the T19-owned surfaces onto the latest bskel main. The branch is zero commits behind the restack
base and changes only the T19 QA/evidence surfaces.

The mutation runners are fail-closed on source provenance:

- harness and product reports bind `source_commit`
- mutation catalogs bind by SHA-256
- source bytes are materialized with `git archive <source_commit>`
- product dependencies come from the archived commit's `package-lock.json`
- dependencies are installed with `npm ci --ignore-scripts`
- the reported lockfile digest must equal the tracked lockfile at the certified commit
- live ignored files and live `node_modules` are not accepted as certified source bytes
- unapproved `equivalent` mutation/negative results are rejected

## Evidence-head convention

`3ba5afd8025a04c918e45fd0ca0b137683da9355` is the **tested source head**. The commit that
records this packet is a descendant of it and is **evidence-only**: it changes just
`evidence/next/T19-CURRENT-MAIN-ACCEPTANCE.md`, `evidence/next/T19-RELEASE-ACCEPTANCE.json`
and the constants in `test/t19-release-acceptance/t19-release-acceptance.test.mjs`
(the T19 count of 75 is the count at the tested head and is unchanged by the packet commit). Verify with
`git diff --name-only 3ba5afd8025a04c918e45fd0ca0b137683da9355..<packet head>`.
A packet cannot name its own commit or its own CI run; the CI run on the packet commit is
a separate, later observation. The earlier `6acc4bfcb06e53bac511763c9892df4372ecebe9`
run (#1551) predates changes to the certifier, bounded-process supervisor, mutation
runners and their regressions and is **not** evidence for the current head. Likewise
`a84530b51eb33341173adb0278cc8c5cb6c9eeea` (run #1574, 74 tests) predates the
bounded-process supervisor cancellation fix (SIGINT/SIGTERM/parent-death now kill the
detached group; regression `bounded-process.test.mjs`) and is superseded.

## Exact-source GitHub validation

Workflow run (pull_request, attempt 1, conclusion success):

- run id: **36530790434**
- run number: **1576**
- head_sha: `3ba5afd8025a04c918e45fd0ca0b137683da9355`

T19 nested lane (`node scripts/run-next-nested-tests.mjs T19`, job `nested-next`):

- Node 22 job **109283796238** — **75/75 PASS**, 0 fail, 0 skip
- Node 24 job **109283796309** — **75/75 PASS**, 0 fail, 0 skip

The T19 nested suite executes seven test files across `test/conformance-next` and
`test/t19-release-acceptance`: bounded-process 1, certify 32, harness 14, mutation-runner 7,
product-mutation-runner 8, product-security-invariants 4, release-acceptance 9 (= 75).

## Local clean-checkout reproduction at the same head

A detached clean worktree at `3ba5afd8025a04c918e45fd0ca0b137683da9355` (`git status` empty
before and after each lane; `npm ci`):

- T19 nested suite, Node v22.23.3 — **75/75 PASS**
- T19 nested suite, Node v24.19.0 — **75/75 PASS**
- direct harness mutation campaign (`--source-commit` pinned) — **7/7 killed**,
  report `source_commit` == tested head, catalog digest `16ebc6d2344e...`
- direct product mutation campaign (`--source-commit` pinned) — **13/13 killed**,
  report `source_commit` == tested head, catalog digest `7a89c0472d38...`
- all other present nested suites (18 run, T11 NOT_PRESENT) on Node 22 and Node 24 —
  1097 tests each, 0 fail, 0 skip

Mutation evidence exercised by the nested suite:

- T19 harness mutation campaign: **7/7 killed**
- product mutation campaign: **13/13 killed**
- total executable mutation fixtures: **20/20**
- planned negative-vector catalog: **79**
- the 79-vector catalog is not misrepresented as 79 directly executed mutation fixtures

The product campaign also executes the regression proving that a live ignored file
does not enter the claimed-commit scratch tree.

## Resolved upstream dependencies

- TypeScript Express holdout blocker (#119/#154/#155 family): **resolved upstream**
- T20 trust implementation PR #72: **merged**
- beval main carrying that merge: `73595d4f1fb51fa0e7eb99034d9f534965c068a8`

These resolved dependencies are no longer valid reasons to keep an old
`HOLDOUT_ISSUE_119_OPEN` or `T20_03_NOT_ACCEPTED` blocker in the T19 release
packet.

## Release-certification boundary

This packet certifies the T19 QA implementation and exact-source execution above.
It does **not** fabricate the independent private-holdout authority needed for the
final release certificate.

The committed public reference corpus deliberately contains no private holdout
entries, and `test/conformance-next/holdout-attestors.json` still contains no
approved independent attestor key. A caller-generated key is intentionally rejected.

Current disposition:

- post-A T19 QA implementation: **PASS**
- exact-source Node 22/24 nested QA (75/75 each, head 3ba5afd): **PASS**
- executable mutation fixtures: **20/20**
- independent/private holdout: **MISSING**
- trusted independent holdout attestor: **MISSING**
- T19 release certificate: **BLOCKED(PRIVATE_HOLDOUT_AND_TRUSTED_ATTESTOR_REQUIRED)**
- product release/default activation: **NOT AUTHORIZED**

T00-E must freeze the final three repository heads and supply independently trusted
holdout evidence before converting this QA acceptance slice into a release certificate.
