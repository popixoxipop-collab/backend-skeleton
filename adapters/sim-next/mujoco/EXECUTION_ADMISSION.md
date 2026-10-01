# T24 M4 pre-execution admission

Status: **A1 evidence preparation / NOT_ADMITTED**

This slice prepares the exact evidence package for a separate T20/T16 execution-admission review.
It does **not** import MuJoCo, call the M3 helper, compile MJCF, create `MjData`, or authorize execution.

## Frozen prerequisite

Independent M3 review is closed for exact candidate:

`78dcf2d720215e4c9cd54b0402eb83083b1a5ddd`

Issue #184 verdict:

`PASS_FOR_M3_HELPER_REVIEW`

That verdict does not admit M4 execution.

## Why a wrapper is required

The existing Alienware MuJoCo installation is a Python venv. Launching a normal venv interpreter
would allow Python `site` startup to process site-packages and `.pth` files before the reviewed
helper is in control.

M4 therefore introduces a runner-owned wrapper:

`runtime_wrapper.py`

Required invocation shape:

`python -I -S -B runtime_wrapper.py RUNTIME_IMPORT_ROOT HELPER_PATH HELPER_SHA256`

The wrapper:

- requires isolated mode (`-I`);
- requires no-site mode (`-S`);
- requires no-bytecode mode (`-B`);
- verifies the exact M3 helper bytes before transfer;
- preserves only interpreter-owned stdlib/dynload roots;
- appends exactly one reviewed runtime import root;
- keeps that runtime root after stdlib so it cannot shadow standard-library modules;
- then transfers control to the already-reviewed M3 helper.

The wrapper does not self-certify the exec environment. In particular, an empty execve environment,
network denial, mount permissions and process restrictions remain external T20 enforcement facts.

## Filesystem-only runtime inventory

`runtime_inventory_collector.py` is standard-library-only and must itself run with `-I -S -B`.
It never imports MuJoCo and never compiles a model.

Its input identifies:

- the exact runtime import root;
- the exact M3 helper file;
- the exact trusted wrapper file;
- interpreter stdlib roots to bind;
- explicit native dependency files to bind.

It is currently pinned to the reviewed Alienware/WSL ABI:

- platform: `Linux-x86_64`;
- Python: `3.12.x`;
- MuJoCo: `3.12.0`;
- exact CPython 3.12 binding filenames reviewed by M3/M4.

It verifies and records:

1. MuJoCo 3.12.0 METADATA;
2. every hashed MuJoCo wheel RECORD entry against actual installed bytes;
3. safe relative RECORD paths;
4. the exact file inventory under the approved runtime import root;
5. no symlink entries in the accepted closure;
6. no MuJoCo-package files outside RECORD;
7. exact launcher bytes;
8. exact helper bytes;
9. exact wrapper bytes;
10. exact `libmujoco.so.3.12.0`;
11. required Python extension bindings;
12. every bundled plugin library under `mujoco/plugin`;
13. configured interpreter stdlib roots;
14. configured native dependency files.

The output is:

`sbf.sim-mujoco-runtime-inventory/draft-1`

The runtime-closure identity is a canonical SHA-256 over the full sorted file inventory, not merely
the wheel RECORD digest.

## MuJoCo import closure matters

MuJoCo 3.12.0 import is broader than `libmujoco.so` plus one extension.

The upstream package imports Python dependencies and automatically loads every bundled native library
under `mujoco/plugin` using `ctypes.CDLL`.

Therefore admission must bind:

- launcher;
- wrapper;
- M3 helper;
- full runtime import-root closure;
- native MuJoCo library;
- required extension modules;
- bundled plugin libraries;
- interpreter stdlib/runtime roots;
- explicit native dependencies required by those binaries.

The old pilot evidence remains useful as a pointer, but is not sufficient admission evidence by itself.

## T20 plan remains narrow

`execution-admission.mjs` consumes the inventory and builds only a proposed T20 plan.

The resulting runtime permission manifest remains:

- input mode: `approved-files`;
- read roots: explicit source staging only;
- write roots: empty;
- network: deny;
- listen: deny;
- environment allowlist: empty;
- secret refs: empty;
- devices: deny;
- process argv allowlist: exact launcher basename only;
- max children: 1;
- target code execution: false;
- acquisition: null;
- `executable_now=false`;
- `runtime_binding_required=true`.

Runner-owned interpreter/helper/runtime assets remain outside target source roots and are exact-digest
trust inputs.

## A1 cannot self-admit

`buildMujocoExecutionAdmissionCandidate()` never returns an admitted state.

Its stable state is:

`state: NOT_ADMITTED`

and:

- `execution_authorized=false`;
- `t16_runtime_binding_allowed=false`;
- `independent-t20-t16-admission-verdict-required` remains unresolved.

Without external enforcement evidence, review readiness is:

`BLOCKED`

Even when all structural enforcement fields are present and digest-bound, the strongest result A1 can
produce is:

`review_readiness: READY_FOR_INDEPENDENT_REVIEW`

That is not an admission PASS.

## External enforcement evidence

The later target-host runner must independently demonstrate and bind:

- runner implementation SHA-256;
- runtime execution policy SHA-256;
- exact permission-manifest SHA-256;
- exact runtime-inventory SHA-256;
- source mount read-only;
- runtime mount read-only;
- source symlink denial;
- source hardlink denial;
- source writes denied;
- runtime writes denied;
- outbound network denied;
- listening denied;
- unexpected process creation denied;
- empty exec environment;
- pre/post source hashes equal;
- runtime closure reverified;
- interpreter stdlib closure reverified;
- native library reverified;
- transitive native dependency closure reverified;
- plugin closure reverified;
- decoder closure reverified;
- resource-provider closure reverified.

Caller-provided booleans are not themselves authority. They form an A1 evidence package that the
independent T20/T16 reviewer must validate against target-host receipts and negative probes.

## Current Alienware blocker

The known pilot runtime is in WSL:

`/home/alienware-r13/robotis_sh5_mjlab/.venv`

The currently exposed Tailnet Commander Alienware workspace is Windows:

`C:\Users\ALIENWARE-R13\mcp-sandbox\tailnet-commander`

The workspace file API cannot read WSL `/home/...` paths, and the registered exec policy rejects
ad-hoc filesystem/hash commands for those paths.

This is treated as an admission blocker, not bypassed by widening remote execution.

Before independent admission review, one of these must exist:

1. a narrow registered read-only inventory job/profile on Alienware/WSL, or
2. an approved read-only workspace exposing the exact runtime bundle.

The collector then runs there without MuJoCo import.

## Independent T20/T16 review

Once actual target-host inventory + enforcement evidence exists, a separate reviewer must verify the
exact package, including:

- M3 candidate identity;
- helper/wrapper identities;
- launcher identity;
- runtime/native/plugin closure;
- interpreter stdlib closure;
- transitive native dependencies;
- decoder/resource-provider closure;
- artifact-trust expansion;
- permission manifest;
- runner implementation;
- execution policy;
- read-only immutable staging;
- hardlink/TOCTOU denial;
- network/write/process denial;
- exact negative-probe receipts.

A1 does not issue that verdict.

## After admission PASS

Only after the separate admission PASS may M4 create a unique T16 attempt and execute the exact M3
helper, causing the first admitted real:

`mujoco.MjModel.from_xml_path(...)`

The result must still pass:

1. exact M3 request/response binding;
2. M2 effective-model validation;
3. exact T16 binding/evidence verification.

Compilation still does not imply dynamics evidence:

- `runtime_behavior_verified=false`
- `dynamic_state_observed=false`

remain mandatory.
