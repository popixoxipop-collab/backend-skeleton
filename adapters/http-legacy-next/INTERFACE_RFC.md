# T11 legacy HTTP bridge: interface RFC

Status: draft, shadow only. T11 is not declared complete and nothing here is active by default. Scope: the five legacy HTTP adapters and the six modules in `adapters/http-legacy-next`.
Companions: `INTEGRATION.md` (handoff narrative and commands), `BASELINE.json` (behaviour pinned by T11-01), `test/http-legacy-next/interface-rfc.vocabulary.json` (every identifier used here) and `test/http-legacy-next/interface-rfc.test.mjs`. That test compares the vocabulary with the code and this text with the vocabulary, and fails when a listed identifier, key list, table row, export, import, file or directory differs. Backticked words and the tables are machine checked, so keep them literal; other prose is not compared with the code, except where a sentence cites a test that runs the behaviour it states.

## 1. Purpose and non-goals

The stable scanner stays authoritative: its `sbf.scan-report/2` output is the only truth about a project. T11 adds a lossless copy (`bridge.mjs`), a location independent comparison (`parity.mjs`), a synchronous shadow check (`shadow-projection.mjs`), a hand fed readiness checklist (`cutover-readiness.mjs`), a checkout guard (`checkout-completeness.mjs`) and a pinned descriptor table (`baselines.mjs`). It emits no contracts/next artifact, imports no T01 or T03 code, promotes nothing and applies nothing.

## 2. Adapters in scope

Exactly the five rows below. `legacyHttpBaseline` returns `{fixture, descriptor, inventory}` for them and `null` for every other string that is not an inherited property name (`generic-grep` included). It is a plain property read, not a membership test: every inherited name of `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__`, ...) returns the inherited value, and a key that coerces to an id (an array holding one id) returns that entry. This is a known limit of the unmodified code that T11-03 must fix with an own lookup; until then check an id against `LEGACY_HTTP_ADAPTER_IDS`. `snapshotLegacyHttpAdapter` and `bridgeLegacyHttpScan` compare the id exactly, without coercion, and throw for every other value. The `adapter` argument is the registry's legacy `sbf.adapter/2` record; T11 never copies its `detect`, `scan`, `introspectRoutes`, `listReadSet` or `diagnostics` (section 3 lists the keys it does copy). The four capability columns are legacy booleans (section 5).

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
| `baselines.mjs` | `legacyHttpBaseline` | adapter id | entry, `null`, or an inherited value (section 2) |
| `bridge.mjs` | `snapshotLegacyHttpAdapter` | registry record | `{contract, id, title, specificity, confidence, verificationBasis, capabilities}`, a detached copy |
| `bridge.mjs` | `bridgeLegacyHttpScan` | `{adapter, report}` | `{schema, mode, source_adapter, source_scan_schema, legacy_report}` |
| `bridge.mjs` | `summarizeLegacyHttpReport` | `report` | `{modules, moduleCount, controllerCount, entityCount, enumCount, dtoCount, endpointCount, filesReadCount}` |
| `parity.mjs` | `legacyHttpSemanticSnapshot` | `report`, optional absolute `root` | `{schema, adapter, confidence, api_surface_source, verdict, path_prefix_signals, modules, files_read}` |
| `parity.mjs` | `legacyHttpSemanticDigest` | snapshot, or `report` with optional `root` | sha256 hex of key sorted JSON |
| `parity.mjs` | `compareLegacyHttpSemanticSnapshots`, `compareLegacyHttpReports` | two snapshots, or two reports with both roots or none | `{equal, diffs, truncated}` |
| `shadow-projection.mjs` | `runLegacyHttpShadowProjection` | `{adapter, report, projector, projectorId, projectorContract, maxDiffs, root}` | `{schema, mode, adapter_id, projector_id, projector_contract, authoritative_source, legacy_semantic_sha256, projected_semantic_sha256, parity, promotion_allowed, notes}` |
| `cutover-readiness.mjs` | `evaluateLegacyHttpCutoverReadiness` | `{adapterId, checks}` | `{schema, adapter_id, checks, ready_for_t00_integration, apply_allowed, blockers, notes}` |
| `checkout-completeness.mjs` | `inspectLegacyCorpusCheckout`, `assertLegacyCorpusCheckoutComplete` | `{repoRoot, adapterId, maxMissing}` | `{complete, mode, git_head, project_root, adapter_id, expected_tracked_read_files, materialized_read_files, missing_count, missing_paths}` and the conditional keys of section 5 |

