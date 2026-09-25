# T00-04A Activation Gate

This is the fail-closed activation boundary for the staged core freeze.

The candidate semantics are already documented in `T00-04A-CORE-FREEZE.md`. Activation still requires:
1. T00-01 baseline state `ACCEPTED`;
2. current bskel/becoder/beval main SHAs equal the pinned baseline;
3. current exact-head main CI green;
4. independent T19 baseline review PASS;
5. exact-byte T01 identity candidate green and additive;
6. T03 five-state semantics green and scope-valid;
7. certification/evidence wire shape remains unpromoted;
8. runtime-tested requires verified runtime evidence;
9. T00-03 r1 lease/fencing remains green/fail-closed;
10. uncertainty/runtime-authority/non-inferred-causality boundaries remain frozen.

## Current state

**BLOCKED — baseline independent review is not complete.**

Epoch 5 currently pins:
- bskel `5472a8b82655840d1d3ce76cb926987376e37ca6`
- becoder `37ffb1d8fab6a1e4485fb6b12515d5416963bc48`
- beval `24cd9ad3cb913756184f79bb008af565a0458967`

All three current main exact-head CI runs are green. Epoch-5 PR #116 exact head is `dfec8ef6b6065d5881094565915dd4c08453f88b`; its own CI and T19 exact-head review must be terminal PASS before baseline acceptance.

T01 current head `e499073...` is green. The four blobs actually frozen by 04A are unchanged from the earlier reviewed head:
- `contracts/next/identity.mjs` → `c880a606...`
- ArtifactRef schema → `d6936653...`
- HTTP identity-envelope schema → `e4e5fdd3...`
- identity golden → `42177e1a...`

T03's only path exception is exact bridge lease `T03-ROOT-TEST-001`: `test/capability-next.test.mjs` blob `544b8bcc...`. It contains only the import shim for the nested ownership-local suite and has no semantic authority. Any byte change invalidates the lease. T03 certification/evidenceRefs remain draft; only the five-state vocabulary is an 04A candidate.

Plane-specific work T02/T09/T10/T16/T17/T18 and framework profiles remains outside 04A and follows 04B promotion gates.
