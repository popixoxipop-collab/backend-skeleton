# T00-04A Activation Gate

This file is the machine-readable activation boundary for the staged core freeze.

The semantic candidate is already documented in `T00-04A-CORE-FREEZE.md`. This gate answers a narrower question: **may the candidate be called ACTIVE now?**

Activation is fail-closed. It requires all of:

1. current T00 baseline state is `ACCEPTED`;
2. bskel/becoder/beval current main SHAs exactly equal the pinned baseline;
3. all current exact-head baseline CI is green;
4. independent T19 baseline review is PASS;
5. T01 exact-byte identity candidate is exact-head green, scope-compliant, legacy-compatible and additive;
6. T03 five-state semantics are exact-head green and scope-compliant;
7. T03 certification/evidence wire shape remains unpromoted during 04A;
8. runtime-tested support requires verified runtime execution evidence;
9. T00-03 r1 lease/fencing verifier is green and fail-closed;
10. unknown/ambiguity, runtime authority, and non-inferred causality boundaries are frozen.

The current committed snapshot is intentionally **BLOCKED**. It records the actual blockers instead of weakening them:
- epoch-4 baseline is SUBMITTED;
- beval exact-head main CI is still queued;
- T19 independent review is BLOCKED;
- T03 still carries an out-of-lease root test shim.

Plane-specific work such as T09/T10/T16/T17/T18 remains outside 04A activation and follows its own 04B promotion gate.
