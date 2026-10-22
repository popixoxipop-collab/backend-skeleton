# T21 scan scheduler and artifact store: interface RFC

Status: draft, shadow only. Nothing in the stable scan calls the layer, nothing is active by default, and this RFC does not declare track T21 complete. Every statement about the layer describes the base commit `15a38e923cb5e079c6f8e2a4c2a9386406c41f52`; the file lists in section 8 describe the tree with this change.

Companions: `lib/scan-scheduler-next/BASELINE.json` (schema `bskel.track-baseline-record/2`, provisional), `lib/artifact-store-next/README.md`, `test/perf-next/t21-interface-rfc.vocabulary.json` (schema `bskel.t21-interface-vocabulary/1`) and `test/perf-next/t21-interface-rfc.test.mjs`.

## 1. Purpose and non-goals

This RFC fixes, for the shadow layer in `lib/scan-scheduler-next` and `lib/artifact-store-next`, what each module takes and returns, what identifies a cached result, what the layer reports when it does not know, and what it does when storage is damaged or used by two callers at once. It is checked, not only read: `test/perf-next/t21-interface-rfc.test.mjs` recomputes the vocabulary file from the loaded modules, from the keys of real results and from the directory listings, and recomputes the declared tables from the vocabulary and record. **Only the checked tables, listed identifiers and specifically guarded numbered claims** are drift-protected: arbitrary explanatory prose edits are NOT exhaustively checked. Every numbered statement in sections 4 to 6 has a test of the same number in that file, and the test runs the statement on real calls.

The layer has two halves. The scheduling half derives the inputs of a decision: cache keys, file indexes, invalidation sets, a project plan, memory admission, a task schedule and a performance verdict. The store half keeps results by content: immutable blobs addressed by digest, an index from a cache key to a blob, and a collector for blobs that nothing refers to.

Non-goals of this change:

- No module is changed. The change adds a baseline record, this RFC, a pointer README and tests. The scheduler and the store behave exactly as at the base commit, including the behaviours that the record lists as limits.
- No integration. Nothing here wires the layer into the stable scan, a runner or a provider (track item T21-05).
- No promotion, rollback plan or supported-scope record (track item T21-06). Section 7 lists the gates and none of them is lifted.
- No new timing. The record holds no millisecond figure as a fact and this RFC sets no service level objective.
- No wire format for the foreign schemas and key names named in sections 3 and 4.

## 2. Scope

The tables list every module of the two directories, what each exports and imports, and how each exported function is called. They are rendered from the vocabulary file, which the test compares with the directory listings, with the exports of the loaded modules, with the parameter lists in the source text and with the import statements. A module, an export, a parameter or an import that is added or changed fails the test until the vocabulary and this text follow.

| module | directory | role |
| --- | --- | --- |
| `cache-index.mjs` | `lib/artifact-store-next` | Cache index file inside a repository: cache key to artifact reference plus dependency paths, written under a lock |
| `gc.mjs` | `lib/artifact-store-next` | Garbage collection of unreferenced blobs: dry run by default, unexpected entries are reported and never deleted |
| `store.mjs` | `lib/artifact-store-next` | Content-addressed blob store: put, has and read by sha256 reference; atomic write and read-back verification |
| `cache-key.mjs` | `lib/scan-scheduler-next` | Canonical JSON, sha256 digests and the scan cache key |
| `cache-runtime.mjs` | `lib/scan-scheduler-next` | Runs a computation through the cache: a hit returns the stored artifact, a miss computes, stores and indexes it |
| `file-index.mjs` | `lib/scan-scheduler-next` | Digest index of the files below a root, with count and byte budgets and portable path findings |
| `invalidation.mjs` | `lib/scan-scheduler-next` | Added, deleted, modified and dependency-invalidated paths between two file indexes |
| `legacy-cache.mjs` | `lib/scan-scheduler-next` | Shadow cache around the single-project scanner runScan, which it does not change |
| `performance-policy.mjs` | `lib/scan-scheduler-next` | Pass, fail or blocked verdict comparing a candidate measurement with a baseline measurement |
| `project-cache-plan.mjs` | `lib/scan-scheduler-next` | Per-project cache namespaces from the draft project graph, and the projects invalidated by a change |
| `project-cache-runner.mjs` | `lib/scan-scheduler-next` | Shadow run of the legacy cache for every planned project through the scheduler |
| `resource-budget.mjs` | `lib/scan-scheduler-next` | Memory admission derived from total memory, a reserve fraction and a minimum reserve |
| `scheduler.mjs` | `lib/scan-scheduler-next` | Dependency-aware task graph runner with a concurrency limit and a byte budget |

| module | exports |
| --- | --- |
| `cache-index.mjs` | `createCacheIndex` |
| `gc.mjs` | `collectArtifactGarbage` |
| `store.mjs` | `createArtifactStore` |
| `cache-key.mjs` | `buildScanCacheKey`, `digestJson`, `sha256Bytes`, `stableJson` |
| `cache-runtime.mjs` | `runCachedTask` |
| `file-index.mjs` | `DEFAULT_EXCLUDED_DIRS`, `buildFileIndex`, `indexEntryMap`, `portablePathIssuesForPaths` |
| `invalidation.mjs` | `computeInvalidation` |
| `legacy-cache.mjs` | `runLegacyScanCached` |
| `performance-policy.mjs` | `evaluatePerformanceGate` |
| `project-cache-plan.mjs` | `T21_PROJECT_CACHE_PLAN_DRAFT`, `T21_PROJECT_GRAPH_DRAFT`, `buildProjectCachePlan`, `propagateProjectInvalidation` |
| `project-cache-runner.mjs` | `runProjectGraphCached` |
| `resource-budget.mjs` | `deriveMemoryAdmission` |
| `scheduler.mjs` | `runTaskGraph` |

The imports table is the static dependency surface of the layer. An unlisted import fails the test; every dynamic `import(...)` (even when the specifier is a literal), `require(...)` and Node module factory calls is classified as opaque and forbidden, rather than treating dynamic module loading as a static import. `lib/fsutil.mjs` and `lib/lock.mjs` are shared files that no track owns. The layer uses `writeFileAtomic` from the first and `withLockSync` from the second and does not change either.

