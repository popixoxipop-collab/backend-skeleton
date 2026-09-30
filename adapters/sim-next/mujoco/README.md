# T24 MuJoCo source slice 1

Status: draft leaf implementation. This directory performs source-only, data-only MuJoCo MJCF discovery and bounded structural extraction. It does not launch MuJoCo, Python, a compiler, a renderer, or any network client.

## Scope

`discover.mjs` accepts a caller-selected repo-relative `.xml` file only when its explicit root element is `<mujoco>`.

`mjcf-source.mjs` extracts declared source structure for the first slice:

- model name;
- body hierarchy;
- joint / `freejoint` / geom / site declarations;
- actuator and sensor declarations;
- contact pair/exclude;
- equality/tendon declarations;
- compiler/option/default declarations;
- keyframes with qpos/qvel/act/ctrl kept as distinct channels;
- include dependency references resolved relative to the main MJCF directory;
- asset file references retained as compiler-dependent source facts because `meshdir` / `texturedir` / `assetdir` can rewrite effective resolution.

Dependencies are not fetched. `include` paths are interpreted relative to the main MJCF directory. Asset paths are deliberately not given a fabricated resolved path at source stage because compiler directory settings can change effective resolution. All remain unresolved facts until a later approved dependency/effective-model stage supplies exact bytes. Direct self-includes and caller-supplied dependency graph cycles fail closed.

## Security and trust boundary

The parser:

- accepts exact bytes, not a filesystem path to open on its own;
- validates the logical path as repo-relative POSIX;
- rejects invalid UTF-8, DOCTYPE/ENTITY, malformed XML, parent traversal, absolute/backslash paths and URI dependencies;
- has explicit byte, depth, element and dependency budgets;
- uses no `child_process`, dynamic target import, Python import, simulator execution or network access.

## Claims

The output sets only:

- `declared_structure_only = true`

and explicitly keeps:

- `effective_model_verified = false`
- `runtime_behavior_verified = false`
- `causal_edges_verified = false`

No source parser result is a runtime certification.

## Focused tests

```bash
node --test test/sim-next/mujoco/*.test.mjs
```

This nested suite is not automatically proven by a generic root `npm test` unless CI explicitly includes the T24 path.

## Unsupported high-risk source semantics

The source slice does not execute or resolve procedural/plugin meta-elements such as
`extension`, `plugin`, `frame`, `replicate`, `composite`, `flexcomp` and `attach`.
Their presence is preserved as explicit `MUJOCO_UNMODELED_HIGH_RISK_ELEMENT` diagnostics.
A later effective-model/runtime profile must resolve them under a separately approved execution boundary.

Direct child templates under `default` are preserved as declarations only; this source slice does not
apply inheritance or claim the compiler-resolved effective values.
