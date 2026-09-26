# T03 integration handoff

Branch: `scale/T03/capability-policy-next` / defect-fix worktree branch
`t03/fix-evidence-binding`

PR: #81

Lease: `T03-evidence-binding-fix-20260926`, fencing token 2.

T03 owns only `scanners/capability-next/**` and `test/capability-next/**`.
Shared CLI/registry/stable schema/package/lock/workflow files are not modified.

## Frozen semantic invariant

The five-state 04A vocabulary is unchanged:

- supported
- partial
- unsupported
- unknown
- not-applicable

Legacy adapter booleans keep their current narrow meaning.

## T01 exact identity input

T03 consumes the reviewed T01 `sbf.artifact-ref/1` shape from PR #82 head
`e499073aaa7fe9c116e30fbff0536cccecb6eb69`.

Reviewed schema identity:

- path: `schemas/next/artifact-ref.schema.json`
- git blob: `d69366533844c4d002de8746140776edfdccbb25`
- SHA-256: `9c23e23d76937476752b3a3ddc72ee0b0ce24c23ff4b00cf6f18f174400ac8bd`
- size: 880 bytes

T01 ArtifactRef is exact-byte identity only. It is not semantic certification.

## Defect correction

The previous draft could use arbitrary non-empty evidence strings, and the first local correction
still allowed any exact-byte artifact receipt to be reused as evidence for another semantic claim.
Both paths are now fail-closed.

T03 now separates:

1. exact artifact identity;
2. semantic authority for one capability/status;
3. independent certification authority for one target/level/profile/codegen combination.

`verifyArtifactEvidence()` provides identity only and therefore cannot mint a supported capability
or certification row.

Current semantic authorities are deliberately narrow:

- reviewed T01 ArtifactRef schema bytes ->
  `identity.artifact-ref = supported` only;
- reviewed T19 T16-core review bytes ->
  `runtime.certification = partial` only.

A caller cannot choose a capability name and reuse unrelated exact bytes as evidence.

## T16/T19 runtime boundary

Reviewed T16 runtime core:

- beval PR #52 head `7a7ec02e0e765bb9c7367b737ce1fc44e5fcb93b`
- merge `795c11bc78a6cfd9ce0d40392a564bb3ffc542e4`
- runtime-binding source blob `6af4770dbc31ca64dd94ac8ec83ae570bb00104d`
- source SHA-256 `97222d92b6b3450b0c2729aa2b38d27670c4d5e37e0e9d9c693616d02d4ad2ec`

Independent T19 review:

- PR #136 head `21cf8e519addcbe56dbf093967816e47a35ee2cf`
- review blob `6990553e297b493c3a4a480b1b7bec03b822a6b8`
- review SHA-256 `4d7fd6d5e234282715f35e01f0da2760ea3c1be28cdeb4dd78caf4feaf2d998f`
- verdict: PASS for immutable binding/process-policy core only

That review explicitly excludes runtime-tested capability certification.
RuntimeBinding presence, profile strings, generic CI, builds and mocks remain insufficient.

A future positive runtime-tested path must provide exact T16 runtime-execution evidence plus
independent T19 acceptance bound to the same target/profile/combination. T03 does not invent that
wire before its owning tracks freeze it.

## Certification boundary

Discovery/contract/runtime-tested and none/scaffold/build-tested/behavior-tested remain independent
axes.

At this correction point:

- runtime-tested is blocked;
- behavior-tested is blocked;
- identity-only evidence cannot create discovery or contract certification;
- no public support-matrix row is authorized by this branch.

`buildLegacyCompatibilityView()` remains `certified:false`.

## T15 and T22 consumer handoff

Use the same serialized fixture:

`test/capability-next/fixture-status-diagnostics.json`

Rules:

- ArtifactRefs are identity/provenance, not proof by mere presence;
- supported is never inferred from a non-empty evidence array;
- partial/unknown/unsupported/not-applicable remain distinct;
- conflict remains aggregation/reconciliation-only and never maps to supported;
- `certification:null` remains uncertified;
- support level and codegen state remain independent;
- RuntimeBinding/mock/generic CI success is not runtime-tested.

The serialized fixture itself is not a T03 in-process evidence receipt.

## T19 delta-review request

Independently execute the final T03 focused suite from the exact PR head and review:

- arbitrary string/raw ArtifactRef rejection;
- exact-byte identity-only receipt cannot authorize arbitrary capability;
- caller cannot spoof legacy bridge source;
- stale/forged/wrong T01/T16/T19 artifacts fail closed;
- current T16/T19 core proof remains partial/non-certifying;
- runtime-tested/behavior-tested remain blocked;
- unknown/partial/conflict never become supported.

## Root bridge

Existing `test/capability-next.test.mjs` is not modified by this defect fix.
Its previously granted exact-file bridge lease remains a historical branch artifact only while its
blob stays `544b8bcc9f83738fb6dc10c4767e12ac90e3d7c5`.

No new root test shim is created.

## Stable surfaces untouched

- `scanners/capabilities.mjs`
- `schemas/adapter.schema.json`
- `scanners/registry.mjs`
- `scanners/index.mjs`
- `handles/registry.mjs`
- `bin/bskel.mjs`
- `package.json` / lockfile
- `.github/workflows/**`
- existing adapters/providers
