# T19 independent candidate review — T11 legacy HTTP compatibility

Reviewed: 2026-09-25
PR: #77
Reviewed immutable commit: `541272b0091734870dee035f38f295bc37f37330`
Current PR head observed later: `3c6ec03ac557324bbe1873427fa15d10afc8a73d`
Disposition: **VALID HISTORICAL EXTERNAL EVIDENCE CANDIDATE — PARTIAL MAPPINGS ONLY**

This review deliberately distinguishes the immutable handoff commit from the now-advanced PR branch.

## Partial mappings

### NEG-ID-03 — alias/operation identity refusal

Reviewed test:
- `test/http-legacy-next/parity.test.mjs`
  - `T11-04 parity catches endpoint path + operation identity drift at precise paths`

This proves the T11 parity harness detects a changed operation identity. It does **not** specifically prove that every display alias cannot repair a missing operation identity. Therefore T19 records only a **partial** NEG-ID-03 mapping.

### NEG-GEN-05 — wrong primary-key codec

Reviewed test:
- `test/http-legacy-next/parity.test.mjs`
  - `T11-04 parity catches persistence-key drift without widening JS Express capability semantics`

This catches key-semantic drift but does not independently execute a wrong key codec through generated resolver behavior. Therefore the NEG-GEN-05 mapping is **partial**, not direct.

## Additional useful compatibility evidence

Reviewed T11 definitions also include:
- read-set drift and module-order drift detection;
- exact checkout ref rejection before corpus scanning;
- expected-adapter mismatch rejection;
- semantic regression digest mismatch rejection;
- readiness logic that never grants stable apply permission.

These are useful T11 migration guards. T19 does not turn them into unrelated negative-vector coverage merely to increase the count.

## Execution state of the reviewed commit

The historical reviewed commit has exact-head GitHub run:
- run `36089509500`
- run #739
- head `541272b0091734870dee035f38f295bc37f37330`
- status completed
- conclusion success

However that generic root CI did **not** execute the nested `test/http-legacy-next/**` suite. T11's 30/30 EOE nested run is producer-reported execution context, not an independent required-CI execution binding.

The PR later advanced to `3c6ec03ac557324bbe1873427fa15d10afc8a73d`, whose observed current CI is queued. This review must not be used as certification of that later head.

## Verdict

T19 admits the immutable `541272b...` evidence as an external candidate with two partial mappings only.

- certification: false
- covered vectors from this candidate: 0
- nested CI integration still required
- current-head T11 promotion still requires a fresh independent review after required dependencies are satisfied
