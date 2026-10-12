# T13 interface RFC: HTTP wave B and C adapters (Hono, Koa, Next.js)
Status: experimental and descriptive. Scope: `adapters/http-wave-bc`. Companions: `BASELINE.json` (pins, counter-examples, limits), `README.md`, `profile-evidence.json`, `t19-review-request.json`.
`interface-rfc.test.mjs` compares the title, the headings, the tables, four lines of key lists, schemas and reason codes, the code spans that name identifiers, schemas, paths or limit ids, and the line count of this file with `interface-rfc.vocabulary.json` and the code, refuses universal words outside code spans, and runs one named check per claim row. Other sentences are not compared. A claim that says sampled holds for the scans of the three upstream-example directories under `test/http-wave-bc/fixtures` and of trees that the test writes itself.

## 1. Purpose and non-goals
This file states, as they are, rules for the input, output and identity of the three leaf adapters (sections 3 to 5), so that its consumers (section 7) read one document. It changes no behaviour; a rule that sections 3 to 5 do not state is not covered by it.
Non-goals: output in the contracts/next form (the leaves emit the legacy contract, `legacy-contract`); registration in the production registry (`not-registered`); framework behaviour (`no-runtime`); leaves for the catalog targets without one (`absent-leaves`). The items T13-03 to T13-06 and the per-target items are not claimed here.

## 2. Adapters and catalog
| adapter | specificity | confidence | verificationBasis | api.operations | api.request-shape | resource.fetch | codegen.handles | diagnostic codes (detected / not detected) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `node-hono` | 55 | high | synthetic-only | false | false | false | false | `t13-experimental-hono` / `hono-not-detected` |
| `node-koa` | 54 | high | synthetic-only | false | false | false | false | `t13-experimental-koa-router` / `koa-router-not-detected` |
| `typescript-nextjs` | 56 | high | synthetic-only | false | false | false | false | `t13-experimental-nextjs` / `nextjs-routes-not-detected` |

| targets | wave B | wave C | with a leaf | without a leaf |
| --- | --- | --- | --- | --- |
| 16 | 9 | 7 | 3 | 13 |

## 3. Inputs and outputs
| module | exports | imports | input | output |
| --- | --- | --- | --- | --- |
| `catalog.mjs` | `HTTP_WAVE_BC_TARGETS`, `validateWaveBcCatalog` | no import | optional array of targets | array of target records; list of error texts |
| `node-hono/adapter.mjs` | `adapter`, `detectHonoRoot`, `scanHono` | `./route-graph.mjs`, `node:fs`, `node:path` | repo root; optional detection | descriptor; detection or null; scan result |
| `node-hono/route-graph.mjs` | `isHonoCodeIndex`, `maskHonoSourceComments`, `scanHonoProject` | `node:fs`, `node:path` | source text; object with repoRoot, projectRoot, packageFile | exported helpers, no contract stated |
| `node-hono/show-routes-parser.mjs` | `parseHonoShowRoutes` | no import | text of a show-routes listing | snapshot |
| `node-koa/adapter.mjs` | `adapter`, `detectKoaRouterRoot`, `scanKoaRouter` | `../../../scanners/adapters/_express-shared.mjs`, `../../../scanners/text-util.mjs`, `node:fs`, `node:path` | repo root; optional detection | descriptor; detection or null; scan result |
| `typescript-nextjs/adapter.mjs` | `adapter`, `detectNextRoot`, `scanNext` | `node:fs`, `node:path` | repo root; optional detection | descriptor; detection or null; scan result |