| module | imports |
| --- | --- |
| `cache-index.mjs` | `lib/fsutil.mjs` (writeFileAtomic), `lib/lock.mjs` (withLockSync), `lib/scan-scheduler-next/cache-key.mjs` (stableJson), `node:fs`, `node:path` |
| `gc.mjs` | `node:fs`, `node:path` |
| `store.mjs` | `node:crypto` (createHash), `node:fs`, `node:path` |
| `cache-key.mjs` | `node:crypto` (createHash) |
| `cache-runtime.mjs` | `lib/scan-scheduler-next/cache-key.mjs` (stableJson) |
| `file-index.mjs` | `lib/scan-scheduler-next/cache-key.mjs` (digestJson), `node:crypto` (createHash), `node:fs`, `node:path` |
| `invalidation.mjs` | `lib/scan-scheduler-next/file-index.mjs` (indexEntryMap) |
| `legacy-cache.mjs` | `lib/artifact-store-next/cache-index.mjs` (createCacheIndex), `lib/artifact-store-next/store.mjs` (createArtifactStore), `lib/scan-scheduler-next/cache-key.mjs` (buildScanCacheKey, digestJson), `lib/scan-scheduler-next/cache-runtime.mjs` (runCachedTask), `lib/scan-scheduler-next/file-index.mjs` (buildFileIndex), `node:path`, `scanners/index.mjs` (runScan) |
| `performance-policy.mjs` | none |
| `project-cache-plan.mjs` | `lib/scan-scheduler-next/cache-key.mjs` (digestJson) |
| `project-cache-runner.mjs` | `lib/scan-scheduler-next/file-index.mjs` (buildFileIndex), `lib/scan-scheduler-next/legacy-cache.mjs` (runLegacyScanCached), `lib/scan-scheduler-next/project-cache-plan.mjs` (T21_PROJECT_GRAPH_DRAFT, buildProjectCachePlan), `lib/scan-scheduler-next/scheduler.mjs` (runTaskGraph), `node:crypto` (createHash), `node:fs`, `node:path` |
| `resource-budget.mjs` | none |
| `scheduler.mjs` | none |

Functions are listed with their positional parameters and the properties of their options object. The defaults table gives the default of each parameter as it is written in the source.

| function | module | async | positional parameters | options object |
| --- | --- | --- | --- | --- |
| `createCacheIndex` | `cache-index.mjs` | no | `repoRoot` | `relativePath`, `lockName` |
| `collectArtifactGarbage` | `gc.mjs` | no | `storeRoot` | `reachable`, `dryRun`, `minAgeMs`, `nowMs`, `maxDeleteCount`, `maxDeleteBytes` |
| `createArtifactStore` | `store.mjs` | no | `storeRoot` | `maxArtifactBytes` |
| `buildScanCacheKey` | `cache-key.mjs` | no | - | `namespace`, `sourceDigest`, `resolverDigest`, `configDigest`, `parserDigest`, `adapterDigest`, `schemaDigest`, `policyDigest`, `runtimeFingerprint` |
| `digestJson` | `cache-key.mjs` | no | `value` | - |
| `sha256Bytes` | `cache-key.mjs` | no | `value` | - |
| `stableJson` | `cache-key.mjs` | no | `value` | - |
| `runCachedTask` | `cache-runtime.mjs` | yes | - | `cacheKey`, `cacheIndex`, `artifactStore`, `compute`, `dependencies`, `metadata`, `serialize`, `deserialize`, `validate` |
| `buildFileIndex` | `file-index.mjs` | no | `repoRoot` | `excludedDirs`, `include`, `maxFiles`, `maxBytes` |
| `indexEntryMap` | `file-index.mjs` | no | `index` | - |
| `portablePathIssuesForPaths` | `file-index.mjs` | no | `paths` | - |
| `computeInvalidation` | `invalidation.mjs` | no | - | `previousIndex`, `nextIndex`, `dependencyEdges`, `globalInputsChanged` |
| `runLegacyScanCached` | `legacy-cache.mjs` | yes | - | `repoRoot`, `cacheRoot`, `adapter`, `terms`, `rgAvailable`, `implementationDigest`, `cacheNamespace`, `policyFingerprint`, `runtimeFingerprint`, `useCache`, `indexOptions` |
| `evaluatePerformanceGate` | `performance-policy.mjs` | no | - | `baseline`, `candidate`, `policy` |
| `buildProjectCachePlan` | `project-cache-plan.mjs` | no | `graph` | `includeFallback` |
| `propagateProjectInvalidation` | `project-cache-plan.mjs` | no | `graph`, `changedProjectIds` | - |
| `runProjectGraphCached` | `project-cache-runner.mjs` | yes | - | `repoRoot`, `cacheRoot`, `graph`, `adapters`, `implementationDigests`, `terms`, `rgAvailable`, `includeFallback`, `useCache`, `policyFingerprint`, `maxConcurrency`, `maxEstimatedBytesInFlight`, `reservationBaseBytes`, `reservationSourceMultiplier` |
| `deriveMemoryAdmission` | `resource-budget.mjs` | no | - | `totalBytes`, `reserveFraction`, `minReserveBytes`, `maxAdmissionBytes` |
| `runTaskGraph` | `scheduler.mjs` | yes | `tasks`, `worker` | `maxConcurrency`, `maxEstimatedBytesInFlight` |

