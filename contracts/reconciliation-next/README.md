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
3. Operation-level `security: []` is an explicit public declaration. When operation-level security is
   absent, OpenAPI may inherit document-level security. The legacy index/result does not carry that root
   value into the reconciliation result.
4. The legacy OpenAPI index stores the first occurrence of a duplicate `operationId`. A field-level
   promotion layer must independently detect duplicates before treating the ID as unique.
5. OpenAPI security here is **declared** security only. It is not proof that runtime authorization was
   enforced.
6. `matched` or `adopted` proves only the fields that the current reconciliation established. It is
   not a blanket runtime conformance verdict.

## T09-02 authority rules in this slice

| Field | Resolved authority | Conflict/unknown rule |
|---|---|---|
| operation.identity | scan+OpenAPI for explicit match; OpenAPI for a single route adoption | missing/ambiguous/unresolved never promoted; duplicate OpenAPI IDs conflict |
| http.method | scan+OpenAPI agreement | verb drift is conflict |
| http.path | exact or prefix-reconciled source/OpenAPI pair | unexplained drift/ambiguity is conflict |
| request/response/error schema | safely projected OpenAPI schema | failed/unsupported/lost distinction remains unknown/skipped |
| api.security.declared | explicit operation security or audited root inheritance | malformed/unknown schemes or unsafe endpoint remain unknown |

There is no majority vote. Two observations derived from the same source are not treated as independent votes.

## T09-03 decision graph

`decision-graph.mjs` exports:

- `buildEndpointDecision()`: one legacy reconciliation result -> ordered field decisions,
- `buildReconciliationDecisionGraph()`: a provenance-bound graph for a full module,
- `promotableOperationKeys()`: a deliberately narrow route/operation helper.

The vocabulary is marked `0-draft` and remains local to T09 until T01/T03 freeze the cross-track
Claim/Capability interface.

## T09-04 OpenAPI context audit

`openapi-context.mjs` consumes the raw OpenAPI document plus the existing validated index, without
modifying either one. It adds two fail-closed checks the legacy result cannot express:

- document-level `security` inheritance, including explicit root `security: []`, absent root security,
  malformed requirements, and undeclared schemes;
- duplicate `operationId` occurrences collected from the route index.

`applyOpenApiContext()` downgrades a resolved identity to conflict when the OpenAPI ID is duplicated and
fills only the previously-known root-security gap. Explicit operation-level security still wins.

`contextBoundPromotableOperationKeys()` returns no operation until this context audit has been attached.
This is the stricter helper for T09 shadow promotion. It still does **not** certify runtime behavior.

## Tests

Run the whole T09 slice directly:

```bash
node --test test/t09-reconciliation-next.test.mjs
```

The top-level entrypoint is matched by the repository's existing `npm test` pattern
(`test/*.test.mjs`), so no package script or lockfile change is required.

The current T09 suite contains **41 tests**:

- 18 field-decision regressions,
- 4 real `indexOpenApiDocument -> reconcileModule -> decision graph` integration regressions,
- 14 OpenAPI context/root-security/duplicate-ID/schema-presence regressions,
- 5 negative differential regressions for stale/missing/ambiguous OpenAPI.

It covers matched/adopted/drift/missing/ambiguous/unresolved results, synthesized IDs, prefix proof,
schema resolved/unresolved/dialect-disabled/absent/media-skipped states, explicit and inherited declared security,
duplicate operation IDs, provenance matching, route-only promotion, legacy-to-next integration, and stale-spec fail-closed behavior.

## Next T09 slices

1. Bind source/OpenAPI/runtime artifacts to an exact repository revision, build fingerprint, and environment
   before cross-source promotion.
2. Add runtime-only/source-only differential fixtures once the runtime observation envelope is available.
3. Add runtime observations as a separate evidence role; never overwrite source/OpenAPI claims in place.
4. Hand the decision graph and evidence conditions to the shared T01/T03 Claim/Capability policy once that
   interface is frozen.

Until those slices and cross-track gates land, this module is diagnostic shadow data only.
