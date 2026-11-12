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
- `node test/project-graph/interface-rfc.probe.mjs <normal|negative|shadow|options|registered>` prints the
  canonical JSON that the RFC's recorded hashes refer to. `options` builds graphs from non-default
  options and caller-supplied values (RFC section 2.5).
- `interface-rfc.record.json` holds the recorded commands, exit codes, hashes and vocabulary lists;
  `interface-rfc.test.mjs` checks them against the code, the schema and the RFC.
- `packed-cross-integration.test.mjs` packs the actual npm package offline and installs it into a disposable
  consumer, verifies installed T02/T21 module bytes, then runs the registered Spring, FastAPI,
  TypeScript Express, JavaScript Express and Rails project graph through T21's cache plan and shadow scanner with cache
  off, miss and hit parity. The install prefers cached dependencies but may fetch missing registry
  metadata; lifecycle scripts are disabled. This does not activate project-graph routing in production.
- `package-replay.test.mjs` verifies pinned historical installed-package previous → candidate →
  previous restoration, including an interrupted candidate probe. See
  [PROMOTION_ROLLBACK.md](PROMOTION_ROLLBACK.md) for exact commits, receipts,
  stop conditions and limits. It is not a live-service promotion.

The packed cross-integration covers all five currently registered first-party HTTP adapters.
Express+Prisma, Nest+TypeORM and Three+R3F combinations remain future adapter work, not evidence
of current support. Real-cohort observations remain manual and are not represented by this
synthetic disposable-consumer test.

Not here: CLI or contract wiring (T00/T23), router-internal mount graphs (adapter-owned), cache and
invalidation policy (T21), and any service facet other than `http`. An absent facet means unknown, not none.
