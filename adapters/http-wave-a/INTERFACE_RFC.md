# T12 HTTP wave A layer: interface RFC

Status: draft, provisional, shadow only. T12 is not declared complete; nothing here is registered, runtime tested or active by default. Scope: the shared module, the seven leaf modules and the tooling in `adapters/http-wave-a` (T12-02).
Companions: `BASELINE.json` (behaviour pinned by T12-01), `leaf-contract.schema.json` (section 3), `test/http-wave-a/interface-rfc.vocabulary.json` (every identifier used here) and
`test/http-wave-a/interface-rfc.test.mjs`, which fails when the compared parts of this text, the vocabulary, the code, the schema or the ownership checker of T00 drift apart. It compares the tables, the bullet lines of sections 3 and 4 and the last line of section 7 with the vocabulary; elsewhere a backticked word only has to be a word of the vocabulary. Headings and other prose are not compared (limit `interface-rfc-prose-is-not-compared` in `BASELINE.json`).

## 1. Purpose and non-goals

The scanners of T04, T06, T07 and T08 stay authoritative. T12 turns their facts into one internal leaf output per HTTP framework (section 3): the routes it can prove, and everything else as an unknown. It emits no contracts/next artifact, imports no code of T01 or T03, registers no adapter, claims no runtime test and changes no upstream behaviour.
No bridge to `contracts/next` or to the capability vocabulary of `scanners/capability-next` exists: a leaf `status` is not a capability value. The missing bridge, the blocked leaves and the string-only real repository comparisons are the promotion gates of section 6.

## 2. Modules in scope

| module | role | exports | profile id | state | owner | upstream contracts |
| --- | --- | --- | --- | --- | --- | --- |
| `_shared.mjs` | shared | `HTTP_WAVE_A_LEAF_CONTRACT`, `blockedProjection`, `defineProfile`, `joinHttpPath`, `literalArgument`, `localDecoratorNamesFromModuleFacts`, `makeRoute`, `projection`, `routeOrUnknown` | - | - | - | - |
| `aspnet-core.mjs` | leaf | `ASPNET_CORE_PROFILE`, `projectAspNetCoreFacts` | `csharp-aspnet-core` | `candidate` | T08 | `bskel.native-language/1` |
| `django-drf.mjs` | leaf | `DJANGO_DRF_PROFILE`, `projectDjangoDrfShadow` | `python-django` | `blocked-upstream-fact-gap` | T06 | T06 `buildDjangoUrlShadow` output |
| `fastify.mjs` | leaf | `FASTIFY_PROFILE`, `projectFastifyFacts` | `node-fastify` | `blocked-upstream-fact-gap` | T04/T02 | `bskel.internal.js-ts-source-facts/0`, `bskel.internal.js-ts-structure/0` |
| `flask.mjs` | leaf | `FLASK_PROFILE`, `projectFlaskShadow` | `python-flask` | `candidate` | T06 | T06 `buildFlaskRouteShadow` output |
| `gin.mjs` | leaf | `GIN_PROFILE`, `projectGinFacts` | `go-gin` | `candidate` | T08 | `bskel.native-language/1` |
| `laravel.mjs` | leaf | `LARAVEL_PROFILE`, `projectLaravelCandidates` | `php-laravel` | `candidate` | T07 | `sbf.dsl-route-candidates/1` |
| `nestjs.mjs` | leaf | `NESTJS_PROFILE`, `projectNestJsFacts` | `typescript-nestjs` | `candidate` | T04 | `bskel.internal.js-ts-source-facts/0`, `bskel.internal.js-ts-structure/0` |
| `python-scope/static-runner.mjs` | tooling | `STATIC_LAYERS`, `STATIC_LAYER_SOURCES`, `STATIC_RUNNER_SCHEMA`, `canonical`, `fixtureDirs`, `runStatic`, `serializeStatic`, `walk` | - | - | - | - |
| `python-scope/verify.mjs` | tooling | `REPO_ROOT`, `SCOPE_TARGETS`, `canonicalJson`, `compareLayer`, `derivePartition`, `expectedCommands`, `liveRegistration`, `loadRecord`, `oraclePairs`, `outcomeOf`, `printedRecord`, `pythonJson`, `recordDir`, `sealOf`, `sealRecord`, `verifyItems`, `verifyLiveTree`, `verifyScopeRecord`, `verifyStoredRecord` | - | - | - | - |

## 3. Inputs and outputs

Unusable input is each of `undefined`, `null`, a number, a string, `{}` and `[]`; the last column says what every one of them does.