| function | parameter | default |
| --- | --- | --- |
| `createCacheIndex` | `relativePath` | `'.sbf/cache-next/index.json'` |
| `createCacheIndex` | `lockName` | `'t21-cache-index'` |
| `collectArtifactGarbage` | `reachable` | `[]` |
| `collectArtifactGarbage` | `dryRun` | `true` |
| `collectArtifactGarbage` | `minAgeMs` | `0` |
| `collectArtifactGarbage` | `nowMs` | `Date.now()` |
| `collectArtifactGarbage` | `maxDeleteCount` | `10_000` |
| `collectArtifactGarbage` | `maxDeleteBytes` | `1024 * 1024 * 1024` |
| `createArtifactStore` | `maxArtifactBytes` | `512 * 1024 * 1024` |
| `buildScanCacheKey` | `namespace` | `'bskel.scan-cache/1'` |
| `runCachedTask` | `dependencies` | `[]` |
| `runCachedTask` | `metadata` | `null` |
| `runCachedTask` | `serialize` | `defaultSerialize` |
| `runCachedTask` | `deserialize` | `defaultDeserialize` |
| `runCachedTask` | `validate` | `null` |
| `buildFileIndex` | `excludedDirs` | `DEFAULT_EXCLUDED_DIRS` |
| `buildFileIndex` | `include` | `null` |
| `buildFileIndex` | `maxFiles` | `200_000` |
| `buildFileIndex` | `maxBytes` | `2 * 1024 * 1024 * 1024` |
| `computeInvalidation` | `dependencyEdges` | `[]` |
| `computeInvalidation` | `globalInputsChanged` | `false` |
| `runLegacyScanCached` | `cacheRoot` | `repoRoot` |
| `runLegacyScanCached` | `terms` | `[]` |
| `runLegacyScanCached` | `rgAvailable` | `true` |
| `runLegacyScanCached` | `cacheNamespace` | `null` |
| `runLegacyScanCached` | `policyFingerprint` | `null` |
| `runLegacyScanCached` | `runtimeFingerprint` | `defaultRuntimeFingerprint()` |
| `runLegacyScanCached` | `useCache` | `true` |
| `runLegacyScanCached` | `indexOptions` | `{}` |
| `evaluatePerformanceGate` | `policy` | `{}` |
| `buildProjectCachePlan` | `includeFallback` | `false` |
| `runProjectGraphCached` | `cacheRoot` | `repoRoot` |
| `runProjectGraphCached` | `terms` | `[]` |
| `runProjectGraphCached` | `rgAvailable` | `true` |
| `runProjectGraphCached` | `includeFallback` | `false` |
| `runProjectGraphCached` | `useCache` | `true` |
| `runProjectGraphCached` | `policyFingerprint` | `null` |
| `runProjectGraphCached` | `maxConcurrency` | `4` |
| `runProjectGraphCached` | `maxEstimatedBytesInFlight` | `512 * 1024 * 1024` |
| `runProjectGraphCached` | `reservationBaseBytes` | `8 * 1024 * 1024` |
| `runProjectGraphCached` | `reservationSourceMultiplier` | `4` |
| `deriveMemoryAdmission` | `reserveFraction` | `0.25` |
| `deriveMemoryAdmission` | `minReserveBytes` | `8 * 1024 * 1024 * 1024` |
| `deriveMemoryAdmission` | `maxAdmissionBytes` | `null` |
| `runTaskGraph` | `maxConcurrency` | `4` |
| `runTaskGraph` | `maxEstimatedBytesInFlight` | `512 * 1024 * 1024` |

The two factories return handles. The table lists the fields and the methods of each with their parameters; a method is synchronous unless the table says yes in the async column.

| handle | member | async | positional parameters | options object | defaults |
| --- | --- | --- | --- | --- | --- |
| `artifact_store` | `root` | field | - | - | - |
| `artifact_store` | `put` | no | `content` | - | - |
| `artifact_store` | `has` | no | `ref` | - | - |
| `artifact_store` | `read` | no | `ref` | - | - |
| `artifact_store` | `pathForDigest` | no | `digest` | - | - |
| `cache_index` | `schema` | field | - | - | - |
| `cache_index` | `path` | field | - | - | - |
| `cache_index` | `get` | no | `cacheKey` | - | - |
| `cache_index` | `set` | no | `cacheKey`, `artifactRef` | `dependencies`, `metadata` | dependencies = `[]`, metadata = `null` |
| `cache_index` | `remove` | no | `cacheKey` | - | - |
| `cache_index` | `list` | no | - | - | - |
| `cache_index` | `invalidateDependencies` | no | `paths` | - | - |
| `cache_index` | `reachableArtifactRefs` | no | - | - | - |

## 3. Inputs and outputs

Inputs are plain values: paths as strings, digests as 64 lowercase hexadecimal characters, option objects, arrays, and two documents that other tracks produce or define. One is a scan report (`sbf.scan-report/2`), produced by the stable scanner and validated on every miss and every hit of the legacy path. The other is a project graph (`sbf.project-graph/draft-1`), whose schema belongs to another track and is still a draft. Section 5 lists what happens when an input is missing, damaged or stale.

Outputs are plain objects. The table gives the keys of each kind of object in the order the code writes them. The third column lists the keys that exist only in some results of that kind, with the case stated in section 5. The test compares each list with every object of that kind that real calls return.

| output | keys | extra keys when |
| --- | --- | --- |
| `store_ref` | {algorithm, digest, size} | - |
| `cache_key` | {algorithm, digest, material} | - |
| `cache_key_material` | {namespace, source_digest, resolver_digest, config_digest, parser_digest, adapter_digest, schema_digest, policy_digest, runtime_fingerprint} | - |
| `cache_index_entry` | {artifact, dependencies} | {metadata} |
| `cache_index_listing_item` | {cache_key, artifact, dependencies} | {metadata} |
| `file_index` | {schema, source_digest, entries, stats, skipped_symlinks, portable_path_issues} | - |
| `file_index_entry` | {path, size, mode, sha256} | - |
| `file_index_stats` | {files, bytes, directories_visited, skipped_symlinks} | - |
| `portable_path_issue` | {kind, paths} | - |
| `invalidation` | {schema, added, deleted, modified, changed, invalidated, global_inputs_changed} | - |
| `memory_admission` | {schema, status, total_bytes, reserve_fraction, fractional_reserve_bytes, min_reserve_bytes, required_reserve_bytes, admission_bytes, max_admission_bytes} | {reason} |
| `scheduler_result` | {schema, results, metrics} | - |
| `scheduler_metrics` | {tasks, started, passed, failed, blocked, peak_concurrency, peak_estimated_bytes_in_flight, max_ready_queue, byte_admission_deferrals, concurrency_admission_deferrals, resource_budget_blocked, dependency_blocked} | - |
| `task_passed` | {id, status, value} | - |
| `task_failed` | {id, status, error} | - |
| `task_blocked_dependency` | {id, status, reason, dependency} | - |
| `task_blocked_budget` | {id, status, reason, estimated_bytes, budget_bytes} | - |
| `gc_result` | {schema, dry_run, reachable, total_blobs, candidates, candidate_bytes, deleted, unexpected} | - |
| `gc_item` | {digest, size, relative_path} | - |
| `performance_gate` | {schema, status, environment, policy, checks} | - |
| `performance_policy` | {minSamples, maxColdRegressionPct, maxPeakRssRegressionPct, maxCacheHitFractionOfCold} | - |
| `performance_check` | {status, code, workload, actual, limit, detail} | - |
| `performance_gate_early` | {schema, status, checks} | - |
| `cached_task_result` | {cache_hit, value, artifact} | - |
| `project_plan` | {schema, graph_schema, projects} | - |
| `project_plan_item` | {project_id, project_root, adapter_id, mode, dependency_project_ids, cache_namespace, markers} | - |
| `project_marker` | {path, kind, digest} | - |
| `legacy_result` | {schema, cache_used, cache_hit, cache_key, source_digest, report, artifact} | - |
| `legacy_index_metadata` | {adapter_id, cache_contract, source_digest} | - |
| `project_run` | {schema, graph_schema, plan_schema, results, metrics} | - |
| `project_run_value` | {project_id, project_root, adapter_id, cache_namespace, cache_hit, cache_key, source_digest, report, artifact} | - |