Nested shapes; the test compares each key list with every such object that real scans of the five fixtures produce (diffs: those of a hand-made comparison):

- baseline `descriptor` `{contract, title, specificity, confidence, verificationBasis, capabilities}` (no `id`); baseline `inventory` has the keys of `summarizeLegacyHttpReport`; `source_adapter` is the `snapshotLegacyHttpAdapter` copy.
- snapshot modules `{module, controllers, entities, enums, dtos}`; controllers `{className, basePath, file, endpoints}`; endpoints `{method, verb, path, operationId, file}`.
- entities `{className, table, idField, idFieldType, idFieldIsUuid, file}`; enums `{name, constants, file}`; DTOs `{className, file}`.
  Keys the scan reports beyond these are dropped. A DTO may be a bare class name (then `file` is `null`) or an object whose `className` falls back to its `name`.
- diffs `{path, kind, expected, actual}`; `path_prefix_signals` and `files_read` are copied as the scan reported them.

Inputs carry `sbf.adapter/2` and `sbf.scan-report/2`; outputs carry `sbf.http-legacy-bridge/1` and `sbf.http-legacy-semantic-snapshot/1`; the internal, unfrozen (suffix 0) outputs carry `bskel.internal.t11-shadow-projection/0` and `bskel.internal.t11-cutover-readiness/0`; the constants `LEGACY_HTTP_ADAPTER_IDS`, `LEGACY_HTTP_BASELINES`, `LEGACY_HTTP_BRIDGE_SCHEMA`, `LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA`, `T11_SHADOW_PROJECTION_SCHEMA` and `T11_CUTOVER_READINESS_SCHEMA` export the ids and tables above. A projector is synchronous: it gets a deep frozen `{bridge, legacy_semantic_snapshot}` and returns `{projector_contract, semantic_snapshot}`; a Promise or another contract is refused.

## 4. Identity

- Adapter: `id` is one of the five above, compared exactly. A report is accepted only when `report.adapter` equals the descriptor id (the error shows `(missing)` for a report without one). The snapshot repeats `adapter`; the shadow result carries `adapter_id`.
- Report: only `sbf.scan-report/2` is accepted and recorded as `source_scan_schema`; any other schema is refused.
- Endpoint: legacy output has no stable operation identity. An endpoint is addressed by its position (module, controller, endpoint index in report order) plus `method`, `verb`, `path`, `operationId`, `file`; `operationId` is passed through, never synthesized.
- Location: with `root` every `file` becomes a POSIX path relative to it. `root` is a non-empty absolute string: `undefined` leaves the files as scanned; `null`, an empty string, any other type, a relative `root`, a relative `file` and a file outside the root throw.
- Digest: `legacyHttpSemanticDigest` and the two `*_semantic_sha256` fields are regression keys for one snapshot schema (equal for a snapshot and for its report with `root`), not identities. T11 never emits `sbf.contract-ref/1`, `sbf.artifact-ref/1` or `sbf.identity-envelope/1`, and a digest must not be stored as a `contract_hash`. T01 owns those; T00 wires them in after section 6.

## 5. Unknown, partial and unsupported