Keys in emitted order, as label {keys}: `descriptor` {contract, id, title, specificity, confidence, verificationBasis, capabilities, detect, scan, listReadSet, diagnostics}; `detection` {projectRoot, packageFile}; `scan_result` {modules, filesRead, scanNotes, apiSurfaceSource}; `not_detected_result` {modules, filesRead, scanNotes}; `module` {module, controllers, entities, enums, dtos}; `controller` {className, basePath, operationIds, endpoints, file}.
Endpoints: `hono_endpoint` {verb, path, operationId, method, line}; `koa_endpoint` {verb, path, operationId, routeName, method, line}; `next_endpoint` {verb, path, operationId, method, line, params}. Others: `diagnostic` {level, code, message}; `show_routes_snapshot` {schema, routes, unknownLines}; `show_route` {method, path, line, handlers}; `show_handler` {name, line}; `show_unknown_line` {line, text}. Input of the helper: `scanHonoProject` {repoRoot, projectRoot, packageFile}.
Schemas in use: `sbf.adapter/2` (descriptor), `sbf.scan-report/2` (report built by `runScan`), `bskel.hono-show-routes-snapshot/1` (snapshot). Foreign names, absent from this layer: `sbf.contract-ref/1`, `sbf.artifact-ref/1`, `sbf.identity-envelope/1`, `contract_hash`.

| id | claim |
| --- | --- |
| `io-legacy` | Each leaf descriptor carries contract `sbf.adapter/2`; no sampled output and no module of section 3 holds a schema name or key listed as foreign above. |
| `io-methods` | `detect` and `scan` return what the exported detect and scan functions of their module return for the same arguments, and `scan` uses the detection it is given (null selects the not-detected result); `listReadSet` returns the `filesRead` of that scan, an empty list for a tree that is not detected; `diagnostics` returns one info entry. |
| `io-input` | A root that is undefined, null, a number, an empty string, a missing path, a file path, an array or an object gives `detect` null, the not-detected result, an empty read set and the not-detected diagnostic, and does not throw for these eight roots. A detection passed by hand that is an empty object, a string, an object with a numeric projectRoot or an object without packageFile makes `scan` and `listReadSet` throw TypeError; null selects the not-detected result. |
| `io-run-scan` | `runScan` with one leaf and an empty terms list returns `sbf.scan-report/2` whose `related_modules`, `files_read` and `api_surface_source` equal `modules`, `filesRead` and `apiSurfaceSource` of the scan, and whose unknowns end with the `scanNotes`, after two notes that `runScan` adds. |
| `io-registry` | No leaf id is an entry of the ADAPTERS list, and neither registry file names a path of this layer. |
| `io-catalog` | `HTTP_WAVE_BC_TARGETS` is a frozen array. `validateWaveBcCatalog` returns an empty list for it and throws TypeError, not an error text, for an array that holds null; this defect is recorded as a fixture of `BASELINE.json` and not repaired here. |

## 4. Identity
| id | claim |
| --- | --- |
| `id-operation` | In the sampled scans `operationId` is null on each endpoint and `operationIds` is empty on each controller, so no operation identity is derived. `method` holds the handler name (null for an inline handler) and `verb` holds the HTTP method. |
| `id-class-name` | `className` is Hono(file relative to the project root:variable), KoaRouter(file basename:variable) or NextRoute(file relative to the project root). Two Koa router files of one basename in different folders get equal `className` values; the Hono and Next forms differ for them. |
| `id-duplicate` | Registrations are not merged or renumbered. Two Hono or Koa calls with one verb and path stay two endpoints; written on one source line they share verb, path and `line` and differ only in `method`. In the sampled Next scans, two route files for one path that export a method in common stay two controllers and one scan note names both files, while two files for one path that export different methods give no such note. |
| `id-line` | `line` is the 1-based line of the registration (of the export in a Next file). Inserting one line above a route moves `line` by one and leaves `className`, `verb` and `path` as they were. |
| `id-location` | In the sampled scans `file` of a controller is the scan root as passed, joined with the path of the file below it: absolute for an absolute scan root and relative to the working directory for a relative one. `filesRead` entries are relative to the scan root in both cases. The file named in `className` is relative to the project root for Hono and Next but only a basename for Koa (`id-class-name`), and does not depend on the form of the scan root; for a project below the scan root these bases differ, which the sampled Hono project shows. |
| `id-no-digest` | No sampled output has a key with hash, digest or sha as a word of its name, so the layer emits no identity digest. Each sampled endpoint has `verb`, `path` and `line`, and its controller has `className`; together they are a regression key within one scan and not a stable identifier: `line` moves when a line is inserted (`id-line`), and two registrations written on one source line carry equal values (`id-duplicate`). |

