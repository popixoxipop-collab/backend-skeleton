# T20 → T17 native engine export trust handoff

This T20-owned helper does **not** launch Unreal, Unity or Godot. It creates a non-executable trust requirement object for a future T16/T00-approved runner.

The builder requires:
- engine class: Unreal / Unity / Godot;
- exact executable basename;
- independently observed executable SHA-256;
- artifact trust policy that explicitly trusts that digest as `usage=helper`;
- explicit source/project read roots;
- explicit scratch/export write roots;
- explicit child-process capacity;
- filtered environment names;
- explicit device classes such as GPU/display only when requested;
- bounded wall/CPU/memory/PID/stdout/stderr/scratch limits.

It forces:
- network deny;
- no secret refs;
- no shell/executable path;
- `executable_now:false`;
- `runtime_binding_required:true`;
- `external_isolation_required:true`;
- `cleanup_proof_required:true`;
- source/export artifact hashing required;
- runtime behavior certification false.

Actual engine launch remains blocked until T16/T00 defines and enforces the admitted runner/profile. Passing this builder does not certify runtime behavior, causality, state transition, Blueprint coverage, or engine correctness.
