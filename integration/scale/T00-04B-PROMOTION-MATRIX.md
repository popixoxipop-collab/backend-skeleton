# T00-04B Plane / Profile Promotion Matrix

> **Status note (2026-09-26):** this matrix is a historical 04B decision snapshot. For current PR/SHA/CI/merge state and the active integration order, use `integration/scale/T00-05-EXECUTION-BOARD.md`. Do not treat stale track-state labels below as current execution status.

Generated: 2026-09-25  
Coordinator: T00  
Status: **DRAFT_MATRIX — applies after T00-04A activation**

T00-04A freezes only common semantics. 04B promotes each analysis plane, runtime bridge, and framework profile independently.

## Promotion rule

A plane/profile may move from `DRAFT` to `INTEGRATION_CANDIDATE` only when all of the following are true:

1. exact-head CI is terminal success;
2. focused tests for that plane actually ran;
3. changed paths are within the T00-03 lease;
4. source/runtime evidence is bound to exact artifacts where required;
5. unknown/partial/ambiguous states remain explicit;
6. T19 has independent negative/corpus review for the claimed support level;
7. package/CLI/registry changes, if any, are separately leased by T00/T23;
8. runtime-tested claims have T16/beval evidence, never candidate self-report.

Green generic repository CI alone is not sufficient if the plane's nested tests were not discovered.

## Current track dispositions

| Track | Current state | Cleared | Remaining before 04B promotion |
|---|---|---|---|
| T01 identity | 04A semantic candidate | exact-byte ArtifactRef, HTTP additive envelope, scope corrected, CI green | independent consumer replay for T15/T16 before cross-tool shipping |
| T02 ProjectGraph | INTERNAL_DRAFT | scope corrected, Legacy A mapping, exact-head green | remove absolute checkout path from portable serialized identity/cache seam |
| T03 capability | 04A vocabulary candidate / certification draft | five-state vocabulary, CI green | typed immutable/runtime evidence refs; root test re-home before branch integration |
| T04 JS/TS | HOLD_FANOUT | base analyzer green | root-test re-home; collapse child experiments; T23/T20 dependency decision for parser packages |
| T05 JVM | INTERNAL_CANDIDATE | owned syntax foundation, CI green | semantic/backend selection review; framework layers consume, do not duplicate |
| T06 Python | HOLD_SCOPE | analyzer + Django/Flask shadows green | re-home all root Python tests; stop further framework fan-out until 04A |
| T07 Ruby/PHP | HOLD_SCOPE | conservative DSL facts green | root test shims re-home; retain dynamic DSL unknowns |
| T08 native server | HOLD_SCOPE | language backend foundation green | root test re-home; T20 review for any executable/toolchain path |
| T09 reconciliation | INTERNAL_CANDIDATE | synthesized-ID correctness fixed, CI green | root test re-home; legacy HTTP v9 writer remains authority until integration |
| T10 persistence | INTERNAL_DRAFT | provider plane expanded, CI green | validate generic source_refs/entity IDs; explicit binding only; independent evidence review |
| T11 legacy HTTP | INTEGRATION_CANDIDATE_AFTER_04A | fully re-homed, parity/corpus guards, CI green | T19 review + integration lease; no legacy behavior drift |
| T12 Wave A | REMOVED_FROM_TRAIN | branches preserved | resubmit common leaf under `adapters/http-wave-a/**`; no live registry until certification |
| T13 Wave B/C | PROFILE_BY_PROFILE | Hono/Koa implementation evidence | re-home root shims; Next.js red; no new fan-out; T19 per-profile certification |
| T14 codegen composition | HOLD_SCOPE | composition preview green | test re-home; typed runtime behavior evidence handoff from T16/T19 |
| T15 becoder consumer | SPLIT_REQUIRED | old R3F evidence preserved | new dependency-safe T15-01/02 PR only; renderer/product patch replay later |
| T16 runtime binding | RESUBMIT_REQUIRED | stale-base issue fixed in preserved branch | clean split under next-runtime owned paths; T01 replay; CI; no shared product hook |
| T17 game-next | 04B_CANDIDATE_PENDING_INTEGRATION | exact source contract ArtifactRef, Legacy A mapping, scope corrected, CI green | nested-test discovery + package allowlist; native execution waits T20/T16 |
| T18 protocol-next | 04B_CANDIDATE_PENDING_INTEGRATION | typed exact protocol item refs, scope corrected, CI green | nested-test/package integration; runtime oracle/certification owned by T16/T19 |
| T19 QA | QA_AUTHORITY_DRAFT | independent reviews functioning | nested QA suites must become required CI; keep expected outputs independent |
| T20 trust | HOLD_SCOPE | deny-by-default policy green | root test re-home; actual enforcement/sandbox integration later |
| T21 incremental/cache | HOLD_SCOPE | cache/store primitives green | root test re-home; portable fingerprints from T02/T10/T17/T18 before default caching |
| T22 SDK/UX | INTERNAL_CANDIDATE | data-only SDK boundary | T20 execution policy + T23 packaging; no auto-install/dynamic import |
| T23 release | INTEGRATION_OWNER | runbook/inventory/change requests | implement shared nested-test discovery and package allowlists only after 04A activation |

