# Track A integration patch requests

## PATCH-A-00 — Foundation freeze
Target: Integrator-owned common Foundation paths.  
Reason: the parallel Master requires common runtime/execution-plan/receipt/probe schemas and ID/verdict helpers to be frozen before A/B/C integration. No complete frozen Foundation layer is currently present across the three track branches.  
Required behavior:
- freeze the shared schema/ID/verdict contract before merging A/B/C;
- map Track A's `sbf.project/1`, `sbf.plane-adapter/1`, and `sbf.multiplane-scan/1` outputs onto that common layer without weakening provenance or source-role semantics;
- reject incompatible version/ID drift rather than silently translating it.
Compatibility: Track A collector semantics and evidence provenance remain authoritative for its static-analysis output.

## PATCH-A-01 — CLI wiring
Target: `lib/cli.mjs` and `bin/bskel.mjs`.  
Reason: expose the side-effect-free multi-domain analyzer without changing legacy `bskel scan`.  
Required behavior: route a future `bskel webgame analyze --repo <path> [--json]` command to `tools/webgame/analyze.mjs` or `scanners/multiplane.mjs`.  
Compatibility: existing `scan`, adapter arbitration, scan-report schema, and exit codes remain unchanged.  
Tests: add a top-level CLI contract test; Track A directly covers `scanMultiplane()`.

## PATCH-A-02 — Permanent test wiring
Target: Integrator-owned root test/package wiring.  
Reason: existing `npm test` expands `test/*.test.mjs`, while Track A owns only `test/webgame-scan/**`.  
Required behavior: permanently import/run `test/webgame-scan/*.test.mjs` from an Integrator-owned root test or shared test script.  
Evidence: temporary validation shim at commit `cb6049d68ba0049a4fe7fef6975c2beaab157174` ran all **30 Track A tests** successfully on Node 22 and Node 24 in workflow run `36027868011` (#300); each full suite was **1,909 tests / 1,899 pass / 0 fail / 10 skip**.  
Compatibility: do not remove or rename existing scripts or change existing test semantics.

## PATCH-A-03 — TypeScript compiler API dependency
Target: shared `package.json` / `package-lock.json` only if Integrator approves.  
Reason: the parallel Master specifies the TypeScript compiler API, but the current package declares no `typescript` dependency and Track A is forbidden from changing shared dependencies.  
Current state: Track A implements a conservative, non-executing lexical fallback that masks comments/strings/regex, tracks imports/aliases/bindings, preserves Svelte coordinates, and emits explicit unresolved findings for syntax/dynamic/template uncertainty.  
Required behavior: for RC requiring full compiler semantics, add `typescript` and replace the parser backend behind the existing Track A interface.  
Compatibility: current evidence/output contract, source roles, source digests, and fail-closed unresolved semantics must remain stable.

## PATCH-A-04 — Private/local acceptance
Target: authorized execution workspace only.  
Reason: Messenger-copy / Messenger-local are not exposed to the currently available tools.  
Required behavior: run the finalized Track A scanner against those exact checkouts and store the resulting acceptance artifacts without copying private source into the public repository.
