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
| `reported_value` | own nonempty array or nonempty/non-null scalar (including `false` and `0`) |
| `invalid_type` | array-valued report section receives a non-array value |
| `invalid_container` | nested module is not an ordinary object-like container |
| `accessor_unsupported` | own accessor instead of data property; its getter is never invoked |

Lists record `itemCount`, a nonnegative integer for a reported array, otherwise `null`. This never invents missing entities/endpoints. Nested module observation order matches the report array order. Maximum 2048 module entries is a bounded failure, not silent truncation. A malformed or unknown report schema is rejected.

A positive `reported_fields_only` status does **not** mean the scanner found every route, that source is authorized or that runtime behavior is known. `unknown` and `unsupported` are not silently upgraded to `supported`; the adapter's original capability booleans are untouched.

## Compatibility and validation

Legacy `sbf.scan-report/2` consumers remain unchanged and authoritative. This is opt-in, additive evidence for a future T00/T01/T02/T03 cross-project projection; it **does not** become a new default `scan` output, and it cannot activate a T11 cutover.

Normal fixtures must prove reported empty versus omitted hashes/states differ and normal legacy inputs do not mutate. Negative fixtures must check null/undefined, inherited properties, accessors with throwing getters, wrong container type, malformed schema and count bounds. The `test/t11-observation-v1.test.mjs` product file will exercise those cases independently, while the historical T11 test directory remains frozen.

**Strict 291-task MET rule**: this local RFC and positive/negative checks are only a **T11-02 acceptance candidate**. Dependency, main-merge, independently reviewed exact-head CI and final T00 audit judgement are required before official MET count moves. The historical T11 baseline and RFC remain readable unchanged.
