# T02 project graph: interface RFC

Status: draft / provisional, not a stable SBF contract
Task: T02-02 (inputs and outputs, identity, unknown/partial semantics, file ownership)
Owner: T02, `scanners/project-graph/`
Covers: `sbf.project-graph/draft-1`, `sbf.project-scan-shadow/draft-1`

This RFC records what the code on main does today. It changes no behavior. Where it states a rule that
no code enforces, it says "convention". Nothing here is a `contracts/` entry, and nothing is added to the
stable root `schemas/` namespace or to T01's `schemas/next`.

Evidence tags: **[probe]** = reproduced by a command in section 7 whose output hash is recorded;
**[source]** = read from the module source and not reproduced by a probe; **[convention]** = a rule
consumers are asked to follow that no code enforces.

## 1. Status and scope

- Every field below may change until T00 and T01 approve a cross-tool seam. `LEGACY_A_RECONCILIATION.md`
  in this directory remains the ownership decision of record; this RFC adds the interface vocabulary it
  did not define.
- In scope: the exports of `index.mjs`, `source-role.mjs`, `registered.mjs` and `shadow.mjs`.
- Out of scope: CLI or contract-emitter wiring (T00/T23, needs a lease), router-internal mount graphs
  (adapter-owned), cache and invalidation policy (T21), DB and runtime-route execution (disabled in the
  shadow path), and every service facet other than `http`.
- Machine-readable draft: `schemas/project-graph.draft-1.schema.json` in this directory (JSON Schema
  2020-12, `$id` `urn:sbf:project-graph:draft-1`). It describes the object returned by
  `buildProjectGraph()` and `buildRegisteredProjectGraph()` only, not discovery output, plans or shadow
  output. The test in `test/project-graph/interface-rfc.test.mjs` validates real graphs against it and
  requires the negative fixtures in that test to be rejected.
- Placement: the root `schemas/` directory is the stable namespace and is checked against the package
  pack list, so a draft that may still change lives next to its owner, the way T18 keeps its draft
  item-ref schema inside its own track directory. Promotion to a stable namespace is a T00/T01 decision.

## 2. Inputs and outputs

### 2.1 Entry points

| Export (module) | Input | Output |
|---|---|---|
| `discoverProjectRoots(repoRoot, {markerRules})` (`index.mjs`) | repo path; optional marker rules, read the way `buildProjectGraph` reads them (section 2.5). It checks no `repoRoot`: an empty string is the process working directory, and `undefined`, `null` or a number is a Node `TypeError`, as is `null` in place of the options object | in-process `{repo_root, roots[], unresolved[], files_read[]}`; `repo_root` and each `roots[].absolute_root` are absolute, so this object is not portable [probe: options `discover_roots`] |
| `inferDetectionProjectRoot(detection)` | an adapter `detect()` return value | absolute project root or `null`. Accepted: a non-empty string (resolved; a trailing `src/main/java` is stripped, so `/src/main/java` gives `/`), or an object whose `projectRoot` is a non-empty string (resolved only, never stripped), else an object whose `srcRoot` is a non-empty string (resolved and stripped like a string). A relative string resolves against the process working directory, not the repository. Anything else (`true`, `''`, `0`, `NaN`, `{}`, an array, a Promise, a function, an object with neither key as a non-empty string) gives `null`. [probe: options `detect_values`] |
| `captureAdapterReadSetSnapshot({repoRoot, projectRoot, adapter})` | adapter with optional `listReadSet(absProject)` returning project-relative paths | `null` when the adapter has no `listReadSet`; else `{adapter_id, files[{path, digest, role}], fingerprint}`. Throws `TypeError` (a falsy `repoRoot`, `projectRoot` or `adapter`, a result that is not an array, or an invalid entry), `PROJECT_READ_SET_ESCAPE` (an entry leaves the project, or the project leaves the repository) or the file-system error of an unreadable file |
| `buildProjectGraph({repoRoot, adapters, markerRules})` | a truthy `repoRoot` and an `adapters` array, the only two checks (else `TypeError`); optional `markerRules`, default the nine rules of section 4. Section 2.5 lists what else is accepted and what is not checked | the graph, section 2.2 |
| `buildProjectScanPlan(graph, {includeFallback, includeNonActive})` | a draft-1 graph (else `TypeError: expected sbf.project-graph/draft-1`); optional flags, section 2.3 | array of plan items, section 2.3 |
| `buildRegisteredProjectGraph(repoRoot, {adapters, markerRules})`, `buildRegisteredProjectScanPlan(repoRoot, {includeFallback, ...})` (`registered.mjs`) | repo path; `adapters` defaults to the registry's `ADAPTERS` when it is omitted, `undefined` or `null`, and any other value goes to the builder, so `false` fails with `adapters must be an array` [probe: options `registered_adapters_false`]; `markerRules` is passed on only when truthy, so `[]` is passed and `null` or omitted means the defaults [probe: options `empty_marker_rules`]. The plan variant forwards `includeFallback` to the plan but not `includeNonActive`, so it never plans a non-active project [probe: options `plan_options`]. A `null` in place of the options object is a Node `TypeError` for both functions [probe: options `registered_options_null`, `registered_plan_options_null`] | the same graph plus `registry_load_errors`; the plan variant returns `{graph, plan}` |
| `executeProjectScanPlan({repoRoot, graph, terms, adapters, rgAvailable, includeFallback})` (`shadow.mjs`) | a graph and the repo it was built from | `sbf.project-scan-shadow/draft-1`, section 2.4 |
| `classifyProjectSourceRole(path)`, `groupProjectSourcesByRole(paths)`, `PROJECT_SOURCE_ROLES` (`source-role.mjs`) | repo-relative paths | a role name, or a `{role: paths[]}` map covering all five roles, each list sorted (duplicates are kept), and the array that is given is left as it was. A path that is not a non-empty string (a `String` object is not one), or a non-array given to the grouping, is a `TypeError`. A non-empty path that holds no name (`/`, `./`) is `active`. Doubled and trailing separators are skipped, so `docs/page.tmpl/` is judged by its name `page.tmpl` and is template |
| `portableProjectDiagnosticMessage(message, repoRoot)`, `portableRegistryLoadErrors(entries)` | raw error text / registry load errors | text with every occurrence of the absolute repo (or adapter) directory replaced by `<repo>` (or `<adapter-dir>`) and backslashes turned into `/`. A `null` or `undefined` message gives `''`, and without a `repoRoot` only the backslashes change. A directory in a Windows-style `file` (`C:\x\y.mjs`) is replaced whether `message` spells it with backslashes or with `/`. `portableRegistryLoadErrors` throws a `TypeError` for a non-array, and returns `{file, message}` sorted by `file`, then `message`, with the base name of `file` (`(unknown)` when it is missing, empty or not a string, and `''` when it ends in a separator; a leading separator is cut as well, so `/x.mjs` gives `x.mjs`), and the text of `message` (`''` for a missing one, `5` for the number 5) |
| `PROJECT_GRAPH_DRAFT`, `PROJECT_GRAPH_EXECUTION_ROOT`, `projectGraphExecutionRoot(graph)` | none / a graph | the draft id; a Symbol key; the absolute root captured at build time or `null` |

Adapters are the existing `sbf.adapter/2` descriptors (`detect` and `scan` required; `listReadSet`,
`diagnostics`, `introspectRoutes` optional; `id` equals the file name). T02 calls them and never edits
them. At the time of writing every first-party adapter on main defines `listReadSet` [source]; a
third-party or test adapter without it yields a `null` read set (section 5).

### 2.2 Graph object

Every key below is always present on a graph. Arrays are sorted with plain code-unit comparison, except
`unresolved`, which keeps the order in which the builder found things (section 5.1), and `notes`, which is
fixed prose.

| Key | Meaning |
|---|---|
| `schema` | the constant `sbf.project-graph/draft-1` |
| `repo_root` | always `.`. The absolute root lives under the non-enumerable `PROJECT_GRAPH_EXECUTION_ROOT` symbol and disappears on JSON serialization. The property is read-only and not configurable (`writable` and `configurable` are `false`) |
| `projects` | one entry per discovered project root, sorted by `root`; the repository root is always a project, even with no marker of its own |
| `project_edges` | `contains` and `local-package-dependency` edges sorted by kind, from, to, dependency name |
| `unresolved` | facts the builder could not resolve; section 5 |
| `files_read` | sorted unique repo-relative POSIX paths: marker files plus selected adapter read-set files |
| `notes` | five fixed prose strings. Not machine-stable; do not parse |
| `registry_load_errors` | registered builder only: `{file, message}` with the adapter file's base name and `<adapter-dir>` in messages |

Project entry:

