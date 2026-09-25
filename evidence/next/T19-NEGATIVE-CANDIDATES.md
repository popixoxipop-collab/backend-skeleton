# T19 negative-vector evidence candidates

Status: source-mapped candidates only. **No vector in this document is certified covered.**

The purpose of this pass is to reuse existing regression tests instead of recreating equivalent T19 fixtures. A candidate becomes `covered` only after an exact execution reference is attached and the mapping is independently reviewed.

| vector | existing implementation/test reference | why it is only a candidate |
|---|---|---|
| NEG-ID-06 Unicode difference | `test/contract-identity.test.mjs` — “binding-json preserves Unicode bytes rather than normalizing them” | directly tests byte-preserving Unicode identity, but T19 has not attached an exact current-head execution ref |
| NEG-ID-05 cross-project same name | `test/cross-feature-collisions.test.mjs` — shared resourceType / shared operationId cases | feature scope is a close precursor to project scope; not identical to the planned multi-project semantics |
| NEG-DB-06 migration/live drift | `test/cross-feature-collisions.test.mjs` — migration data never outranks available Plane C/live data | exercises source precedence/drift behavior, but does not yet prove the future Persistence IR reconciliation contract |
| NEG-GEN-01 edited overwrite | `test/patch-transactions.test.mjs` — apply/rollback refuses after human edits | strong existing write-protection test; exact execution evidence still required |
| NEG-GEN-02 manifest drift | `test/patch-transactions.test.mjs` — approve refuses when target changed since propose | strong stale-plan/hash-style guard; future generation manifest semantics may be stricter |
| NEG-RELEASE-04 package missing | `test/package-install.test.mjs` — real npm pack/install and runtime asset resolution | strong packaged-artifact regression, but current required-CI relation is owned by T23 |

Machine-readable state lives in `test/conformance-next/negative-vectors.json`:
- `specified-not-implemented`: no reviewed implementation mapping
- `evidence-candidate`: implementation/test refs exist, but not certified
- `covered`: implementation refs **and exact execution refs** are required

Current candidate count: 6.
Current covered count: 0.

The branch's existing `npm test` CI executes the root-level referenced tests but still does not execute `test/conformance-next/t19-foundation.test.mjs`; that nested-suite integration remains a T00/T23 change request. Therefore a green general CI run is not used here to promote these candidates.
