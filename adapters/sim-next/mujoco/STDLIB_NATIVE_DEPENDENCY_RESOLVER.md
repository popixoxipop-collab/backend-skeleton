# T24 M4B stdlib native-extension dependency closure

Status: A1 evidence producer / **not admission authority**.

Upstream authority is frozen to:

- M4 #209: `0f980b713a5669f329e9dabc3c4ef7333909859e`;
- Q4-approved M4A #219: `8172ee29d535db7c608bce60ba103ddf97f20634`;
- M4A tree: `2c1c65d1ae91101debce7600e062828350511181`;
- approved resolver SHA-256:
  `9e0ddc4daa28e05a68086ab11b3475652644ffff19ab24eb8f19708aeaeab7a5`;
- Q4 #200 verdict: `PASS_FOR_M4A_NATIVE_DEPENDENCY_REVIEW`.

## Purpose

M4A closes the exact Python launcher, MuJoCo native extensions, libmujoco and
recursive MuJoCo plugin dependencies. M4B closes the remaining external native
dependencies of the configured Python 3.12 standard-library native extensions.

M4B does not execute the target runtime.

## Parser reuse

M4B does not implement its own ELF parser or DT_NEEDED resolver.

Before work begins it verifies the adjacent Q4-approved
`native_dependency_resolver.py` by exact SHA-256 and size. It imports that
reviewed module under a private module name and reuses its:

- path/symlink validation;
- stdlib root resolution;
- ELF parser;
- DT_NEEDED/RPATH/RUNPATH resolution;
- graph budgets;
- file hashing;
- logical native-path mapping;
- canonical hashing.

Parser byte drift is fatal. Any `ResolveError` emitted by an approved M4A helper is translated into the single M4B fail-closed error protocol; approved-parser denials are never allowed to escape as a traceback-based alternate authority path.

## Native-extension seed boundary

The producer derives exact interpreter-owned roots from `sysconfig`:

- `stdlib`;
- `platstdlib`;
- `DESTSHARED`.

Native-extension roots are the exact configured `DESTSHARED` plus existing
`lib-dynload` directories under stdlib/platstdlib, deduplicated after exact
resolution. Missing optional `lib-dynload` paths may be absent, but any other
filesystem inspection error is fatal rather than treated as absence.

Every native-extension root must remain inside an exact configured stdlib root.

Search roots are server-owned evidence policy, not a widening mechanism. A search
root that exposes a soname only through a symlink escaping that root is not
admissible under the Q4-approved resolver. The real CI holdout therefore uses
the canonical Linux x86_64 system-library root
`/usr/lib/x86_64-linux-gnu` and does not add alias/compatibility roots such as
`/usr/lib64` merely because they exist.

The producer recursively seeds every regular non-symlink file ending in `.so`
below those roots. Directory/file symlinks, non-regular entries, traversal
errors, empty seed sets and seed-count overflow fail closed.

## Closure

Each seed is parsed by the exact Q4-approved M4A parser. Every transitive
`DT_NEEDED` edge is resolved by the exact Q4-approved loader-resolution
function against server-owned approved roots.

Unresolved, ambiguous, path-escape, RPATH/RUNPATH/token, malformed ELF,
duplicate PT_INTERP, graph-budget and other M4A parser/loader denials propagate
as M4B denial.

Files under configured stdlib roots remain represented as stdlib-native graph
nodes. Only external real files are emitted in `native_dependency_files`.

M4A and M4B use the same `system-native/<path-hash>-<basename>` mapping.

M4B also defines the strict final-union contract used after target-host M4A
evidence exists:
- an identical `(logical_path, real path)` pair is deduplicated;
- the same logical path pointing to two real paths is denied;
- the same real path carrying two logical paths is denied;
- union size is bounded and output ordering is canonical;
- the collision contract is applied once before M4B emits its own native mapping and again to the eventual M4A+M4B union.

## Output

Schema:

`sbf.sim-python-stdlib-native-dependency-closure/draft-1`

The output binds:

- exact #209 candidate;
- exact #219 candidate/tree;
- exact Q4-approved resolver SHA/size;
- exact running Python launcher path/SHA/size;
- exact stdlib roots and native-extension roots;
- every stdlib-native seed SHA/size;
- dependency graph;
- external native files as both the exact inventory-facing `native_dependency_files` mapping and explicit `external_native_files` rows carrying logical path, real path, SHA-256 and size;
- M4B producer SHA/size;
- canonical closure SHA over upstream #209/#219/parser identity, exact launcher identity, roots, seeds, graph, external native files and the fixed strict-union policy.

All execution/admission claims remain false.

## Review and authority

Canonical independent M4B review is Q5 #213.

This producer cannot feed final runtime inventory until Q5 issues
`PASS_FOR_M4B_STDLIB_NATIVE_DEPENDENCY_REVIEW` for one exact frozen
candidate/output contract.

A CI holdout runs the complete producer against the real pinned Python 3.12
`sysconfig`/`lib-dynload` tree and system library roots, parsing files only and
asserting all execution claims remain false.

Q5 PASS still does not authorize MuJoCo import, M3 helper execution, MJCF
compilation, `MjModel.from_xml_path()`, MjData, stepping/rendering, or T20/T16
admission.
