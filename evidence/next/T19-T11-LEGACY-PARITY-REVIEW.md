# T19 independent QA review — T11 legacy HTTP compatibility evidence candidate

Reviewed: 2026-09-25
PR: #77
Exact reviewed head: `e8c256e403c6237a326c86ab355d02f79c1a26dc`
Disposition: **VALID EXTERNAL EVIDENCE CANDIDATE — PARTIAL MAPPINGS ONLY — NOT COVERED / NOT CERTIFIED**

This supersedes the earlier historical review of `541272b...`. The current PR head was re-read and the mapped selectors still exist at the exact head above.

This review concerns compatibility/parity evidence only. It does not certify framework completeness, stable cutover, or T11's semantic digest as ContractRef identity.

## Exact-head repository evidence

GitHub exact-head PR CI:
- run id: `36095044051`
- run number: #981
- event: pull_request
- status: completed
- conclusion: **success**
- head SHA matches `e8c256e403c6237a326c86ab355d02f79c1a26dc`

The root CI does not discover `test/http-legacy-next/*.test.mjs`, so #981 is repository regression evidence, not direct execution binding for the T11-specific selectors.

## Mapping 1: NEG-ID-03 — partial only

Reviewed file:
- `test/http-legacy-next/parity.test.mjs`
- blob: `a9f82c8ae83cf34c30816ead21888032f9d6882b`

Relevant selector:
- `T11-04 parity catches endpoint path + operation identity drift at precise paths`

This proves the T11 parity harness notices operation-identity drift. It does **not** independently prove T19's stronger alias-repair refusal rule, where a valid but different operation identity must not be silently rewritten to another display/alias identity.

Candidate mapping strength: **partial**.

## Mapping 2: NEG-GEN-05 — partial only

Same parity file selector:
- `T11-04 parity catches persistence-key drift without widening JS Express capability semantics`

This proves the compatibility layer notices persistence-key drift. It does **not** prove an emitted resolver/codec correctly decodes every supported physical key end-to-end.

Candidate mapping strength: **partial**.

## Current corpus evidence reviewed

Current `test/http-legacy-next/corpus-parity.test.mjs`:
- blob: `4c036e31713812a71aef99d7d92064b4937b6a81`
- asserts the T11 corpus baseline covers every existing pinned oracle-manifest entry exactly once;
- rejects checkout drift before scanning;
- rejects expected-adapter mismatch;
- rejects semantic drift when an expected regression digest is supplied.

This strengthens T11's regression methodology, but the underlying legacy oracle repositories remain source candidates from T19's perspective until license and independent-golden review requirements are satisfied. Scanner output is not automatically application ground truth.

## Fail-closed cutover evidence

Reviewed `test/http-legacy-next/cutover-readiness.test.mjs`:
- blob: `d5dad6063a2a3e92f6950bcf337526d2f7d21cd0`
- readiness never grants apply permission even when every migration gate is true;
- missing gates are named rather than collapsed;
- invented or non-boolean gates fail closed.

Reviewed `test/http-legacy-next/shadow-projection.test.mjs`:
- blob: `ce662c3954e4b311eb56953223a1c49e08a2f830`
- shadow projection remains non-authoritative;
- semantic drift is reported;
- schema/adapter/contract mismatch is rejected;
- projector input is frozen.

These are positive safety properties, not proof that all promotion gates are already satisfied.

## Why this is not `covered`

- Exact-head #981 generic CI does not run the nested T11 suite.
- Producer-reported EOE nested-suite results are not an independent T19 execution binding.
- NEG-ID-03 and NEG-GEN-05 matches are partial by construction.
- T01/T02/T03/T23/T19 promotion dependencies remain distinct from T11's own readiness evaluator.

No T19 vector is promoted to covered from this review.

## Promotion requirements

For future T11-to-T19 coverage:
1. required nested T11 CI or equivalent independent exact-head execution must run the exact mapped selector;
2. execution must be bound to exact head/run/job evidence;
3. T19 must review semantic equivalence vector-by-vector;
4. exact ContractRef identity may not be replaced by T11's regression semantic SHA;
5. stable cutover remains T00/T23-owned and must not be inferred from T19 accepting evidence.

Final verdict: **current T11 head accepted into the external evidence registry as two partial mappings only**.