| function | module | input | unusable input |
| --- | --- | --- | --- |
| `projectAspNetCoreFacts` | `aspnet-core.mjs` | T08 analyze-response of language `csharp`, protocol `bskel.native-language/1` | TypeError |
| `projectDjangoDrfShadow` | `django-drf.mjs` | T06 `buildDjangoUrlShadow` result with the arrays `registrations` and `unknowns` | blocked output |
| `projectFastifyFacts` | `fastify.mjs` | none, the argument is ignored | ignored, always blocked |
| `projectFlaskShadow` | `flask.mjs` | T06 `buildFlaskRouteShadow` result with the arrays `registrations` and `unknowns` | TypeError |
| `projectGinFacts` | `gin.mjs` | T08 analyze-response of language `go`, protocol `bskel.native-language/1` | TypeError |
| `projectLaravelCandidates` | `laravel.mjs` | T07 envelope with contract `sbf.dsl-route-candidates/1` and framework `laravel` | TypeError |
| `projectNestJsFacts` | `nestjs.mjs` | T04 `{moduleFacts, structureFacts}`, contracts `bskel.internal.js-ts-source-facts/0` and `bskel.internal.js-ts-structure/0` | TypeError |
| `routeOrUnknown` | `_shared.mjs` | `{method, path, handler, source, provenance}` and a context object | unknown for the ANY method, a method outside the seven or a path that is not absolute; TypeError for a bad handler or provenance of a route that is otherwise valid |
| `makeRoute` | `_shared.mjs` | `{method, path, handler, source, provenance}` | TypeError for a method outside the seven, a path that is not absolute, a handler that is neither null nor a non-empty string, a missing provenance |
| `defineProfile` | `_shared.mjs` | a profile object with `id` and `state` | TypeError for a non-object, a missing `id`, a `state` outside the two profile states |
| `projection` | `_shared.mjs` | a profile and `{sourceContracts, routes, unknowns, observations, evidence}` | TypeError for a route that owns `operationId`; nothing else is checked |
| `blockedProjection` | `_shared.mjs` | a profile, a code, a reason and evidence | nothing is checked |