- Absent means `undefined` or `null` in scan data, and only that: a missing scalar snapshot field is `null`, a missing list is `[]` (so is an enum `constants` that is not an array) and a missing report section counts as 0 in the summary; `false`, `0` and `''` are values that a scalar field keeps. A present value of another type is outside this contract (nothing validates or repairs it). Options differ: for `root`, `maxDiffs` and `maxMissing` only `undefined` is absent and `null` throws.
- Known limit `omitted-report-sections-read-as-empty` (recorded in `BASELINE.json`, status UNSUPPORTED): a report that omits `related_modules`, `path_prefix_signals` and `files_read` and one that holds them empty give the same summary, snapshot, digest and comparison, and so do a missing and a `null` adapter or verdict and a module that omits its lists; nothing in the summary, the snapshot, the digest or the comparison marks the difference, so a parity result cannot tell a section the scanner did not report from one it saw empty. `test/http-legacy-next/interface-rfc.test.mjs` runs each of these cases and checks the recorded statement.
- `verdict`, `confidence` and `api_surface_source` are open fields, copied as emitted and `null` when absent (the five fixtures emit a string or `null`); consumers pass unknown values through. The vocabulary lists the fields, never their observed values.
- Capability booleans are legacy truth values: `false` means no claim, `true` is that adapter's own claim; neither is certified. T03 maps
  `false` to `unsupported` and `true` to `supported` only through its legacy bridge; T11 imports nothing from T03.
