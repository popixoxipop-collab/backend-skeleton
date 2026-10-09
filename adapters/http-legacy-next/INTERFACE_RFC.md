# T11 legacy HTTP bridge: interface RFC

Status: draft, shadow only. T11 is not declared complete and nothing here is active by default.
Scope: the five legacy HTTP adapters and the six modules in `adapters/http-legacy-next`.
Companions: `INTEGRATION.md` (handoff narrative and commands), `BASELINE.json` (behaviour pinned by T11-01),
`test/http-legacy-next/interface-rfc.vocabulary.json` (every identifier used here) and
`test/http-legacy-next/interface-rfc.test.mjs`, which fails when this text, the vocabulary or the code drift apart.
Backticked words and the tables are machine checked, so keep them literal.

## 1. Purpose and non-goals

The stable scanner stays authoritative: its `sbf.scan-report/2` output is the only truth about a project. T11 adds a lossless
copy (`bridge.mjs`), a location independent comparison (`parity.mjs`), a synchronous shadow check (`shadow-projection.mjs`), a
hand fed readiness checklist (`cutover-readiness.mjs`), a checkout guard (`checkout-completeness.mjs`) and a pinned descriptor
table (`baselines.mjs`). It emits no contracts/next artifact, imports no T01 or T03 code, promotes nothing and applies nothing.

## 2. Adapters in scope

Exactly the five rows below. `legacyHttpBaseline` returns `{fixture, descriptor, inventory}`, or `null` for any other id
(`generic-grep` included); `snapshotLegacyHttpAdapter` and `bridgeLegacyHttpScan` throw for it. The descriptor is the registry's
legacy `sbf.adapter/2` record; the four capability columns are legacy booleans (section 5).

| adapter | specificity | confidence | verificationBasis | api.operations | api.request-shape | resource.fetch | codegen.handles |
| --- | --- | --- | --- | --- | --- | --- | --- |
| java-spring | 100 | high | production-repo | yes | yes | yes | yes |
| ruby-rails | 95 | high | production-repo | yes | no | no | no |
| python-fastapi | 90 | high | official-reference | no | no | yes | yes |
| typescript-express | 85 | high | community-sample | no | no | yes | yes |
| javascript-express | 80 | high | community-sample | no | no | no | no |

## 3. Inputs and outputs

| module | function | input | output |
| --- | --- | --- | --- |
| `baselines.mjs` | `legacyHttpBaseline` | adapter id | entry or `null` |
| `bridge.mjs` | `snapshotLegacyHttpAdapter` | registry descriptor | detached copy of the descriptor |
| `bridge.mjs` | `bridgeLegacyHttpScan` | descriptor and `report` | `{schema, mode, source_adapter, source_scan_schema, legacy_report}` |
| `bridge.mjs` | `summarizeLegacyHttpReport` | `report` | `{modules, moduleCount, controllerCount, entityCount, enumCount, dtoCount, endpointCount, filesReadCount}` |
| `parity.mjs` | `legacyHttpSemanticSnapshot` | `report`, absolute `root` | `{schema, adapter, confidence, api_surface_source, verdict, path_prefix_signals, modules, files_read}` |
| `parity.mjs` | `legacyHttpSemanticDigest` | snapshot, or `report` with `root` | sha256 hex of key sorted JSON |
| `parity.mjs` | `compareLegacyHttpSemanticSnapshots`, `compareLegacyHttpReports` | two snapshots, or two reports with both roots | `{equal, diffs, truncated}` |
| `shadow-projection.mjs` | `runLegacyHttpShadowProjection` | descriptor, `report`, sync `projector`, `projectorId`, `projectorContract`, `root` | `{schema, mode, adapter_id, projector_id, projector_contract, authoritative_source, legacy_semantic_sha256, projected_semantic_sha256, parity, promotion_allowed, notes}` |
| `cutover-readiness.mjs` | `evaluateLegacyHttpCutoverReadiness` | `{adapterId, checks}` | `{schema, adapter_id, checks, ready_for_t00_integration, apply_allowed, blockers, notes}` |
| `checkout-completeness.mjs` | `inspectLegacyCorpusCheckout`, `assertLegacyCorpusCheckoutComplete` | `{repoRoot, adapterId, maxMissing}` | `{complete, mode, git_head, project_root, adapter_id, expected_tracked_read_files, materialized_read_files, missing_count, missing_paths}` |

Nested shapes: snapshot modules `{module, controllers, entities, enums, dtos}`, controllers `{className, basePath, file, endpoints}`,
endpoints `{method, verb, path, operationId, file}`, diffs `{path, kind, expected, actual}`. Inputs carry `sbf.adapter/2` and
`sbf.scan-report/2`; outputs carry `sbf.http-legacy-bridge/1` and `sbf.http-legacy-semantic-snapshot/1`; the internal, unfrozen
(suffix 0) outputs carry `bskel.internal.t11-shadow-projection/0` and `bskel.internal.t11-cutover-readiness/0`;
the constants `LEGACY_HTTP_ADAPTER_IDS`, `LEGACY_HTTP_BASELINES`, `LEGACY_HTTP_BRIDGE_SCHEMA`, `LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA`, `T11_SHADOW_PROJECTION_SCHEMA` and `T11_CUTOVER_READINESS_SCHEMA` export the ids and tables above. A projector is synchronous:
it gets a deep frozen `{bridge, legacy_semantic_snapshot}` and returns `{projector_contract, semantic_snapshot}`; a Promise or another contract is refused.

