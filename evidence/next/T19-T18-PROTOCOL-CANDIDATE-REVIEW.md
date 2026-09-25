# T19 independent QA review — T18 protocol-next evidence candidate

Reviewed: 2026-09-25
PR: #70
Exact reviewed head: `9fcab1f369ba93b2b30decb2d0181af50ef621d9`
Disposition: **VALID EXTERNAL EVIDENCE CANDIDATE — NOT COVERED / NOT CERTIFIED**

This review does not certify T18 runtime behavior, protocol support, or product release status.

## Exact-head repository evidence

GitHub exact-head PR CI:
- run id: `36094194743`
- run number: #889
- event: pull_request
- status: completed
- conclusion: **success**
- head SHA matches `9fcab1f369ba93b2b30decb2d0181af50ef621d9`

The generic repository CI is useful regression evidence, but the root `npm test` glob does not execute `test/protocol-next/*.test.mjs`. Therefore #889 is not treated as independent execution proof of the T18-specific selectors below.

## Direct T19 mappings accepted as candidates

### NEG-ID-01 — exact-byte identity

Reviewed file:
- `test/protocol-next/protocol-item-ref.test.mjs`
- blob: `d3db3d8e52f0a58a0ba582bfa671f219d09a8b06`

Relevant selectors:
- `format-only contract byte change invalidates the protocol item ref`
- `contract object view cannot disagree with the exact referenced contract bytes`

These directly support the T19 negative requirement that exact referenced bytes cannot be replaced by a semantically similar/reformatted or split-brain object view.

Candidate mapping strength: **direct**.

### NEG-SCHEMA-08 — remote ref denial

Reviewed file:
- `test/protocol-next/protocol-loaders.test.mjs`
- blob: `8fb569c36f285f708d6fb1b99bd2f5b52cc23c5d`

Relevant selector:
- `structured loader rejects remote refs, oversized documents and duplicate YAML keys`

This directly supports the bounded-loader portion of T19's remote-ref negative requirement: the protocol loader does not silently follow a remote schema reference.

Candidate mapping strength: **direct**.

## Useful non-certifying observations

Reviewed `test/protocol-next/protocol-flow.test.mjs` blob `f098e72adac3f97cc7f41020ec410fb5a15abaf1` includes explicit tests that:
- temporal ordering does not imply causation;
- correlation does not imply causation;
- causation only comes from explicit `caused_by`;
- cycles and mismatched action references fail closed.

These are useful future protocol/distributed-flow QA material, but T19 does not remap them into an unrelated existing negative-vector category just to increase coverage.

## Why this is not `covered`

T19 coverage requires an exact execution reference for the mapped selector(s). Current #889 is generic root CI and does not execute the nested T18 suite. T18's producer-reported EOE 69/69 and 97/97 runs are valuable producer evidence but are not independent T19 execution binding.

Additional blockers:
- T18 runtime/oracle execution is T16-owned and remains blocked;
- T00/T23 nested-test/package integration is not complete;
- T00-04 activation remains candidate-only/infrastructure-blocked.

## Promotion requirements

Before T19 can promote either vector from external-candidate to `covered`:
1. run the exact T18 nested selectors against this immutable source head, or another re-reviewed exact head;
2. bind the terminal execution to exact head/run/job evidence;
3. preserve the tested source/blob identities;
4. keep runtime claims separate unless T16 independent oracle evidence exists;
5. rerun T19 review if T18 head changes.

Final verdict: **accepted into the external evidence registry only**.
