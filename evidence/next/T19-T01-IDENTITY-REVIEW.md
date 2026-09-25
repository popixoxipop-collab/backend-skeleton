# T19 independent review — T01 identity conformance pack

Reviewed source:
- PR #82
- exact head: `c91c2e208e6318f056501474fa9da6eea9f51384`
- pack: `schemas/next/identity-conformance.json`
- pack blob: `519ae080631cebeed9f3426365ce661f361d90b3`
- pack status: `candidate-prefreeze`

Disposition: **VALID EVIDENCE CANDIDATE, NOT COVERED/CERTIFIED**

## Direct T19 mappings

### NEG-ID-01 — raw reformat / exact-byte identity

The pack contains `compact-json` and `pretty-json` artifact cases. They parse to the same JSON shape but intentionally have different:
- byte lengths: 21 vs 26
- SHA-256 values: `b8a87c62...` vs `33e55763...`

This directly supports the T19 requirement that apparent semantic equivalence does not erase exact-byte artifact identity.

### NEG-ID-03 — operation alias repair

The pack contains `valid-but-different-operation-id-is-not-repaired`:
- input operation ID: `001-hello:getHello`
- expected operation ID remains exactly `001-hello:getHello`
- it is explicitly not rewritten to `getHello`

This directly supports the T19 no-alias-repair negative requirement.

## Useful but not exact mappings

- `unknown-envelope-version` demonstrates fail-closed handling for an unknown identity envelope version, but T19 `NEG-RELEASE-02 unknown-major` is broader and is therefore **not** marked covered by this pack.
- `reference-kind-mismatch`, `unsupported-family`, and `extra-display-field` are useful future negative fixtures but do not exactly replace T19's project/field-location/runtime vectors.

## Execution state

GitHub exact-head CI for `c91c2e20...`:
- run: `36087437621`
- run number: #573
- observed status: **in_progress**
- conclusion: null

T01 separately reported a direct EOE run of its two next-contract tests as 13 pass / 0 fail. T19 records that as a producer report, not independent exact-head CI evidence.

No T19 vector is promoted to `covered` from this review because:
1. exact-head CI is not terminal success at this observation;
2. T15/T16 independent consumer replay is not complete;
3. T00-04 interface freeze remains blocked.

This review only establishes that the T01 pack is a useful candidate source for T19's ID negative corpus.
