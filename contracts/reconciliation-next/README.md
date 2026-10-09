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

## T09-01 baseline record

`BASELINE.json` pins what this layer does today, and where it fails, for one exact revision: the base commit
`02e7d05e71bdb64d94c16e1adf7cbe38626ee58a`. It changes no module. Its schema, `bskel.track-baseline-record/2`, is provisional.

Recorded: every pinned file (the source modules, the test files, the shared test fixture, the files the modules import
from outside this directory, and the nested runner) with size, git blob id and sha256; two real commands run in an
extracted copy of the base commit, with exit codes and counts (`node --test` on the seven test files, and
`node scripts/run-next-nested-tests.mjs T09`, with its first line); named fixtures that call the pinned modules, each with its
expected values and the sha256 of its output, split into normal fixtures and negative fixtures (cases the layer rejects by
design, and observed defects); and limits, each with a status and the fixtures that bind its statement.

| limit status | meaning |
|---|---|
| `UNSUPPORTED` | the layer does not do this at the base commit; nothing is marked supported |
| `UNKNOWN` | the layer reports the field as unknown or skipped, or the record cannot decide it |
| `BLOCKED` | cannot be observed here; the reason is stated (the runtime evidence in the fixtures is synthetic) |
| `NOT_RECORDED` | not measured |

`baseline-record.test.mjs` recomputes every size, hash, count, exit code, expected value, fixture output and file list from
the working tree, from the pinned commit and from an extracted copy of it. It also compares the table, the test
counts, the `NESTED_SUITE` line and the base commit named in this README and in `T09_STATUS.md` with the record. The extracted
copy runs against the `node_modules` of the checkout only after the version of every package the pinned files import (and of
the packages those require) equals the version the base commit's `package-lock.json` states; the record lists them as
`environment.loaded_packages`, and a different or missing version fails the test. Not recomputed: the CI observation (read once
through the read-only CI API), the machine description, the files inside the installed packages (only their versions are
compared with the lockfile), the synthetic support data, and the explanatory prose of the record and of these two documents.
`artifact_digest` seals the whole record except its own value, so an edit that is not re-sealed is reported; an editor who
re-seals the record is caught only by the recomputed values and by review of the diff.

```bash
npm ci
node --test test/reconciliation-next/baseline-record.test.mjs
```

A commit that is not available (for example in a shallow checkout that cannot fetch it) fails the test;
`BASELINE_ALLOW_UNVERIFIED=1` turns only that case into a visible skip, and never the dependency version check. A later
dependency update that changes one of the loaded packages therefore fails the test until the baseline is replaced. A changed
baseline is a new record for a new commit, reviewed as a diff, not an edit in place.

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

Run the whole T09 slice through the nested runner, exactly as the required `nested-next` CI job does,
or run the files directly:

```bash
node scripts/run-next-nested-tests.mjs T09
node --test test/reconciliation-next/*.test.mjs
```

All T09 tests remain inside the leased `test/reconciliation-next/**` path. The legacy root
`npm test` pattern (`node --test test/*.test.mjs`) does not discover nested tests, and T09 does not own
package/workflow wiring. T00/T23's required `nested-next` dispatcher explicitly executes the T09 directory;
exact-head evidence must show the `NESTED_SUITE T09 RUN <n> files` line, where `<n>` is the number of
`*.test.mjs` files in the directory at that head, and terminal counts on Node 22/24.
Generic root-test success alone is still not T09 focused evidence.

At the pinned base commit `02e7d05e71bdb64d94c16e1adf7cbe38626ee58a` the seven original test files contain
**113 tests** (the total both commands report there) and the nested runner prints `NESTED_SUITE T09 RUN 7 files`:

| file | tests | covers |
|---|---|---|
| `decision-graph.test.mjs` | 19 | field-decision regressions |
| `differential.test.mjs` | 5 | negative differential regressions for stale/missing/ambiguous OpenAPI |
| `evidence-binding.test.mjs` | 25 | exact ArtifactRef/T16 binding/evidence regressions |
| `openapi-context.test.mjs` | 22 | OpenAPI context/root/operation-security/duplicate-ID/schema-presence/context-provenance regressions |
| `openapi-integration.test.mjs` | 4 | real `indexOpenApiDocument -> reconcileModule -> decision graph` integration regressions |
| `promotion-readiness.test.mjs` | 16 | policy-neutral promotion-readiness regressions |
| `runtime-routes.test.mjs` | 22 | bound runtime-route reconciliation regressions |

`baseline-record.test.mjs` (T09-01, below) checks the record instead of the modules, so it is not in the table
and the nested runner counts one more file than at the base commit. The table and these figures describe the base
commit; `baseline-record.test.mjs` compares them with `BASELINE.json`, whose counts it reproduces.

The seven original files cover matched/adopted/drift/missing/ambiguous/unresolved results, synthesized IDs, prefix proof,
schema resolved/unresolved/dialect-disabled/absent/media-skipped states, explicit and inherited declared security,
duplicate operation IDs, provenance matching, route-only promotion, legacy-to-next integration, and stale-spec fail-closed behavior.

## T09-05 evidence binding

`evidence-binding.mjs` refuses to infer that two artifacts belong together from names, timestamps or
branch labels. Source and OpenAPI are bound only when each exact byte stream matches a valid
`sbf.artifact-ref/1`, both artifacts name the same repository and exact revision, and the decision
graph provenance ref equals the corresponding ArtifactRef `byte_sha256`.

Runtime-backed promotion additionally requires the independently reviewed T16 immutable core:
a canonical `beval.runtime-binding/1`, its exact binding hash, a canonical
`beval.runtime-evidence-pair/1`, matching contract/case/profile/attempt values, and source/OpenAPI
artifact digests present in the binding's artifact map. Local repo/revision/build/environment strings
alone can no longer create a bound runtime relation.

A bound source/OpenAPI relation is enough only for source/spec-level route promotion. Callers that ask
for runtime-backed promotion receive no promotable operation until `runtimeBinding.state === "bound"`.
This remains a T09 shadow readiness fact, not T03 stable certification.

## T09-06 runtime route observations

`runtime-routes.mjs` consumes a **pre-existing** bound runtime route observation. It does not start the
application or define T16/beval's runner protocol. The observation must match the exact T16 runtime
binding hash, profile approval hash and attempt nonce, and its canonical content must be the
`route_observation` content hashed inside the bound candidate evidence.

A complete runtime snapshot may prove a route missing; a partial snapshot may not. Runtime routes are
compared with the existing canonical parameter-shape rule (`{id}` vs `:id`/constrained parameters), while
literal segment drift remains a conflict. Duplicate runtime operationIds conflict even when one duplicate
exactly matches the expected route, and routes that exist only at runtime are emitted separately as `runtimeOnlyRoutes`.

This keeps runtime evidence as a separate plane instead of overwriting source/OpenAPI decisions.

## T09-07 promotion readiness handoff

`promotion-readiness.mjs` is an advisory-only bridge to T03. It does not set a stable capability or
change a contract. For each endpoint it records whether source/spec route facts are ready, whether a
bound runtime route was actually observed, and the exact blockers when they are not.

The report requires the OpenAPI context audit, source/spec evidence binding, and resolved
`operation.identity/http.method/http.path`. Runtime readiness additionally requires a bound runtime
relation, matching source/OpenAPI ArtifactRef digests plus T16 binding/profile/attempt/evidence hashes,
and an observed endpoint whose embedded expected operation/method/path exactly matches the current
decision graph. Missing/conflict/partial-runtime outcomes remain blockers. The report exposes these
verified references with `stableCapabilityWire:false`; T03 remains the capability/certification owner.

## Next T09 slices

1. Add field-level runtime observations beyond route existence only after T16 defines trusted probe semantics.
2. Replace the local 0-draft vocabulary with the shared T01/T03 Claim/Capability interface once frozen.
3. Add cross-repository conformance fixtures when T01/T03/T16 interfaces are frozen.

Until those slices and cross-track gates land, this module is diagnostic shadow data only.