Some names belong to the contracts of other tracks: the schemas listed as foreign in the schema table of section 4 and the key names artifact_ref, byte_sha256, size_bytes, media_type and contract_hash. This layer neither produces nor consumes them. The reference that the store returns is the three-key store_ref object, which has no schema string, and a test fails if a foreign schema string appears in the code.

## 4. Identity

A cached result is identified by two values that never share a role. The artifact id names bytes: it is the sha256 of the exact content, so the same bytes are the same artifact wherever they were produced. The cache key names a question: it is the sha256 of the canonical JSON of everything that the answer depends on, and the cache index maps a key to the artifact that answers it. The constants and schema strings below are the version markers of the layer.

| constant | module | value |
| --- | --- | --- |
| `DEFAULT_EXCLUDED_DIRS` | `file-index.mjs` | `[".git",".sbf","node_modules",".venv","venv","__pycache__","coverage","dist","build"]` |
| `T21_PROJECT_CACHE_PLAN_DRAFT` | `project-cache-plan.mjs` | `"sbf.project-cache-plan/draft-1"` |
| `T21_PROJECT_GRAPH_DRAFT` | `project-cache-plan.mjs` | `"sbf.project-graph/draft-1"` |

| schema string | role | carried by |
| --- | --- | --- |
| `bskel.scan-cache/1` | output | `cache_key_namespace` |
| `sbf.scan-cache-index/1` | output | `cache_index` |
| `sbf.scan-file-index/1` | output | `file_index` |
| `sbf.scan-invalidation/1` | output | `invalidation` |
| `sbf.scan-memory-admission/1` | output | `memory_admission` |
| `sbf.scan-scheduler-result/1` | output | `scheduler_result` |
| `sbf.scan-performance-gate/1` | output | `performance_gate` |
| `sbf.artifact-gc-result/1` | output | `gc_result` |
| `sbf.legacy-scan-cache-result/1` | output | `legacy_result` |
| `sbf.project-scan-cache-shadow/draft-1` | output | `project_run` |
| `sbf.project-cache-plan/draft-1` | output | `project_plan` |
| `sbf.scan-report/2` | input, read and never written | `scan_report` |
| `sbf.project-graph/draft-1` | input, read and never written | `project_graph` |
| `t21-legacy-scan-shadow/1` | contract tag stored in index metadata | `legacy_shadow` |
| `sbf.artifact-ref/1` | foreign: neither produced nor consumed by this layer | - |
| `sbf.contract-ref/1` | foreign: neither produced nor consumed by this layer | - |
| `sbf.identity-envelope/1` | foreign: neither produced nor consumed by this layer | - |
| `sbf.action-ref/1` | foreign: neither produced nor consumed by this layer | - |
| `sbf.field-ref/1` | foreign: neither produced nor consumed by this layer | - |

The key is built by buildScanCacheKey from a namespace (default `bskel.scan-cache/1`), the digests and the runtime fingerprint. Its digest is digestJson of the material, and the material is returned beside it. The legacy single-project scan derives the digests and the fingerprint as follows.

| key field | derived from |
| --- | --- |
| `sourceDigest` | the source_digest of the file index of repoRoot |
| `resolverDigest` | digestJson of object with exact fields mode='legacy-single-project'; cache_namespace=cacheNamespace; adapter_id=descriptor.id; rg_available=Boolean(rgAvailable); include_db=false; runtime_routes=false |
| `configDigest` | digestJson({ terms }), an object wrapper, not digestJson(terms) |
| `parserDigest` | implementationDigest as given by the caller |
| `adapterDigest` | digestJson of object with fields implementation_digest=implementationDigest and descriptor=adapterSnapshot(adapter); descriptor has contract, id, title, specificity, confidence, verification_basis and capabilities |
| `schemaDigest` | digestJson({ scan_schema: 'sbf.scan-report/2' }), an object wrapper, not digestJson('sbf.scan-report/2') |
| `policyDigest` | digestJson of object with exact fields cache_contract='t21-legacy-scan-shadow/1'; external_policy_fingerprint=policyFingerprint; db='disabled'; runtime_routes='disabled'; cache_corruption='fail-closed' |
| `runtimeFingerprint` | as given; the default is node=VERSION;platform=PLATFORM;arch=ARCH of the running process |

The project path gives each planned project a cache_namespace, which is the digest of:

- graph_schema, the schema string of the project graph
- project_id and project_root
- adapter_id, and mode: first-class from the selected adapter, fallback only when includeFallback is set
- markers: path, kind and digest of each marker, sorted by path and kind
- dependency_project_ids: only local-package-dependency edges, from the consumer to the dependency

The source digest of a tree is the digest of its file index. Each entry of the index holds:

- path of the file
- size in bytes
- mode, permission bits only
- sha256 of the content

The source digest does not depend on, and a change of any of these leaves it as it was:

- modification time
- symlinks, which are listed in skipped_symlinks and never followed
- empty directories
- the absolute path of the root
- portable path findings
- the contents of a directory named in excludedDirs, at any depth

The default excluded directory names include node_modules; the constants table lists all of them.

Numbered statements. Each has a test of the same number.

