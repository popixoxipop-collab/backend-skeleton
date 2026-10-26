# HTTP-php-laravel-01 target scope

Status: **static source and evidence plan**, not production certification. Prerequisite T12-02 is MET. This target owns only `adapters/http/php-laravel/**`.

The current Laravel path is a two-stage static candidate. T07 recognizes bounded literal `Route::get`, `post`, `put`, `patch`, `delete`, `options`, `any`, `match`, `resource`, and `apiResource` declarations and same-file literal group metadata. The unregistered T12 leaf projects those `sbf.dsl-route-candidates/1` facts into `bskel.internal.http-wave-a-leaf/0`. Neither stage is a PHP parser, Composer resolver, Laravel runtime, registered scanner adapter, packaged product path, or stable cross-tool contract.

## Frozen application and framework identities

- Application repository: `laravel/laravel`
- Application commit: `aa0cf127fc365a56ee016867144ddffabc2290ae`
- Application files: exact `composer.json` and `routes/web.php` Git blobs copied below `fixtures/upstream/laravel/`
- Application declaration: PHP `^8.3`, `laravel/framework` `^13.17`
- Exact framework source boundary: `laravel/framework` tag `v13.17.0`, commit `0802b7a81f3252d78200b8037ac183a686a529f0`
- Framework file: exact `composer.json` Git blob copied below `fixtures/framework/laravel-v13.17.0/`

The application has no committed Composer lock in this target. `^13.17` is a compatibility declaration, not an installed version. `v13.17.0` is the one exact framework-source boundary selected for this plan; no other compatible release is certified.

## Oracle and runtime boundary

The copied upstream `routes/web.php` is analyzed, not built or booted. It deterministically yields one literal candidate and one T12 route: `GET /`. No PHP process, Composer install, package download, `artisan route:list`, HTTP request, middleware chain, handler behavior, service provider, macro, or external runtime-equivalence comparison is executed. Scanner-versus-runtime equality is **NOT VERIFIED**.

The profile's `historical-pass-needs-leaf-rerun` marker and the baseline's `upstream-real` label are historical record text, not a current runtime pass. The live profile still has `versionPin.framework: null`; this scope does not silently rewrite that fact.

## Must-catch matrix

1. Exact application and framework repositories, commits/tag, Git blobs, and copied SHA-256 bytes.
2. The upstream literal `GET /` route through both T07 expansion and the T12 leaf.
3. Literal group-prefix composition and bounded `apiResource` action expansion.
4. Deterministic same-input facts, candidates, routes, unknowns, and ordering.
5. Dynamic route paths and group metadata preserved as T07-prefixed unknowns.
6. `Route::any` preserved only as `ROUTE_METHOD_WILDCARD_UNRESOLVED`, never expanded into methods.
7. Irregular resource parameters and unsupported resource actions preserved as unknowns.
8. Partial/null candidate paths preserved as `ROUTE_PATH_UNKNOWN` without aborting other routes.
9. Comments, strings, unsupported calls, and non-Route receivers never promoted to routes.
10. Wrong contracts/framework identities rejected at the leaf boundary.
11. Exact PHP/framework declarations and the difference between the application range and exact source tag.
12. Unchanged T00 ownership, `baseline.lock.json`, workflow, and T12 nested-runner boundaries.

## Explicit limitations and authority

Multiline or generated declarations, dynamic factories, cross-file group context, facade aliases, custom macros, service-provider registrations, attribute packages, middleware/auth semantics, deployment prefixes, and runtime-installed routes may be absent rather than diagnosed. No missing route may be interpreted as proof that the runtime lacks it.

Execute `node --test adapters/http/php-laravel/target-scope.test.mjs adapters/http/php-laravel/target-scope-negative.test.mjs`, then the immutable Git-source evidence replay. Existing T07/T12 sources and tests remain untouched and source-pinned. Passing creates no MET, release, runtime certification, external runtime equality, production registration, or signed-attestation claim. Official promotion still requires exact-head CI, independent review, protected merge, merged-source replay, and a T00 one-row CAS. T19/T20 authority and the global release remain BLOCKED.