| Key | Meaning |
|---|---|
| `project_id` | `project:<root>`; section 3 |
| `root` | repo-relative POSIX path, `.` for the repository |
| `project_role` | role of the root path relative to the repository (section 4); `.` is always `active` |
| `kind` | `application` when an adapter was selected; else `ambiguous` when first-class adapters tie for the highest specificity; else `aggregate` when the project has child project roots; else `unrecognized` |
| `markers` | `[{path, kind, digest}]` files that put the directory on the graph; `digest` is `sha256:` plus 64 hex |
| `facets` | `{http: {...}}`; section 4 |
| `fallback_adapter` | id of the generic fallback adapter, or `null`. Set only when the project has no first-class candidate. A non-null value is a non-empty string, as for a candidate's `adapter_id`; section 2.5 says what happens to an empty, a numeric and a missing id [probe: options `empty_fallback_adapter_id`, `numeric_fallback_adapter_id`, `missing_fallback_adapter_id`] |
| `selected_adapter_read_set` | `{adapter_id, files[{path, digest, role}], fingerprint}` or `null`; section 5 |
| `child_project_roots` | the nearest descendant project roots only: a descendant with another project between it and this root is left out, and a directory with no marker between two projects does not count. [probe: options `nested_projects`] |
| `nested_detections` | `[{adapter_id, detected_root}]`, sorted by `adapter_id`, then `detected_root`; section 5 [probe: options `adapter_order`] |
| `local_package` | `{name, private, dependency_names, workspace_patterns, evidence{path, digest}}` read from the first `node-package` marker by path (section 2.5), or `null` |

