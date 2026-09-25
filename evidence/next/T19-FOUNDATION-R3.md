# T19 QA foundation R3 — current-branch exact-source execution

Date: 2026-09-25
Source branch: `scale/t19-qa-corpus-foundation`
Source branch head before this evidence commit: `ab70ebe4be0f9833f2dbc3e8cd1434fc0f17350d`
Status: implementation/QA evidence; not release certification.

## Current T19 state verified

- local development corpus: 5 entries
- local corpus certification-eligible: 0
- legacy real-repo oracle projection: 17 exact-SHA source candidates, still license-review + independent-golden-review pending
- negative catalog: 79 vectors
- local evidence-candidates: 11
- local covered vectors: 0
- external cross-track candidate registry: 5 candidate branches / 12 unique mapped vectors
- external candidates do not self-certify coverage

## Exact source blobs

- `test/corpus-next/corpus.mjs`: `80bda8bfbdd124083c79db5b8c32ca762ea49118`
- `test/corpus-next/manifest.json`: `2b73352e4f2e1a6011c204080937f3d7a9b57e6a`
- `test/corpus-next/legacy-oracle-import.mjs`: `9e65c8d395ce6cf6dc0b234302e2cfd5fff99375`
- `test/fixtures/oracle-manifest.json`: `cf542c5398a730611e7205e6ddfbc20845a9070c`
- `test/conformance-next/catalog.mjs`: `0834b8ea8e9a97f63b5db67864c1dfcab0104c55`
- `test/conformance-next/negative-vectors.json`: `094f9a008f916b3568b32a4abdfcce07b6810351`
- `test/conformance-next/external-candidates.mjs`: `02fbbaa08e10dfcf52a6869ca85818eb62d00987`
- `test/conformance-next/external-evidence-candidates.json`: `24bea17e39ebaa9d20a06fe34c2dfe7bd984ab8b`
- `test/conformance-next/t19-foundation.test.mjs`: `4baa76d160aaa15525ab49aa64ca72a6f9e76a2d`

## Exact-source staged execution

GitHub branch files were fetched through the authorized GitHub connector and copied to the EOE sandbox. The sandbox write API cannot create arbitrary parent directories, so source modules/JSON were staged under flat filenames and the test file's import/read paths alone were rewritten. Assertions, validator bodies, input JSON and expected values were unchanged.

EOE:
- Node: `v26.7.0`
- request id: `39e93812-74e6-435d-878c-f92f498ac936`
- command: `node --test t19_full_branch.test.mjs`
- exit code: 0
- tests: 23
- pass: 23
- fail: 0
- cancelled: 0
- skipped: 0
- todo: 0

This proves the current T19 foundation code paths listed above execute successfully in the staged environment. It does not prove product/framework certification and it does not substitute for required GitHub CI.

## Boundary

T19-03 remains blocked behind T00-04/shared Claim/IR acceptance. T19 continues only T19-01/T19-02 and independent-review work.

## CI integration gap

Current repository `npm test` resolves to `node --test test/*.test.mjs`. That glob does not include `test/conformance-next/t19-foundation.test.mjs`. Required CI must explicitly run the nested T19 suite before this evidence can be treated as ordinary exact-head CI coverage.