- Leaf output `{contract, profileId, registration, productionDefault, status, sourceContracts, routes, unknowns, observations, evidence}`: `contract` always `bskel.internal.http-wave-a-leaf/0`; `profileId` the `id` of the profile; `registration` always `unregistered`; `productionDefault` always `false`; `status` `candidate`, or `blocked` when the profile state is `blocked-upstream-fact-gap`; `sourceContracts` a copy of the upstream contracts that were read; `routes` sorted by `path`, `method`, `handler`, none for a blocked leaf; `unknowns` sorted by their key-sorted JSON text, each with a `code`; `observations` facts that are not routes, sorted like `unknowns`; `evidence` passed through by reference.
- Route `{method, path, handler, source, provenance}` where `method` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`; unknown made by `routeOrUnknown` `{code, reason, method, path, handler, source, provenance}`; profile `{id, title, state, upstreamOwner, upstreamContracts, supportedSyntax, unknownConditions, versionPin, realRepoComparison, registration, productionDefault, runtimeTested, t19Review}`.
- `defineProfile` forces `registration` to `unregistered`, `productionDefault` to `false` and `runtimeTested` to `false`; `t19Review` is `NOT_REVIEWED` unless the caller passes one; `realRepoComparison` is a plain string that may start with `BLOCKED_INFRA` or `PASS_STATIC_REAL_REPO`.
- Known differences, stricter than the code: `route-fields`: a route needs a method of the seven, an absolute path, a handler that is null or a non-empty string, a source that is an object or null and a string provenance, none of which `projection` checks (`makeRoute` checks all of them except `source`); `blocked-without-routes`: a `blocked` output has no routes, which `projection` does not enforce; `unknown-code`: every unknown is an object with a non-empty string `code`, which `projection` does not check; `support-keys`: no key named `supported`, `support`, `capability` or `capabilities` at any depth, while `projection` passes the contents of `unknowns`, `observations` and `evidence` on unchecked; `plain-contents`: `sourceContracts` holds non-empty strings and each observation and `evidence` is a plain object, while `projection` copies whatever it is given.
- Known differences, looser than the code: `order-and-ties`: does not check the sort order and does not tie `profileId` and `status` to a profile; `open-contents`: accepts a route unknown that has only a `code` while `routeOrUnknown` always emits the unknown keys; neither list is proved complete.

## 4. Identity

- Leaf: `profileId` is the `id` of its profile: `csharp-aspnet-core`, `python-django`, `node-fastify`, `python-flask`, `go-gin`, `php-laravel`, `typescript-nestjs`.
- Route: no identity is created; a route is addressed by `path`, `method` and `handler`, also its sort order, and equal routes are kept. `projection` throws TypeError for a route that owns `operationId`, and `makeRoute` never sets it.
- Contract: `bskel.internal.http-wave-a-leaf/0` is internal and unfrozen (suffix 0). Inputs carry `bskel.native-language/1`, `sbf.dsl-route-candidates/1`, `bskel.internal.js-ts-source-facts/0`, `bskel.internal.js-ts-structure/0`; the T06 shadows are named by `buildFlaskRouteShadow`, `buildDjangoUrlShadow`.
- Foreign: the replayed outputs hold none of `sbf.contract-ref/1`, `sbf.artifact-ref/1`, `sbf.identity-envelope/1`, no key `contract_hash` and no key named `supported`, `support`, `capability`, `capabilities`, but `projection` passes the contents of `unknowns`, `observations`, `evidence` on unchecked, so a live output can hold any of them there; the schema accepts all of them there except the names `supported`, `support`, `capability`, `capabilities` (`support-keys`); T01 owns identity and T03 the capability vocabulary.

## 5. Unknown, withheld and partial

A leaf output has `status` `candidate`, or `blocked` when its profile state is `blocked-upstream-fact-gap`: a blocked output is withheld (no route, and its first unknown is of the blocked group). A candidate is partial: `routes` holds what is proven, `unknowns` the rest, and nothing is guessed.
Groups: route, from `routeOrUnknown`; blocked; leaf; wrapped, the default code of an upstream unknown that has none; prefix, an upstream code behind the prefix. Silent drops of upstream facts are limits in `BASELINE.json`, not codes.

| code | group | leaf | reason | witness fixture |
| --- | --- | --- | --- | --- |
| `ROUTE_METHOD_WILDCARD_UNRESOLVED` | route | _shared | route method is the ANY wildcard; it is kept as an unknown and never expanded into a method list | route-method-any-lowercase |
| `ROUTE_METHOD_UNSUPPORTED` | route | _shared | route method is not one of the explicit HTTP methods a supported route can carry | route-method-trace-unsupported |
| `ROUTE_PATH_UNKNOWN` | route | _shared | route path is missing, not a string or not an absolute path | route-path-relative-unknown |
| `DJANGO_DRF_UPSTREAM_FACTS_MISSING` | blocked | django-drf | T12 requires T06 Django URL facts and a future T06-owned DRF action/method fact surface. | django-blocked-without-shadow |
| `DRF_ACTION_METHOD_FACT_MISSING` | blocked | django-drf | T06 has not promoted Router/ViewSet action-to-HTTP-method facts; Django URL observations cannot become HTTP endpoints. | django-blocked-with-shadow-hand-fed |
| `FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING` | blocked | fastify | T12 will not recreate a JS parser. A T04/T02-owned fact must bind Fastify instance/plugin receiver identity and registration ownership before HTTP routes can be projected. | fastify-blocked-without-input |
| `ASPNET_FOREIGN_ROUTE_FACT` | leaf | aspnet-core | T08 route fact is not an ASP.NET Core route | aspnet-foreign-route-hand-fed |
| `GIN_FOREIGN_ROUTE_FACT` | leaf | gin | T08 route fact is not a Gin route | gin-foreign-route-hand-fed |
| `FLASK_METHOD_SEMANTICS_UNRESOLVED` | leaf | flask | varies | flask-methods-unresolved-hand-fed |
| `NESTJS_UPSTREAM_FACTS_INCOMPLETE` | leaf | nestjs | T04 module/structure facts are incomplete or syntax-unvalidated | nestjs-incomplete-facts-hand-fed |
| `NESTJS_FACT_FILE_MISMATCH` | leaf | nestjs | module and structure facts do not refer to the same source file | nestjs-file-mismatch-hand-fed |
| `NESTJS_CONTROLLER_DECORATOR_NOT_CALLED` | leaf | nestjs | varies | nestjs-decorator-not-called-hand-fed |
| `NESTJS_CONTROLLER_PATH_UNKNOWN` | leaf | nestjs | varies | nestjs-controller-path-unknown-hand-fed |
| `NESTJS_METHOD_DECORATOR_NOT_CALLED` | leaf | nestjs | varies | nestjs-decorator-not-called-hand-fed |
| `NESTJS_METHOD_PATH_UNKNOWN` | leaf | nestjs | varies | nestjs-controller-hand-fed |
| `T06_FLASK_UNKNOWN` | wrapped | flask | varies | flask-methods-unresolved-hand-fed |
| `T06_DJANGO_UNKNOWN` | wrapped | django-drf | varies | django-blocked-with-shadow-hand-fed |
| `T07_` | prefix | laravel | varies | laravel-any-dynamic-upstream |
| `T08_` | prefix | aspnet-core, gin | varies | aspnet-mapmethods-diagnostic-upstream, gin-any-trace-dynamic-upstream |

## 6. Promotion gates

Every gate is open. The test computes each state from the code (`consumer_exists` from `BASELINE.json`, the state at the base commit) and fails when one differs; `limits` names the records in `BASELINE.json` that document the gap.

| gate | blocker | closes when | state | limits |
| --- | --- | --- | --- | --- |
| `leaves_registered` | `leaves-not-registered` | a leaf profile id is in the registry | open | leaves-are-unregistered-candidates |
| `runtime_tested` | `leaves-not-runtime-tested` | a profile has `runtimeTested` true | open | - |
| `review_accepted` | `review-not-accepted` | a profile has a `t19Review` other than `NOT_REVIEWED` | open | - |
| `blocked_leaves_unblocked` | `blocked-leaves-not-unblocked` | no profile is in state `blocked-upstream-fact-gap` | open | django-drf-leaf-blocked, fastify-leaf-blocked |
| `real_repo_evidence_structured` | `real-repo-evidence-not-structured` | no profile has a plain string as its `realRepoComparison` | open | real-repo-comparison-is-a-plain-string, leaf-rerun-markers-describe-history |
| `bridges_built` | `bridges-not-built` | a module of the layer names `contracts/next`, `schemas/next` or `scanners/capability-next` | open | no-bridge-to-contracts-next-or-the-capability-vocabulary |
| `schema_frozen` | `schema-not-frozen` | the contract id no longer ends in `/0` | open | - |
| `consumer_exists` | `consumer-not-present` | a file outside the layer names the contract (state at the base commit) | open | leaf-contract-has-no-consumer-outside-the-layer |

## 7. File ownership

The last column is the answer of the T00 ownership checker for a path of the row, run with `--track T12`.

| paths | owner | T12 may | checker |
| --- | --- | --- | --- |
| `adapters/http-wave-a`, `test/http-wave-a` | T12 | edit | OK |
| `scanners/language/native-server` | T08 | read only, pinned by BASELINE.json | `PATH_OWNED_BY_OTHER_TRACK` |
| `scanners/language/python` | T06 | read only, pinned by BASELINE.json | `PATH_OWNED_BY_OTHER_TRACK` |
| `scanners/language/ruby-php` | T07 | read only, pinned by BASELINE.json | `PATH_OWNED_BY_OTHER_TRACK` |
| `scanners/language/js-ts` | T04 | none, no import | `PATH_OWNED_BY_OTHER_TRACK` |
| `adapters/http-legacy-next` | T11 | read only, pinned by BASELINE.json | `PATH_OWNED_BY_OTHER_TRACK` |
| `adapters/http-wave-bc` | T13 | read only, pinned by BASELINE.json | `PATH_OWNED_BY_OTHER_TRACK` |
| `scanners/registry.mjs`, `scanners/text-util.mjs`, `scanners/adapters`, `schemas/adapter.schema.json` | stable scanner surface | read only, pinned by BASELINE.json | `PATH_UNOWNED` |
| `contracts/next`, `schemas/next` | T01 | none, no import | `PATH_OWNED_BY_OTHER_TRACK` |
| `scanners/capability-next` | T03 | none, no import | `PATH_OWNED_BY_OTHER_TRACK` |
| `scripts/run-next-nested-tests.mjs`, `package.json`, `package-lock.json` | T00 coordinator | read only, pinned by BASELINE.json | `PATH_RESERVED_HOT` |
| `.github/workflows`, `CATALOG.md`, `DECISIONS.md` | T00 coordinator | never edit | `PATH_RESERVED_HOT` |

`adapters/http-wave-a` holds exactly `BASELINE.json`, `INTERFACE_RFC.md`, `_shared.mjs`, `aspnet-core.mjs`, `django-drf.mjs`, `fastify.mjs`, `flask.mjs`, `gin.mjs`, `laravel.mjs`, `leaf-contract.schema.json`, `nestjs.mjs`, `python-django`, `python-flask`, `python-scope`, `scope`; a new file there needs this RFC and the vocabulary updated first.