Edges: `contains` runs from the nearest enclosing project to its child with `evidence: []`. The nearest
enclosing project is the one with the longest root text, which is wrong for a child of a one-character
top-level project (section 8, limit 18). [probe: options `nested_projects`, `short_root_names`]
`local-package-dependency` runs from the declaring project to the single project whose package `name`
matches a name in the declarer's dependency lists, with `dependency_name` and
`evidence: [the declaring project's local_package.evidence]`. [probe: normal] Dependency names are the
union of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`; the `normal` probe
uses only `dependencies`. A self-match is skipped: a project that lists its own name keeps it in
`dependency_names` and gets no edge, unless another project declares that name too: then the dependency is
ambiguous like any other and the project itself is one of the candidates. [probe: options `package_metadata`,
`package_owners`]

The edges are built from the package name alone. A name that no project declares (an external package)
makes no edge and no entry. A name that two or more projects declare is an `ambiguous-local-package-name`
entry, listed in package-name order with the `project_ids` sorted by root, and every dependency on it is an
`ambiguous-local-package-dependency` entry (`candidate_project_ids` sorted by root) and no edge. A project
that lists a local name in two dependency fields gets one edge. A project may depend on the repository root
project when that declares a name. [probe: options `package_owners`]

### 2.3 Plan item

`buildProjectScanPlan` returns `{project_id, project_root, adapter_id, mode}` items sorted by
`project_root`, then `adapter_id`. `mode` is `first-class` or `fallback`. It only labels how the item came into
the plan: the shadow run copies it into `scans[]` and never acts on it (section 2.4).

1. A project whose `project_role` is not `active` is skipped unless `includeNonActive` is set. It stays
   visible in the graph.
2. A project with a selected adapter yields one `first-class` item.
3. Otherwise, with `includeFallback`, a project that has a `fallback_adapter` and is not `aggregate`
   yields one `fallback` item.
4. An `ambiguous` project yields nothing in either mode. [probe: negative `specificity_tie`]
5. A plan is a hint (which adapter to run on which root), not a result. It does not say the scan will
   succeed or that the sources are fresh.

`includeFallback` and `includeNonActive` are plain truthiness tests: `'yes'` and `1` count as set, `0` and
`''` do not. They combine, so a non-active project gets a fallback item only when both are set, and an
`aggregate` project gets none either way. [probe: options `plan_options`] Passing `null` instead of the
options object fails with a Node `TypeError` (text not stable), and a first argument that is not a draft-1
graph fails with `TypeError: expected sbf.project-graph/draft-1`. [probe: options `plan_options_null`,
`plan_not_a_graph`]

The plan reads six fields of each project: `project_id`, `root`, `project_role`, `kind`, `fallback_adapter` and
`facets.http.selected_adapter`. It does not depend on the order of `projects`. A project without `facets` has no
selected adapter, and a project without `project_role` is not `active`. The only checks on the graph are that it is
truthy, that its `schema` is `sbf.project-graph/draft-1` and that `projects` is an array: a graph with no `projects`,
or with `projects` that is not an array, fails with the same `TypeError`, and the entries are not checked (`{}` is a
project that is skipped, `null` is a Node `TypeError`). Items are not de-duplicated, so two projects with the same
`root` give two items, ordered by `adapter_id`. Rule 4 holds for the graphs the builder produces, where an `ambiguous`
project has no `fallback_adapter`, and not for every graph the plan accepts: a hand-built `ambiguous` project that
carries a `fallback_adapter` gets a `fallback` item.

The plan tests `facets.http.selected_adapter` and `fallback_adapter` for truthiness, so a value of `''` counts as
none: an `application` whose `selected_adapter` is `''` yields no item, and a project whose `fallback_adapter` is `''`
yields no `fallback` item, in both cases without any sign in the plan. The builder never combines a `selected_adapter`
of `''` with `unique-highest-specificity`: it copies an empty id, but then takes the project for one with no first-class
adapter (section 2.5) [probe: options `empty_adapter_id`]. A graph that was edited or built by hand can hold the
combination, and the schema rejects it (section 2.6). [source] `buildProjectCachePlan` in
`lib/scan-scheduler-next/project-cache-plan.mjs` (T21) tests the same two fields the same way at the time of writing;
this test does not read that file.

### 2.4 Shadow output

`executeProjectScanPlan` returns `{schema, graph_schema, terms, scans[], notes}` where each
`scans[]` item is `{project_id, project_root, adapter_id, mode, report}` and `report` is the unchanged
legacy `sbf.scan-report/2` produced by `runScan` for that project root with only the planned adapter,
`includeDb: false`, `dbSchema: null` and `runtimeRoutes: false`. `mode` is copied from the plan item and
changes nothing in the scan: the report is an inventory (`verdict` `inventory`) when `terms` is empty and a
scored report otherwise, for a `first-class` item and for a `fallback` item alike (section 5.3). The nested scan
runs on the project's own directory: for each planned project the planned adapter's `detect` and `scan` are
called once with the absolute project root (the repository itself for `.`), no other adapter of `adapters` is
called, `introspectRoutes` is never called, and the report has an `unknowns` entry that starts with
`DB not scanned` and neither a `db_schema` nor a `runtime_introspection` key. `notes` holds three fixed prose
strings. [probe: shadow] [probe: options `shadow_options`]

Its options. A falsy `repoRoot` is `TypeError: repoRoot is required`, and a graph that is not draft-1 is
`TypeError: expected sbf.project-graph/draft-1`; `null` in place of the options object is a Node `TypeError`. A
truthy `repoRoot` that is not a string (`5`) is a Node `TypeError` too. A missing graph, `null`, and a graph with another
`schema` are the draft-1 error as well, even when they have no `projects` list.
`terms` (default `[]`) is returned as a copy and handed to every nested scan. It has to be an array: `null`, a
non-empty string, a `Set` (an empty one too) or a number makes the nested scan throw, and that comes back as
`PROJECT_PLAN_STALE` (section 5.3) although nothing is stale. `null` throws whatever the scan reports; the others
throw only when the scan has a text with an ASCII letter or digit to score, such as a module name. An empty string
has length 0: the scan runs it as an inventory and the returned `terms` is `[]`. With no planned project there is
no nested scan, and `terms` is only spread into the returned list: a string gives a list of its characters, a
`Set` a list of its members, and `null` or a number is a Node `TypeError`. The spread also follows every nested
scan that did not throw, so when the scan has nothing to score, a string or a `Set` returns a report and a number
fails with that `TypeError` instead of `PROJECT_PLAN_STALE`. `rgAvailable` (default `true`) is handed to it too
and comes back as the report's `rg_available` as given, not turned into a boolean; a falsy value (`false`, `0`,
`null`) adds the `ripgrep` entry to the report's `unknowns`. `adapters` (default the registry's `ADAPTERS`) is
looked up by `id`: two entries with one id throw a plain `Error` with no `code` before any project is verified,
whether or not the plan uses them. It need not be an array, any iterable of adapters works (a `Set`), and `null`
is a Node `TypeError`.
`includeFallback` (default off) adds the `fallback` items of section 2.3, so a project that only the
fallback recognizes is then scanned in `fallback` mode. Only an active project that has no selected adapter and
has a `fallback_adapter` gets one, and an `aggregate` project never does. A project without an item is not
scanned and not verified, and nothing in the result lists it (section 5.3). It takes no `includeNonActive`: that
key, like any other key that is not listed, is ignored, so non-active roots are never scanned in shadow mode.
[probe: options `shadow_options`]

The graph and `repoRoot` are matched as follows. The root a live graph captured and `repoRoot` are compared as
text after `path.resolve`: a trailing separator, a `..` segment or a relative path to the same directory matches,
and a symbolic link to it does not (`PROJECT_GRAPH_ROOT_MISMATCH`). A draft-1 graph whose `projects` is missing or
is not an array is a Node `TypeError`, raised after the duplicate-id check and before any project is verified, and
one with an empty `projects` array returns an empty `scans`. [probe: options `shadow_options`]

Before each planned project it re-hashes every marker and, when the graph carries a read set for that project,
re-captures the selected adapter's read set and compares the adapter id and the fingerprint. A changed, added or
removed file fails, and so do an adapter that no longer lists a read set, a read set recorded under another
adapter id and a listing that throws. A project with no read set (`selected_adapter_read_set` `null`) skips that
check and keeps the marker check, and a project entry with no `markers` key has nothing to re-hash. The builder
captures a read set only for a selected adapter, so in a graph it wrote a `fallback` item has none: its markers
are re-hashed and its source files are not checked. A project that is not in the plan is not verified at all, its
markers included. The projects are verified one after the other, each just before its own scan, so a project
that has gone stale late in the plan fails after the earlier projects have been scanned. Any failure throws and
**no partial `scans` list is returned** (all-or-nothing, fail closed). A graph that went through
`JSON.stringify` and `JSON.parse` executes on an equivalent checkout; the root-mismatch check only applies to a
live graph that still carries the execution-root symbol. [probe: shadow] [probe: options `shadow_options`]

### 2.5 Options and input the builder does not check

`buildProjectGraph` validates two things: `repoRoot` is truthy (else `TypeError: repoRoot is required`) and
`adapters` is an array (else `TypeError: adapters must be an array`). It checks nothing else about its
input. It reads three keys of the options object and ignores every other one, so a plan option such as
`includeFallback` does nothing there [probe: options `unknown_options`], and `null` in place of the options
object is a Node `TypeError` [probe: options `options_null`]. `discoverProjectRoots`, the walk the builder
starts with, reads `markerRules` the same way but checks no `repoRoot` (section 2.1). A value outside the
"Accepted" column either fails with a `TypeError` raised by Node itself, whose text is not stable, or is
copied into the graph unchecked, where the schema may then reject the graph. Each row names the cases of
`node test/project-graph/interface-rfc.probe.mjs options` (section 7.1) that reproduce it.

| Option or input | Accepted, and what the graph records | Not checked, or rejected | Evidence |
|---|---|---|---|
| `markerRules[].kind` | Any truthy value, copied unchanged to `markers[].kind`. The schema accepts any non-empty string, so a custom kind validates, including one that is only digits, only a space, or has non-ASCII letters. The nine default kinds (section 4) are the defaults and the `examples` of the schema, not a closed list | That the kind is a string, is unique, or differs from the defaults. A falsy `kind` (`''`, `0`, `null`, `undefined`, `false`) makes the file not a marker, and no later rule is tried for it. A truthy non-string (`42`, `{}`, `true`, `['x']`) is copied and the graph then fails the schema (`type`). Only `node-package` has a meaning to the builder: `local_package` is read from the first marker of that kind by path, whatever its file name, and parsed as JSON. A later `node-package` marker is ignored even when the first one is invalid | probe: options `custom_marker_kinds`, `non_string_marker_kinds` |
| `markerRules` | An array of `{kind, test}`. It replaces the nine defaults; nothing is merged. `[]` leaves the repository root as the only project. Omitted or `undefined` means the defaults. Each rule's `test(name)` gets one argument, the file's base name, once per regular file visited, unless an earlier rule has already matched that file (not for a symbolic link, not below a hard-ignored directory of section 5.2), and the first rule that returns a truthy value decides the kind | `null`, a non-array, a `null` rule and a rule without `test`: each is a Node `TypeError` as soon as the walk visits a regular file, and none fails in a repository that has no regular file. An error thrown by `test` passes through unchanged. Its return value is not checked: any truthy value counts, a Promise included, so an `async` test matches every regular file | probe: options `custom_marker_kinds`, `empty_marker_rules`, `async_marker_rule`, `marker_rules_null`, `marker_rules_not_an_array`, `marker_rule_null`, `marker_rule_without_test`, `marker_rule_throws` |
| `repoRoot` | A non-empty string. Only `path.resolve` is applied, so a relative path, a trailing separator and a symbolic link give the same graph. A path that does not exist, or that is a file, records one `directory-read` entry (path `.`) and a graph that holds only the root project `.` | That it is a string (`5` is a Node `TypeError`) or that it exists. An empty string, or no argument, is `repoRoot is required`. A relative path resolves against the process working directory | probe: options `repo_root_forms`, `missing_repo_root`, `file_as_repo_root`, `repo_root_not_a_string`, `empty_repo_root`, `no_arguments` |
| `adapters` | An array, possibly empty. With none, the markers still make projects, each is `aggregate` or `unrecognized`, and none has a fallback. A repository with no marker and no file gives the root project only | The elements. `null` is a Node `TypeError`. An element without a `detect` function records `adapter-detect-error` for every project root. `id` is not checked. For a first-class adapter, any non-empty string is a valid id, spaces and non-ASCII letters included, but an empty id is selected as `''` while `selection_reason` says `no-first-class-adapter` (its read set is never captured), a number is copied, two adapters with one id can tie, and an adapter with no `id` becomes a candidate without `adapter_id` that is never selected, although `selection_reason` says `no-first-class-adapter`. The schema rejects those four (`minLength`, `type`, `uniqueItems`, `required`). An empty id that ties with another adapter is copied as `''` into `ambiguous_adapter_ids` as well, and the schema rejects it there (`minLength`). Two adapters with one id and different specificities do not tie: both are candidates, the graph is valid, and the read set comes from the first of them in the array (section 4). A fallback adapter (section 4) adds only its id to the graph, as `fallback_adapter` of each project it recognizes, and is never a candidate. There the schema asks for a non-empty string, or `null` for none. An empty id is copied as `''`, which is falsy, so the plan never gives that project a `fallback` item, and a numeric id is copied as given; the schema rejects both (`minLength`, `type`). The schema rejects `NaN` and `Infinity` in memory, where they are numbers, but accepts the graph after `JSON.stringify`, which writes them as `null`. An adapter with no `id`, or a `null` one, leaves `null`, which is what no fallback looks like: the graph is valid and nothing in it shows the adapter. An adapter removed from the array while the build runs gives `selected-adapter-missing` | probe: options `no_adapters`, `empty_repository`, `empty_adapter_id`, `numeric_adapter_id`, `missing_adapter_id`, `duplicate_adapter_ids`, `empty_fallback_adapter_id`, `numeric_fallback_adapter_id`, `missing_fallback_adapter_id`, `adapter_values`, `adapter_removed_during_build`, `adapter_order`, `adapters_missing`, `adapters_not_an_array`, `adapters_with_null` |
| `detect(absRoot)` and `listReadSet(absProject)` calls | The builder calls both as methods of the adapter, so `this` is the adapter, and passes one argument, the absolute path of the project root: `path.resolve(repoRoot)` for `.`, and that path followed by the recorded root for any other project. A symbolic link in `repoRoot` is not resolved. `detect` is called once for each element of `adapters` for each discovered project root, in the order of `projects` and, within a root, in the asking order of section 4, whatever an earlier adapter returned. `listReadSet` is called once, for the adapter that was selected, right after the detections of that project root and before the next root is visited. It is not called for a candidate that lost, for a tie, or for a fallback | Anything beyond the path. No `repoRoot`, no options and no second argument are passed. That the adapter reads the argument, or that two calls agree | probe: options `adapter_calls` |
| adapter `title`, `specificity`, `confidence`, `verificationBasis`, `capabilities` | Recorded in the candidate as section 4 describes: an omitted or `null` field takes its default (`title` the adapter's `id`, `confidence` and `verification_basis` `unknown`, `capabilities` `{}`, `specificity` `0`) and an empty string is kept, `specificity` is kept when it is a finite number (negative and fractional included) and is `0` otherwise, `capabilities` is copied one level deep with an object spread, so an array or a string becomes an object keyed by index and a number becomes `{}`. Equal recorded specificities tie, so `NaN` and `Infinity` can tie at `0` | Types. A non-string `title`, `confidence` or `verificationBasis` is copied and the schema rejects the graph (`type`) | probe: options `adapter_defaults`, `adapter_values`, `fallback_adapters`, `non_string_adapter_fields` |
| `detect()` return value | `null`, `undefined` and `false` mean not detected, and nothing is recorded. Every other value is a detection, `true`, `0`, `''` and `NaN` included. A fallback adapter (section 4) that detects is recorded as the fallback whatever it returned. Any other adapter must return a shape that `inferDetectionProjectRoot` accepts (section 2.1): `projectRoot` wins over `srcRoot`, and an empty `projectRoot` falls through to `srcRoot`. A root equal to the candidate makes a candidate, a root below it is a `nested_detections` entry, any other root is `out-of-scope-detection` | Every other shape is `unlocated-detection`, for a first-class adapter only. A relative string is resolved against the process working directory, not the repository, so it usually reads as out of scope. The parent directory is out of scope too (`detected_root` `.`) | probe: options `detect_values` |
| `detect()` failures | A throw is recorded as `adapter-detect-error` with a portable message, and the adapter is not a candidate for that root. The thrown value may be a string. An async `detect` returns a Promise, an unrecognized shape: `unlocated-detection` | A `detect` that throws `null` or `undefined` fails with a Node `TypeError`, because the builder reads `.message` | probe: options `detect_failures`, `detect_throws_null`, `detect_throws_undefined` |
| `listReadSet(absProject)` | An array of non-empty strings. They resolve against the project root (an absolute path inside the project is accepted) and duplicates collapse by repo-relative path. A marker file may be listed too, and `files_read` then holds it once. An empty array gives an empty read set, not `null`. A path inside a hard-ignored directory such as `node_modules` is accepted. No function gives a `null` read set | One bad entry fails the whole read set: a result that is not an array, an entry that is empty or not a string, a directory, a missing file, a path that leaves the project, or a throw inside the listing. The graph records one `adapter-read-set-error` and a `null` read set | probe: options `read_set_shapes` |
| `package.json` content | Valid JSON. `name` is kept when it is a non-empty string, and `private` is `true` only for the JSON value `true`. `dependency_names` holds the keys of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`, whatever their values are (an empty key included), sorted by code unit and de-duplicated. A field counts only when it is a plain object: a string, a number, `null` or an array adds nothing, and no other field is read (`bundledDependencies`, `peerDependenciesMeta`, `overrides`). `workspace_patterns` holds the string entries of a `workspaces` array, or of `workspaces.packages` when `workspaces` is not an array and `packages` is one, sorted by code unit and not de-duplicated. An empty string among them is kept and the schema accepts it (section 2.6). JSON of another shape (`null`, `[]`, a number) gives a readable `local_package` with those defaults | An empty file, a file that starts with a byte-order mark, and invalid JSON record `package-metadata-read` and leave `local_package` `null`. The name format is not checked | probe: options `package_metadata` |
| directory and file names | Names that are legal on POSIX: spaces, `c:`, `a:b`, a backslash, a newline, a tab, a quote, non-ASCII letters, a leading dash or dot. Graph paths are relative strings in which a backslash is an ordinary character, and the schema accepts any relative path without a `..` segment. Names that every object has as properties, `__proto__`, `constructor`, `toString` and `hasOwnProperty`, are ordinary too, as a directory, a package name, a dependency name or an adapter `id`: the builder keeps its tables in `Map` and `Set` objects | A first path segment that starts with two dots (`..dots`, `..lib`) is read as an escape by five checks in the builder (section 8, limit 16) | probe: options `odd_names`, `dotdot_names`, `prototype_names` |
| files that change during the build | A marker file that cannot be read after its rule matched is recorded as `marker-read` and is not a marker, so its directory may be missing from the graph. The package facts are read after every adapter has run: a `package.json` that has been removed by then records `package-metadata-read` with a portable message, and one that has been rewritten gives the facts of the new content under the digest taken when the file was found | The `marker-read` message is the raw system text and holds the absolute path (section 8, limit 4). Every other message is portable | probe: options `vanished_marker`, `package_metadata` |

