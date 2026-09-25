# T00-02 Existing Work Reconciliation / Collision Map

Date: 2026-09-25
Coordinator: T00
Status: SUBMITTED

## Baseline drift discovered during T00-02

T00-01 originally froze:
- bskel `5472a8b82655840d1d3ce76cb926987376e37ca6`
- becoder `a575679b7d9e6df69c95c6c4f71cfdcf8e67c11e`
- beval `f87d442949be1ac81d00d47ab49fc0beccfc0424`

During T00-02, beval PR #39 was merged to main even though the T00 dispatch had required exact-latest-head verification before merge.

Current beval main:
- merge commit: `5bdecbcbb839ecf3fc6aad3f54b4564906c3e56c`
- merged PR head: `00792c229fc3d67ec5d4ff248aaf720f7d09defa`
- latest PR-head CI at observation: queued
- merge-commit push CI #865 at observation: queued

Therefore T00-01 cannot move to ACCEPTED yet. The original snapshot remains audit evidence, but the current execution baseline is stale until beval main is re-verified and the baseline lock is refreshed.

## Classification vocabulary

- **KEEP-SHADOW**: useful isolated work; continue only in owned paths, no stable integration yet.
- **SELECTIVE-ABSORB**: legacy work contains valuable components but must be decomposed into current track owners; do not merge as one unit.
- **FIX-REQUIRED**: scope is broadly valid, but exact-head CI is red.
- **SPLIT-REQUIRED**: implementation crossed an ownership/integration boundary and must be split before integration.
- **HOLD-STACKED**: valid dependent work, but its base/interface dependency is not accepted.
- **VERIFY-ONLY**: evidence/verification branch; never merge.
- **LANDED-PROVISIONAL**: already merged externally, but T00 has not accepted it as a verified baseline.
- **DEFER**: outside the current scale integration train.

## Collision decisions

| Work | Decision | Evidence / reason | Next safe action |
|---|---|---|---|
| T00 #65 | HOLD-REFRESH | own CI #439 green, but beval main moved after freeze | refresh only after beval merge-head evidence is complete |
| Legacy Track A #63 | SELECTIVE-ABSORB | semantic overlap with T02 project discovery, T04 JS/TS analysis, T17 game graph, T18 protocol/network; no direct file collision with current lanes | freeze code; create unique-vs-duplicate mapping |
| Legacy Track C #62 | SELECTIVE-ABSORB | evidence/freshness/release policy overlaps T19/T20/T23 and beval runtime evidence; also touches shared `lib/gate-profiles.mjs` | freeze; re-home unique pieces by owner |
| T01 #82 | KEEP-SHADOW | backward-compatible identity lane, exact-head CI green | continue audit/goldens; no stable cutover before T00-04 |
| T02 #72 | KEEP-SHADOW | project graph exact-head CI green | reconcile #63 nested project/read-set concepts |
| T03 #81 | KEEP-SHADOW | capability policy exact-head CI green | keep stable capability schema unchanged |
| T04 #73 | KEEP-SHADOW | JS/TS facts/comparator exact-head CI green | reconcile parser/provenance with #63 |
| T04 stacked #87 | HOLD-STACKED | based on #73 and already moves into Express shadow differential | preserve evidence; no further slice until #73/T00-04 |
| T05 #86 | KEEP-SHADOW | JVM foundation exact-head CI green | continue syntax/fixture/RFC boundary only |
| T06 #75 | KEEP-SHADOW | Python foundation exact-head CI green | static facts only; no target execution |
| T07 #69 | KEEP-SHADOW | Ruby/PHP facts exact-head CI green | preserve partial/unknown semantics |
| T08 #76 | KEEP-SHADOW | native-server foundation exact-head CI green | isolated backend protocol only |
| T09 #83 | FIX-REQUIRED | exact-head CI #449 red; test expected `undefined` but got `[]` in synthesized-operation-id case | fix shape/test contract within T09 paths, rerun |
| T10 #84 | KEEP-SHADOW | persistence plane exact-head CI green | read-only normalization only |
| T11 #77 | KEEP-SHADOW | legacy bridge exact-head CI #339 green | normalized projection blocked on T00-04 |
| T12 #66 | SPLIT-REQUIRED | placed `typescript-nestjs.mjs` in auto-loaded `scanners/adapters/`; changed live registry order (92 vs expected 90), missing conformance fixture; CI red | move experimental leaf outside live registry and restore stable registry tests |
| T13 #67 | FIX-REQUIRED | leaf scope is isolated, but exact-head CI red because own test asserts stale scan-note wording | fix owned test/implementation contract; remain unregistered |
| T14 #71 | KEEP-SHADOW | provider composition exact-head CI green | preview only |
| T15 becoder #8 | SPLIT-REQUIRED | CI green but edits existing emit/repair files, package.json, docs, existing Three renderer before T15-03/T00-04/T17 dependency | split baseline/reader evidence from later R3F renderer patch |
| T16 beval #41 | HOLD-STACKED | runtime binding is isolated but beval baseline moved; CI queued | continue only env/credential isolation + owned schema tests |
| T17 #68 | KEEP-SHADOW | bridge exact-head CI green; semantic overlap with #63; packaging request unresolved | reconcile #63; no native engine exporter before T00-04/T20 |
| T18 #70 | KEEP-SHADOW | protocol plane exact-head CI green | spec/static only |
| T19 #74 | KEEP-SHADOW | QA foundation exact-head CI #334 green | independent review/corpus certification next |
| T20 #79 | KEEP-SHADOW | trust foundation exact-head CI green | deny-by-default declarations only |
| T21 #80 | KEEP-SHADOW | incremental primitives exact-head CI green | no default scheduler/cache cutover |
| T22 #85 | KEEP-SHADOW | data-only SDK exact-head CI green | no execution/auto-install |
| T23 #78 | KEEP-SHADOW | release controls exact-head CI #340 green | runbook/inventory only |
| becoder #7 | VERIFY-ONLY | ordinary CI green, dedicated beval cross-verify failed | keep open only as evidence; no merge |
| beval #39 | LANDED-PROVISIONAL | merged to main while latest PR-head CI and merge push CI were queued at observation | post-merge exact-head verification required; baseline blocked |
| beval #40 | HOLD-STACKED | stacked on #39; CI queued | no merge/rebase-to-main until #39 merge commit accepted |
| bskel #60/#61 | DEFER | old beval promotion-signal PRs, outside scale integration train | preserve immutable evidence; analyze later through T09/T19 |

