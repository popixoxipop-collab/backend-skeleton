# T19 QA foundation R5 — manual source goldens + license provenance

Date: 2026-09-25
Source branch head before this evidence commit: `6d2efd1f2f620e5930819a4b7ffbd547e06c330b`
Status: T19-01/T19-02 implementation evidence; **not product/framework/runtime/release certification**.

## T19-01 corpus progress

### Local development fixtures

Five shipped local fixtures remain in the development cohort:
- java-spring
- python-fastapi
- typescript-express
- javascript-express
- ruby-rails

Each now points to a **manual, source-backed, selected-fact golden**:
- golden files: 5
- selected source assertions: **24**
- completeness claims: **0**
- independent reviews completed: **0**
- certification-eligible entries: **0**

The goldens were authored from fixture source, not copied from scanner output.

Examples of what is pinned:
- Spring controller base path, one exact operation, JPA table/key, enum storage, global prefix declaration
- FastAPI router prefix/route and SQLModel entity/DTO source shapes
- TypeScript Express nested mount declarations, leaf GET route, TypeORM UUID entity
- JavaScript Express app/router mounts and three explicit user routes
- Rails resource declarations, dynamic-route interpolation flag, explicit table/primary key

The goldens deliberately do not claim complete application coverage or runtime-effective route completeness.

### License provenance observations

The 17 exact-SHA real-repo oracle candidates were checked at their pinned commits for root LICENSE/COPYING/NOTICE-style files and compared with current GitHub repository license metadata as a **hint only**.

Observed:
- pinned root license file present: **12**
- no pinned root license file observed: **5**
- current GitHub SPDX hint present: **12**
- certification eligible from license observation alone: **0**

The five repositories with no pinned-root license file and no current GitHub license metadata observed are:
- `ali-bouali/spring-security-asymmetric-encryption`
- `justine92415/express-postgres-template`
- `leroy-netizen/marketplace-backend`
- `rtfeldman/node-express-realworld-example-app`
- `nekesam/helloworld`

“no pinned root license file observed” is intentionally narrower than “unlicensed”; T19 does not make a legal determination from this scan.

For the 12 observed files, the exact pinned Git blob SHA and byte size are recorded. Current-repo SPDX metadata is not treated as proof that the pinned commit has the same legal classification.

### Legacy real-repo projection

All 17 legacy oracle repos remain:
- exact-SHA pinned source candidates;
- non-certifying;
- pending an actual license/legal-use decision where required;
- pending independent golden review.

No network scanner output is promoted to ground truth by this change.

## T19-02 negative/evidence state

- negative vectors: **79**
- local evidence-candidate vectors: **11**
- local covered vectors: **0**
- external immutable candidate commits: **7**
- external unique mapped vectors: **14**
- direct external mappings: **12**
- partial external mappings: **4**
- external recorded exact-head generic CI success: **7/7**
- candidates with selector-level job observations: **1**
- covered vectors from external registry: **0**

Every external CI record is now required to satisfy:
`ci.head_sha === source.commit`.

Generic CI success does not prove nested track-owned selector execution.

## Exact source blobs used

- corpus validator: `b1f4aa3e8cdd7cc193748c3bcf1fded3d0615393`
- local corpus manifest: `2309164fe4aee24d6b9832abd90b02d2bf5a26be`
- legacy oracle projector: `9e65c8d395ce6cf6dc0b234302e2cfd5fff99375`
- license observation validator: `09dd223ffb35f6fd7121fd3a80bd225df2c1464d`
- license observations: `9069309a4209bb0409d4792a4210894632669649`
- manual source-golden validator: `01f5af69d9c92ebf21623b12c26fd193dcaaf99c`
- manual source goldens: `f0485005e063d88cda87c4be59aec2d9b5ec5aec`
- negative catalog validator: `0834b8ea8e9a97f63b5db67864c1dfcab0104c55`
- negative catalog: `094f9a008f916b3568b32a4abdfcce07b6810351`
- external-candidate validator: `e2f8f69dbe50b4114b0d675c7d44db6a926950d8`
- external-candidate registry: `26ffded32bf9d2cbd32436590fb0e8d9795fc6a5`
- T19 foundation test: `7a43d16bcaaea95cee056c42e9fadcb41a34bf30`

## Exact-source staged execution

GitHub source artifacts above were staged to EOE with source bodies/JSON unchanged. Because the sandbox writer cannot create arbitrary nested directories, only test import/read paths were rewritten to flat sandbox filenames.

EOE:
- command: `node --test t19_full_branch.test.mjs`
- request id: `0d17d519-3e91-4b0a-9fd7-3df34ec9bbbc`
- exit: 0
- tests: **32**
- pass: **32**
- fail: 0
- skipped: 0
- cancelled: 0
- todo: 0

## GitHub CI boundary

At the pre-evidence exact head `6d2efd1f...`, generic PR CI run `36103041834` / #1100 was queued at the observation point.

Regardless of its eventual result, current root `npm test` does not discover `test/conformance-next/t19-foundation.test.mjs`. The shared T00/T23 nested-lane request therefore remains open.

## Dependency boundary

T19-03 differential harness remains **not started**. T00-04/shared Claim/IR activation remains candidate-only/infrastructure-blocked.

R5 therefore advances only:
- T19-01 corpus/provenance/golden preparation;
- T19-02 negative/evidence provenance;
- independent QA reviews.

No support matrix or release state changes are granted.