## 4. Identity

- Adapter: `id` is one of the five above. A report is accepted only when `report.adapter` equals the descriptor id (the error shows
  `(missing)` for a report without one). The snapshot repeats `adapter`; the shadow result carries `adapter_id`.
- Report: only `sbf.scan-report/2` is accepted and recorded as `source_scan_schema`; any other schema is refused.
- Endpoint: legacy output has no stable operation identity. An endpoint is addressed by its position (module, controller, endpoint
  index in report order) plus `method`, `verb`, `path`, `operationId`, `file`; `operationId` is passed through, never synthesized.
- Location: with an absolute `root` every `file` becomes a POSIX path relative to it; a relative root or a file outside it throws.
- Digest: `legacyHttpSemanticDigest` and the two `*_semantic_sha256` fields are regression keys for one snapshot schema (equal for
  a snapshot and for its report with `root`), not identities. T11 never emits `sbf.contract-ref/1`, `sbf.artifact-ref/1` or
  `sbf.identity-envelope/1`, and a digest must not be stored as a `contract_hash`. T01 owns those; T00 wires them in after section 6.

## 5. Unknown, partial and unsupported

- Absent is unknown, never defaulted: a missing scalar snapshot field is `null` and a missing list is `[]`; a missing report section counts as 0 in the summary.
- `verdict`, `confidence` and `api_surface_source` are open fields, copied as emitted (string or `null`); consumers pass unknown values through.
  The vocabulary lists the fields, never their observed values.
- Capability booleans are legacy truth values: `false` means no claim, `true` is that adapter's own claim; neither is certified. T03 maps
  `false` to `unsupported` and `true` to `supported` only through its legacy bridge; T11 imports nothing from T03.
- Partial: a comparison stops collecting at `maxDiffs` differences (integer 1 to 1000, default 100) and returns `truncated: true`, also when there
  are exactly `maxDiffs`: it means "the cap was reached", not "more exist". `equal` means zero differences. Diff kinds: `type`, `array-length`, `unexpected`, `missing`, `value`.
- Checkout modes: `full-working-tree`, `sparse-readset-verified` (only `ruby-rails` and `python-fastapi`) and `sparse-unsupported-adapter`, where
  `missing_count` is `null`: completeness is unknown and counts as incomplete. `maxMissing` (integer 1 to 1000) caps `missing_paths`; the assert throws code `T11_CORPUS_CHECKOUT_INCOMPLETE`.
- Modes `compatibility-only` (bridge) and `shadow-only` (shadow) are not support claims; `promotion_allowed` and `apply_allowed` are always false.

## 6. Cutover readiness

`evaluateLegacyHttpCutoverReadiness` needs `adapterId` (one of the five) and all ten checks as booleans; a missing, non-boolean or unknown
check throws TypeError. `ready_for_t00_integration` is true only when every check is true and `blockers` follow the gate order. The
checks are fed by hand; T11 verifies none of them (limits are recorded in `BASELINE.json`).

| # | gate | blocker |
| --- | --- | --- |
| 1 | ownership_scope_clean | ownership-scope-not-clean |
| 2 | legacy_baseline_pinned | legacy-baseline-not-pinned |
| 3 | lossless_bridge_verified | lossless-bridge-not-verified |
| 4 | semantic_parity_verified | semantic-parity-not-verified |
| 5 | pinned_corpus_verified | pinned-corpus-not-verified |
| 6 | exact_head_ci_green | exact-head-ci-not-green |
| 7 | identity_interface_frozen | identity-interface-not-frozen |
| 8 | capability_interface_frozen | capability-interface-not-frozen |
| 9 | independent_review_accepted | independent-review-not-accepted |
| 10 | nested_test_discovery_integrated | nested-test-discovery-not-integrated |

## 7. File ownership

| paths | owner | T11 may |
| --- | --- | --- |
| `adapters/http-legacy-next`, `test/http-legacy-next` | T11 | edit |
| `test/fixtures` | stable scanner | read only, pinned by BASELINE.json |
| `scanners/index.mjs`, `scanners/registry.mjs`, `scanners/text-util.mjs`, `scanners/adapters` | stable scanner | call from tests, never edit; pinned by BASELINE.json |
| `contracts/next`, `schemas/next` | T01 | none, no import |
| `scanners/capability-next` | T03 | none, no import |
| `release/next` | T23 | none |
| `scripts/run-next-nested-tests.mjs`, `.github/workflows`, `package.json`, `CATALOG.md`, `DECISIONS.md` | T00 | read only (inspectSuite), never edit |

`adapters/http-legacy-next` holds exactly: `BASELINE.json`, `INTEGRATION.md`, `INTERFACE_RFC.md` and the six modules; a new file there needs
this RFC and the vocabulary updated first.
