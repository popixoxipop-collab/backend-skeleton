# T11-02 — versioned scan-report observation presence contract

**Contract**: `bskel.t11-report-observation/1`.
**Scope**: T11's original `sbf.scan-report/2` values from five legacy HTTP adapters.
**Owner**: `next/t11/**` (the original 291-task plan).
**Status**: additive local candidate, independent review / main integration pending.

## Input, output, identity

`observeLegacyScanReport(report)` accepts an object with an **own data property** `schema: 'sbf.scan-report/2'`. It never calls a scanner, rewrites its report, changes the existing T11 `bridge.mjs`, `parity.mjs`, `shadow-projection.mjs`, registry, or frozen `BASELINE.json`.

Output fields:

| Field | Meaning |
|---|---|
| `schema` | versioned `bskel.t11-report-observation/1` |
| `sourceReportSchema` | `sbf.scan-report/2` |
| `observationBasis` | `own_data_properties_only` |
| `fields` | explicit top-level `related_modules`, `path_prefix_signals`, `files_read`, `adapter`, `verdict`, `confidence`, `api_surface_source` statuses |
| `modules` | stable input-order index and statuses for `module`, `controllers`, `entities`, `enums`, `dtos` |
| `observationSha256` | SHA-256 of the deterministic serialized observation envelope before adding this digest |
| `quality` | `incomplete_report_fields` if any examined field is missing/invalid; else `reported_fields_only`, **not** verified scan completeness |
| `supportCertified`, `promotionAllowed` | both always **false** |

This is **not** T01's contract/identity-envelope and may not be used as a `contract_hash` or source-authorization token. The digest is a repeatability key for presence observations, not a signature or runtime evidence.

## Missing, null, empty and partial

Original legacy snapshot/summary collapses absent `related_modules` and reported `[]` to the same zero-count. That is precisely T11-02's documented gap. This sidecar distinguishes:

| State | Evidence |
|---|---|
| `not_reported` | own property absent; even an inherited prototype property does not count |
| `explicit_undefined` | own data property whose value is `undefined` |
| `explicit_null` | own data property `null` |
| `reported_empty` | own array with length 0 or an own scalar exactly `''` |
| `reported_value` | own nonempty array, or a nonempty string in a string report field |
| `invalid_type` | an array section receives a non-array, or a string section receives any non-string value, including booleans, finite/non-finite numbers, objects, arrays, functions, symbols or bigint |
| `invalid_container` | nested module is not an ordinary object-like container |
| `accessor_unsupported` | own accessor instead of data property; its getter is never invoked |

String-field checks are type/presence checks, not full report-schema or enum validation. Present `false` and `0` remain `invalid_type`, never `not_reported` or an invented empty value.

Lists record `itemCount`, a nonnegative integer for a reported array, otherwise `null`. This never invents missing entities/endpoints. Nested module observation order matches the report array order. Maximum 2048 module entries is a bounded failure, not silent truncation. A malformed or unknown report schema is rejected.

A positive `reported_fields_only` status does **not** mean the scanner found every route, that source is authorized or that runtime behavior is known. `unknown` and `unsupported` are not silently upgraded to `supported`; the adapter's original capability booleans are untouched.

## Compatibility and validation

Legacy `sbf.scan-report/2` consumers remain unchanged and authoritative. This is opt-in, additive evidence for a future T00/T01/T02/T03 cross-project projection; it **does not** become a new default `scan` output, and it cannot activate a T11 cutover.

Normal fixtures must prove reported empty versus omitted hashes/states differ and normal legacy inputs do not mutate. Negative fixtures must check null/undefined, inherited properties, accessors with throwing getters, wrong container type, malformed schema and count bounds. The `test/t11-observation-v1.test.mjs` product file will exercise those cases independently, while the historical T11 test directory remains frozen.

**Strict 291-task MET rule**: this local RFC and positive/negative checks are only a **T11-02 acceptance candidate**. Dependency, main-merge, independently reviewed exact-head CI and final T00 audit judgement are required before official MET count moves. The historical T11 baseline and RFC remain readable unchanged.

## Opt-in legacy bridge consumer (product wiring)

`next/t11/observed-bridge-v1.mjs` exports `bridgeLegacyHttpWithObservation({ adapter, report, root })` and `T11_OBSERVED_BRIDGE_V1`. It pairs the original `bridgeLegacyHttpScan` envelope and legacy semantic SHA with a **separate source-report presence observation**, derived BEFORE the compatibility JSON clone.

- `legacy_bridge`: the exact existing T11 compatibility-only object.
- `legacy_semantic_sha256`: same preexisting legacy digest; this may collapse omitted and observed-empty fields.
- `report_observation`: original own-data-property statuses, including explicit `undefined` that JSON cloning drops.
- `report_observation_sha256`: distinguishes a missing `related_modules` property from a real `related_modules: []`.
- `consumer_presence_available=true`; `runtime_certified=false`; `promotion_allowed=false`; `source_authorized=false`.

This bridge is an **opt-in product consumer contract**, not a replacement for stable `sbf.scan-report/2`, not a registered default scanner or a source trust signature. `root` follows the original semantic snapshot's absolute-path requirement.

For fields explicitly covered by the report observation contract, own-property or nested module accessors are rejected **before** the existing bridge's JSON clone or semantic projection can invoke getters. Inherited top-level/module fields are rejected as well: they must not be consumed by legacy projection while the new own-data-property observation treats them as not reported. Invalid legacy field types follow the existing validator's refusal semantics; no missing/invalid input is turned into fabricated empty success.

Companion `test/t11-observed-bridge-v1.test.mjs` checks five genuine legacy adapter fixture reports, old semantic SHA equality versus new observation SHA difference, explicit null/undefined preservation, immutable envelopes, adapter/root mismatch and accessor refusal with zero getter calls.

**Strict MET gate still outstanding:** T00 owner must approve this new consumer API's ownership and any needed downstream wiring; exact-head independent CI/review and official T00 audit after main merge are not supplied by local tests. No official MET increase is claimed.


## Programmatic input resource bounds

The product bridge and consumer copy only bounded own-data input before legacy JSON processing. In addition to the 128-depth and 200,000 aggregate node/slot limits, the copied envelope has a conservative 2 MiB JSON-output byte budget. Every occurrence of a string, including shared values, property names, UTF-8/JSON escapes, container punctuation and sparse slots is charged before output can expand. Oversized data throws `T11_DATA_BYTE_LIMIT`; it is not silently truncated or promoted. The direct field-presence observer does not serialize uninspected payload values.
