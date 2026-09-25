# T19 independent candidate review — T18 protocol-next

Reviewed: 2026-09-25
PR: #70
Reviewed commit: `9fcab1f369ba93b2b30decb2d0181af50ef621d9`
Disposition: **VALID EXTERNAL EVIDENCE CANDIDATE — NOT COVERED / NOT CERTIFIED**

## Direct mappings accepted as candidates

### NEG-ID-01 — exact-byte identity

Reviewed test definitions:
- `test/protocol-next/protocol-item-ref.test.mjs`
  - `format-only contract byte change invalidates the protocol item ref`
  - `contract object view cannot disagree with the exact referenced contract bytes`

These directly exercise that a protocol item ref is bound to exact addressed bytes and that a separately supplied object view cannot replace those bytes.

This is candidate evidence for NEG-ID-01. It is not general ContractRef certification for every family.

### NEG-SCHEMA-08 — remote ref denial

Reviewed test definition:
- `test/protocol-next/protocol-loaders.test.mjs`
  - `structured loader rejects remote refs, oversized documents and duplicate YAML keys`

This directly matches the remote-ref denial portion of NEG-SCHEMA-08 for the T18 bounded structured loader.

It does not prove every OpenAPI/schema loader in bskel denies remote network refs.

## Useful evidence not mapped to the 79-vector catalog

T18 also has explicit tests that:
- temporal ordering does not become causation;
- correlation does not become causation;
- family/plane mismatch fails closed;
- causal/order cycles fail closed.

Those are valuable protocol-plane QA but the current 79-vector taxonomy has no protocol causation category. T19 does not force them into an unrelated vector.

## Current execution state

GitHub exact head:
- `9fcab1f369ba93b2b30decb2d0181af50ef621d9`

CI:
- run `36094194743`
- run #889
- event: pull_request
- status: **queued**
- conclusion: null

T18 reports direct EOE runs of 69/69 focused and 97/97 cross-regression at this head. T19 records those as producer-reported context, not independent CI evidence.

The root bskel test glob also does not automatically execute `test/protocol-next/*.test.mjs`.

## Verdict

The two mappings are admitted to T19's `sbf.external-evidence-candidates/1` registry with direct strength, but:
- candidate state remains `external-candidate`;
- certification remains false;
- job observations are empty;
- no T19 vector is promoted to `covered`.

T18 runtime/oracle and protocol certification remain blocked on the T16/T19/T00 integration boundaries.
