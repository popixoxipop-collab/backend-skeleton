# T09 reconciliation-next foundation

Status: **shadow-only / experimental**.

This directory is the first implementation slice for T09 (OpenAPI + source + runtime reconciliation).
It deliberately does **not** replace `contracts/openapi.mjs`, mutate `sbf_contract: "9"`, add a stable CLI flag,
or certify runtime behavior.

## What is reused

The existing OpenAPI reconciler already owns substantial, tested behavior:

- operationId and method/path reconciliation,
- conservative path-prefix inference,
- request/response/error schema projection,
- parameter and path-parameter projection,
- operation-level security passthrough,
- per-status responses and request media types,
- source descriptions/tags and defensive resource caps,
- refusal to use a bskel-generated OpenAPI export as an independent oracle.

T09 therefore wraps the existing reconciliation result instead of reimplementing those rules.

## T09-01 audit findings

The shadow layer has to preserve information gaps instead of silently repairing them.

1. A legacy `drift`/`missing` result does not retain the source operationId itself. Callers that need
   field-level provenance must also pass the original scan endpoint by endpoint key.
2. The legacy result retains a resolved schema or an unresolved reason, but a matched/adopted endpoint
   does not retain the per-operation distinction between "no schema" and "skipped unsupported media type".
   The decision graph therefore reports that field as `unknown`, not `absent`.
3. Operation-level `security: []` is an explicit public declaration and is safe to preserve. When
   operation-level security is absent, OpenAPI may inherit document-level security. The current legacy
   index/result does not retain document-level security, so the shadow layer reports
   `root-security-inheritance-not-retained-by-legacy-result` instead of guessing public/absent.
4. OpenAPI security here is **declared** security only. It is not proof that runtime authorization was
   enforced.
5. `matched` or `adopted` proves only the fields that the current reconciliation established. It is
   not a blanket runtime conformance verdict.

## T09-02 authority rules in this slice

| Field | Resolved authority | Conflict/unknown rule |
|---|---|---|
| operation.identity | scan+OpenAPI for explicit match; OpenAPI for a single route adoption | missing/ambiguous/unresolved never promoted |
| http.method | scan+OpenAPI agreement | verb drift is conflict |
| http.path | exact or prefix-reconciled source/OpenAPI pair | unexplained drift/ambiguity is conflict |
| request/response/error schema | safely projected OpenAPI schema | failed/unsupported/lost distinction remains unknown/skipped |
| api.security.declared | explicit operation-level OpenAPI security | unknown scheme, unsafe endpoint, or possible root inheritance stays unknown |

There is no majority vote. Two observations derived from the same source are not treated as independent votes.

## T09-03 implementation

`decision-graph.mjs` exports:

- `buildEndpointDecision()`: one legacy reconciliation result -> ordered field decisions,
- `buildReconciliationDecisionGraph()`: a provenance-bound graph for a full module,
- `promotableOperationKeys()`: a deliberately narrow route/operation promotion helper.

The promotion helper defaults to `operation.identity + http.method + http.path` only. It is **not** the
future shared capability-policy engine and cannot by itself promote schema/security/runtime claims.

The vocabulary is marked `0-draft` and remains local to T09 until T01/T03 freeze the cross-track
Claim/Capability interface.

## Tests

Run this slice directly:

```bash
node --test test/reconciliation-next/decision-graph.test.mjs
```

The repository's current `npm test` pattern is `test/*.test.mjs`, so this nested shadow test is not
added to the default suite yet. Updating shared package/test wiring belongs to the integration owner,
not this T09 leaf branch.

The test suite covers matched/adopted/drift/missing/ambiguous/unresolved results, synthesized IDs,
prefix proof, schema resolved/unresolved/dialect-disabled states, operation security, root-security
uncertainty, provenance requirements, and route-only promotion.

## Next T09 slices

1. Add a bounded raw/index view that preserves per-operation "none vs skipped media type".
2. Preserve document-level OpenAPI security and model operation inheritance explicitly.
3. Bind OpenAPI/source/runtime artifacts to an exact revision/environment before cross-source promotion.
4. Add negative differential fixtures for stale OpenAPI, same operationId with changed route, and
   runtime-only/source-only routes.
5. Hand the field decisions to the shared T01/T03 Claim/Capability policy once that interface is frozen.

Until those slices and cross-track gates land, this module is diagnostic shadow data only.
