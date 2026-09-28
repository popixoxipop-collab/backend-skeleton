# T19 post-A exact-source QA acceptance slice

Observed: 2026-09-29 KST  
Branch: `t00/t19-current-main-qa-r1`  
Restack base: `backend-skeleton@80002a1e6536c007d9daaf8e2180fe82f14971e4`  
Exact source head tested: `1ae4a506fe1bf7376a0213c52550ef5d1a5906ce`

## Scope

This packet records the post-A T19 QA implementation after restacking the T19-owned
surfaces onto the latest bskel main. The branch is zero commits behind the restack
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

## Exact-source GitHub validation

Workflow run:

- run id: **36463531776**
- run number: **1511**
- source head: `1ae4a506fe1bf7376a0213c52550ef5d1a5906ce`

T19 nested lane:

- Node 22 job **109068277052** — **74/74 PASS**, 0 fail, 0 skip
- Node 24 job **109068276911** — **74/74 PASS**, 0 fail, 0 skip

The T19 nested suite executes six test files across `test/conformance-next` and
`test/t19-release-acceptance`. The exact-source run includes the current
certification/attestor regressions rather than the historical 14-test certification
slice.

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
- exact-source Node 22/24 nested QA: **PASS**
- executable mutation fixtures: **20/20**
- independent/private holdout: **MISSING**
- trusted independent holdout attestor: **MISSING**
- T19 release certificate: **BLOCKED(PRIVATE_HOLDOUT_AND_TRUSTED_ATTESTOR_REQUIRED)**
- product release/default activation: **NOT AUTHORIZED**

T00-E must freeze the final three repository heads and supply independently trusted
holdout evidence before converting this QA acceptance slice into a release certificate.