Two failure messages of `buildProjectGraph` belong to the builder and are stable: `repoRoot is required` and
`adapters must be an array` (`buildProjectScanPlan` adds a third, section 2.3). An error thrown by a function
the caller supplied passes through unchanged. Every other failure in the table is a `TypeError` produced by
Node, whose text is not stable and which the probe therefore records as a class only.

### 2.6 Strings that must not be empty

An id, a name or a path that is the empty string names nothing, and the plan reads two of the ids by truthiness
(section 2.3). The schema therefore asks for at least one character (`minLength`, or a `pattern` that `''` does not
match) wherever the graph holds an id, a name, a path or a fixed word, and lets the empty string through only where
the builder copies free text. `null` stays valid wherever it was valid. A string of spaces is not empty: nothing
here trims. The table lists every position at which the schema takes a string, by data path (`[]` is an array
element). The test reads the positions from the schema file, so a position that is added, dropped or changed fails it
until this table says the same, and it puts `''` in place of each string of the real graphs, one at a time, to check
the verdict. The last column says whether the builder can write the empty string there. The schema is stricter than
the builder on purpose, because a graph can also come from a file, another tool or an edit.

| Value | Data paths | The empty string | Can the builder write it |
|---|---|---|---|
| id of the selected adapter | `projects[].facets.http.selected_adapter` | rejected: `minLength` on the property and again in the branch for `unique-highest-specificity`; `null` stays valid where it was | Only from an adapter whose `id` is `''`, and the project then reads `no-first-class-adapter`, which the schema already rejected. Next to `unique-highest-specificity` only an edited or hand-built graph has it [probe: options `empty_adapter_id`] |
| ids of tied adapters | `projects[].facets.http.ambiguous_adapter_ids[]` | rejected (`minLength`) | Yes, from an adapter whose `id` is `''` that ties with another one [probe: options `empty_adapter_id`] |
| ids copied from an adapter | `projects[].facets.http.candidates[].adapter_id`, `projects[].fallback_adapter`, `projects[].nested_detections[].adapter_id`, `unresolved[].adapter_id` | rejected (`minLength`) | Yes, from an adapter whose `id` is `''`: as a candidate, as a fallback, as a nested detection, and in the entries `adapter-detect-error`, `unlocated-detection` and `out-of-scope-detection` [probe: options `empty_adapter_id`, `empty_fallback_adapter_id`] |
| id in a read set | `projects[].selected_adapter_read_set.adapter_id` | rejected (`minLength`) | No: a read set is captured only when the selected id is truthy (section 2.5) |
| marker kind | `projects[].markers[].kind` | rejected (`minLength`) | No: a falsy `kind` makes the file not a marker (section 2.5) |
| package name | `projects[].local_package.name`, `project_edges[].dependency_name`, `unresolved[].package_name` | rejected (`minLength`); `local_package.name` may be `null` | No: an empty `name` is read as `null`, so no edge and no entry carries it [probe: options `package_metadata`] |
| registry file | `registry_load_errors[].file` | rejected (`minLength`) | Not through `buildRegisteredProjectGraph`: the registry loads files whose names end in `.mjs`, so the base name is never empty. `portableRegistryLoadErrors` called by hand with a path that ends in a separator returns `''` (section 2.1) |
| project ids and roots | `projects[].project_id`, `projects[].root`, `projects[].child_project_roots[]`, `project_edges[].from_project_id`, `project_edges[].to_project_id`, `unresolved[].project_id`, `unresolved[].project_ids[]`, `unresolved[].candidate_project_ids[]`, `unresolved[].project_root` | rejected (`pattern`) | No: the repository itself is `.` and every other root is a relative path |
| detected roots | `projects[].nested_detections[].detected_root`, `unresolved[].detected_root` | rejected: `pattern` for a nested detection, `minLength` for `out-of-scope-detection` | No: a detection at the repository root is written as `.`, and a nested one lies below its project [probe: options `detect_values`] |
| repo-relative file paths | `files_read[]`, `projects[].markers[].path`, `projects[].local_package.evidence.path`, `project_edges[].evidence[].path`, `projects[].selected_adapter_read_set.files[].path`, `unresolved[].path` | rejected (`pattern`) | No: a path is written relative to the repository, and the repository itself is `.` |
| digests | `projects[].markers[].digest`, `projects[].local_package.evidence.digest`, `project_edges[].evidence[].digest`, `projects[].selected_adapter_read_set.files[].digest`, `projects[].selected_adapter_read_set.fingerprint` | rejected (`pattern`) | No: `sha256:` and 64 hex characters |
| fixed words | `schema`, `repo_root`, `projects[].kind`, `projects[].project_role`, `projects[].selected_adapter_read_set.files[].role`, `projects[].facets.http.selection_reason`, `project_edges[].kind`, `unresolved[].kind` | rejected (`const` or `enum`) | No: the builder takes them from its own lists (sections 4 and 5.1) |
| adapter text | `projects[].facets.http.candidates[].title`, `projects[].facets.http.candidates[].confidence`, `projects[].facets.http.candidates[].verification_basis` | accepted | Yes: an empty string is kept as given (section 2.5) [probe: options `adapter_values`] |
| package text | `projects[].local_package.dependency_names[]`, `projects[].local_package.workspace_patterns[]` | accepted | Yes: an empty key of a dependency object and an empty entry of `workspaces` are kept [probe: options `package_metadata`] |
| messages | `unresolved[].message`, `registry_load_errors[].message` | accepted | Yes: an error without text gives `''` |
| notes | `notes[]` | accepted | No: five fixed strings, which the schema does not pin (section 2.2) |

`projects[].facets.http.candidates[].capabilities` is an object with no declared properties: its keys and the strings
inside it belong to the adapter, the schema does not look at them, and the table leaves them out. Every rule of this
section looks at one value at a time. That the ids of one project agree with each other is not checked (limit 19).

## 3. Identity

- `project_id` is `"project:" + root`. It is a repo-local planning key, valid inside one graph of one
  repository state. It is not an ArtifactRef, ActionRef, ContractRef or FieldRef substitute, and
  `beval.binding-json/1` stays authoritative. It must not be frozen as cross-tool identity before T01 and
  T00 approve that seam (`LEGACY_A_RECONCILIATION.md`).
- Identity comes only from the repo-relative root path. Moving or renaming a project directory changes
  its id. No content identity is claimed. Digests are freshness evidence, never identity.
- [convention] Treat `project_id` as an opaque string. Do not split it, and do not compare ids from two
  different repositories.
- Roots and ids compare as exact strings (code units, no locale, no case folding, POSIX separators).
- `adapter_id` is the registry adapter's `id`, which equals its file name. Ids must be unique in the
  adapter list given to `executeProjectScanPlan` (a duplicate is a plain `Error`, no `code`).
  [probe: options `shadow_options`]
- A digest is `sha256:` plus 64 lowercase hex characters over the raw file bytes. A read-set
  `fingerprint` is the same form over `path`, `digest` and `role` of every file, each followed by a NUL
  byte, files sorted by path. Both detect change; neither names anything.
- `local_package.name` is the npm package name. It creates a `local-package-dependency` edge only when
  exactly one project declares that name. Two projects with the same name produce
  `ambiguous-local-package-name` and no edge, so a package name is never treated as an identity.
  [probe: negative `duplicate_local_package`]