- **I1** The cache key digest is the digest of the key material, and the material holds exactly the fields listed for cache_key_material, written in snake case from the nine inputs of buildScanCacheKey.
- **I2** Every input of buildScanCacheKey moves the digest when it changes, including the namespace; the order of the properties of the input and a property that the function does not know do not move it.
- **I3** A digest input must be 64 lowercase hexadecimal characters and the runtime fingerprint a non-empty string, otherwise a TypeError names the input. A call without an argument is a raw TypeError.
- **I4** Canonical JSON writes the keys of an object in one order whatever the insertion order (keys that look like integers first, in numeric order, then the others by code unit). It refuses undefined, functions, symbols, bigint and non-finite numbers with a TypeError that names the path, and it writes Date, Map and Set values as empty objects, so they must not be used as key material.
- **I5** An artifact is identified by the sha256 of its exact bytes: a string, a Buffer and a Uint8Array with the same bytes give the same reference (algorithm, digest and size) and one blob, the blob lives at the path derived from the digest, a different byte gives a different artifact, and empty content is a valid artifact.
- **I6** The source digest covers the path, size, mode and content hash of every regular file below the root in sorted order. A new root, a new modification time, an empty directory, a symbolic link, an excluded directory at any depth and a portable path finding leave it as it was; a mode change or a content change moves it.
- **I7** The legacy scan key is the one the identity table derives: the test recomputes it from the table, including the adapter snapshot. A second call with the same inputs is a cache hit with the same key and artifact, the index metadata names the adapter, the contract tag and the source digest, a change of the terms, the implementation digest, the cache namespace, the policy fingerprint, the runtime fingerprint or rgAvailable gives another key, and useCache false reports cache_used false and no artifact.
- **I8** A project namespace is the digest of the graph schema, the project id and root, the adapter id, the mode, the markers and the dependency project ids. A changed marker moves the namespace of the project that holds it, a cut edge moves the namespace of the consumer and not of its dependency, and the order of the projects in the graph does not matter.

## 5. Unknown, partial and stale

In the cases that the claims of this section run on real calls, the layer returns one of the codes or statuses below, or throws; it does not guess, repair or fall back. The recorded limits (section 7) name inputs that it does not refuse, such as a symbolic link inside the repository that points outside it. A code is the code property of a thrown error, the reason of a blocked task or admission, or the code of a gate check.

| code | kind | module | properties or status | meaning |
| --- | --- | --- | --- | --- |
| `ARTIFACT_BUDGET_EXCEEDED` | error code | `store.mjs` | code | put refuses content larger than maxArtifactBytes and writes nothing |
| `ARTIFACT_CORRUPT` | error code | `store.mjs` | code | stored bytes differ from the reference in size or digest, on read or on the read-back after a write; nothing is repaired |
| `ARTIFACT_NOT_FOUND` | error code | `store.mjs` | code | read of a reference whose blob is absent |
| `INDEX_BUDGET_EXCEEDED` | error code | `file-index.mjs` | actual, code, kind, limit | file count or byte count above maxFiles or maxBytes; no partial index is returned |
| `PROJECT_ADAPTER_UNAVAILABLE` | error code | `project-cache-runner.mjs` | code | the plan names an adapter that is not among the given adapters |
| `PROJECT_GRAPH_ROOT_MISMATCH` | error code | `project-cache-runner.mjs` | code | the graph root is neither a dot nor the absolute execution root |
| `PROJECT_GRAPH_STALE` | error code | `project-cache-runner.mjs` | actual_digest, code, expected_digest | a marker file changed after graph discovery; a marker that is missing or unreadable carries only code |
| `DEPENDENCY_NOT_PASSED` | reason | `scheduler.mjs` | - | a task named in dependsOn failed or was blocked, so this task never ran; the result names that dependency |
| `RESOURCE_BUDGET_EXCEEDED` | reason | `scheduler.mjs` | - | estimatedBytes of the task alone exceed maxEstimatedBytesInFlight; the result carries estimated_bytes and budget_bytes |
| `INSUFFICIENT_MEMORY_AFTER_RESERVE` | reason | `resource-budget.mjs` | - | nothing is left to admit after the reserve; status is blocked and admission_bytes is zero |
| `MISSING_ENVIRONMENT_IDENTITY` | gate check | `performance-policy.mjs` | blocked | baseline or candidate environment lacks profile_id, platform, arch or node_major; the result holds this check alone |
| `ENVIRONMENT_MISMATCH` | gate check | `performance-policy.mjs` | blocked | baseline and candidate environments differ; the result holds this check alone |
| `WORKLOAD_SET_MISMATCH` | gate check | `performance-policy.mjs` | blocked | a workload id exists on one side only |
| `INSUFFICIENT_SAMPLES` | gate check | `performance-policy.mjs` | blocked | fewer samples than minSamples on either side |
| `SEMANTIC_MISMATCH` | gate check | `performance-policy.mjs` | fail | semantic_equivalence is false |
| `SEMANTIC_EQUIVALENCE_UNPROVEN` | gate check | `performance-policy.mjs` | blocked | semantic_equivalence is neither true nor false |
| `MISSING_OR_INVALID_METRIC` | gate check | `performance-policy.mjs` | blocked | a required metric is not a finite positive number |
| `COLD_REGRESSION_PCT` | gate check | `performance-policy.mjs` | pass or fail | candidate cold_p95_ms against baseline cold_p95_ms, limit maxColdRegressionPct |
| `PEAK_RSS_REGRESSION_PCT` | gate check | `performance-policy.mjs` | pass or fail | candidate peak_rss_bytes against baseline peak_rss_bytes, limit maxPeakRssRegressionPct |
| `CACHE_HIT_FRACTION_OF_COLD` | gate check | `performance-policy.mjs` | pass or fail | candidate cache_hit_p95_ms divided by candidate cold_p95_ms, limit maxCacheHitFractionOfCold |

