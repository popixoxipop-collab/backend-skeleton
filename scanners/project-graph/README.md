# scanners/project-graph

Owner: T02. Repository, project and service-facet graph used to plan which adapter scans which
project root. **Draft:** `sbf.project-graph/draft-1` is not a stable SBF contract, and `project_id` is a
repo-local planning key, not a cross-tool identity.

Start with [INTERFACE_RFC.md](INTERFACE_RFC.md). It defines the inputs and outputs, identity, facet
vocabulary, unknown and partial semantics, file ownership, evidence and remaining limits.

| File | Role |
|---|---|
| `index.mjs` | project discovery, adapter read-set snapshot, `buildProjectGraph`, `buildProjectScanPlan` |
| `source-role.mjs` | path-level source roles: active, reference, generated, vendor, template |
| `registered.mjs` | the same builders over the adapters in the scanner registry |
| `shadow.mjs` | fail-closed execution of a plan through the legacy scanner; reports are unchanged |
| `schemas/project-graph.draft-1.schema.json` | draft JSON Schema for the graph object |
| `INTERFACE_RFC.md` | the interface RFC |
| `LEGACY_A_RECONCILIATION.md` | ownership decision of record for the overlap with legacy Track A |

Tests and reproducible evidence live in `test/project-graph/`:

- `node scripts/run-next-nested-tests.mjs T02` runs the whole T02 suite.
- `node test/project-graph/interface-rfc.probe.mjs <normal|negative|shadow|registered>` prints the
  canonical JSON that the RFC's recorded hashes refer to.
- `interface-rfc.record.json` holds the recorded commands, exit codes, hashes and vocabulary lists;
  `interface-rfc.test.mjs` checks them against the code, the schema and the RFC.

Not here: CLI or contract wiring (T00/T23), router-internal mount graphs (adapter-owned), cache and
invalidation policy (T21), and any service facet other than `http`. An absent facet means unknown, not none.
