# T08 → T19 independent QA handoff

Status: independent review request. The expected outcomes below are review targets, not T08 self-certification.

T08 verification revision: `66e804bb2b8fb08fc2c902204a7581f5605fdac1`.

Self-test evidence at that revision:
- macOS / EOE focused suite: **51/51 PASS**;
- Windows / Alienware focused suite: **51/51 PASS**;
- T08 package check: **1/1 PASS** on each platform;
- existing registry/conformance/package subset: **25/25 PASS** on EOE.

T08 does **not** use those self-tests as a substitute for independent QA.

## Claimed slice to review

- Gin literal roots/groups/routes;
- ASP.NET Core literal Minimal API groups/routes and direct controller route attributes;
- Axum literal Router route/nest/merge subset;
- Actix direct route and literal scope subset;
- bounded NDJSON worker/runner contract.

No claim is made for framework-complete discovery, request/response schemas, auth enforcement, persistence, codegen, compiler semantics or runtime-tested framework support.

## Independent negative vectors requested

Please derive expected outcomes independently.

1. comments/string/raw-string route-looking data must not become facts;
2. computed route/group paths must remain unknown diagnostics;
3. ASP.NET conventional routing must not invent a route;
4. Axum nest/move/merge must not duplicate routes;
5. unsupported Axum intermediate chains such as `.clone()` must not be silently treated as moves;
6. mixed Axum/Actix source must not create cross-framework false diagnostics;
7. malformed UTF-8/protocol/multiline envelopes and malformed response facts must fail closed;
8. response request-ID/language substitution must be rejected;
9. request budgets must not expand the runner profile;
10. a profile must not advertise an input ceiling beyond the worker bootstrap reader;
11. worker must inherit no ambient environment/secrets;
12. timeout/output/route/diagnostic overflow paths must fail closed;
13. repeated identical input must produce deep-equal facts.

## Corpus request

Use fixtures not copied from T08 test strings:
- Go/Gin: nested groups + wrapper/dynamic registration outside supported subset;
- C#/ASP.NET: Minimal API + controller sample with convention/inheritance outside subset;
- Rust/Axum: nested/merged router + macro/generated/unsupported chain;
- Rust/Actix: scope/direct route + configure/resource-builder construct outside subset.

Report precision/recall only for an explicitly annotated supported subset. Unknown/abstention must remain visible rather than being dropped from a broader denominator.

## Evidence requested back

- exact T08 revision reviewed;
- independent fixture/golden source + digest;
- command/exit code;
- per-vector observations;
- false positive/negative source spans;
- reviewed support level and limitations.

T08 will wait for T19's independent result before any profile-level support promotion.
