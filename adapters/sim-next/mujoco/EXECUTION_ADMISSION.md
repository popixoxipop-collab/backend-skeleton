# T24 M4 pre-execution admission

Status: **A1 evidence preparation only / NOT_ADMITTED**

This slice prepares the evidence required for the separate T20/T16 execution-admission review.
It does **not** run MuJoCo, import MuJoCo, compile MJCF, or authorize M4 execution.

## Prerequisite

Independent M3 helper review is closed for exact candidate:

`78dcf2d720215e4c9cd54b0402eb83083b1a5ddd`

Issue #184 verdict:

`PASS_FOR_M3_HELPER_REVIEW`

This does not itself admit execution.

## Filesystem-only runtime collector

`runtime_inventory_collector.py` accepts only:

- exact protocol id;
- absolute venv root;
- absolute M3 helper path;
- expected MuJoCo version, fixed to 3.12.0.

It never imports MuJoCo or launches the Python interpreter.

It verifies:

1. a single `lib/pythonX.Y/site-packages` under the venv;
2. `mujoco-3.12.0.dist-info/METADATA` reports exactly version 3.12.0;
3. every hashed wheel RECORD entry has a safe relative path;
4. every non-RECORD row has SHA-256 + size;
5. every installed entry is a regular non-symlink file;
6. every installed file's bytes match RECORD hash + size;
7. the native library exists inside that verified closure;
8. at least one Python extension binding exists inside the same closure;
9. the requested helper bytes are hashed without executing them;
10. the launcher path is resolved and the actual executable bytes are hashed.

It emits:

`sbf.sim-mujoco-runtime-inventory/draft-1`

with status:

`INVENTORY_OBSERVED_NOT_ADMITTED`

and explicit false claims for:

- `mujoco_imported`
- `helper_executed`
- `mjcf_compiled`
- `execution_admitted`

## Runtime closure identity

The runtime-closure role is not the RECORD file digest.

It is a canonical digest over every verified installed RECORD entry:

`sbf.sim-mujoco-runtime-closure/draft-1\n<canonical entries>\n`

This means the later T20 `mujoco-runtime-closure` asset identity is bound to actual installed bytes, not merely to the wheel's self-described RECORD bytes.

RECORD and METADATA hashes remain separately recorded as evidence.

## A1 admission candidate

`execution-admission.mjs` validates the collector output independently:

- recomputes runtime closure digest;
- recomputes total size and entry count;
- binds native library and extension modules to the closure;
- rejects any inventory that claims import/execution/compilation/admission;
- requires launcher/helper/runtime-closure/native-library digests to be distinct.

It then constructs a **proposed**, not approved:

- artifact trust policy;
- M2/T20 MuJoCo helper plan;
- runtime permission manifest;
- trust-policy digest;
- permission-manifest digest.

The permission plan remains:

- input mode: `approved-files`
- network: deny
- listen: deny
- writes: none
- environment: none
- secrets: none
- devices: deny
- process: only the exact launcher basename
- max children: 1
- target code execution: false
- acquisition phase: none
- `executable_now=false`
- `runtime_binding_required=true`

## Why the result is always NOT_ADMITTED

A1 must not self-authorize the execution gate.

Therefore `buildMujocoExecutionAdmissionCandidate()` always returns:

`state: NOT_ADMITTED`

`execution_authorized: false`

and leaves explicit unresolved items such as:

- artifact trust expansion requires independent approval;
- runtime inventory requires independent review;
- runner implementation hash is not bound;
- runtime execution policy hash is not bound;
- read-only immutable staging enforcement is not proven;
- TOCTOU/hardlink denial is not proven;
- runtime plugin/decoder/resource-provider closure is not independently admitted;
- T16 RuntimeBinding is not created;
- unique attempt nonce is not created;
- independent T20/T16 admission verdict is required.

There is intentionally no `approved`, `force`, or `executable_now` caller knob.

## Alienware evidence boundary

Existing pilot evidence points at the WSL environment:

`/home/alienware-r13/robotis_sh5_mjlab/.venv`

with MuJoCo 3.12.0.

The currently exposed Tailnet Commander Alienware workspace is Windows:

`C:\Users\ALIENWARE-R13\mcp-sandbox\tailnet-commander`

and its workspace file API cannot read the WSL `/home/...` paths.

The exec policy also currently denies arbitrary `sha256sum` / filesystem inventory commands.

This is treated as a real admission blocker, not bypassed by widening the remote exec policy ad hoc.

A later **narrow registered inventory job/profile** must run the collector against the exact WSL venv and M3 helper bytes, or that runtime must be exposed through an approved read-only workspace.

Until then the old pilot inventory remains candidate evidence only.

## Required independent admission review

After a real filesystem inventory exists, a separate reviewer must verify:

- M3 candidate identity;
- helper bytes;
- launcher resolved bytes;
- full installed runtime closure;
- native library;
- extension bindings;
- proposed artifact trust expansion;
- permission manifest;
- runner implementation identity;
- runtime execution policy identity;
- read-only/immutable staging enforcement;
- TOCTOU/hardlink denial;
- plugin/decoder/resource-provider closure assumptions;
- negative denial tests.

Only that reviewer may issue the T20/T16 admission verdict.

## After admission PASS

Only after independent admission PASS may M4 create a unique T16 execution attempt and run:

`mujoco.MjModel.from_xml_path(...)`

The resulting helper response must still pass:

1. M3 exact request/response binding;
2. M2 effective-model validation;
3. exact T16 binding/evidence checks.

Even then:

- `runtime_behavior_verified=false`
- `dynamic_state_observed=false`

remain mandatory because compilation is not physics stepping.
