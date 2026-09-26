# T19 independent review — T03/T09/T10/T14 evidence-promotion boundaries

Reviewed: 2026-09-26

This review distinguishes:
- evaluator/static correctness;
- source/spec reconciliation;
- live persistence verification;
- runtime behavior evidence;
- certification/promotion.

No stable CLI/registry/schema/package/workflow or product implementation was modified by T19.

## T03 — capability policy

PR #81:
- head `9795ab4ef3d24e0dd2d30646c373343c76a081c3`
- CI `36084027973` — success

Independent EOE focused command:

```bash
node --test   t19-review-t03/test/capability-next/core.test.mjs   t19-review-t03/test/capability-next.test.mjs
```

Result:
- 60 pass
- 0 fail
- 0 skip

Verified static semantics:
- five statuses remain distinct;
- `unknown` cannot be accepted;
- partial/not-applicable require explicit policy;
- integrity/sandbox failures are non-waivable;
- discovery/contract/runtime-tested require evidence refs;
- runtime-tested additionally requires a profile;
- codegen status is a separate axis;
- legacy compatibility rows remain uncertified;
- OpenAPI satisfier metadata alone does not widen the adapter descriptor.

Important boundary:
`certificationRecord()` validates that evidenceRefs are present strings; it does not independently verify artifact bytes/run identity/runtime outcome. Therefore T03 is a policy/record layer and must consume already-approved evidence references from their owning tracks.

T19 verdict:
`PASS(STATIC_POLICY_BOUNDARY)`

Not approved:
- any concrete target as runtime-tested merely from a T03 row;
- stable support-matrix publication;
- evidenceRef trust without T01/T09/T10/T16/T19 verification.

## T09 — source/spec/runtime reconciliation

PR #83:
- current head `7074e815e0c471ec7770f3f5f50f691c9e275b5d`
- base `3e2db88d25da1f11b830e2dd1f24d60f3f291d43`
- CI #1205 / `36212194234` — success
- nested-next Node 22 job `108320917842`, step `T09 reconciliation-next` — success
- nested-next Node 24 job `108320917800`, step `T09 reconciliation-next` — success

Independent EOE focused command executed all 7 T09 test files.

Result:
- 98 pass
- 0 fail
- 0 skip

Verified boundary:
- source/OpenAPI repository + revision binding is exact;
- runtime additionally requires exact revision/build/environment;
- incomplete/partial runtime cannot prove absence;
- duplicate operation IDs and route conflicts block;
- declared security does not become runtime authorization proof;
- unresolved refs remain unknown;
- runtime observation must bind source/openapi/runtime refs and expected route.

Most importantly, `buildPromotionReadinessReport()` returns:
`advisoryOnly:true`.

T19 verdict:
`PASS(ADVISORY_RECONCILIATION)`

Not approved:
- capability mutation from T09 readiness;
- runtime-tested support certification from route observation alone;
- authorization enforcement certification.

## T10 — persistence plane

PR #84:
- head `1095e855f425746865cccd9f6453e645f5f0eaa5`
- CI `36093289581` — success, but this historical workflow did not execute the nested T10 suite.

T19 first attempted a directory target and received a Node MODULE_NOT_FOUND command error. This is recorded as an invalid test invocation, not a product failure.

T19 then explicitly executed all 16 `test/persistence-next/*.test.mjs` files.

Result:
- 112 pass
- 0 fail
- 0 skip

Static semantics that are valid:
- resource/entity name similarity does not auto-bind;
- composite key order is preserved;
- synthetic conformance cannot request runtime scope;
- write remains false;
- T14 catalog approval remains separate;
- current generation handoff requires live-read verified + single UUID key.

### Independent provenance probe

T19 ran an external read-only probe against exact T10 bytes.

Probe SHA-256:
`cd77d936511e5a8a6da2c5ac65589e1545cbe67705ffd0021018af4997b9e221`

Observed:
- caller supplied arbitrary entity id `caller-controlled-id` was accepted;
- malformed/out-of-repo-like `source_refs:[{file:"../../outside"}]` was preserved unvalidated;
- source provider was `typeorm`;
- observed live provider was a different `unrelated-live-provider`;
- matching physical table/PK/type still produced `verified_read_by_primary_key:true`.

This confirms the current promotion blocker independently from implementer summaries.

Current `sbf.persistence-generation-handoff/1` is acceptable only as a T14 lookup tuple. It is **not certification evidence** because it lacks:
- exact candidate/source revision binding;
- immutable artifact/content reference;
- approved composition/profile identity;
- provider-consistent live evidence binding.

T19 verdict:
`BLOCKED(PERSISTENCE_CERTIFICATION_PROVENANCE)`

Approved level:
- persistence IR/static normalization;
- synthetic/pinned non-runtime conformance;
- handoff tuple shape for lookup only.

Not approved:
- general runtime-read certification from current handoff;
- T14 behavior-tested input;
- write capability.

## T14 — composition/codegen

PR #71:
- head `6ef66955f8cd1180063c9ff17b1d2619a8d6036c`
- CI #721 / `36088925526` — success

Independent EOE command:

```bash
node --test t19-review-t14/test/t14-provider-composition.test.mjs
```

Result:
- 18 pass
- 0 fail
- 0 skip

Verified:
- catalog is explicit and fail-closed;
- preview forces `dryRun` and `applyAllowed:false`;
- unsupported combinations block before provider emit;
- manual auth/patch gaps remain visible;
- revision/provider/combination-scoped evidence is required for build certification;
- generic persistence/runtime evidence cannot mint behavior-tested.

Current code always adds:
`behavior-handoff-not-integrated`
for requested `behavior-tested`.

Issue #110 is still open. T10 current output is not certification-eligible, and T16 immutable binding/evidence core is not itself a verifier-produced behavior-success handoff.

T19 verdict:
- `PASS(PREVIEW_AND_CERTIFICATION_GATE_SEMANTICS)`
- `BLOCKED(BEHAVIOR_TESTED)`

No actual apply path or behavior-tested combination is approved.

## Cross-track promotion boundary

The permitted direction is:

```text
T09 source/spec facts
        ↓ advisory only
T03 capability policy
        ↓ only trusted evidence refs
T10 persistence facts/live proof
        ↓ versioned provenance-bound handoff required
T16 runtime execution/evidence
        ↓ verifier-produced success handoff required
T14 composition certification
        ↓ behavior-tested remains blocked until both handoffs are accepted
```

Current independent disposition:

| Track | evaluator/focused tests | highest independently acceptable level |
|---|---|---|
| T03 | 60/60 PASS | static capability-policy semantics |
| T09 | 98/98 PASS + nested CI 22/24 | advisory source/spec/runtime-route readiness |
| T10 | 112/112 PASS | static/non-runtime persistence; runtime certification BLOCKED |
| T14 | 18/18 PASS | preview/build gate semantics; behavior-tested BLOCKED |

A green unit/focused test proves the gate logic at that code SHA. It does not automatically prove a target/runtime/profile has supplied the evidence required by that gate.
