# T09 implementation status / handoff

Branch: `scale/T09/reconciliation-next-foundation`  
PR: #83  
Status: **implemented in draft branch; not merged; shared vocabulary not frozen**

This file records T09-local implementation state. It is not a release certificate and does not mark
T00/T01/T03/T16/T19 tasks accepted.

## Task mapping

| T09 slice | Branch state | Evidence in this PR | Remaining dependency |
|---|---|---|---|
| T09-01 existing reconciliation audit | implemented | README audit findings + legacy integration tests | reviewer confirmation |
| T09-02 field authority / reconciliation rules | implemented as `0-draft` | `decision-graph.mjs` | T01/T03 shared Claim/Capability names |
| T09-03 method/path/operation reconciliation projection | implemented | matched/adopted/drift/missing/ambiguous/unresolved tests | shared interface freeze |
| T09-04 schema/security context | implemented | raw schema presence, root security, duplicate OpenAPI ID audit | runtime auth semantics remain T16 |
| T09-05 negative differential | implemented | stale path/method, ambiguity, missing operationId, runtime route drift/missing tests | real cross-repo corpus belongs T19 |
| T09-06 promotion handoff | implemented as advisory report | evidence binding + runtime route report + readiness blockers | actual capability promotion belongs T03 |

## T09-local modules

### decision-graph.mjs

Produces per-endpoint field decisions for:

- `operation.identity`
- `http.method`
- `http.path`
- `api.request.schema`
- `api.response.schema`
- `api.error.schema`
- `api.security.declared`

States are `resolved`, `conflict`, `unknown`, `absent`, `skipped`.

### openapi-context.mjs

Adds raw OpenAPI context that the legacy result does not retain:

- root-level security inheritance,
- duplicate `operationId` detection,
- request/response/error schema presence,
- absent vs unsupported-media-type distinction,
- unresolved/malformed component-ref distinction,
- versioned OpenAPI context provenance.

### evidence-binding.mjs

Requires explicit artifact relation rather than name/time inference:

- source/OpenAPI: valid `sbf.artifact-ref/1` + exact byte hash/size match,
- source ↔ OpenAPI: same repository + exact revision,
- graph evidence refs equal each ArtifactRef `byte_sha256`,
- runtime: canonical `beval.runtime-binding/1` + exact binding hash,
- runtime evidence: canonical `beval.runtime-evidence-pair/1` + exact oracle/candidate evidence hashes,
- runtime: exact contract/case/profile/attempt match,
- T16 binding artifact map must contain the exact source/OpenAPI ArtifactRef digests,
- arbitrary local string refs or build/environment labels cannot create a bound relation.

### runtime-routes.mjs

Consumes an already-created runtime route observation. It does **not** execute applications.

- exact route -> observed,
- same operationId on different route -> conflict,
- duplicate operationId -> conflict even when one route exactly matches,
- exact route with no ID while the expected ID is observed elsewhere -> conflict,
- complete snapshot may prove missing,
- partial snapshot may only return unknown,
- runtime-only routes remain separate.

### promotion-readiness.mjs

Produces advisory blockers only. It never mutates contract/capability state.

`sourceSpecReady` requires:

1. valid OpenAPI context audit,
2. bound source/OpenAPI evidence,
3. resolved operation identity,
4. resolved HTTP method,
5. resolved HTTP path.

`runtimeRouteReady` additionally requires:

1. bound T16 runtime binding + evidence pair,
2. exact binding/profile/attempt/evidence hashes in the runtime report,
3. supported runtime-report version,
3. matching source/OpenAPI ArtifactRefs and T16 runtime binding hash,
4. endpoint state `observed`,
5. runtime report's expected operation/method/path exactly matches the current graph.

## Shared interface requests

### T01 — contract / claim interface

T09 needs a versioned equivalent for:

- field decision status,
- evidence/provenance refs,
- authority,
- conflict candidates,
- explicit unknown/absent/skipped distinction.

T09 does **not** request changing `sbf_contract: "9"` in this PR.

### T03 — capability policy

T09 hands over facts and blockers. T03 should own:

- which commands require which fields,
- whether a given profile needs runtime evidence,
- certification/status vocabulary,
- waiver policy,
- stable support matrix generation.

Do not turn `promotion-readiness.mjs` into the stable policy engine.

### T16 — runtime / evidence

T16 now owns the merged immutable `beval.runtime-binding/1` and `beval.runtime-evidence-pair/1` core. T09 consumes those exact identities and T16 should continue to own:

- process/container isolation,
- application startup,
- route introspection/probes,
- complete vs partial observation guarantees,
- attempt/run identity,
- runtime artifact signing/binding,
- authorization behavior observations.

T09 validates the T16 binding/evidence pair, exact profile/attempt/contract/case hashes, source/OpenAPI artifact digests, and the route observation content bound inside candidate evidence; it still does not execute the application or certify Runtime-tested status.

### T19 — corpus / QA

T09 still needs independent real-repo and holdout coverage after shared interfaces freeze:

- stale OpenAPI from a different revision,
- deployment prefix differences,
- runtime-only routes,
- source-only routes,
- duplicate operation IDs in real generated specs,
- root-security inheritance,
- malformed/unresolved request/response component refs.

## Stable code intentionally untouched

This branch does not edit:

- `contracts/openapi.mjs`,
- `contracts/emit.mjs`,
- stable contract schema version,
- `bin/bskel.mjs`,
- `package.json` or lockfiles.

The 110 focused T09 tests live entirely under `test/reconciliation-next/**`.
The current shared `test/*.test.mjs` command does not discover them. The out-of-lease root shim was
removed at commit `92ee509c0654ef1d235851d4abe61cf74bb5c65d`. A shared-owner change request on
T00 PR #65 asks central CI to include `test/reconciliation-next/*.test.mjs` without granting T09 a
root/shared-file lease. Until that lands, T09 is BLOCKED for integration and generic CI green does not
certify the nested focused suite.

## Merge / promotion rule

Do not mark this PR ready solely because tests are green. Before shared use:

1. latest-head generic CI must be green,
2. central CI/shared-owner discovery must actually execute the nested 98-test T09 suite,
3. T01/T03 must review the local vocabulary and either adopt or map it,
4. T16 must review the runtime observation boundary,
5. stable writers remain unchanged until an integration PR explicitly enables a next path.

Until then the output is shadow diagnostics and advisory readiness only.