## Framework profile promotion

Framework support is certified per profile, not per language family.

### Production registration requires

- leaf implementation is outside the live registry until the registration gate;
- source discovery + route/model facts are independently tested;
- runtime/OpenAPI reconciliation is tested where the profile claims it;
- persistence/codegen capabilities only activate for explicitly proven combinations;
- registration adds conformance fixture + corpus + negative cases;
- T19 records the certified support level;
- T23 performs the live registry/package change under an integration lease.

### Current HTTP profile notes

- Existing five adapters: preserve as legacy production baseline under T11 parity.
- NestJS / Fastify / Flask Wave-A attempts: previous live-registry PRs were closed without merge; re-submit as unregistered leaves.
- Hono: static leaf evidence is green; integration still waits scope cleanup + T19.
- Koa: static leaf evidence green; root shim cleanup pending.
- Next.js: current first slice has red exact-head CI; profile stays HOLD_FIX.
- Django/Flask language facts in T06 are analyzer evidence, not production adapter certification.

## Game / protocol promotion

### T17 game-next
May ship as a next/draft plane only after:
- `adapters/game-next/**` is explicitly included by T23;
- nested tests are required CI;
- exact input webgame contract bytes are revalidated;
- no causal/runtime claim is emitted from static structure.

Native Unreal/Unity/Godot export execution remains a later T20/T16 gate.

### T18 protocol-next
May ship as a next/draft plane only after:
- `adapters/protocol-next/**` package decision;
- nested tests required in CI;
- typed item refs stay bound to exact contract bytes;
- runtime assertions are delegated to T16/beval;
- ordering/correlation never imply causation.

## Runtime / codegen promotion

### T16
A runtime evidence envelope is not production-ready merely because a binding hash exists.
Promotion requires:
- clean owned-path PR;
- exact T01 conformance replay;
- isolated env/credential policy;
- immutable verifier-produced outcome binding;
- exact-head runtime tests.

### T14
`behavior-tested` requires a verifier-produced successful behavior result bound to exact runtime evidence.
The existence of a RuntimeBinding or evidence pair alone is insufficient.

## Shared integration work after 04A

T23/T00 should batch shared hot-file changes rather than letting each track create a root shim or package edit:

1. nested test discovery;
2. package allowlists for approved next namespaces;
3. optional CLI/registry discoverability for promoted planes;
4. rollback flags / compatibility inventory;
5. release evidence that proves legacy default behavior remains unchanged.

## Concurrency cap

Until the first 04A activation:
- one active implementation slice per track;
- additional child branches are evidence-only;
- no new T04/T12/T13 framework/parser fan-out;
- verify-only runtime experiments must not starve baseline CI.