## 4. Facet vocabulary

A facet is a per-project, per-service-kind block under `facets`. The draft defines exactly one.

| Facet | Fields |
|---|---|
| `http` | `candidates[]`, `selected_adapter`, `selection_reason`, `ambiguous_adapter_ids[]` |

A candidate is `{adapter_id, title, specificity, confidence, verification_basis, capabilities}`, copied
from the adapter's `id`, `title`, `specificity`, `confidence`, `verificationBasis` and `capabilities`. An
omitted (`undefined` or `null`) `title` is recorded as the id, an omitted `confidence` or `verificationBasis`
as the string `unknown`, and omitted `capabilities` as `{}`; `capabilities` is copied one level deep.
`specificity` is recorded as given when it is a finite number, negative and fractional values included, and
as `0` otherwise, so `NaN`, `Infinity`, a numeric string and an omitted value all record `0`. A value of
another type in a text field is copied without a check (section 2.5).
[probe: options `adapter_defaults`, `adapter_values`]

A first-class candidate is an adapter that is not a fallback and whose `detect()` returned a root equal
to the project root. Fallback means id `generic-grep` or a raw `specificity` that is exactly the number
`0`. An adapter whose specificity is omitted, `NaN`, `Infinity`, `'0'`, `''` or `false` is therefore first-class although it
records `0`, and candidates with equal recorded specificity tie. A fallback adapter is recorded as the
project's `fallback_adapter` when its `detect()` returns anything other than `null`, `undefined` or `false`,
whatever the shape or root, and only for a project that has no candidate (a tie counts as having candidates);
when several do, the one asked last is recorded (the asking order is below).
Of that adapter only the id reaches the graph, and the schema asks a non-empty string of it, as of a candidate's
`adapter_id`, or `null` when there is none (section 2.5).
[probe: options `fallback_adapters`, `detect_values`, `empty_fallback_adapter_id`, `numeric_fallback_adapter_id`,
`missing_fallback_adapter_id`] Other adapters that threw, returned an
unrecognized shape, or returned another root are not candidates; they appear in `unresolved` or
`nested_detections` (section 5).

| `selection_reason` | Condition | `selected_adapter` | `ambiguous_adapter_ids` |
|---|---|---|---|
| `unique-highest-specificity` | exactly one candidate has the highest specificity | that id | empty |
| `specificity-tie` | two or more candidates share the highest specificity | `null` | the tied ids |
| `no-first-class-adapter` | no candidates | `null` | empty |

`candidates` lists every first-class candidate, sorted by descending recorded specificity then id, not only
the tied ones, and `ambiguous_adapter_ids` follows that order. The builder asks the adapters in another
order: by the `specificity` the adapter has, as given, descending, then by `id`. There an omitted value
counts as `0`, a numeric string as its number, and `Infinity` comes first, so an adapter that is listed
among the `0`s can be asked before all the others. The caller's `adapters` array is sorted as a copy and
is never reordered. [source] A `NaN` makes the asking order unreliable, because a comparison with it is
never true. The asking order decides the order of the
adapter diagnostics of one project root in `unresolved` (section 5.1) and which of several fallbacks is
recorded; it does not change the candidates, `nested_detections` or the selection. When two adapters share
an `id`, the read set is captured from the first element of the array that has that `id`, which need not
be the adapter that detected. [probe: options `adapter_order`]

Adding a facet means a new key under `facets`. The draft schema is closed over `facets`, so a
new facet requires a new schema revision. [convention] A consumer must ignore facet keys it does not know
and must read a missing facet as **unknown, never none**: today a graph says nothing about queues, jobs,
databases or sockets, and the `http` facet only says what the registered HTTP adapters could recognize.

| Vocabulary | Values |
|---|---|
| `kind` | `application`, `ambiguous`, `aggregate`, `unrecognized` |
| `project_role` and read-set `role` | `active`, `reference`, `generated`, `vendor`, `template` |
| marker `kind`, default rules | `node-package`, `python-project`, `jvm-build`, `jvm-workspace`, `ruby-bundle`, plus forward-compatible `go-module`, `rust-package`, `php-package`, `dotnet-project`. A caller's `markerRules` may emit any other non-empty string (section 2.5), so a consumer must not treat this list as closed |
| edge `kind` | `contains`, `local-package-dependency` |

The four forward-compatible marker kinds only put a directory on the graph. They do not imply that an
adapter exists for that ecosystem. The default rules match the base name of a regular file: `package.json`
(`node-package`); `pyproject.toml` and any `requirements.txt`, `requirements-*.txt` or `requirements.*.txt`
(`python-project`); `pom.xml`, `build.gradle`, `build.gradle.kts` (`jvm-build`); `settings.gradle`,
`settings.gradle.kts` (`jvm-workspace`); `Gemfile` (`ruby-bundle`); `go.mod` (`go-module`); `Cargo.toml`
(`rust-package`); `composer.json` (`php-package`); a name that ends in `.csproj`, `.fsproj` or `.vbproj`
(`dotnet-project`). Every name is matched exactly, except the `requirements` pattern and the three `.*proj`
suffixes, which ignore letter case. The probe feeds 31 base names to the nine rules, one file each.
Match: `package.json` (`node-package`), `pyproject.toml` (`python-project`), `requirements.txt` (`python-project`),
`requirements-dev.txt` (`python-project`), `requirements.dev.txt` (`python-project`), `REQUIREMENTS.TXT`
(`python-project`), `pom.xml` (`jvm-build`), `build.gradle` (`jvm-build`), `build.gradle.kts` (`jvm-build`),
`settings.gradle` (`jvm-workspace`), `settings.gradle.kts` (`jvm-workspace`), `Gemfile` (`ruby-bundle`), `go.mod`
(`go-module`), `Cargo.toml` (`rust-package`), `composer.json` (`php-package`), `App.csproj` (`dotnet-project`),
`app.fsproj` (`dotnet-project`), `APP.VBPROJ` (`dotnet-project`), `.csproj` (`dotnet-project`). No match: `POM.XML`, `Package.json`,
`Pyproject.toml`, `gemfile`, `cargo.toml`, `requirements_dev.txt`, `prerequirements.txt`, `requirements.txt.bak`,
`README.md`, `app.sln`, `App.csproj.user`, `Appcsproj`. [probe: options `default_markers`] Role precedence is vendor, then reference, then generated, then
template, then active, matched on whole path segments (case-insensitive), never on substrings; a
`.tmpl`, `.template`, `.mustache` or `.hbs` file name also means template. [probe: normal `source_roles`]
Examples from that probe: `vendor/examples/x.js` is vendor, `generated/tests/x.js` is reference,
`dist/bundle.js` is generated, `src/app.js` is active. The whole-segment names, each list in code-unit order:
vendor `third-party`, `third_party`, `vendor`, `vendors`; reference `__tests__`, `example`, `examples`, `fixture`,
`fixtures`, `fixtures-reference`, `reference`, `references`, `sample`, `samples`, `test`, `tests`, `upstream`;
generated `.next`, `.svelte-kit`, `build`, `dist`, `generated`, `out`; template `scaffold`, `scaffolds`, `template`,
`templates`. Any other segment gives `active`, and the file name counts as a segment, so `src/tests` is reference.
The names come from the repository, so they are input. A backslash counts as a separator, so a project below a directory literally named `x\vendor` is judged `vendor`.
Only the last segment is tested for the template extensions: `docs/Page.TMPL` is template, `docs/page.tmpl.bak`
is active. The extension needs its dot and ignores letter case: `.mustache` and `page.HBS` are template, `pagehbs` is
active. `Vendor/lib` is vendor and `my-vendor/lib` is active. [probe: options `role_names`]

## 5. Unknown and partial semantics

Rule: the graph never turns an unanswered question into an answer. When it cannot decide it leaves a
field `null` or empty and says why in `unresolved`, or it refuses to choose. A consumer must not read a
missing, `null` or unresolved value as "supported", and must not read it as "none".

### 5.1 `unresolved` entries

Every entry has a `kind` and a human `message`. Consumers key on `kind` and the structured fields.
`unresolved` is not sorted: entries come in the order the builder found them. First the discovery
diagnostics (`directory-read` and `marker-read`, in walk order); then, for each project root in `root` order,
the adapter diagnostics (adapters in the asking order of section 4: their own `specificity` descending,
then id) followed by that root's read-set diagnostic; then `package-metadata-read` per project; then the
edge diagnostics. Do not rely on the position of an entry.
[probe: options `detect_failures`, `unresolved_order`, `adapter_order`]

The walk is depth first. In one directory it visits the files in descending name order, then the subdirectories
in ascending name order, each with everything below it before the next. Names compare by code unit, so `B` comes
before `a` and a surrogate pair (U+1F600) before U+FF61. `directory-read` and `marker-read` entries therefore come
in that order, which is not the sorted order of their paths: `a/b` is listed before `a-x`. The `test` calls of the
marker rules come in the same order. [probe: options `walk_order`]

