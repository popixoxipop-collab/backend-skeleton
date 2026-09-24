# Track A integration patch requests

## PATCH-A-01
Target: `lib/cli.mjs` and `bin/bskel.mjs`  
Reason: expose the completed side-effect-free multi-domain analyzer without changing legacy `bskel scan`.  
Required symbols/behavior: route a future `bskel webgame analyze --repo <path> [--json]` command to `tools/webgame/analyze.mjs` or `scanners/multiplane.mjs`.  
Compatibility: existing `scan`, adapter arbitration, scan-report schema, and exit codes must remain unchanged.  
Tests: integration owner should add a top-level CLI contract test; Track A tests directly cover `scanMultiplane()`.

## PATCH-A-02
Target: CI/package test wiring owned by the Integrator.  
Reason: the repository's existing `npm test` glob is `test/*.test.mjs`; Track A owns only `test/webgame-scan/**`.  
Required behavior: import/run `test/webgame-scan/*.test.mjs` from an Integrator-owned root test or add a shared test script.  
Evidence: a temporary root shim on validation commit `b2e7255907b3cf0ccb945930772ae706bfbfeeec` ran all 19 Track A tests successfully on Node 22 and Node 24 in workflow run `36024180096`; the shim is intentionally removed from the final Track A diff to preserve path ownership.  
Compatibility: do not change existing test semantics or remove existing scripts.

## PATCH-A-03
Target: Foundation dependency decision / `package.json` only if Integrator approves  
Reason: the parallel plan mentions the TypeScript compiler API, but Track A is forbidden from changing package dependencies and the current package does not declare `typescript`. The implemented parser is a conservative, non-executing lexical parser that masks comments/template strings and preserves Svelte source coordinates.  
Required behavior: if full TypeScript AST semantics are required for RC, Integrator may add `typescript` and swap the parser implementation behind the same Track A interface.  
Compatibility: current evidence/output contract must remain stable; parser failure/dynamic references remain explicit `unresolved` findings.
