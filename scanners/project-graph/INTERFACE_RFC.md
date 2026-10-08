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
| `discoverProjectRoots(repoRoot, {markerRules})` (`index.mjs`) | repo path; optional marker rules | in-process `{repo_root, roots[], unresolved[], files_read[]}`; `repo_root` and each `roots[].absolute_root` are absolute, so this object is not portable |
| `inferDetectionProjectRoot(detection)` | an adapter `detect()` return value | absolute project root or `null`. Accepted: non-empty string (a trailing `src/main/java` is stripped), `{projectRoot}`, `{srcRoot}`. Anything else, including `true`, gives `null` |
| `captureAdapterReadSetSnapshot({repoRoot, projectRoot, adapter})` | adapter with optional `listReadSet(absProject)` returning project-relative paths | `null` when the adapter has no `listReadSet`; else `{adapter_id, files[{path, digest, role}], fingerprint}`. Throws `TypeError` (non-array or invalid entry), `PROJECT_READ_SET_ESCAPE` (path leaves the project or repo) or the file-system error of an unreadable file |
| `buildProjectGraph({repoRoot, adapters, markerRules})` | `repoRoot` and an `adapters` array (both required, else `TypeError`) | the graph, section 2.2 |
| `buildProjectScanPlan(graph, {includeFallback, includeNonActive})` | a draft-1 graph (else `TypeError`) | array of plan items, section 2.3 |
| `buildRegisteredProjectGraph(repoRoot, {adapters, markerRules})`, `buildRegisteredProjectScanPlan(repoRoot, {includeFallback, ...})` (`registered.mjs`) | repo path; defaults to the registry's `ADAPTERS` | the same graph plus `registry_load_errors`; the plan variant returns `{graph, plan}` |
| `executeProjectScanPlan({repoRoot, graph, terms, adapters, rgAvailable, includeFallback})` (`shadow.mjs`) | a graph and the repo it was built from | `sbf.project-scan-shadow/draft-1`, section 2.4 |
| `classifyProjectSourceRole(path)`, `groupProjectSourcesByRole(paths)`, `PROJECT_SOURCE_ROLES` (`source-role.mjs`) | repo-relative paths | a role name, or a `{role: paths[]}` map covering all five roles |
| `portableProjectDiagnosticMessage(message, repoRoot)`, `portableRegistryLoadErrors(entries)` | raw error text / registry load errors | text with the absolute repo (or adapter) directory replaced by `<repo>` (or `<adapter-dir>`) and backslashes turned into `/` |
| `PROJECT_GRAPH_DRAFT`, `PROJECT_GRAPH_EXECUTION_ROOT`, `projectGraphExecutionRoot(graph)` | none / a graph | the draft id; a Symbol key; the absolute root captured at build time or `null` |

Adapters are the existing `sbf.adapter/2` descriptors (`detect` and `scan` required; `listReadSet`,
`diagnostics`, `introspectRoutes` optional; `id` equals the file name). T02 calls them and never edits
them. At the time of writing every first-party adapter on main defines `listReadSet` [source]; a
third-party or test adapter without it yields a `null` read set (section 5).

### 2.2 Graph object

Every key below is always present on a graph. Arrays are sorted with plain code-unit comparison.

| Key | Meaning |
|---|---|
| `schema` | the constant `sbf.project-graph/draft-1` |
| `repo_root` | always `.`. The absolute root lives under the non-enumerable `PROJECT_GRAPH_EXECUTION_ROOT` symbol and disappears on JSON serialization |
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
| `fallback_adapter` | id of the generic fallback adapter, or `null`. Set only when the project has no first-class candidate |
| `selected_adapter_read_set` | `{adapter_id, files[{path, digest, role}], fingerprint}` or `null`; section 5 |
| `child_project_roots` | the nearest descendant project roots only |
| `nested_detections` | `[{adapter_id, detected_root}]`; section 5 |
| `local_package` | `{name, private, dependency_names, workspace_patterns, evidence{path, digest}}` read from the `node-package` marker, or `null` |

