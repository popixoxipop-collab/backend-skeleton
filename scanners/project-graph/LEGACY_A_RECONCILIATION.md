# T02 reconciliation: Legacy Track A PR #63

Status: T02-owned reconciliation note. This does not make `sbf.project-graph/draft-1` a stable public schema.

Legacy Track A: PR #63, head `4e2e15e200eb965d4107acf59db21583d2657ea1`.
T00 ownership source: PR #65 `integration/scale/T00-03-OWNERSHIP.md` and `T00-04-PREFREEZE.md`.

## Ownership decision

T02 is the canonical owner of repository/project/service-facet graph, project-level read-set/freshness,
and the path-level source-role vocabulary. PR #63 must not land `scanners/multiplane.mjs` or its
project/schema stack as a competing global graph.

## Overlap / unique mapping

| Legacy A #63 surface | Overlap with T02 #72 | Canonical disposition |
|---|---|---|
| nested package/project discovery | direct overlap | T02 ProjectGraph owns project roots; Legacy A discovery is not a second global authority |
| deterministic project read-set / package digest | overlap | T02 owns project marker read-set, marker SHA-256 and stale-graph rejection; later language read-sets plug into the project |
| active/reference/generated/vendor/template roles | unique behavior worth absorbing | absorbed as `scanners/project-graph/source-role.mjs` with the same category set and precedence |
| package provenance | partial overlap | T02 keeps marker/package digest and local package facts; richer provenance can be added without importing the multiplane IR |
| JS/TS/Svelte parsing and source coordinates | no T02 ownership | T04 differential corpus / language-facts responsibility |
| Three.js/WebGPU/TSL facts, assets, workers | no T02 ownership | T17 game semantics |
| WebSocket/game network inventory | no T02 ownership | T17 for game inventory; T18 for protocol/message semantics |
| generic API plane | no T02 ownership | HTTP adapter tracks T11/T12/T13 |
| fixtures/reports | QA evidence, not ProjectGraph semantics | T19 after provenance review |
| `scanners/multiplane.mjs` global graph | competing IR | do not absorb wholesale before T00-04 final freeze |

## T02-only semantics retained

The T02 graph adds backend/general project behavior that Legacy A did not own as a stable cross-stack
primitive:

- per-project evaluation of the existing first-party backend adapter registry;
- parent aggregate protection when legacy adapter detect functions recurse into child services;
- explicit same-specificity ambiguity instead of an arbitrary repository-wide winner;
- conservative direct containment and unique local Node package dependency edges;
- fail-closed duplicate local package names;
- shadow execution that reuses unchanged legacy `runScan()` per selected project;
- marker revalidation immediately before shadow execution.

Router-internal mount graphs remain adapter-owned. ProjectGraph does not reimplement Express/FastAPI/
framework-local route composition.

## Stable-interface boundary

`project_id: "project:<repo-relative-root>"` remains repo-local planning identity only. It is not an
ArtifactRef/ActionRef replacement and must not be frozen as cross-tool identity before T01/T00 approve
that seam. Existing ContractRef/ActionRef/FieldRef and `beval.binding-json/1` stay authoritative.

No shared hot file is required by this reconciliation. CLI/test discovery/package/workflow integration
is a T00/T23 responsibility and requires an explicit lease.
