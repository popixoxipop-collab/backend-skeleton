# T08 → T19 independent QA handoff

Status: independent review request. The expected outcomes below are review targets, not T08 self-certification.

T08 product-code revision for the initial request: `974fd99374722d9cdb931c3fed8f2b086010039a`.

## Claimed slice to review

T08 claims only a conservative **static fact layer** for these subsets:

- Gin literal roots/groups/routes;
- ASP.NET Core literal Minimal API groups/routes and direct controller route attributes;
- Axum literal Router route/nest/merge subset;
- Actix direct route and literal scope subset;
- bounded NDJSON worker/runner contract.

It does **not** claim framework-complete discovery, request/response schemas, authorization enforcement, persistence, code generation, compiler semantics or runtime-tested framework support.

## Independent negative vectors requested

Please recreate expected results independently rather than copying T08 analyzer output.

1. route-looking text in comments and strings must not become facts;
2. computed/dynamic route/group paths must remain explicit unknown diagnostics;
3. unresolved ASP.NET conventional routing must not invent `/`;
4. Axum nested/moved/merged routers must not duplicate exposed routes;
5. unsupported Axum intermediate chains such as `.clone()` must not be silently treated as moves;
6. Axum and Actix in the same source must not create cross-framework unknowns;
7. malformed UTF-8, protocol version, multiline envelope and malformed response facts must fail closed;
8. response request ID/language substitution must be rejected;
9. request resource budgets must not expand the trusted runner profile;
10. worker receives no ambient environment or secret-shaped variables;
11. timeout/output/route/diagnostic overflow paths must fail closed;
12. repeated identical input must produce deep-equal facts.

## Corpus request

For each language, use at least one fixture not authored from T08's own test strings:

- Go/Gin: nested groups plus one wrapper/dynamic registration that should be unknown;
- C#/ASP.NET: one Minimal API sample and one controller sample with a convention/inheritance construct outside the claimed subset;
- Rust/Axum: nested or merged router plus one macro/generated/unsupported chain;
- Rust/Actix: scope/direct route plus one configure/resource-builder construct outside the subset.

Please report precision/recall only for an explicitly annotated supported subset. Unknown/abstention must remain visible rather than being dropped from the denominator of a broader claim.

## Evidence requested back

- exact T08 commit reviewed;
- independent fixture/golden source and its digest;
- command and exit code;
- per-vector observations, including expected rejects/unknowns;
- any false positive/false negative with source span;
- whether the reviewed scope is Discovery-only or supports a stronger level.

T08 will not use its own 50/50 regression result as a substitute for this independent review.
