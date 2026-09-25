# T17 reconciliation with legacy Track A PR #63

Status: draft mapping only. This document does not merge, vendor, import, or promote PR #63.

Observed legacy source:
- PR #63 `feature/webgame-a-static`
- inspected head: `4e2e15e200eb965d4107acf59db21583d2657ea1`
- legacy Track A schemas: `sbf.multiplane-scan/1`, `sbf.plane-adapter/1`
- public game authority on main remains `sbf.webgame-contract/1`

## Decision

T17 does **not** adopt `sbf.multiplane-scan/1` as a second game contract and does not copy Track A's graph as a game behavior graph.

The stable v1 webgame contract remains authoritative for current scene/entity/hierarchy/input/simulation/render/network/asset declarations. Track A is treated as a future enrichment evidence source after T00/T01 integration provides an exact artifact boundary.

Any future Track A intake must bind the exact raw Track A artifact bytes before reading individual evidence items. A parsed-object-only handoff is not sufficient.

## Complementary coverage

| Concern | Existing sbf.webgame-contract/1 | Legacy Track A PR #63 | T17 reconciliation |
|---|---|---|---|
| Scene declarations | authoritative v1 scene plane | game-runtime `scene` evidence | keep v1 item; Track A can add source-role/provenance, not duplicate authority |
| Entities | v1 Mesh/Group/Object declarations | not a primary Track A plane | keep v1 |
| Static hierarchy | v1 literal `parent.add(child)` | no equivalent behavior authority | keep v1 symbolic hierarchy only |
| Input declarations | v1 listeners/key checks | not a primary Track A plane | keep v1; never infer effects |
| Simulation/update | v1 named systems + loops | frame-loop evidence | v1 remains authority; Track A may corroborate loop provenance |
| Renderer | v1 WebGL/WebGPU/R3F renderer declarations | imported renderer + renderer-instance render-call correlation | absorb Track A correlation/provenance as enrichment evidence |
| WebGPU / TSL | renderer type only / limited import context | explicit `webgpu` and `tsl` capabilities | future T17 render-capability enrichment |
| Materials / loaders | not modeled as first-class v1 items | explicit material/loader evidence | future T17 render/asset metadata, no runtime behavior claim |
| Assets | v1 literal asset references | role-aware static/runtime-load asset evidence | deduplicate by source provenance; preserve role |
| Workers | absent from v1 | worker/shared-worker plane | future T17 worker structural nodes; no message semantics |
| Source roles | no active/reference/generated/vendor/template role model | explicit role on evidence | preserve Track A role on enrichment; non-active evidence cannot promote runtime presence |
| Nested projects | v1 detects multiple package roots but emits one aggregate scan | explicit project records and domain scoping | use T02 project identity once frozen; do not invent a T17 project-ID system |
| Network | v1 literal socket endpoints | WS/HTTP client/server static evidence | T17 may retain opaque external-interaction refs; protocol/message semantics belong to T18 |
| API | not a game behavior plane | separate Track A API domain | not absorbed by T17; route/API authority remains HTTP/protocol owners |
| Playable runtime | v1 completeness is static extraction completeness | `playable_runtime_claimed` is derived from static renderer+scene+render-call+import evidence | must never be translated to Runtime-tested; at most static runtime-shape evidence |
| Graph edges | v1 has only observed hierarchy; no causal graph | contains-domain/evidenced-by/uses-* composition edges | structural composition only; never translate `uses-*` into causal or state-transition edges |

## Facts T17 may absorb after shared freeze

### Game-runtime enrichment
Allowed Track A evidence kinds:
- `three-import`
- `tsl-import`
- `renderer`
- `scene`
- `material`
- `loader`
- `render-call`
- `frame-loop`

Rules:
1. evidence keeps `project_id`, `role`, source path/digest, line/column, collector and confidence;
2. `reference`, `generated`, `vendor`, and `template` evidence remains non-active;
3. a Track A `status: complete` or `playable_runtime_claimed: true` is a static-shape result, not runtime execution evidence;
4. scene/renderer/frame-loop evidence already represented by v1 is corroboration, not a second authoritative item;
5. material/loader/TSL/WebGPU data may extend draft render/asset metadata only after shared vocabulary freeze.

### Asset enrichment
Track A asset evidence may augment v1 asset items with:
- source role;
- exact source digest and location;
- static-import vs runtime-load declaration kind.

It must not claim the asset loaded successfully at runtime.

### Worker enrichment
Track A `worker` / `shared-worker` declarations are T17 structural facts because they affect game runtime topology.

They do not establish:
- worker message schemas;
- request/response semantics;
- ordering or correlation;
- causality between worker messages and game state.

Those semantics belong to T18 when explicit protocol evidence exists.

## Facts T17 must not absorb as game semantics

- Track A API route semantics;
- WebSocket/HTTP message schemas or protocol-flow semantics;
- `multiplayer_server_claimed` as runtime proof;
- domain `uses-network` as a behavior edge;
- temporal/order/correlation assumptions not explicitly represented in authoritative evidence;
- Track A `playable_runtime_claimed` as beval runtime proof.

## Identity requirements for a future Track A bridge

Before cross-tool use, a future bridge requires:

1. exact Track A artifact bytes bound with the shared T01 ArtifactRef contract;
2. exact Track A schema/version and producer revision;
3. T02 project identity mapping rather than a T17-private project identity;
4. evidence item addressing that includes artifact identity plus project/domain/evidence identity;
5. a deduplication rule against authoritative v1 items that preserves both provenances;
6. no mutation of the original v1 webgame contract bytes.

If PR #63 lands with a changed schema, this mapping must be replayed against the landed exact revision. T17 must not bind to a branch name or mutable PR head.

## Current disposition

- `sbf.webgame-contract/1`: **AUTHORITATIVE_CURRENT**
- T17 `sbf.game-graph-draft/1`: **DERIVED_DRAFT**
- PR #63 `sbf.multiplane-scan/1`: **LEGACY_DRAFT_ENRICHMENT_SOURCE**
- native export envelope: **BOUND_UNINTERPRETED_DRAFT**
- causal/state-transition graph: **NOT AUTHORIZED FROM STATIC EVIDENCE**