Edges: `contains` runs from the nearest enclosing project to its child with `evidence: []`.
`local-package-dependency` runs from the declaring project to the single project whose package `name`
matches a name in the declarer's dependency lists, with `dependency_name` and
`evidence: [the declaring project's local_package.evidence]`. Dependency names are the union of
`dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. A self-match is
skipped. [probe: normal]

### 2.3 Plan item

`buildProjectScanPlan` returns `{project_id, project_root, adapter_id, mode}` items sorted by
`project_root`, then `adapter_id`. `mode` is `first-class` or `fallback`.

1. A project whose `project_role` is not `active` is skipped unless `includeNonActive` is set. It stays
   visible in the graph.
2. A project with a selected adapter yields one `first-class` item.
3. Otherwise, with `includeFallback`, a project that has a `fallback_adapter` and is not `aggregate`
   yields one `fallback` item.
4. An `ambiguous` project yields nothing in either mode. [probe: negative `specificity_tie`]
5. A plan is a hint (which adapter to run on which root), not a result. It does not say the scan will
   succeed or that the sources are fresh.

### 2.4 Shadow output

`executeProjectScanPlan` returns `{schema, graph_schema, terms, scans[], notes}` where each
`scans[]` item is `{project_id, project_root, adapter_id, mode, report}` and `report` is the unchanged
legacy `sbf.scan-report/2` produced by `runScan` for that project root with only the planned adapter,
`includeDb: false`, `dbSchema: null` and `runtimeRoutes: false`. It takes no `includeNonActive`, so
non-active roots are never scanned in shadow mode.

Before each project it re-hashes every marker and, when the graph carries a read set, re-captures the
selected adapter's read set and compares fingerprints. Any failure throws and **no partial `scans` list
is returned** (all-or-nothing, fail closed). A graph that went through `JSON.stringify` and `JSON.parse`
executes on an equivalent checkout; the root-mismatch check only applies to a live graph that still
carries the execution-root symbol. [probe: shadow]

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

A candidate is `{adapter_id, title, specificity, confidence, verification_basis, capabilities}`.
Defaults when an adapter omits a field: `title` is the id, `specificity` is `0` unless a finite number,
`confidence` and `verification_basis` are the literal string `unknown`, `capabilities` is `{}`.

A first-class candidate is an adapter that is not a fallback and whose `detect()` returned a root equal
to the project root. Fallback means id `generic-grep` or specificity `0`. Adapters that threw, returned
an unrecognized shape, or returned another root are not candidates; they appear in `unresolved` or
`nested_detections` (section 5).

| `selection_reason` | Condition | `selected_adapter` | `ambiguous_adapter_ids` |
|---|---|---|---|
| `unique-highest-specificity` | exactly one candidate has the highest specificity | that id | empty |
| `specificity-tie` | two or more candidates share the highest specificity | `null` | the tied ids |
| `no-first-class-adapter` | no candidates | `null` | empty |

`candidates` lists every first-class candidate, sorted by descending specificity then id, not only the
tied ones. Adding a facet means a new key under `facets`. The draft schema is closed over `facets`, so a
new facet requires a new schema revision. [convention] A consumer must ignore facet keys it does not know
and must read a missing facet as **unknown, never none**: today a graph says nothing about queues, jobs,
databases or sockets, and the `http` facet only says what the registered HTTP adapters could recognize.

| Vocabulary | Values |
|---|---|
| `kind` | `application`, `ambiguous`, `aggregate`, `unrecognized` |
| `project_role` and read-set `role` | `active`, `reference`, `generated`, `vendor`, `template` |
| marker `kind` | `node-package`, `python-project`, `jvm-build`, `jvm-workspace`, `ruby-bundle`, plus forward-compatible `go-module`, `rust-package`, `php-package`, `dotnet-project` |
| edge `kind` | `contains`, `local-package-dependency` |

The four forward-compatible marker kinds only put a directory on the graph. They do not imply that an
adapter exists for that ecosystem. Role precedence is vendor, then reference, then generated, then
template, then active, matched on whole path segments (case-insensitive), never on substrings; a
`.tmpl`, `.template`, `.mustache` or `.hbs` file name also means template. [probe: normal `source_roles`]
Examples from that probe: `vendor/examples/x.js` is vendor, `generated/tests/x.js` is reference,
`dist/bundle.js` is generated, `src/app.js` is active.

## 5. Unknown and partial semantics

Rule: the graph never turns an unanswered question into an answer. When it cannot decide it leaves a
field `null` or empty and says why in `unresolved`, or it refuses to choose. A consumer must not read a
missing, `null` or unresolved value as "supported", and must not read it as "none".

### 5.1 `unresolved` entries

Every entry has a `kind` and a human `message`. Consumers key on `kind` and the structured fields.

| `kind` | Other fields | Meaning | Tag |
|---|---|---|---|
| `directory-read` | `path` | a directory could not be listed during discovery; its subtree is unobserved | source |
| `marker-read` | `path` | a recognized marker file could not be read; it is not a marker, so a project may be missing | source |
| `package-metadata-read` | `project_id`, `path` | `package.json` is unreadable or not valid JSON; `local_package` is `null` for that project | probe: negative `malformed_metadata` |
| `ambiguous-local-package-name` | `package_name`, `project_ids` (2 or more) | several projects declare one package name | probe: negative `duplicate_local_package` |
| `ambiguous-local-package-dependency` | `project_id`, `package_name`, `candidate_project_ids` (2 or more) | a dependency matches several local projects; no edge was created | probe: negative `duplicate_local_package` |
| `adapter-detect-error` | `project_root`, `adapter_id` | the adapter's `detect()` threw for that candidate root; it is not a candidate there | probe: negative `detect_error` |
| `unlocated-detection` | `project_root`, `adapter_id` | `detect()` was truthy but returned no recognized root shape; T02 does not guess ownership | probe: negative `unlocated_detection` |
| `out-of-scope-detection` | `project_root`, `adapter_id`, `detected_root` | the detected root is neither the candidate nor inside it | probe: negative `out_of_scope_detection` |
| `selected-adapter-missing` | `project_root`, `adapter_id` | the selected id was absent from the adapter list at read-set capture; defensive, the id comes from that same list | source |
| `adapter-read-set-error` | `project_root`, `adapter_id` | `listReadSet` or hashing failed (bad shape, `PROJECT_READ_SET_ESCAPE`, unreadable file); the project keeps its adapter but has no read set | probe: negative `read_set_escape` |

### 5.2 States that look like absence

| State | Meaning | Do not conclude |
|---|---|---|
| `kind: ambiguous`, `selection_reason: specificity-tie` | two or more first-class adapters tie; nothing is selected and nothing is planned, even with `includeFallback` | that any tied adapter owns the project |
| `selection_reason: no-first-class-adapter` | no registered adapter recognized the root. `fallback_adapter` may name a low-confidence inventory fallback | that the project has no HTTP surface, or that the fallback supports it |
| `kind: aggregate` | has child project roots and no adapter of its own; never gets a fallback plan item | that the children are scanned by the parent |
| `nested_detections` | an adapter that recurses found a project below this root, so the parent is not selected. One entry per adapter, the first match in that adapter's own traversal | that this is the list of children. Use `child_project_roots` and each child's own facet. [probe: normal, repo root] |
| `selected_adapter_read_set: null` with a selected adapter | source freshness is **unattested**: the adapter has no `listReadSet`, or capture failed. Shadow mode still re-hashes markers and skips the source check | that the sources are fresh. [probe: normal `backend-java`, negative `read_set_escape`] |
| `local_package: null` | no readable Node package facts: no `node-package` marker, or a `package-metadata-read` entry exists. `local_package.name: null` means readable but unnamed | that the project has no packages in other ecosystems |
| `confidence` or `verification_basis` equal `unknown` | the adapter declared nothing | a hidden default of "high" |
| `unique-highest-specificity` plus an `adapter-detect-error` with the same `project_root` | partial selection: the winner is the highest among adapters that answered, and `kind` is not downgraded. [probe: negative `detect_error`, `broken-http` threw at specificity 99 and `javascript-express` still won `service`] | that the winner would survive if every adapter had answered. [convention] check `unresolved` for the same `project_root` first |
| a project below a hard-ignored directory or reached through a symlink | discovery never enters `.git`, `.hg`, `.svn`, `.bskel`, `node_modules`, `coverage`, `.cache`, `.turbo`, `dist`, `build`, `out`, `.next`, `.svelte-kit`, `vendor`, `third_party`, `third-party` and never follows symlinks | that the project does not exist. It is unobserved |

### 5.3 Shadow failure codes

`executeProjectScanPlan` fails closed with an `Error` that has a `code`. Probe keys are in
`shadow.failures` of the `shadow` probe output.

| `code` | Raised when | Extra fields | Probe key |
|---|---|---|---|
| `PROJECT_GRAPH_ROOT_MISMATCH` | a live graph's captured root differs from `repoRoot` | none | `root_mismatch` |
| `PROJECT_ROOT_ESCAPE` | a project `root` resolves outside the repository | none | `project_root_escape` |
| `PROJECT_MARKER_ESCAPE` | a marker `path` resolves outside the repository | none | `marker_escape` |
| `PROJECT_GRAPH_STALE` | a marker is missing, unreadable or changed | `project_id`, `marker_path`, `expected_digest`, `actual_digest` | `marker_drift` |
| `PROJECT_GRAPH_STALE` with `stale_kind: adapter-read-set` | the selected adapter's read set changed (content, added or removed file) or could not be recaptured | `project_id`, `adapter_id`, `expected_fingerprint`, `actual_fingerprint`, `expected_files`, `actual_files`, or `cause` | `source_drift`, `source_file_added` |
| `PROJECT_ADAPTER_UNAVAILABLE` | the planned adapter id is not in `adapters` | none | `adapter_unavailable` |
| `PROJECT_PLAN_STALE` | legacy `runScan` threw for the planned adapter, for example `detect()` no longer matches | `project_id`, `adapter_id`, `cause` | `plan_stale` |
| `PROJECT_PLAN_INVALID` | a planned project id is missing from the graph | none | none: unreachable, the plan is derived from the same graph [source] |
| `PROJECT_PLAN_DRIFT` | the report names a different adapter than planned | none | none: unreachable, `runScan` receives only the planned adapter [source] |

`PROJECT_READ_SET_ESCAPE` is raised by `captureAdapterReadSetSnapshot` for a read-set path that leaves the
project or repository. At graph build time it surfaces only as an `adapter-read-set-error` entry (the
code is not copied into the entry); at shadow time it is wrapped in a `PROJECT_GRAPH_STALE` error.

A project that has no selected adapter is never reported as scanned. A `fallback` plan item is labeled
`mode: fallback` and its report is inventory-only; T02 passes adapter `confidence` and
`verification_basis` through as declared and never upgrades them.

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

Everything below was produced on macOS with Node v24.19.0 from a clean checkout after `npm ci`. The
machine-readable copy is `test/project-graph/interface-rfc.record.json`; the test reads that file, so the
two cannot drift apart silently.

### 7.1 Commands and exit codes

Run from the repository root. Each probe prints canonical (sorted-key) JSON, builds its fixtures in a
temporary directory it removes before exiting, and fails if its output contains that directory's path.

| Command | Exit | Stdout sha256 |
|---|---|---|
| `node test/project-graph/interface-rfc.probe.mjs normal` | 0 | `2058d22a2f992b833c8468ed6fb21345a27f31ef4332cfd5b072f61f885800e7` |
| `node test/project-graph/interface-rfc.probe.mjs negative` | 0 | `caa0e55e9abf5e2d78961aedda7b7bbea32304d8441a33657e79d5d64f32e36f` |
| `node test/project-graph/interface-rfc.probe.mjs shadow` | 0 | `1e1b41a11a8fc61706eeaf96e4001980942412361b4acaeee18d2162814ac43b` |
| `node test/project-graph/interface-rfc.probe.mjs registered` | 0 | `1c6ddc7a6ca6dce69377362c8e954d4dc1f0c6afdbbc1524b8b1cfebb31d8fe9` |
| `node --test test/project-graph/*.test.mjs` | 0 | not hashed |
| `node scripts/run-next-nested-tests.mjs T02` | 0 | not hashed |

The first three hashes are pinned by the test: they depend only on fixtures and adapters defined in
`test/project-graph/interface-rfc.fixtures.mjs` plus the T02 code, so a changed hash means T02 behavior
or this RFC's evidence moved. The `registered` hash is a point-in-time record and is **not** pinned: it
depends on which adapters the registry holds, which other tracks own. For that case the test checks the
exit code, that the output parses, and that a real registered graph validates against the draft schema.
Refresh the recorded hash with the command above when the registry's selection result changes.

### 7.2 Schema artifact

`scanners/project-graph/schemas/project-graph.draft-1.schema.json` is identified by the sha256 of its
canonical form, `JSON.stringify` of the parsed document with object keys sorted at every level:

`6da90ebb72f6e02b682382ac800bf6a283bd2149eb7794d9f93925618b68f573`

The raw file bytes are deliberately not hashed, because a checkout with different line endings must not
change the identity of the same document.

### 7.3 Fixtures

| Kind | Fixture | What it shows |
|---|---|---|
| normal | probe `normal` | mixed repo: aggregate root with a generic fallback, a Java app, a Node service with read set, a shared package, a reference-role example; default plan, plan with fallback, plan with non-active roots, role vocabulary |
| normal | probe `registered` | the real registered adapters: two applications under one aggregate root |
| normal | probe `shadow` field `ok`, `serialized_graph_ok` | a successful shadow run, and the same run from a serialized graph |
| negative | probe `negative` | `specificity_tie`, `duplicate_local_package`, `unlocated_detection`, `out_of_scope_detection`, `detect_error`, `malformed_metadata`, `read_set_escape` |
| negative | probe `shadow` field `failures` | `marker_drift`, `source_drift`, `source_file_added`, `root_mismatch`, `adapter_unavailable`, `project_root_escape`, `marker_escape`, `plan_stale` |
| negative | `test/project-graph/interface-rfc.mutations.mjs` | edits to a copy of a real graph that the schema must reject, each for a named keyword: an `ambiguous` project with a selected adapter, a tie reported as unique, an unknown `unresolved` kind, an extra property, an unknown facet, an absolute path, a `..` path |

### 7.4 What the test checks

`test/project-graph/interface-rfc.test.mjs` fails when: a documented export is missing; an `unresolved`
kind, shadow error code, marker kind, selection reason, edge kind or source role appears in the source
and is absent from this RFC or the record (or the reverse); a probe exit code or pinned hash differs; a
real graph fails the schema; an edited graph passes the schema or fails it for a different keyword than
the one named; the RFC lacks a required section or a recorded hash; or a file listed as owned by T02
sits outside the two T02 directories. It also feeds the drift checks damaged copies (a new kind or error
code in a fake source, dropped or invented record items, a widened schema, damaged RFC text) to prove
each check can fail.

## 8. Remaining limits

1. **Draft.** Shapes may change. `project_id` is repo-local and derived from the path, so a rename
   changes it. No cross-tool identity exists until T00 and T01 approve one.
2. **One facet.** Only `http` exists. A graph says nothing about queues, jobs, databases, sockets, games
   or protocols (T17, T18 and later work). Absence is unknown.
3. **Schema scope.** The schema checks shape and a few cross-field rules (selection reason against
   selected adapter and ids; kind against fallback and read set). It does not check that edge endpoints
   and `child_project_roots` name real projects, that `project_id` matches `root`, or that `files_read`
   covers every marker. [source]
4. **`marker-read` message.** It carries the raw system error text, not the portable form the other
   diagnostics use, so it can contain an absolute path. Treat every `message` as prose, and scrub it before
   publishing a graph. Not probed. [source] Finding for the T02 owner.
5. **Unattested sources.** A project whose selected adapter has no read set is never source-fresh-checked
   in shadow mode (section 5.2).
6. **`nested_detections`** keeps one entry per adapter, so it is not a list of nested projects.
7. **Partial selection.** The winner is chosen among adapters that completed detection
   (section 5.2).
8. **Several fallback adapters.** If more than one fallback adapter detects the same root, the last one
   in (specificity descending, id ascending) order is recorded. Not probed. [source]
9. **Unprobed paths.** `PROJECT_PLAN_INVALID`, `PROJECT_PLAN_DRIFT` and `selected-adapter-missing` are
   defensive and cannot be reached through the public entry points. `directory-read` (an unreadable
   directory) is not reproduced by any fixture. [source]
10. **Two role views.** `project_role` is judged from the project root path relative to the repository;
    a read-set file's `role` is judged from its path relative to the project. The same file can carry a
    different role in each view.
11. **Prose.** `notes` strings and every `message` are not machine-stable.
12. **Unobserved subtrees.** Hard-ignored directories and symlinks are never entered (section 5.2).
13. **Platforms.** Verified on macOS with Node v24.19.0 only. CI for this repository does not run
    Windows, and no Windows run was made.
14. **Unverified prose.** Statements tagged [source] or [convention] were read from code or are requests
    to consumers. The test covers literal lists, probe outputs and the schema, not every sentence.