## Direct file collision findings

Current scale lanes are mostly physically isolated. The dangerous overlaps are semantic/integration boundaries rather than same-file edits.

### Legacy Track A #63 vs new lanes
- #63 owns `scanners/project-discovery.mjs`, `tools/webgame/parsers/**`, `scanners/planes/**`.
- T02 #72 owns `scanners/project-graph/**`.
- T04 #73 owns `scanners/language/js-ts/**`.
- T17 #68 owns `adapters/game-next/**`.

No same-file collision, but project identity, source-role/read-set, JS/TS parsing and game structure are duplicate concepts. Integration must pick one shared primitive per concept, not ship parallel truth models.

### Legacy Track C #62 vs new lanes
- #62 owns `webgame/fingerprint.mjs`, receipts/performance/release-policy and shared `lib/gate-profiles.mjs`.
- T19/T20/T23 use new QA/trust/release namespaces.

Unique webgame evidence primitives may be absorbed, but #62 must not wire shared gates directly.

### T12 #66 boundary violation
`scanners/adapters/*.mjs` is zero-registration executable code. Adding `typescript-nestjs.mjs` there makes it a shipped live adapter immediately. This is not a leaf-only experiment and caused the stable adapter-order/conformance failures. T12 must relocate until production registration is explicitly approved.

### T15 #8 boundary violation
The branch includes a useful R3F renderer, but also edits:
- `package.json`
- `lib/webgame-emit.mjs`
- `lib/webgame-repair-manifest.mjs`
- existing Three renderer/tests/docs

Those are integration/product surfaces, not T15-01/02 isolated reader/audit paths. Preserve the renderer commits for replay; split before integration.

## Gate to T00-03 / T00-04

T00-03 ownership freeze may proceed as read-only coordination work.

T00-04 interface freeze MUST NOT be declared complete until:
1. beval current-main merge commit is exact-head verified,
2. T12 is removed from the live adapter registry or explicitly promoted with full conformance evidence,
3. T09 and T13 exact-head CI are green,
4. T15 is split into dependency-safe and deferred renderer portions,
5. legacy #63/#62 unique-vs-duplicate mappings are recorded,
6. T01/T02/T03 shared identity/project/capability interfaces are reviewed together.

No stable schema/CLI/package/default behavior change is authorized by this document.
