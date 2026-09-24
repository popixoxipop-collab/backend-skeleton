# Track A integration patch requests

## PATCH-A-01
Target: `lib/cli.mjs` and `bin/bskel.mjs`  
Reason: expose the completed side-effect-free multi-domain analyzer without changing legacy `bskel scan`.  
Required symbols/behavior: route a future `bskel webgame analyze --repo <path> [--json]` command to `tools/webgame/analyze.mjs` or `scanners/multiplane.mjs`.  
Compatibility: existing `scan`, adapter arbitration, scan-report schema, and exit codes must remain unchanged.  
Tests: integration owner should add a top-level CLI contract test; Track A tests directly cover `scanMultiplane()`.

## PATCH-A-02 — closed in Track A
The existing `npm test` glob only sees `test/*.test.mjs`. Track A now adds a new-file-only shim, `test/webgame-static.test.mjs`, which imports the owned nested suite. No `package.json` edit is required.

## PATCH-A-03
Target: Foundation dependency decision / `package.json` only if Integrator approves  
Reason: the parallel plan mentions the TypeScript compiler API, but Track A is forbidden from changing package dependencies and the current package does not declare `typescript`. The implemented parser is a conservative, non-executing lexical parser that masks comments/template strings and preserves Svelte source coordinates.  
Required behavior: if full TypeScript AST semantics are required for RC, Integrator may add `typescript` and swap the parser implementation behind the same Track A interface.  
Compatibility: current evidence/output contract must remain stable; parser failure/dynamic references remain explicit `unresolved` findings.