| status set | applies to | field | values | module |
| --- | --- | --- | --- | --- |
| `scheduler_task_status` | each task result of the scheduler | `status` | passed, failed, blocked | `scheduler.mjs` |
| `memory_admission_status` | each memory admission | `status` | ready, blocked | `resource-budget.mjs` |
| `performance_gate_status` | the gate result | `status` | pass, fail, blocked | `performance-policy.mjs` |
| `performance_check_status` | each gate check | `status` | pass, fail, blocked | `performance-policy.mjs` |
| `project_plan_mode` | each planned project | `mode` | first-class, fallback | `project-cache-plan.mjs` |
| `portable_issue_kind` | each portable path finding | `kind` | case-fold-collision, unicode-nfc-collision | `file-index.mjs` |
| `index_budget_kind` | the kind property of INDEX_BUDGET_EXCEEDED | `kind` | file-count, byte-count | `file-index.mjs` |

Unknown is reported as blocked or as an error: a gate without an environment identity, without proof of semantic equivalence or without a valid metric is blocked, and a reference to a blob that does not exist is ARTIFACT_NOT_FOUND. **Important GC limit:** the historical `collectArtifactGarbage` output has **no partial/completeness marker**. With count/byte caps, its candidates are only the digest-ordered prefix until the first candidate exceeds either cap; it stops rather than searching later smaller blobs. Even an empty candidate list may be truncated: sizes 20, 5, 7 with `maxDeleteBytes=6` yield zero chosen blobs, not zero eligible blobs. Treat a capped result as potentially **PARTIAL/UNKNOWN**, never as an exhaustive deletion inventory. No historical source or recorded baseline is rewritten by this documentation. Partial is not returned as complete in these cases: a file index over its budget throws INDEX_BUDGET_EXCEEDED and returns nothing, a blob that is truncated is ARTIFACT_CORRUPT, and a task whose dependency did not pass is blocked. Stale is named: a project graph whose marker changed is PROJECT_GRAPH_STALE, and an index entry that depends on a changed path is removed by invalidateDependencies.

The performance gate compares a candidate with a baseline under these defaults. A policy field that is given must be of the right type, otherwise the gate throws a TypeError.

| policy field | default |
| --- | --- |
| `minSamples` | `5` |
| `maxColdRegressionPct` | `15` |
| `maxPeakRssRegressionPct` | `15` |
| `maxCacheHitFractionOfCold` | `0.5` |

- **U1** A blob is trusted only after a read has checked its size and its sha256. A truncated blob, a blob with other bytes and a reference with the wrong size raise ARTIFACT_CORRUPT and the blob is left as found; a reference to no blob raises ARTIFACT_NOT_FOUND; has answers existence only and says true for a truncated blob; a reference that is not a sha256 reference is a TypeError and not a code.
- **U2** Content over maxArtifactBytes raises ARTIFACT_BUDGET_EXCEEDED before anything is written, and content of exactly that size is accepted.
- **U3** An index file that is not valid JSON, that does not carry the index schema, or that holds a reference that is not a sha256 reference fails every read and every write, and a failed write leaves the file as it was. A missing index file is an empty index, and reading it does not create the file.
- **U4** On a cache hit a missing or corrupt blob raises ARTIFACT_NOT_FOUND or ARTIFACT_CORRUPT and the task is not computed again behind it. A value that validate rejects is stored nowhere.
- **U5** A file index over maxFiles or maxBytes fails as a whole with INDEX_BUDGET_EXCEEDED and the properties kind, limit and actual; there is no partial index. A limit of NaN disables that budget. A root that does not exist is the raw ENOENT of the system and a file given as root is ENOTDIR.
- **U6** A task whose worker throws is failed with the message of the error. A task whose dependency did not pass is blocked with DEPENDENCY_NOT_PASSED and the id of the dependency. A task whose estimatedBytes exceed maxEstimatedBytesInFlight is blocked with RESOURCE_BUDGET_EXCEEDED and never started, and a task of exactly that size runs. A task is passed only when its worker returned.
- **U7** The performance gate does not pass on the unknown inputs listed here. A missing environment identity, an environment mismatch, a workload set mismatch, too few samples, unproven semantic equivalence and an invalid metric are blocked, a proven semantic mismatch fails, and only a candidate whose measured checks are inside the policy passes. Two empty workload lists pass vacuously, which the caller must guard against.
- **U8** Memory admission is ready only when something is left after the reserve. With nothing left it is blocked with INSUFFICIENT_MEMORY_AFTER_RESERVE and admission_bytes 0, and the reason key exists only on a blocked result.
- **U9** A project graph that is stale or does not belong to the repository is refused before any scan and without needing ripgrep, each case with its own code: PROJECT_GRAPH_STALE (with expected_digest and actual_digest when a marker changed, with the code alone when a marker is missing or unreadable), PROJECT_GRAPH_ROOT_MISMATCH and PROJECT_ADAPTER_UNAVAILABLE. A missing implementation digest is a plain Error without a code.
- **U10** Invalidation classifies a path as added, deleted or modified and widens the changed set by its transitive dependents. globalInputsChanged invalidates every path of both indexes. The cache index drops the entries that depend on a path with invalidateDependencies, and an empty list changes nothing.

## 6. Consistency and failure

Blob and index writes go through a temporary file and a rename, and nothing is flushed to disk; correctness is checked on read. Index writers exclude each other on one host only when they use the same lockName; collection takes no lock. The statements below are what a caller may rely on and what it must guard against.