| `kind` | Other fields | Meaning | Tag |
|---|---|---|---|
| `directory-read` | `path` | a directory could not be listed during discovery (for example a missing or non-directory `repoRoot`, path `.`); its subtree is unobserved | probe: options `missing_repo_root`, `file_as_repo_root` |
| `marker-read` | `path` | a file that a marker rule matched could not be read; it is not a marker, so a project may be missing. Its `message` is the raw system text and holds the absolute path (section 8, limit 4) | probe: options `vanished_marker` |
| `package-metadata-read` | `project_id`, `path` | the project's first `node-package` marker is unreadable, empty or not valid JSON (a leading byte-order mark makes it invalid); `local_package` is `null` for that project | probe: negative `malformed_metadata`; probe: options `package_metadata`, `custom_marker_kinds` |
| `ambiguous-local-package-name` | `package_name`, `project_ids` (2 or more) | several projects declare one package name | probe: negative `duplicate_local_package` |
| `ambiguous-local-package-dependency` | `project_id`, `package_name`, `candidate_project_ids` (2 or more) | a dependency matches several local projects; no edge was created | probe: negative `duplicate_local_package` |
| `adapter-detect-error` | `project_root`, `adapter_id` | the adapter's `detect()` threw, or is not a function, for that candidate root; it is not a candidate there | probe: negative `detect_error`; probe: options `detect_failures` |
| `unlocated-detection` | `project_root`, `adapter_id` | a first-class adapter's `detect()` returned something other than `null`, `undefined` or `false` that names no root (`true`, `0`, `''`, `NaN`, `{}`, an array, a Promise); T02 does not guess ownership | probe: negative `unlocated_detection`; probe: options `detect_values`, `detect_failures` |
| `out-of-scope-detection` | `project_root`, `adapter_id`, `detected_root` | the detected root is neither the candidate nor inside it (another directory, the parent, or a relative path resolved against the working directory) | probe: negative `out_of_scope_detection`; probe: options `detect_values` |
| `selected-adapter-missing` | `project_root`, `adapter_id` | the selected id was no longer in the caller's `adapters` array at read-set capture, which happens only when `detect()` removes an adapter from that array during the build; the project stays `application` with no read set | probe: options `adapter_removed_during_build` |
| `adapter-read-set-error` | `project_root`, `adapter_id` | `listReadSet` or hashing failed (a throw, a result that is not an array, an empty or non-string entry, a directory, a missing file, `PROJECT_READ_SET_ESCAPE`): one bad entry fails the whole read set; the project keeps its adapter but has no read set | probe: negative `read_set_escape`; probe: options `read_set_shapes` |

### 5.2 States that look like absence

| State | Meaning | Do not conclude |
|---|---|---|
| `kind: ambiguous`, `selection_reason: specificity-tie` | two or more first-class adapters tie; nothing is selected, and in a graph the builder wrote nothing is planned, even with `includeFallback` (section 2.3) | that any tied adapter owns the project |
| `selection_reason: no-first-class-adapter` | no first-class adapter recognized the root. `fallback_adapter` may name a fallback adapter, which only a plan made with `includeFallback` uses (section 2.3) | that the project has no HTTP surface, that the fallback supports it, or that a scan of it is an inventory: that depends on `terms` (section 5.3) |
| `kind: aggregate` | has child project roots and no selected adapter. It may carry a `fallback_adapter`, but never gets a fallback plan item | that the children are scanned by the parent |
| `nested_detections` | an adapter that recurses found a project below this root, so the parent is not selected. One entry per adapter, the first match in that adapter's own traversal | that this is the list of children. Use `child_project_roots` and each child's own facet. [probe: normal, repo root] |
| `selected_adapter_read_set: null` with a selected adapter | source freshness is **unattested**: the adapter has no `listReadSet`, or capture failed. Shadow mode still re-hashes markers and skips the source check [probe: shadow `unattested_graph`] | that the sources are fresh. [probe: normal `backend-java`, negative `read_set_escape`] |
| `local_package: null` | no readable Node package facts: no `node-package` marker, or a `package-metadata-read` entry exists. `local_package.name: null` means readable but unnamed | that the project has no packages in other ecosystems |
| `confidence` or `verification_basis` equal `unknown` | the adapter declared nothing | a hidden default of "high" |
| `unique-highest-specificity` plus an `adapter-detect-error` with the same `project_root` | partial selection: the winner is the highest among adapters that answered, and `kind` is not downgraded. [probe: negative `detect_error`, `broken-http` threw at specificity 99 and `javascript-express` still won `service`] | that the winner would survive if every adapter had answered. [convention] check `unresolved` for the same `project_root` first |
| a project below a hard-ignored directory or reached through a symlink | discovery never enters `.git`, `.hg`, `.svn`, `.bskel`, `node_modules`, `coverage`, `.cache`, `.turbo`, `dist`, `build`, `out`, `.next`, `.svelte-kit`, `vendor`, `third_party`, `third-party`, at any depth, and never follows symlinks. The names match exactly, in lower case: `Vendor` and `Dist` are walked, and their projects get the roles `vendor` and `generated`. A name that only resembles one of them (`Node_Modules`, `vendors`, `third_party_x`, `.github`) is walked as well, and so is a repository whose own name is on the list: the check is made on the entries below the root. [probe: options `ignored_directories`, `role_names`] | that the project does not exist. It is unobserved |

### 5.3 Shadow failure codes

`executeProjectScanPlan` fails closed with an `Error` that has a `code`. Probe keys are in
`shadow.failures` of the `shadow` probe output. For each key the probe records which of `stale_kind`,
`project_id`, `marker_path`, `adapter_id`, `cause`, the digest comparison and the lists of added and removed
read-set files the error carries, and the test compares them with the column "Extra fields": a field that the
column does not list is absent, and `stale_kind` is `adapter-read-set` exactly in the rows that say so.

| `code` | Raised when | Extra fields | Probe key |
|---|---|---|---|
| `PROJECT_GRAPH_ROOT_MISMATCH` | a live graph's captured root differs from `repoRoot` | none | `root_mismatch` |
| `PROJECT_ROOT_ESCAPE` | a project `root` resolves outside the repository | none | `project_root_escape` |
| `PROJECT_MARKER_ESCAPE` | a marker `path` resolves outside the repository | none | `marker_escape` |
| `PROJECT_GRAPH_STALE` | a marker changed since discovery | `project_id`, `marker_path`, `expected_digest`, `actual_digest` | `marker_drift` |
| `PROJECT_GRAPH_STALE` | a marker is missing or unreadable | `project_id`, `marker_path`, and no digests | `marker_missing`, `marker_unreadable` |
| `PROJECT_GRAPH_STALE` with `stale_kind: adapter-read-set` | the selected adapter's read set differs from the recorded one: a changed, added or removed file, an adapter that no longer lists a read set (`actual_fingerprint` is then `null` and `actual_files` empty), or a read set recorded under another adapter id | `project_id`, `adapter_id`, `expected_fingerprint`, `actual_fingerprint`, `expected_files`, `actual_files` | `source_drift`, `source_file_added`, `source_file_removed`, `read_set_not_recaptured`, `read_set_adapter_changed` |
| `PROJECT_GRAPH_STALE` with `stale_kind: adapter-read-set` | the read set could not be recaptured: the listing threw, or a path leaves the project (`PROJECT_READ_SET_ESCAPE`) | `project_id`, `adapter_id`, `cause` (the original error), and no fingerprints | `read_set_capture_error`, `read_set_capture_escape` |
| `PROJECT_ADAPTER_UNAVAILABLE` | the planned adapter id is not in `adapters` | none | `adapter_unavailable` |
| `PROJECT_PLAN_STALE` | legacy `runScan` threw for the planned adapter, for example `detect()` no longer matches, or `terms` is `null` or a non-array that the scan has to score (section 2.4) | `project_id`, `adapter_id`, `cause` (the original error) | `plan_stale` |
| `PROJECT_PLAN_INVALID` | a planned project id is missing from the graph | none | none: no probe reaches it, the plan is derived from the same graph inside the call [source] |
| `PROJECT_PLAN_DRIFT` | the report names a different adapter than planned | none | none: no probe reaches it, `runScan` receives only the planned adapter [source] |

`PROJECT_READ_SET_ESCAPE` is raised by `captureAdapterReadSetSnapshot` for a read-set path that leaves the
project or repository. At graph build time it surfaces only as an `adapter-read-set-error` entry (the
code is not copied into the entry); at shadow time it is wrapped in a `PROJECT_GRAPH_STALE` error.

A project that has no selected adapter is scanned only as a `fallback` item. That takes `includeFallback` and a
project that is active, has a `fallback_adapter` and is not an `aggregate` (section 2.3); in a graph the builder
wrote, that is an `unrecognized` project. Every other project without a selected adapter is not scanned and not
verified, and nothing in the result lists it: a project that is missing from `scans` was not scanned, which is
not the same as a scan that found nothing.

`mode: fallback` says only how the item came into the plan. The nested scan is the same `runScan` call as for a
`first-class` item and its report is that call's unchanged output, so whether the report is an inventory depends
on `terms` and on nothing else. With an empty `terms` it is one: `verdict` is `inventory`, `collisions` is empty,
the modules carry no `score` or `evidence`, and the first `unknowns` entry says that nothing was scored. With a
non-empty `terms` every module is scored, `related_modules` lists the modules with a positive `score`, and
`verdict` is `greenfield`, `adjacent` or `collision`, as for a `first-class` item. Do not read `mode: fallback` as
"inventory only".