## 5. Unknown, withheld and partial results
Reason codes in Next notes: `parallel-route-segment`, `private-folder`, `catch-all-segment`, `intercepting-or-unsupported-segment`, `unsupported-dynamic-segment`. Limits of `BASELINE.json` that apply here: `unknown-not-structured`, `withheld-forms`, `silent-drop`, `incomplete-path`, `scope-insensitive`, `undetected-router`.

| id | claim |
| --- | --- |
| `un-empty-lists` | In the sampled scans `entities`, `enums` and `dtos` are empty lists, written as the literal [] in the module sources; an empty list there means not extracted. |
| `un-not-detected` | A tree the detector rejects gives `detect` null and a result with the keys `modules`, `filesRead` and `scanNotes` only, with one note; a detected tree without routes gives empty `modules` and a non-empty `filesRead`, so empty `modules` alone does not tell the two apart. |
| `un-reason-codes` | In the sampled Next scans a route file that exports a supported method and whose path cannot be built because of a segment emits no endpoint and one note naming the file and one of the five reason codes above; the same kind of file without a supported method gets no note, and a file withheld because the base path is unresolved gets a note that names the file and no reason code. In the sampled Hono and Koa scans no note names a reason code. A withheld form is reported as note text only, and no endpoint key carries a status or reason. |
| `un-show-routes` | `parseHonoShowRoutes` returns `schema`, `routes` and `unknownLines`; indented lines bind as handlers to the route above them, a line it cannot read stays in `unknownLines` with its line number, and empty, null or missing input gives empty lists. |
| `un-absent` | A short or empty endpoint list does not show that the source has no such route: the record holds fixtures in which a route form is lost without a note (`silent-drop`) or the router is not detected (`undetected-router`), so a consumer treats an absent route as unknown, not as absent. |

## 6. Promotion gates
| file | key | value |
| --- | --- | --- |
| `profile-evidence.json` | `promotion_state` | `HOLD_T19_T23` |
| `profile-evidence.json` | `new_framework_fanout` | `DEFER_UNTIL_PROFILE_REVIEW` |
| `t19-review-request.json` | `status` | `REQUESTED_NOT_ACCEPTED` |

| gate | owner | named in |
| --- | --- | --- |
| independent profile review | T19 | `profile-evidence.json` |
| package allowlist for adapters/http-wave-bc | T23 | `profile-evidence.json`, `t19-review-request.json` |
| production registry entry | integration owner | `profile-evidence.json`, `t19-review-request.json` |
| runtime verifier evidence | T16 | `profile-evidence.json` |

| id | claim |
| --- | --- |
| `pg-no-contracts-next` | Neither JSON file mentions contracts/next, so no gate for output in that form and no owner for such a gate is recorded; this RFC adds no gate and no owner. |

## 7. File ownership
T13 edits the paths of its own row. The relation column says whether a module of this layer imports from the paths of a row.
| owner | paths | relation |
| --- | --- | --- |
| T13 | `adapters/http-wave-bc`, `test/http-wave-bc` | edit |
| T01 | `contracts/next`, `schemas/next` | no import |
| T03 | `scanners/capability-next` | no import |
| unowned | `scanners/adapters/_express-shared.mjs`, `scanners/text-util.mjs` | import |
| unowned | `scanners/registry.mjs`, `scanners/index.mjs` | no import |
| reserved | `.github/workflows/ci.yml`, `scripts/run-next-nested-tests.mjs` | no import |

Consumers (a sample, not a list):
| file | owner | names |
| --- | --- | --- |
| `adapters/http-legacy-next/scope/verify.mjs` | T11 | `adapters/http-wave-bc/profile-evidence.json` |
| `adapters/http-wave-a/python-scope/verify.mjs` | T12 | `HTTP_WAVE_BC_TARGETS` |
| `test/conformance-next/product-mutations-wave2.json` | T19 | `adapters/http-wave-bc/typescript-nextjs/adapter.mjs` |
| `scripts/run-next-nested-tests.mjs` | reserved | `test/http-wave-bc` |

| id | claim |
| --- | --- |
| `ow-non-leaf-dirs` | The directories `python-litestar`, `python-starlette` and `scope` of this layer contain no file named adapter.mjs; the non-null `scope_record` values of `BASELINE.json` are paths inside these directories. |
