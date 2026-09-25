# T00-03 Lease / fencing enforcement

Status: **SUBMITTED**  
Policy revision: `T00-03-r1`

The existing `T00-03-OWNERSHIP.md` freezes semantic owners. This companion freezes the machine-enforced write lease rules.

## Claim requirements

Every ACTIVE claim binds:
- track + repository,
- worker identity,
- actual worktree identity,
- exact base SHA,
- repo-relative path scopes,
- issue/expiry timestamps,
- monotonically increasing fencing token.

A GitHub branch alone is not treated as proof of an actual worktree. The ledger starts empty rather than fabricating ACTIVE claims.

## Fail-closed rules

The verifier rejects:
1. overlapping unexpired claims in the same repository;
2. fencing token regression;
3. results after lease expiry;
4. results from an older token after re-lease;
5. base SHA mismatch;
6. changed files outside leased scope;
7. traversal/absolute/backslash/unsupported scope patterns;
8. claims outside the track ownership policy.

The verifier is read-only. T00 mutates the ledger only through reviewed commits.

## r1 scope decisions

The default path scopes come from the master plan's maximum write scopes.

Two explicit adjustments are frozen:
- T16 uses `lib/next-runtime/**` rather than planned `src/next-runtime/**`, because the actual beval source tree is `lib/`. Its nested test/docs scopes remain unchanged.
- T23 may not directly lease workflow files in r1 even though the plan names `.github/workflows/scale-next-*.yml`; workflows remain a shared hot path until T00-04.

## Existing-PR audit

Only T05, T10, T19, T22 and T23 are fully inside r1 scopes as currently diffed.

Most minor violations are root-level test shims created because current bskel `npm test` discovers only `test/*.test.mjs`. T00 does not solve that by silently widening every track. Nested-test discovery is a T00/T23 integration change request.

High-impact deviations:
- T11 #77 must re-home compatibility helpers from `scanners/adapters/` into `adapters/http-legacy-next/**`.
- T12 #66 must leave the live `scanners/adapters/` registry and re-home under `adapters/http-wave-a/**`.
- T15 #8 is outside its planned `lib/next/**; test/next/**; docs/next/**` scope and must split.
- T18 #70 must re-home stable `contracts/` / `scanners/` additions into `adapters/protocol-next/**; test/protocol-next/**`.

See `evidence/T00-03/ownership-scope-audit-R1.json`.

## Test evidence

The focused verifier regression suite passed 9/9 locally:
- same-path concurrent claim rejected,
- non-overlap accepted,
- out-of-ownership claim rejected,
- token regression rejected,
- expired result rejected,
- stale fenced result rejected,
- result path escape rejected,
- traversal scope rejected,
- valid ledger accepted.