T02 passes adapter `confidence` and `verification_basis` through as declared and never upgrades them: for a
first-class candidate the graph records both (section 4); for a fallback adapter the graph records only its id,
and the report carries the adapter's `confidence` as declared and has no `verification_basis`.

## 6. File ownership

T02 edits only `scanners/project-graph/**` and `test/project-graph/**`. Path ownership for the rest
follows `LEGACY_A_RECONCILIATION.md` and the suite table (`SUITES`) in `scripts/run-next-nested-tests.mjs`
as they stand at the time of writing; other tracks' rows may lag a rename.

| Path | Owner | T02 relationship |
|---|---|---|
| `scanners/project-graph/**`, `test/project-graph/**` | T02 | edits |
| `scanners/registry.mjs`, `scanners/index.mjs` (`runScan`), `scanners/adapters/**` | the legacy adapter registry; HTTP adapter tracks T11, T12, T13 | calls through `sbf.adapter/2`, never edits; `runScan` stays unchanged |
| `scanners/language/js-ts/**`, `scanners/language/python/**` | T04, T06 | none; their adapters reach T02 only through the registry |
| `lib/scan-scheduler-next/**`, `lib/artifact-store-next/**` | T21 | T21 consumes the draft graph as plain data; cache and invalidation policy stay T21's |
| `handles/composition-next/**` | T14 | none |
| `adapters/protocol-next/**`, `adapters/game-next/**` | T18, T17 | none; protocol, message and game semantics stay theirs |
| `contracts/next/**`, `schemas/next/**` | T01 | none; T01 owns any eventual cross-tool identity |
| `schemas/*` (root, stable namespace) | T00 and T01 approvals | T02 adds nothing |
| `package.json`, `scripts/**`, `.github/workflows/**` | T00 and T23 shared files | no change; wiring the graph into the CLI or packaging needs an explicit lease |

Router-internal mount graphs stay adapter-owned; the project graph does not reimplement Express or
FastAPI route composition.

## 7. Evidence

Everything below was produced on macOS with Node v24.19.0 from a clean checkout after `npm ci`. The pinned
probes print the same bytes on Node 18.20.8 and 22.23.3 on that machine, and the test checks the pinned
hashes again wherever it runs. The machine-readable copy is `test/project-graph/interface-rfc.record.json`; the test reads that file, so the
two cannot drift apart silently.

### 7.1 Commands and exit codes

Run from the repository root. Each probe prints canonical (sorted-key) JSON, builds its fixtures in a
temporary directory it removes before exiting, and fails if its output contains that directory's path.

| Command | Exit | Stdout sha256 |
|---|---|---|
| `node test/project-graph/interface-rfc.probe.mjs normal` | 0 | `2058d22a2f992b833c8468ed6fb21345a27f31ef4332cfd5b072f61f885800e7` |
| `node test/project-graph/interface-rfc.probe.mjs negative` | 0 | `caa0e55e9abf5e2d78961aedda7b7bbea32304d8441a33657e79d5d64f32e36f` |
| `node test/project-graph/interface-rfc.probe.mjs shadow` | 0 | `04e3d207a4f33a87ab2fd4dd2e41a171c54aa75458b7080ca1ccf39255745c9c` |
| `node test/project-graph/interface-rfc.probe.mjs options` | 0 | `911bc3ef180ccc377466355a0fb93962b1053c3467be0c0f2cfd6d893ccbfd43` |
| `node test/project-graph/interface-rfc.probe.mjs registered` | 0 | `1c6ddc7a6ca6dce69377362c8e954d4dc1f0c6afdbbc1524b8b1cfebb31d8fe9` |
| `node --test test/project-graph/*.test.mjs` | 0 | not hashed |
| `node scripts/run-next-nested-tests.mjs T02` | 0 | not hashed |

The first four hashes are pinned by the test: they depend only on fixtures and adapters defined in
`test/project-graph/interface-rfc.fixtures.mjs` plus the T02 code, so a changed hash means T02 behavior
or this RFC's evidence moved. The `registered` hash is a point-in-time record and is **not** pinned: it
depends on which adapters the registry holds, which other tracks own. For that case the test checks the
exit code, that the output parses, and that a real registered graph validates against the draft schema.
Refresh the recorded hash with the command above when the registry's selection result changes.

### 7.2 Schema artifact

`scanners/project-graph/schemas/project-graph.draft-1.schema.json` is identified by the sha256 of its
canonical form, `JSON.stringify` of the parsed document with object keys sorted at every level:

`c90483e5a6d603b472f453cb5f76b6e7db0b70faf1d188d05a7e44aa875a2b2d`

The raw file bytes are deliberately not hashed, because a checkout with different line endings must not
change the identity of the same document.

### 7.3 Fixtures