- Partial: a comparison (the shadow shell's too) stops collecting at `maxDiffs` differences (an integer from 1 to 1000; `undefined` selects the default 100, every other value, `null` and strings included, throws RangeError) and returns `truncated: true`, also when there are exactly `maxDiffs`: it means "the cap was reached", not "more exist". `equal` means zero differences. Diff kinds: `type`, `array-length`, `unexpected`, `missing`, `value`. `unexpected` and `missing` look at own enumerable string keys only: an own `constructor` or `__proto__` key counts, an inherited name does not.
- Checkout modes: `full-working-tree`, `sparse-readset-verified` (only `ruby-rails` and `python-fastapi`) and `sparse-unsupported-adapter`, where `missing_count` is `null`: completeness is unknown and counts as incomplete. `maxMissing` (an integer from 1 to 1000, default 50 for `undefined` only) caps `missing_paths`; the assert throws code `T11_CORPUS_CHECKOUT_INCOMPLETE`.
  `adapterId` is any non-empty string, echoed as `adapter_id` and not checked against the five ids: a full working tree is `full-working-tree` whatever it is, and a sparse one is `sparse-unsupported-adapter` for every id but those two (`generic-grep`, `constructor` and `__proto__` included).
  Conditional keys: `sparse-unsupported-adapter` adds `reason`; `sparse-readset-verified` adds `missing_paths_truncated` (always `true`) only when `missing_count` exceeds the listed `missing_paths`, and leaves it out otherwise.
- Modes `compatibility-only` (bridge) and `shadow-only` (shadow) are not support claims; `promotion_allowed` and `apply_allowed` are always false.

## 6. Cutover readiness

`evaluateLegacyHttpCutoverReadiness` needs `adapterId` (one of the five, compared exactly) and all ten checks as booleans in an object (not `null` or an array); a missing, non-boolean or unknown check throws TypeError. The gates are read as own properties,
so an inherited gate counts as missing; an unknown check is an own enumerable string key (an own `__proto__` from `JSON.parse` included), and non-enumerable or Symbol keys are not looked at. `ready_for_t00_integration` is true only when every check is true and `blockers`
follow the gate order. The checks are fed by hand; T11 verifies none of them (limits are recorded in `BASELINE.json`).

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

`adapters/http-legacy-next` holds exactly these regular files: `BASELINE.json`, `INTEGRATION.md`, `INTERFACE_RECEIPT.json`, `INTERFACE_RFC.md` and the six modules; and exactly these two directories: `adapters/http-legacy-next/python-fastapi` and `adapters/http-legacy-next/scope`, which hold target scope records with their fixtures, results, schema and verifier (`test/http-legacy-next/target-scope-records.test.mjs` checks the records). This RFC says no more about the two directories: `BASELINE.json` does not pin them and the receipt of section 8 does not hash them. The interface test compares the entries of `adapters/http-legacy-next` itself with the vocabulary, accepts no other kind of entry and does not look inside the two directories, so a file added or changed there is not noticed by this RFC or by that test. A new entry of `adapters/http-legacy-next` needs this RFC and the vocabulary updated first.

## 8. Receipt

`adapters/http-legacy-next/INTERFACE_RECEIPT.json` (schema `bskel.interface-receipt/1`, status `provisional`) records one run of two commands at a named commit: `node --test --test-reporter=tap test/http-legacy-next/interface-rfc.test.mjs` and `node scripts/run-next-nested-tests.mjs T11`. `test/http-legacy-next/interface-receipt-generate.mjs` writes it: it refuses a tree that is not clean, runs both commands itself in a scratch HOME and TMPDIR with `T11_RECEIPT_REPLAY` set to 1 (a commit cannot hold the receipt of its own run, and a replay must not replay itself), takes the counts from the printed summary and writes the same bytes every time. No file under `.github/workflows` and not `scripts/run-next-nested-tests.mjs` mentions `T11_RECEIPT_REPLAY`; the receipt test checks that.
It holds {schema, status, track, items, revision, tree, node_version, commands, files, limits, receipt_digest}. A command holds {id, argv, exit_code, tests, pass, fail, skipped, pass_text}, where `pass_text` is the summary lines as printed, without the duration. A file holds {path, bytes, git_blob_sha1, sha256}. `revision` is the commit of the run, `tree` its tree and `receipt_digest` the sha256 of the key sorted JSON of every other key.
The files hashed are `adapters/http-legacy-next/BASELINE.json`, `adapters/http-legacy-next/INTEGRATION.md`, `adapters/http-legacy-next/INTERFACE_RFC.md`, `adapters/http-legacy-next/baselines.mjs`, `adapters/http-legacy-next/bridge.mjs`, `adapters/http-legacy-next/checkout-completeness.mjs`, `adapters/http-legacy-next/cutover-readiness.mjs`, `adapters/http-legacy-next/parity.mjs`, `adapters/http-legacy-next/shadow-projection.mjs`, `test/http-legacy-next/baseline-record-lib.mjs`, `test/http-legacy-next/baseline-record.test.mjs`, `test/http-legacy-next/interface-receipt-generate.mjs`, `test/http-legacy-next/interface-receipt-lib.mjs`, `test/http-legacy-next/interface-receipt.test.mjs`, `test/http-legacy-next/interface-rfc.test.mjs`, `test/http-legacy-next/interface-rfc.vocabulary.json`.
What `test/http-legacy-next/interface-receipt.test.mjs` proves about the committed file: the keys and the digest; the recorded size and hashes of every listed file, live and as blobs at `revision`; that `tree` is the tree of `revision` and `revision` an ancestor of HEAD (on a shallow checkout a revision outside the visible history gives a printed note, not a failure); and that both commands, replayed in an export of `revision`, give the recorded exit code and the recorded numbers of tests, passes, failures and skips. On copies of the real files it fails for a changed exit code, an edited RFC, a wrong revision, a revision that is no ancestor and a missing file.
It does not prove that anyone but the generator ran the commands, that the tests cover more than they contain, or anything about a commit after `revision`. The limits, copied into the receipt:

- self-run: the generator ran both commands on one machine and nobody else observed the run.
- unsigned: no key or signature covers the file, and receipt_digest only detects an edit that did not recompute it.
- not an independent attestation: the receipt is produced by the code it describes, so a CI log or a reviewer is the independent record.
- replay needs the revision's history: a checkout without that commit must fetch it, and on a shallow checkout a revision outside the visible history cannot be told from an ancestor whose history is cut off, so the test prints a note instead of failing.
- provisional: the receipt describes the commit before the one that holds it, so a later change to a listed file makes it stale and it must be regenerated.
- scope of the hashes: the counts cover every test file of the T11 suite at the revision but only the listed files are hashed; the other test files, the nested runner script, the scanner and the fixtures are covered by the revision alone.
- replay without history: the replayed nested run has no git history, so the pinned-commit checks of the record test run there under BASELINE_ALLOW_UNVERIFIED=1 and are reported as not run, and it uses the node_modules of the checkout that replays it; the generator's own run had the history.