- **F1** A blob is written to a temporary file next to its final path, created exclusively with owner-only permissions (octal 600), and renamed into place. A temporary file left behind is not a blob. A put over an existing blob reads it back, and if the bytes differ it raises ARTIFACT_CORRUPT and leaves the blob as found; a blob is never repaired or overwritten.
- **F2** Writers of the cache index exclude each other only when they use the same repository root and the same lockName. A writer created with another lockName is not held back by that lock, so callers that share an index must agree on lockName. The readers take no lock and the lock is not re-entrant. A writer waits up to a timeout and then fails with an error that names the lock. A lock directory left by a crashed holder is not broken by a waiting writer, so a person must remove it; until then reads work and the writers that use that lockName fail without touching the index file.
- **F3** Collection is a dry run by default. The capped list is a digest-ordered prefix, not a complete eligibility inventory; the historical result lacks a partial marker and callers must treat it as potentially incomplete. It selects only blobs that nothing refers to, that are older than minAgeMs and that fit within maxDeleteCount and maxDeleteBytes. Everything else below the store (temporary files, symbolic links, directories with a wrong prefix) is listed as unexpected and never deleted.
- **F4** The caller owns the hazards of collection. The candidate byte/count caps stop at the first over-budget blob without considering later smaller blobs; an empty capped list can conceal eligible candidates. A falsy dryRun deletes, null included. An omitted reachable list means that nothing is reachable, so a call with dryRun false deletes every aged blob. The two limits bound the candidates, the clock is the argument nowMs, so a modification time in the future selects nothing against a small nowMs, and collection takes no lock and does not coordinate with writers. A store root that does not exist gives an empty result.
- **F5** No write path of the layer calls fsync, so the newest write may be missing or truncated after a power loss. A truncated blob is caught on read (U1) and a truncated index fails closed (U3). Durability is not claimed.
- **F6** The containment of the cache index path is lexical: the path is normalized against the root and only the normalized destination is judged. A path whose normalized destination lies outside the repository is refused with an error. A path with a parent segment whose normalized destination lies inside is accepted, and so is an absolute path inside the root. A symbolic link inside the repository that points outside is followed, so the index is written outside the repository. This is the recorded limit cache-index-containment-is-lexical.
- **F7** The scheduler admits work only inside maxConcurrency and maxEstimatedBytesInFlight, and the metrics peak_concurrency and peak_estimated_bytes_in_flight stay inside them. It has no timeout and no cancellation path, because the module has no timer and no abort signal, so one worker that never settles holds the whole run. This is the recorded limit scheduler-has-no-timeout-or-cancellation.
- **F8** Superseded entries are never retired. A new key does not remove the entry of an older key: the old entry stays listed, and the blob it names stays reachable, until the caller removes the entry. Two entries can name one blob, because the store keeps one blob per digest, so a new key does not always add a blob. A blob becomes a collection candidate only when no entry refers to it. This is the recorded limit superseded-cache-entries-are-never-retired.
- **H1** A malformed task graph is refused before any worker runs, with an error that names the task: a duplicate id, a missing dependency, a self dependency, a cycle, an empty id, a dependsOn that is not an array of strings, a negative or fractional estimatedBytes, tasks that are not an array, a worker that is not a function, and a maxConcurrency that is not a positive integer.
- **H2** Hostile identifiers such as __proto__ and constructor are plain data in the scheduler, the file index, the invalidation and the project plan, and no prototype is changed. A cache key must be 64 hexadecimal characters, so such a name is a TypeError there.

## 7. Promotion gates

Nothing in this change promotes the layer. The record `lib/scan-scheduler-next/BASELINE.json` pins the base commit, the size, git blob id and sha256 of the files it lists (the files of the layer, its tests and the external files that the pinned tests load; the installed packages are compared by version only), the replayed outputs of normal and negative fixtures, the commands that were run with their exit codes and counts, and the limits of what it proves. The baseline test `test/perf-next/baseline-record.test.mjs` verifies the record, and it also compares this RFC and the README with it.

| record fact | value |
| --- | --- |
| schema | `bskel.track-baseline-record/2` (provisional) |
| base commit | `15a38e923cb5e079c6f8e2a4c2a9386406c41f52` |
| pinned files | 13 source, 11 test, 3 test support, 92 external dependency, 1 runner |
| fixtures | 13 normal, 23 negative |
| limits | 8 UNSUPPORTED, 3 UNKNOWN, 1 BLOCKED, 10 NOT_RECORDED |
| artifact digest | `ebb193e0cffad6667e7249074e595727ef287c7917464bc8d4ae366618250e49` |

The pinned files hold 58 tests and all of them pass at the base commit. The nested runner prints `NESTED_SUITE T21 RUN 11 files` at the base commit. The live tree prints a count two higher once the two test files of this change are present, because the runner counts every test file in the test directory.

| test file | tests | what it covers |
| --- | --- | --- |
| `t21-artifact-gc.test.mjs` | 4 | dry run by default and reachable blobs never selected, apply deletes only unreachable age-qualified blobs, malformed entries reported and not deleted, deletion budgets |
| `t21-artifact-store.test.mjs` | 3 | deduplication by exact bytes with verified reads, corruption detection, byte budget before write |
| `t21-benchmark-smoke.test.mjs` | 1 | legacy-cache benchmark emits machine-readable semantic-equivalence evidence |
| `t21-cache-index.test.mjs` | 5 | exact artifact refs and sorted listing, fail closed on corrupted state, path containment, two OS processes keep both entries, dependency invalidation |
| `t21-cache-key.test.mjs` | 3 | determinism across key order, every dimension invalidates, malformed digests and ambiguous JSON refused |
| `t21-cache-runtime.test.mjs` | 4 | miss computes once and a hit returns the same value, changed key recomputes, corrupt artifact fails closed, validation on misses and hits |
| `t21-file-index-invalidation.test.mjs` | 5 | deterministic content-addressed index with excluded directories, transitive invalidation, global input drift, budgets fail closed, portability collisions |
| `t21-legacy-cache-equivalence.test.mjs` | 8 | key changes with terms and implementation revision, missing implementation identity refused, project namespace changes the key and not the report, cached reports equal uncached ones per adapter fixture |
| `t21-performance-policy.test.mjs` | 9 | memory admission reserve and cap, gate decisions for pass, fail and blocked inputs |
| `t21-project-cache.test.mjs` | 10 | plan order and fallback exclusion, invalidation propagation, cache off, miss and hit, portable graph in another checkout, marker drift, policy fingerprint, corrupted cache, namespace change |
| `t21-scheduler.test.mjs` | 6 | dependency order, concurrency and byte reservations, oversized task blocking, failure containment, graph refusals before work, metrics |

A limit of the record is closed only by evidence in a later change. The gates below group the limits (statuses UNSUPPORTED, UNKNOWN, BLOCKED and NOT_RECORDED) and state what lifts each gate. No gate is lifted by this change, and the layer stays a shadow until all of them are.

