# T19 independent delta review — T02 locale-independent ProjectGraph ordering

**Verdict: PASS(T02_LOCALE_INDEPENDENT_ORDERING)**

Reviewed: 2026-09-26

## Scope

Repository: `popixoxipop-collab/backend-skeleton`

T02 PR: #72

Delta only:

- previous HEAD: `989e7d332761ab8bcda453b2af9e84a5102b1281`
- reviewed HEAD: `78afb96442a193cf61183df0d57585be94db3768`
- compare: exactly **1 commit**
- commit: `fix(t02): make project graph ordering locale-independent`

This review is limited to locale-independent ordering, ProjectGraph portability/freshness behavior, and T02-owned-scope discipline. It does **not** promote `sbf.project-graph/draft-1` to a stable/public contract.

## Delta / ownership

Exactly four files changed, all inside the T02 ownership namespaces:

| path | old blob | new blob |
|---|---|---|
| `scanners/project-graph/index.mjs` | `b1ef0d6bdb018a913b02011215251fd4b0c6cf0b` | `b92315836da89fa603c8ec18fe80db07eb373a1a` |
| `scanners/project-graph/registered.mjs` | `d366f35c0b03bc25e3962a5fd08785286d6d641f` | `6c956384de85fb9ba637558a5d683dbd37fc0d51` |
| `test/project-graph/project-graph.test.mjs` | `02175f600ffae78183828ab03ea48b9b8dac57f1` | `8ed05778a4867a8433d7a74115b7b3506c8d988a` |
| `test/project-graph/shadow.test.mjs` | `60c4976f6df30ef51c928acd599f3deffe1343e5` | `77a081412415690c9244a6c1664eae2d60dbc9c3` |

No shared CLI, registry, stable schema, package/lockfile, workflow, or non-T02 product path changed.

## 1. localeCompare removal

The implementation introduces the same ordinal comparator in T02 source:

```js
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
```

The delta replaces locale-sensitive ordering at the relevant T02 serialization points:

- directory entry traversal order;
- marker order;
- project-root order;
- marker-within-project order;
- adapter read-set file order;
- direct-parent tie ordering;
- local package owner ordering;
- package-name map iteration ordering;
- project-edge ordering;
- same-specificity adapter tie ordering;
- nested-detection ordering;
- final `ProjectGraph.projects` ordering;
- `buildProjectScanPlan()` ordering;
- registered adapter load-error ordering.

T19 read every executable `.mjs` file under:

- `scanners/project-graph/**`
- `test/project-graph/**`

including `test/project-graph/real-cohort.mjs`.

Observed `localeCompare` occurrences: **0**.

## 2. Exact-head focused execution

Independent checkout:

- host: EOE
- checkout: `/Users/eoe/mcp-sandbox/tailnet-commander/t19-review-t02`
- branch: `scale/t02/project-graph-foundation`
- HEAD: `78afb96442a193cf61183df0d57585be94db3768`
- worktree: clean

Install:

```bash
npm --prefix t19-review-t02 ci --silent
```

Result: exit 0.

Focused command:

```bash
node --test \
  t19-review-t02/test/project-graph/project-graph.test.mjs \
  t19-review-t02/test/project-graph/registered-adapters.test.mjs \
  t19-review-t02/test/project-graph/shadow.test.mjs \
  t19-review-t02/test/project-graph/source-role.test.mjs
```

Result:

- **33 pass**
- **0 fail**
- **0 skip**
- exit 0

Relevant passed regressions include:

- `project and scan-plan ordering uses locale-independent code-unit ordering`
- `serialized ProjectGraph is worktree-portable while execution root stays process-local`
- `shadow execution rejects marker drift instead of running a stale graph`
- `shadow execution rejects source-content drift even when project markers are unchanged`
- `shadow execution rejects a newly-added source file that changes the adapter read-set`
- `shadow execution rejects a deleted source file that changes the adapter read-set`
- `serialized graph can execute on an equivalent checkout without persisting an absolute root`

The updated portability test additionally compares:
- project-id sequence;
- selected-adapter read-set fingerprints;
- scan plan

across the two equivalent worktrees.

## 3. en-US / ko-KR differential

T19 ran the **same non-ASCII input** against both the previous and reviewed implementation heads in fresh Node child processes with:

- `LANG/LC_ALL=en_US.UTF-8`
- `LANG/LC_ALL=ko_KR.UTF-8`

Fixture project roots:

```text
a
z
ä
가
나
```

The child process confirmed its effective Node locale as `en-US` and `ko-KR`.

### Previous HEAD

`989e7d332761ab8bcda453b2af9e84a5102b1281`

Observed ProjectGraph root order:

- en-US: `., a, ä, z, 가, 나`
- ko-KR: `., 가, 나, a, ä, z`

Observed scan-plan order likewise differed by locale.

Therefore the old implementation had a real locale-dependent serialization defect.

### Reviewed HEAD

`78afb96442a193cf61183df0d57585be94db3768`

Observed ProjectGraph root order under both locales:

