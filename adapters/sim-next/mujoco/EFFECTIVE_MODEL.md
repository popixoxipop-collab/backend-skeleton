# T24 MuJoCo effective-model contract (M2)

Status: internal draft contract. No MuJoCo process is executed by this module.

## Purpose

The source parser can describe declared MJCF syntax, but it cannot truthfully know compiled
`mjModel` facts such as:

- `nq` / `nv` and each joint's `qpos` / `qvel` address;
- actuator count, control/output/activation addresses and widths, and transmission targets;
- sensor `sensordata` address and dimension;
- compiler-resolved timestep/integrator and model counts.

`effective-model.mjs` validates a future helper-produced facts envelope. It does not launch,
locate or trust that helper.

## Trust boundary

A future helper must be treated as a T20 `compiler-helper` with approved-files input.
Its launcher/package bytes, source closure, permissions and execution evidence must be bound
through the existing T20/T16 trust/runtime path before any capability promotion.

The M2 helper-plan constructor accepts exactly five top-level inputs: `launcher`, `assets`,
`artifactTrustPolicy`, `readRoots`, and `limits`. Any additional top-level field is rejected.
Permission or execution widening requests must fail closed rather than being silently ignored.

Source closure identity is path + ArtifactRef. Two different logical files may legally have identical bytes; the contract rejects duplicate logical paths, not duplicate digests.\n\nA structurally valid effective-model export is therefore not sufficient to claim:

- runtime behavior;
- dynamic state observation;
- installed/public SIM support;
- release approval.

## Initial invariants

- the contract intentionally carries no producer-authored self-hash; the complete export is content-addressed externally by the caller;\n- joint type determines qpos/dof widths;
- joint address ranges exactly cover `nq` and `nv`;
- sensor ranges exactly cover `nsensordata`;
- actuator rows are sized by `nactuator`, which is distinct from total controls `nu` and total force outputs `nout`;\n- actuator control ranges exactly cover `nu`;\n- actuator force-output ranges exactly cover `nout`;\n- activation ranges exactly cover `na`;
- compiled object IDs are dense and ordered;
- exact source/helper ArtifactRefs are retained together with unique logical source paths;
- runtime/dynamic claims must remain false.

The initial helper permission plan is read-only and stdout-only: no writable repository/scratch roots, network deny, empty inherited environment, no devices, and a one-process launcher allowlist. Any future scratch/cache requirement is a separate permission expansion that must be reviewed explicitly.\n\nThe actual MuJoCo helper implementation and T20/T16 authorization are later slices.


## MuJoCo actuator cardinality

The contract intentionally separates:
- nactuator: number of actuator objects;
- nu: total scalar control inputs;
- nout: total force outputs.

Each actuator therefore carries:
- control_adr / control_count plus per-control limit metadata;
- output_adr / output_count;
- activation_adr / activation_count.

The validator rejects contracts which silently assume nactuator == nu == nout.
This preserves compatibility with multi-input / multi-output actuator infrastructure while still supporting the common SISO case.


## Transmission support boundary

The first M2 draft intentionally supports only the reviewed transmission subset:

- joint
- jointinparent
- slidercrank
- tendon
- site
- body

Any compiled transmission enum outside this set must fail closed in the future helper/exporter instead of being serialized as an arbitrary integer or silently coerced.

This is a capability subset boundary, not a statement that MuJoCo itself supports only these transmission types.
A later contract revision may add newly reviewed transmission semantics with version-specific tests.