| gate | limits it must close | lifted when |
| --- | --- | --- |
| `reachability` | `stable-scan-does-not-use-the-layer` (UNSUPPORTED); `layer-mentioned-outside-its-directories` (UNKNOWN) | a reviewed consumer calls the layer behind a switch that is off by default, every reference outside the two directories is listed and classified, and the stable scan result is byte-identical with the switch off |
| `suite-in-ci` | `root-npm-test-does-not-run-the-suite` (UNSUPPORTED) | the T21 suite runs in a required check or in the root test script, with the job names pinned to the commit under test |
| `packed-import` | `layer-ships-in-the-npm-package-without-a-packed-import-test` (NOT_RECORDED) | a test packs the package, installs it in a scratch directory and imports every exported name of both directories, and the packed file list is recorded |
| `timing` | `old-container-baseline-is-advisory-not-an-exact-commit-measurement` (NOT_RECORDED); `warm-is-a-same-process-rehash-not-a-cache-hit` (NOT_RECORDED); `benchmark-covers-one-adapter-once-in-a-pinned-test` (NOT_RECORDED); `performance-gate-has-no-approved-input-and-no-slo` (BLOCKED) | a measurement protocol is approved, measurements are taken at the exact commit for every adapter on the target hosts, the warm path is a real cache hit, and an approved service level objective is the input of the gate; until then the gate stays blocked |
| `containment` | `cache-index-containment-is-lexical` (UNSUPPORTED); `project-root-containment-is-lexical` (UNSUPPORTED); `legacy-cache-reports-embed-the-creating-trees-paths` (UNSUPPORTED); `file-index-skips-directories-the-stable-scan-reads` (UNSUPPORTED) | containment is checked on resolved real paths, a copied tree cannot serve a report that embeds another tree, and the file index reads the directories the stable scan reads or the difference is the stated cache scope |
| `retention` | `superseded-cache-entries-are-never-retired` (UNSUPPORTED); `gc-takes-no-lock-and-its-clock-is-an-argument` (UNKNOWN); `scheduler-has-no-timeout-or-cancellation` (UNSUPPORTED) | a stated policy retires superseded entries, collection and writers exclude each other under one lock with a clock the caller cannot choose, and the scheduler has a timeout and a cancellation path that a test exercises |
| `project-graph-input` | `project-graph-input-is-a-draft-schema` (UNKNOWN) | the owner of the project graph freezes its schema and this layer reads the frozen reference, with cache namespaces compared before and after |
| `platform-coverage` | `hashes-generated-on-one-platform` (NOT_RECORDED) | the record is regenerated and compared on every platform the pipeline uses, and each difference is listed |
| `promotion` | `no-consumer-runner-or-provider-integration` (NOT_RECORDED); `no-promotion-rollback-or-supported-scope-evidence` (NOT_RECORDED) | an integration is reviewed and merged by its owner, and a rollback plan, a supported-scope record and approvable evidence exist (items T21-05 and T21-06 of the track plan) |

Three limits have no gate:

| limit | status | why it has no gate |
| --- | --- | --- |
| `fixtures-are-synthetic-inputs` | NOT_RECORDED | the replayed inputs are small constructed trees and copies of pinned fixtures; the record never claims they represent real repositories, so nothing is promoted on them |
| `installed-package-files-are-not-hashed` | NOT_RECORDED | package-lock.json and the installed versions are recorded; hashing installed files would pin the machine, so the statement stays a limit |
| `scenario-module-is-not-hashed` | NOT_RECORDED | baseline-scenarios.mjs builds the replayed calls; the outputs it must reproduce are pinned, so a change to it matters only when an output changes |

## 8. File ownership

The original RFC baseline spans the three source/test directories that the ownership map gives to T21; the later immutable execution transcript is recorded separately under the T21-owned next/t21 evidence directory. The table lists their files as they are in the tree; the test compares it with the directory listings. Each changed path was checked with `node next/t00/check-ownership.mjs paths --track T21`.

| directory | files |
| --- | --- |
| `lib/artifact-store-next` | `README.md`, `cache-index.mjs`, `gc.mjs`, `store.mjs` |
| `lib/scan-scheduler-next` | `BASELINE.json`, `INTERFACE_RFC.md`, `cache-key.mjs`, `cache-runtime.mjs`, `file-index.mjs`, `invalidation.mjs`, `legacy-cache.mjs`, `performance-policy.mjs`, `project-cache-plan.mjs`, `project-cache-runner.mjs`, `resource-budget.mjs`, `scheduler.mjs` |
| `test/perf-next` | `baseline-record-lib.mjs`, `baseline-record.test.mjs`, `baseline-scenarios.mjs`, `baselines/2026-09-25-container.json`, `benchmark.mjs`, `legacy-cache-benchmark.mjs`, `t21-artifact-gc.test.mjs`, `t21-artifact-store.test.mjs`, `t21-benchmark-smoke.test.mjs`, `t21-cache-index.test.mjs`, `t21-cache-key.test.mjs`, `t21-cache-runtime.test.mjs`, `t21-file-index-invalidation.test.mjs`, `t21-interface-execution-record.test.mjs`, `t21-interface-rfc.test.mjs`, `t21-interface-rfc.vocabulary.json`, `t21-legacy-cache-equivalence.test.mjs`, `t21-performance-policy.test.mjs`, `t21-project-cache.test.mjs`, `t21-scheduler.test.mjs` |

The second table lists every path that this document names or that the record pins, with its owner and what T21 may do with it. The ownership map is `next/t00/ownership-map.json`. A file that no track owns, a file of another track and a reserved file are read, never edited, and the record pins the ones that the layer depends on.

| paths | owner | T21 may |
| --- | --- | --- |
| `lib/artifact-store-next`, `lib/scan-scheduler-next`, `test/perf-next` | T21 | edit |
| `lib/fsutil.mjs`, `lib/lock.mjs`, `scanners/index.mjs`, `scanners/registry.mjs`, `scanners/text-util.mjs`, `scanners/adapters`, `schemas/adapter.schema.json`, `test/fixtures` | none | read-only, pinned by BASELINE.json |
| `scripts/run-next-nested-tests.mjs`, `package-lock.json` | reserved | read-only, pinned by BASELINE.json |
| `.github/workflows`, `package.json`, `CATALOG.md`, `DECISIONS.md`, `README.md` | reserved | read-only |
| `next/t00` | T00 | read-only |
| `contracts/next`, `schemas/next` | T01 | none |
| `scanners/project-graph` | T02 | read-only |
| `scanners/capability-next` | T03 | none |
| `test/conformance-next`, `evidence/next` | T19 | read-only |
| `release/next` | T23 | none |
