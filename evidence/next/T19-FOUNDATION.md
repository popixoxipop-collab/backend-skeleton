# T19 QA foundation evidence — 2026-09-25

Status: implementation branch, not accepted/released.

Base: `5472a8b82655840d1d3ce76cb926987376e37ca6` (main at T19 start)
Branch: `scale/t19-qa-corpus-foundation`

## Implemented in this slice

- T19-01 foundation: a corpus admission validator and a development-only manifest for the five existing local framework fixtures.
- T19-02 foundation: the planned 79 negative vectors are materialized with stable IDs, categories, expected dispositions and a coverage state that starts at zero.
- Guardrails reject unpinned real repos, missing license metadata, candidate-generated "goldens", self-reviewed holdouts, duplicate corpus/vector IDs, and false coverage claims without implementation references.

The existing `test/fixtures/oracle-manifest.json` remains the network shadow-validation corpus. This slice does not reclassify its scanner output as independent ground truth.

## Verification actually performed before this evidence file was written

Local mirror command:

```bash
node --test test/conformance-next/t19-foundation.test.mjs
```

Environment used for the mirror run: Node `v22.16.0`.

Observed result: 8 tests, 8 pass, 0 fail, 0 skipped.

The branch contents were then re-read through the GitHub API:
- corpus entries: 5
- development cohort: 5/5
- pending independent review: 5/5
- certification-eligible entries: intentionally 0
- negative vectors: 79 total, 79 unique IDs
- category distribution: ID 6, PROJ 6, ROUTE 8, SCHEMA 8, AUTH 6, DB 6, CACHE 6, RUN 8, GAME 7, TRUST 8, GEN 5, RELEASE 5

## Important limitation

Current repository CI runs `npm test`, and package.json resolves that to `node --test test/*.test.mjs`. The new T19 test is deliberately owned under `test/conformance-next/**`, so the current CI glob does **not** discover it automatically.

T19 does not edit `package.json` or `.github/workflows/**` because those are integration/release-owned files in the parallel plan. A T00/T23 integration change is therefore still required to add this nested QA lane to required CI. Until that happens, a green existing CI check does not prove the T19 nested test ran.

## Not claimed

- T19-03 differential harness is not implemented yet; it depends on the shared next interface/claim contract.
- No real-repo corpus item has been independently reviewed for certification in this slice.
- No negative vector is marked covered yet.
- No product support status, runtime certification, release approval, or framework score changes because of this branch.
