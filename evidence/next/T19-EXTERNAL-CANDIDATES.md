# T19 cross-track evidence registry execution — 2026-09-25

Status: QA implementation evidence only; **no framework/target certification and no negative vector promoted to covered**.

Source branch head at staging time: `09ef95dd282acf7ecdb403e90b187488637344f1`.

## Exact GitHub source blobs staged

- `test/corpus-next/corpus.mjs` -> blob `80bda8bfbdd124083c79db5b8c32ca762ea49118`
- `test/corpus-next/manifest.json` -> blob `2b73352e4f2e1a6011c204080937f3d7a9b57e6a`
- `test/conformance-next/catalog.mjs` -> blob `0834b8ea8e9a97f63b5db67864c1dfcab0104c55`
- `test/conformance-next/negative-vectors.json` -> blob `d65c9369b9e03cd4072e798912382293a87f6ac7`
- `test/conformance-next/external-candidates.mjs` -> blob `658648b5e57b163a04c7ea2f88e9109c324e5fe2`
- `test/conformance-next/external-evidence-candidates.json` -> blob `aa8db97542e17d46f5850d332cfc857a620f8fa5`
- `test/conformance-next/t19-foundation.test.mjs` -> blob `5df8a0340fd6b82aebf51bd1b31381830b559f4d`

The EOE sandbox API cannot create arbitrary subdirectories under this workspace. The six module/JSON files above were copied byte-for-byte to flat sandbox filenames. The test file was copied from its exact GitHub blob and changed **only** in import/file-read paths so it referenced those flat staging filenames. No test assertion, input data, validator logic, expected count, or status was changed.

This is therefore stronger than the earlier generated-data mirror, but it is still recorded as a staged-source execution rather than a GitHub required-CI execution.

## Execution

Host: `EOE.local`  
Workspace: Tailnet Commander `sandbox`  
Observed at: `2026-09-25T03:00:44.846Z`  
Request id: `526945de-4a16-4d04-a80b-5e9b7f92879c`

Command:

```text
node --test t19-exact-foundation.test.mjs
```

Result:
- exit code: 0
- tests: 17
- pass: 17
- fail: 0
- cancelled: 0
- skipped: 0
- todo: 0

The suite verifies:
- development corpus remains non-certifying;
- commit/license/golden/holdout/path constraints fail closed;
- 79-vector catalog/category counts;
- candidate->covered promotion requires immutable execution refs;
- mutable/traversal-like evidence refs are rejected;
- external candidate registry uses exact commit refs;
- unknown vector mappings are rejected;
- external sources cannot self-certify;
- queued/in-progress CI is preserved as nonterminal rather than converted to success.

## External candidate snapshot

At the independent observation used by `external-evidence-candidates.json`:
- T01 PR #82 / `c91c2e20...`: CI #573 in progress; direct candidates NEG-ID-01 and NEG-ID-03.
- T21 PR #80 / `148605fb...`: CI #487 completed success; direct candidates NEG-CACHE-01 through NEG-CACHE-06.
- T23 PR #78 / `c3ca5ba8...`: CI #667 queued; direct candidates NEG-RELEASE-03 and NEG-RELEASE-04.
- T14 PR #71 / `6b87e3a2...`: CI #597 in progress; partial candidate NEG-GEN-04.
- T20 PR #79 / `c534935b...`: CI #660 queued; partial candidate NEG-TRUST-05.

Registry summary:
- external candidates: 5
- unique mapped vectors: 12
- direct mappings: 10
- partial mappings: 2
- exact-head CI-success candidate branches: 1
- nonterminal candidate branches: 4
- T19 covered vectors from this registry: **0**

## Boundary

T19-03 remains blocked by T00-04/shared next interface freeze. The current work stays in T19-02: independent negative-vector evidence cataloging. The requested T00/T23 CI integration for `test/conformance-next/*.test.mjs` remains outstanding.
