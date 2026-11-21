# T19 NEG-ROUTE-01 — computed Express mount prefix

## Reproduced product defect

On protected main `cc8c40ce846dc785c0fce6a86b31efcc8566eb95`, `app.use(prefix, childRouter)` discarded the unknown mount edge. The child receiver was then treated as unmounted, producing a false absolute `GET /ping` route from its relative `child.get('/ping', handler)`. Nested computed mounts suffered the same error.

Original code RED evidence: `/Volumes/D50/TailnetCommander/work/t19-route-unknown-20261022/route01-original.RED.tap` (SHA256 `6f03a3ee20e9e501acf93cd35ed32d78b9c594a2f7ccd60ffcd68012d182b8a7`). Two cases directly observed the invented route; the remaining early RED cases established the absence of a first-class unknown diagnostic before the correction.

## Bounded correction

In the first-party scanner `scanners/adapters/typescript-express.mjs`:
- Retain mount edges to **proven local/imported Express receivers** even when the prefix expression is not statically literal (`prefix === null`). Do not identify arbitrary callbacks or unresolved factories as routers.
- A dynamic incoming edge does not give its target a trusted literal prefix. A child with only dynamic ancestors emits **no invented absolute path**. Independent literal incoming routes remain available.
- Emit a deterministic `scanNotes` warning identifying each recognized, unresolved computed mount with repo-relative file and line. The existing public `runScan` forwards it as a report `unknowns` entry.
- Retain prior behavior for unmounted Router receivers and all literal mount-only prefixes.

Seven direct source-oracle tests cover computed parent, nested computed descendant, mixed literal+unknown incoming paths, valid unmounted/static baselines, trusted default imports across two TS files, computed template literals and end-to-end public scan-report diagnostics. No mocks or external HTTP calls.

## Limitations and governance

This is a bounded static source scanner—not runtime Express path introspection, proof of arbitrary dynamic factory bindings, conditional host/version routing, or authorization enforcement. It addresses a concrete `NEG-ROUTE-01` bug without claiming `NEG-ROUTE-08` or whole T19 completion.

The scanner is a shared product source path outside the strict T19-only ownership map. Its addition to a PR requires **explicit T00 cross-owner scope acceptance**; do not forge a normal ownership PASS. Independent code review, exact-head GitHub CI, protected merge, actual merged-head replay and scoped canonical adjudication remain mandatory. No public npm publish, production deployment, Tailnet activation, or MET promotion.

Official state at implementation: T00 r202, MET 88 / PARTIAL 143 / NOT_MET 60; T19-04 PARTIAL.