```text
., a, z, ä, 가, 나
```

Observed scan plan under both locales:

```text
a  -> node-http
z  -> node-http
ä  -> node-http
가 -> node-http
나 -> node-http
```

Checks:

- same serialized ProjectGraph across en-US / ko-KR: **true**
- same ProjectGraph project order: **true**
- same scan-plan order: **true**
- matches ordinal/code-unit expected order: **true**
- old-head project order was locale-independent: **false**
- old-head scan plan was locale-independent: **false**

Probe result:

- `t19-t02-locale-delta-result.json`
- SHA-256: `138d4c03bfaa18fe76febcf8e72450c8143603132ab4158c9457cfc4db116ba9`

Probe scripts:

- child SHA-256: `26cb967dfd4105c8fe404ace3248e23ff893275faab07d4199c6662e714e1ed7`
- driver SHA-256: `ca169edc9cdaa1db67aa85f96ec3e237dd2959b71796150f70626d5e86744d60`

This independently demonstrates that the new non-ASCII regression is not ceremonial: its expected order disagrees with the prior locale-sensitive implementation and catches the actual defect.

## 4. CI

Exact-head GitHub Actions run:

- workflow: CI
- run: **#1224**
- run id: `36213434791`
- event: pull_request
- head: `78afb96442a193cf61183df0d57585be94db3768`
- conclusion: **SUCCESS**

Observed generic test jobs:

- Node 22: job `108324558276` — success
- Node 24: job `108324558326` — success

Important evidence boundary:

This workflow instance does **not** contain a dedicated `nested-next / T02 project-graph` job/step. Therefore T19 does **not** use generic CI #1224 alone as proof that the T02 nested suite executed. The exact-head 33/33 EOE focused execution above is the direct T02 test evidence; CI #1224 is supplementary repository-regression evidence.

Workflow-conditional:
- macOS: skipped
- Spring Initializr canary: skipped

Those skips are not counted as T02 passes.

## 5. ProjectGraph meaning / identity

The one-commit delta changes ordering mechanics and adds regression coverage only.

It does **not** change or widen:

- `PROJECT_GRAPH_DRAFT` / `sbf.project-graph/draft-1`;
- project discovery meaning;
- project kind semantics;
- project edge kinds;
- adapter selection semantics;
- source-role semantics;
- fallback semantics;
- `project_id` construction.

Project IDs remain derived as:

```text
project:<project-root>
```

The review does not treat that draft identity as a frozen cross-tool stable identity.

## Canonical serialization invariant

For the reviewed T02 draft, the canonical ordering rule is:

> Compare already-normalized strings using JavaScript ordinal comparison
> `a < b ? -1 : a > b ? 1 : 0`.

Operationally this is lexicographic JavaScript UTF-16 code-unit ordering. It is:

- independent of process locale;
- independent of ICU collation;
- **not** locale collation;
- **not** Unicode normalization;
- **not** case folding;
- **not** natural/numeric sorting.

Relevant canonical orders are:

1. `ProjectGraph.projects`: ascending by `project.root`.
2. `buildProjectScanPlan(graph)`: ascending by `project_root`, then `adapter_id`.
3. project edges: `kind`, then `from_project_id`, then `to_project_id`, then `dependency_name`.
4. per-project markers: `path`, then `kind`.
5. selected adapter read-set files: `path`.
6. same-specificity adapter tie: `adapter.id`.
7. nested detections: `adapter_id`, then `detected_root`.
8. portable registry load errors: `file`, then `message`.

## Exact invariant T21 may consume

T21 may safely depend on the following T02 draft serialization invariant at this reviewed SHA:

```text
For project-scoped ordered outputs:
  primary key   = project_root
  secondary key = adapter_id when applicable

comparison:
  a < b ? -1 : a > b ? 1 : 0

do not use:
  localeCompare()
  project_id as the primary ordering key
  locale collation
  Unicode normalization/case folding as an implicit reorder
```

In particular:

- T21 should preserve T02 `graph.projects` root order or reproduce it with the same ordinal comparator on `project_root`;
- T21 project-cache plans should order by `project_root`, then `adapter_id`;
- T21 must not require `project_id` lexical order when that conflicts with T02 `project_root` order;
- a cache key/serialization that depends on project ordering must bind this ordering rule or otherwise canonicalize with the exact same rule.

This directly explains the earlier T21 oracle mismatch: T02's canonical plan order is root/project_root based, not project-id based.

## Limitations / non-claims

This PASS does not claim:

- stable/public ProjectGraph contract status;
- stable cross-tool project identity;
- Unicode-normalized path equivalence;
- case-insensitive filesystem equivalence;
- Windows/macOS filesystem normalization equivalence beyond the existing portability tests;
- production/default wiring;
- merge or release readiness.

The accepted scope is only:
- locale-independent ordering;
- deterministic serialization under the reviewed ordering keys;
- maintained two-worktree portability;
- maintained marker/source add/modify/delete fail-closed freshness behavior.
