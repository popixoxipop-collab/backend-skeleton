# T24 M3 MuJoCo effective-model helper

Status: **internal implementation candidate**.

This helper compiles an already-approved MuJoCo source closure into the M2
`sbf.sim-mujoco-effective-model/draft-1` facts envelope.

It is deliberately **not wired into a product execution path** in M3.

## Runtime boundary

Initial runtime is pinned to **MuJoCo 3.12.0**.

The future runner must invoke the helper only after T20/T16 has bound:

- exact launcher bytes;
- exact helper bytes;
- approved source files;
- exact MuJoCo runtime closure and native library;
- permission-manifest identity;
- runner implementation identity;
- runtime execution policy identity;
- unique execution attempt.

The helper itself repeats byte checks as defense in depth.

## Input

Protocol:

`sbf.sim-mujoco-effective-helper-request/draft-1`

Top-level fields are exact:

- `protocol`
- `target` = `SIM-mujoco`
- `source_bundle`
- `helper_artifact`

The request contains no repository root, absolute source path, Python command,
network policy, write-root request, environment request, or target-code execution flag.

The process working directory is the approved staging root.

## Staging closure

Before importing MuJoCo, the helper:

1. checks its own file bytes against `helper_artifact`;
2. inventories the complete staging directory;
3. rejects symlinks and non-regular entries;
4. requires the staging regular-file set to equal the source bundle exactly;
5. verifies every file SHA-256 and size against its ArtifactRef;
6. rejects traversal, URI-like, absolute, backslash, empty/dot/parent segments;
7. enforces file-count and byte budgets.

An unlisted source file is a failure, not an implicit dependency.

Before MuJoCo import, M3 also performs a bounded compiler-read preflight over the
root MJCF plus every dependency declared with role `include`:

- XML must be bounded, UTF-8, namespace-free, and free of DOCTYPE/ENTITY;
- `include file=...` must resolve from the main MJCF directory to an exact
  `source_bundle` dependency with role `include`;
- file-backed `mesh`, `hfield`, `skin`, and `texture` assets must resolve,
  after reviewed `compiler` path semantics, to exact dependencies with role
  `asset`;
- absolute, URI-like, backslash, dot/parent, or undeclared compiler inputs fail;
- `assetdir`, `meshdir`, and `texturedir` must themselves stay relative;
- plugin/extension semantics and unreviewed file-bearing elements fail closed.

This is intentionally narrower than MuJoCo's full grammar. Unsupported input is
rejected rather than compiled while still claiming `source_bundle_bound=true`.

## Compilation

Only after closure verification:

- import `mujoco`;
- require `mujoco.__version__ == "3.12.0"`;
- call `mujoco.MjModel.from_xml_path(root)`;
- extract compiled `mjModel` facts.

The helper does not construct `MjData`, call `mj_step` or `mj_forward`,
render, spawn subprocesses, or open network clients.

## Actuator cardinality

M3 follows the reviewed M2 contract and MuJoCo 3.12 model layout:

- actuator rows: `nactuator`;
- scalar controls: `nu`;
- force outputs: `nout`;
- activation state: `na`;
- control ranges use `actuator_ctrladr/actuator_ctrlnum`;
- output ranges use `actuator_outadr/actuator_outnum`;
- activation ranges use `actuator_actadr/actuator_actnum`.

Control limit metadata is read from the scalar-control arrays
`actuator_ctrllimited` and `actuator_ctrlrange`.

## Transmission boundary

M3 exports only the M2-reviewed transmission subset:

- joint
- jointinparent
- slidercrank
- tendon
- site
- body

Any other compiled transmission enum fails closed. In particular, M3 does not
silently widen the M2 contract for newer MuJoCo transmission types.

## Claims

A success response may claim only:

- `compiled_model_facts=true`
- `source_bundle_bound=true`

It must keep:

- `runtime_behavior_verified=false`
- `dynamic_state_observed=false`

Compiling `MjModel` is not physics-step evidence.

## Output validation

Protocol:

`sbf.sim-mujoco-effective-helper-response/draft-1`

The JS boundary re-validates success output using the already independently
reviewed M2 validator. An authoritative `ok:true` validation additionally requires
the exact invocation request; omitting it is an error. Error-envelope shape
validation remains request-independent.

For successful responses the boundary additionally requires:

- compiler version exactly `3.12.0`;
- returned source bundle exactly equals the request;
- returned helper ArtifactRef exactly equals the request.

## M3 tests

The normal M3 test lane does not require a real MuJoCo installation.

It tests:

- exact request/response envelopes;
- authority and version binding;
- helper self-hash;
- staging source hash and exact file-set checks;
- symlink rejection;
- fake `mjModel` extraction including one actuator / two controls /
  one output / zero activation;
- fail-closed transmission behavior;
- source-level absence of step/render/network/subprocess calls.

Real MuJoCo 3.12.0 execution remains a separately gated T20/T16 evidence step
after independent M3 review.