| Kind | Fixture | What it shows |
|---|---|---|
| normal | probe `normal` | mixed repo: aggregate root with a generic fallback, a Java app, a Node service with read set, a shared package, a reference-role example; default plan, plan with fallback, plan with non-active roots, role vocabulary |
| normal | probe `registered` | the real registered adapters: two applications under one aggregate root |
| normal | probe `shadow` field `ok`, `serialized_graph_ok`, `graph_without_markers_ok` | a successful shadow run, the same run from a serialized graph, and the same run from a graph whose projects carry no `markers` key |
| normal | probe `shadow` field `unattested_graph` | a graph built with an adapter that has no `listReadSet`: a changed source file passes the check and a changed marker fails it |
| normal | probe `options`, group `accepted` | the options and caller-supplied values of section 2.5 that the builder takes and the schema accepts: custom marker kinds, the default marker file names, an `async` marker rule, empty marker rules, adapter field defaults, `null` and odd values, fallback adapters (one with no `id` included), the order in which adapters are asked, what an adapter is called with and when, `detect()` return values and failures, read-set shapes, package metadata and package owners, odd, `..`-prefixed and role-bearing directory names, names that every object has as properties, ignored directories, the walk order, nested projects, short project roots, repository root forms, a missing or file `repoRoot`, no adapters, an empty repository, a vanished marker file, an adapter removed during the build, the order of `unresolved` across all four stages, option keys the builder ignores, the two plan options and the registered plan variant, the options of `executeProjectScanPlan` (what the nested scan is given and calls, `terms`, `rgAvailable`, `adapters`, `repoRoot` forms, graph shapes, a project that goes stale after an earlier one was scanned), and `discoverProjectRoots` called with an empty path, no marker rules and non-string paths |
| normal | the fallback tests in `test/project-graph/interface-rfc.test.mjs` | a repository in which a fallback adapter with a fixed scan result (not the registry's `generic-grep`) alone recognizes the project `solo`, next to a first-class application, an `aggregate` that also has a fallback adapter, an ambiguous pair and a reference-role example: the plan and the shadow run with `includeFallback` off and on and with an empty, a matching, an adjacent and a non-matching `terms`; values of `terms` that are not arrays; the freshness checks of a `fallback` item; `confidence` and `verification_basis` in the graph and in the report |
| negative | probe `negative` | `specificity_tie`, `duplicate_local_package`, `unlocated_detection`, `out_of_scope_detection`, `detect_error`, `malformed_metadata`, `read_set_escape` |
| negative | probe `options`, group `unchecked` | inputs the builder takes without checking and the schema rejects: non-string marker kinds, non-string adapter text fields, an empty (alone and tied with another adapter), a numeric and a missing adapter id, duplicate adapter ids in a tie, and an empty and a numeric id on a fallback adapter |
| negative | probe `options`, group `malformed` | calls that throw (including `null` in place of the options object), with the class of the error and, for the builder's own three messages and one caller error, the message |
| negative | probe `shadow` field `failures` | `marker_drift`, `marker_missing`, `marker_unreadable`, `marker_escape`, `source_drift`, `source_file_added`, `source_file_removed`, `read_set_not_recaptured`, `read_set_adapter_changed`, `read_set_capture_error`, `read_set_capture_escape`, `root_mismatch`, `adapter_unavailable`, `project_root_escape`, `plan_stale`, each with the fields it carries (section 5.3) |
| negative | `test/project-graph/interface-rfc.mutations.mjs` | edits to a copy of a real graph that the schema must reject, each for a named keyword: an `ambiguous` project with a selected adapter, a tie reported as unique, an unknown `unresolved` kind, an extra property, an unknown facet, an absolute path, a `..` path, an empty or non-string marker kind, an empty fallback adapter id, and an empty selected adapter (in an application and in an aggregate), tied adapter id, candidate adapter id, package name, detected root of an out-of-scope detection and registry file name (section 2.6). For these seven the entry names the schema node whose keyword must give the error, and the file lists the values that node still takes: a one-character id, `null` where `null` is valid, `.` and `../x` as a root, a file name with an empty message |
| negative | the section 2.6 tests in `test/project-graph/interface-rfc.test.mjs` | the empty string put in place of each string of the real graphs, one position at a time, against the verdict of the table in section 2.6; graphs built with an adapter whose `id` is `''` (a detection that throws without text, one that names no directory, one at the repository root, one below the project); a registry directory with a file whose `id` is `''`; graphs whose ids disagree with each other, which the schema accepts (limit 19) |

### 7.4 What the test checks

`test/project-graph/interface-rfc.test.mjs` fails when: a documented export is missing; an `unresolved`
kind, shadow error code, marker kind, selection reason, edge kind or source role appears in the source
and is absent from this RFC or the record (or the reverse); a probe exit code or pinned hash differs; a
real graph, including every accepted option case of section 2.5, fails the schema; an unchecked option
case passes the schema or fails it for another keyword than the recorded one; an edited graph passes the
schema or fails it for a different keyword than the one named; the table of section 2.6 lists other string
positions than the schema file declares, or gives another verdict for a position than the validator gives when
`''` takes the place of a string of a real graph; an option case behaves differently from
what section 2.5 and the tables that cite it say (the test asserts each statement against the probe and,
for the arguments a marker rule receives, against a live build); a helper export of section 2.1 returns
or throws something other than the table says (it is called with the values the table names); a `fallback`
plan item is planned, labeled, scored, verified or reported differently from what sections 2.3, 2.4 and 5.3
say (the test runs the real builder, plan and shadow run on a repository in which a fallback adapter alone
recognizes one project); the RFC cites an option case that is not recorded, or a recorded case is cited nowhere;
a section 5.1 tag disagrees with the probe that is named; the RFC lacks a required section or a recorded hash;
or a file listed as owned by T02 sits outside the two T02 directories. It also feeds the drift checks damaged
copies to prove each check can fail: a new kind or error code in a fake source, dropped or invented
record items, a widened or narrowed schema, a schema tightened until it rejects an accepted option case
(a marker kind enum, a pattern on adapter ids or paths, an integer `specificity`, a minimum count, a minimum
length on a root, a package name or a selected adapter that may no longer be `null`, the schema id), a schema
loosened until it accepts an unchecked one, a schema from which one `minLength` of section 2.6 was dropped, a
validator that accepts or rejects every graph, RFC text whose tag is renamed or whose
statement is reworded or removed, a record list that lost, gained or mis-sorted a case, and a tag
pointing at the wrong case.

## 8. Remaining limits

1. **Draft.** Shapes may change. `project_id` is repo-local and derived from the path, so a rename
   changes it. No cross-tool identity exists until T00 and T01 approve one.
2. **One facet.** Only `http` exists. A graph says nothing about queues, jobs, databases, sockets, games
   or protocols (T17, T18 and later work). Absence is unknown.
3. **Schema scope.** The schema checks shape and a few cross-field rules (selection reason against
   selected adapter and ids; kind against fallback and read set). It does not check that edge endpoints
   and `child_project_roots` name real projects, that `project_id` matches `root`, that `files_read`
   covers every marker, or that the adapter ids of one project agree with each other (limit 19).
   [source] It accepts any non-empty string as a marker `kind` (section 2.5) and any
   relative path without a `..` segment, so a custom `markerRules` kind or an odd directory name does not
   fail it. A path whose first segment merely starts with two dots is valid for the schema but not for the
   builder (limit 16).
4. **`marker-read` message.** It carries the raw system error text, not the portable form the other
   diagnostics use, so the message holds the absolute path of the file that vanished. Every other message
   is portable. A graph built while files change can therefore leak a local path through this one message.
   Treat every `message` as prose, and scrub it before publishing a graph. [probe: options `vanished_marker`]
   Finding for the T02 owner; this RFC changes no behavior.
5. **Unattested sources.** A project whose selected adapter has no read set is never source-fresh-checked
   in shadow mode (section 5.2). A `fallback` item has no selected adapter, so in a graph the builder wrote it
   has no read set either, and a project that is not in the plan is not checked at all, its markers included
   (section 2.4).
6. **`nested_detections`** keeps one entry per adapter, so it is not a list of nested projects.
7. **Partial selection.** The winner is chosen among adapters that completed detection
   (section 5.2).
8. **Several fallback adapters.** If more than one fallback adapter detects the same root, the one asked
   last (the asking order of section 4) is recorded; the others are dropped without a trace.
   A fallback is an adapter whose id is `generic-grep` or whose raw `specificity` is exactly `0`, so an
   adapter with no `specificity` is first-class (section 4). [probe: options `fallback_adapters`,
   `adapter_defaults`]
9. **Unprobed paths.** `PROJECT_PLAN_INVALID` and `PROJECT_PLAN_DRIFT` are defensive: no input the probes
   built reaches them through the public entry points. [source] `selected-adapter-missing` is reached only
   when `detect` removes its own adapter from the `adapters` array during the build
   [probe: options `adapter_removed_during_build`], and `directory-read` when `repoRoot` is missing or a
   file [probe: options `missing_repo_root`, `file_as_repo_root`].
10. **Two role views.** `project_role` is judged from the project root path relative to the repository;
    a read-set file's `role` is judged from its path relative to the project. The same file can carry a
    different role in each view.
11. **Prose.** `notes` strings and every `message` are not machine-stable.
12. **Unobserved subtrees.** Hard-ignored directories and symlinks are never entered (section 5.2).
13. **Platforms.** Verified on macOS with Node v24.19.0; the pinned probes also print the same bytes on
    Node 18.20.8 and 22.23.3 there. CI for this repository does not run Windows, and no Windows run was
    made. The fixtures with odd directory names (a colon, a backslash, a newline) need a POSIX file system.
14. **Unverified prose.** Statements tagged [source] or [convention] were read from code or are requests
    to consumers. The test covers literal lists, probe outputs and the schema, not every sentence.
15. **Unchecked input.** The builder does not check the type of a marker `kind`, of an adapter's `title`,
    `confidence` or `verificationBasis`, or whether adapter ids are present, non-empty, strings or unique, for a
    first-class adapter or for a fallback one. Such a value is copied into the graph and the schema then rejects
    the graph, with three exceptions. Two adapters with one id are valid unless they tie. A fallback adapter with
    no `id` leaves `fallback_adapter` `null`, which no schema can tell from no fallback, so a `null` there does not
    prove that no fallback adapter recognized the project. And a fallback `id` of `NaN` or `Infinity` fails the schema
    in memory but not after `JSON.stringify`, which writes `null`. A consumer that builds graphs from untrusted
    adapters or rules must validate the result, in memory and before it is serialized.
    [probe: options `non_string_marker_kinds`, `non_string_adapter_fields`, `empty_adapter_id`, `numeric_adapter_id`,
    `missing_adapter_id`, `duplicate_adapter_ids`, `empty_fallback_adapter_id`, `numeric_fallback_adapter_id`,
    `missing_fallback_adapter_id`, `adapter_order`]
16. **Names that start with two dots.** Five checks in the builder (three in `index.mjs`: the read-set
    project and repository checks and the nested-detection check; two in `shadow.mjs`: the project-root and
    marker-path checks) treat a first path segment that only starts with `..` as an escape from the
    repository, although `..dots` is an ordinary directory name. In the probe, a repository that holds
    `..dots/package.json` and `svc/..lib/b.js` gets `out-of-scope-detection` for the root (`detected_root`
    `..dots`), an `adapter-read-set-error` for `..dots` and for `svc`, and `executeProjectScanPlan` fails
    with `PROJECT_MARKER_ESCAPE`. The schema accepts such paths. This RFC changes no behavior; the finding
    is for the T02 owner. [probe: options `dotdot_names`]
17. **Malformed input.** A call the builder does not check (a `null` marker rules array, a rule without
    `test`, a `detect` that throws `null`, a number as `repoRoot`, `null` as the plan options or as the options of a registered
    builder) fails inside Node with a `TypeError` whose text may change between Node versions. Only the builder's own messages
    and an error thrown by the caller's own function are stable (section 2.5). Some out-of-contract adapter values
    break the build or the serialization instead of reaching the schema [source]: a Symbol or BigInt `specificity`
    makes the builder throw a `TypeError` once `adapters` holds a second adapter, a Symbol `id` does so when two
    specificities tie, and a BigInt or a cyclic value in `capabilities` gives a graph that the schema accepts in memory
    and that `JSON.stringify` cannot write.
    [probe: options `repo_root_not_a_string`, `marker_rules_null`, `detect_throws_null`, `plan_options_null`]
18. **Short project roots.** The builder picks the parent of a `contains` edge as the enclosing project with
    the longest root text. The repository root `.` is one character long, so for a project below a top-level
    project whose root is also one character long (`a`), the two enclosing roots tie, and the tie goes to
    the root that sorts first by code unit. `a/b` therefore gets its `contains` edge from `.` and not from
    `a`, while `-/z` gets it from `-` (`-` sorts before `.`), and `child_project_roots` of `a` still lists
    `a/b`. Only the direct children of such a project are affected: every other enclosing root is a
    longer prefix of the child. A consumer that needs the tree should take it from `child_project_roots`.
    This RFC changes no behavior; the finding is for the T02 owner. [probe: options `short_root_names`]
19. **Ids that must agree.** The schema checks each id on its own (section 2.6) and a few relations (limit 3), but
    not that the ids of one project belong together. A `selected_adapter` that no candidate carries, a
    `selected_adapter_read_set` whose `adapter_id` is not the selected adapter, and `ambiguous_adapter_ids` that name
    an id no candidate carries all validate, because JSON Schema 2020-12 cannot compare one value of a document with
    another. [source] The builder cannot write such a graph: the selected id, the tied ids and the read set all come
    from the same candidates. A graph that was edited, built by hand or read from another tool can hold them, and
    `buildProjectScanPlan` then plans for the id as written. A consumer that takes graphs from outside must check
    these relations itself or rebuild the graph. The test builds the three graphs by hand and expects the schema to
    accept them; it checks none of the relations, and this RFC adds no checker.
