# T19 QA foundation R4 — exact-head provenance hardening

Date: 2026-09-25
Source branch before this evidence commit: `92dee106f8fdafd12770a697baa82ad7a354387c`
Status: QA implementation evidence; **not framework/runtime/release certification**.

## T19-01 / T19-02 state

Corpus:
- 5 local framework fixtures in development cohort
- 0 local entries independently certified
- 17 pinned legacy real-repo oracle entries projected only as source candidates
- those 17 still require license review + independent golden review

Negative catalog:
- 79 total vectors
- 11 local evidence-candidate vectors
- 0 covered vectors

Cross-track external registry:
- 7 immutable candidate commits
- 14 unique mapped vectors
- 12 direct semantic mappings
- 4 partial semantic mappings
- 7/7 recorded exact-head generic CI runs are terminal success
- 1 candidate (T21) has job-level observed mapped subtests
- 0 vectors covered from the external registry

A generic exact-head CI success is not equal to execution of a nested track-owned selector.

## Provenance hardening added

Each external candidate now records:
- exact source commit SHA
- exact CI run id and run number
- exact CI head SHA
- terminal status/conclusion

The validator requires:

```
candidate.ci.head_sha === candidate.source.commit
```

A CI run attached to another head is rejected even if its conclusion is success.

Existing protections remain:
- mutable source refs rejected
- traversal-like test paths rejected
- unknown negative-vector IDs rejected
- external candidate cannot self-mark `covered` or `certification:true`
- nonterminal CI cannot carry a success conclusion
- job-level observations must belong to the same candidate run
- job observations require completed-success candidate CI

## Current external candidate exact-head CI snapshot

| Candidate | Commit | Run | State |
|---|---|---|---|
| T01 identity | `c91c2e208e6318f056501474fa9da6eea9f51384` | #573 / `36087437621` | completed success |
| T21 cache | `148605fb8d7074f78cff368b1c1a237263143e61` | #487 / `36083666703` | completed success |
| T23 release | `c3ca5ba840a6a8bd0f9c210e420184bf672c08e4` | #667 / `36088132185` | completed success |
| T14 generation | `6b87e3a24d029b0b3b888944eb32b2ba8f84da0e` | #597 / `36087619559` | completed success |
| T20 trust | `c534935bf227b306e78ebbbb6e95ed998b690771` | #660 / `36088093082` | completed success |
| T18 protocol | `9fcab1f369ba93b2b30decb2d0181af50ef621d9` | #889 / `36094194743` | completed success |
| T11 legacy parity | `e8c256e403c6237a326c86ab355d02f79c1a26dc` | #981 / `36095044051` | completed success |

T18 review: `evidence/next/T19-T18-PROTOCOL-CANDIDATE-REVIEW.md`.
T11 review: `evidence/next/T19-T11-LEGACY-PARITY-REVIEW.md`.

## Exact-source T19 execution

The current T19-owned modules/JSON were fetched from GitHub and staged byte-for-byte to EOE. The test file path references alone were rewritten to flat sandbox filenames because the sandbox write API cannot create arbitrary parent directories.

Current relevant Git blobs:
- corpus validator: `80bda8bfbdd124083c79db5b8c32ca762ea49118`
- local corpus manifest: `2b73352e4f2e1a6011c204080937f3d7a9b57e6a`
- legacy oracle projector: `9e65c8d395ce6cf6dc0b234302e2cfd5fff99375`
- legacy oracle manifest: `cf542c5398a730611e7205e6ddfbc20845a9070c`
- negative catalog validator: `0834b8ea8e9a97f63b5db67864c1dfcab0104c55`
- negative vectors: `094f9a008f916b3568b32a4abdfcce07b6810351`
- external candidate validator: `e2f8f69dbe50b4114b0d675c7d44db6a926950d8`
- external candidate registry: `26ffded32bf9d2cbd32436590fb0e8d9795fc6a5`
- T19 foundation test: `bd0af7828e9036b1cdd642e57bd6a86ca7e69690`

EOE execution:
- request id: `40e9cf03-f492-4ab3-9c53-1a9cb7d012b5`
- command: `node --test t19_full_branch.test.mjs`
- exit: 0
- tests: **24**
- pass: **24**
- fail: 0
- skipped: 0
- cancelled: 0
- todo: 0

## Program boundary

T19-03 differential harness remains blocked by T00-04/shared Claim/IR acceptance. T00-04 is still candidate-only because the baseline is infrastructure-blocked on beval exact-head CI.

T19 nested tests are still absent from the root `npm test` glob. T00/T23 has the shared-owner request in `T19-CI-INTEGRATION-REQUEST.md`.

Therefore:
- T19-01/T19-02 foundation continues as valid implementation work;
- T19-03 is **not started**;
- no target/framework/runtime support certification is granted;
- `covered` remains 0 until selector-level exact execution evidence is accepted.
