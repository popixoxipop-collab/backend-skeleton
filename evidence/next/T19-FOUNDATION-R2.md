# T19 QA foundation R2 — exact-source staged execution

Date: 2026-09-25
Source branch head at execution: `0b3e999f7eabe2b0be601cd7e074a6c1f7dad2d1`
Status: implementation/QA evidence; not release certification.

## Scope added since the first foundation run

T19-01:
- preserves the five existing local adapter fixtures as development-only corpus entries with 0 certification eligibility;
- adds a conservative projection of the existing `sbf.oracle-manifest/1` corpus;
- all 17 legacy real-repo entries are exact-SHA pinned source candidates;
- every projected legacy oracle repo remains `needs-license-review` and `independent-golden-review`;
- none is silently upgraded into a golden or certified corpus item.

T19-02:
- preserves the 79-vector negative catalog;
- distinguishes `specified-not-implemented`, `evidence-candidate`, and `covered`;
- `covered` requires an immutable execution reference;
- adds a separate cross-track external-candidate registry instead of pretending draft branches are local T19 coverage;
- exact commit, PR number, safe test path, vector existence, CI terminal state, and self-certification constraints are validated;
- T21 cache candidates are additionally bound to exact workflow/job observations on Node 22 and Node 24.

## External candidate snapshot

- T01 PR #82: 2 direct identity mappings; CI #573 was in progress at observation.
- T21 PR #80: 6 direct cache mappings; exact-head CI #487 completed success.
  - Node 22 job `107910850829`: the three mapped cache subtests were explicitly logged as `ok`.
  - Node 24 job `107910850816`: the same three mapped cache subtests were explicitly logged as passed.
- T23 PR #78: 2 direct release mappings; CI #667 was queued.
- T14 PR #71: 1 partial generation mapping; CI #597 was in progress.
- T20 PR #79: 1 partial network-deny mapping; CI #660 was queued.

External registry summary:
- candidate branches: 5
- unique mapped negative vectors: 12
- direct mappings: 10
- partial mappings: 2
- exact-head-CI-success candidate branches: 1
- candidates with verified job-log observations: 1
- T19 covered vectors from external candidates: **0**

## Exact-source staged execution

The active container cannot resolve github.com. T19 therefore fetched the branch files through the authorized GitHub connector and wrote the exact module/JSON bytes into the EOE sandbox. Because that sandbox write API cannot create arbitrary subdirectories, the files were staged under flat names. Only the test file's import/read paths were rewritten to those flat filenames; assertions, validators, JSON inputs, expected values and source module bodies were unchanged.

Exact source blobs used:

- `test/corpus-next/corpus.mjs`: `80bda8bfbdd124083c79db5b8c32ca762ea49118`
- `test/corpus-next/manifest.json`: `2b73352e4f2e1a6011c204080937f3d7a9b57e6a`
- `test/corpus-next/legacy-oracle-import.mjs`: `9e65c8d395ce6cf6dc0b234302e2cfd5fff99375`
- `test/fixtures/oracle-manifest.json`: `cf542c5398a730611e7205e6ddfbc20845a9070c`
- `test/conformance-next/catalog.mjs`: `0834b8ea8e9a97f63b5db67864c1dfcab0104c55`
- `test/conformance-next/negative-vectors.json`: `d65c9369b9e03cd4072e798912382293a87f6ac7`
- `test/conformance-next/external-candidates.mjs`: `02fbbaa08e10dfcf52a6869ca85818eb62d00987`
- `test/conformance-next/external-evidence-candidates.json`: `24bea17e39ebaa9d20a06fe34c2dfe7bd984ab8b`
- `test/conformance-next/t19-foundation.test.mjs`: `644d63fd4025a1b7e7229acd788aaa66930172a1`

EOE execution:
- request id: `5f7fcdd2-1411-481e-baa1-11231fe9fbf3`
- observed at: `2026-09-25T03:10:47.800Z`
- command: `node --test t19-exact3-foundation.test.mjs`
- exit: 0
- tests: **23**
- pass: **23**
- fail: 0
- cancelled: 0
- skipped: 0
- todo: 0

This is staged exact-source execution, not a required GitHub CI lane. The T00/T23 request to add `node --test test/conformance-next/*.test.mjs` to required integration CI remains open.

## Boundary

T19-03 differential harness is not started because the shared T00-04/T01 interface acceptance boundary is not released. T19 continues only T19-01/T19-02 and independent review work until that dependency is satisfied.
