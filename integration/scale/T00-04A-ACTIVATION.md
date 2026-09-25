# T00-04A Activation Gate — Epoch 6

Generated: 2026-09-25  
Status: **BLOCKED_ON_T19_ACCEPTANCE**

This is the fail-closed activation boundary for the staged core freeze. The candidate semantics remain those in `T00-04A-CORE-FREEZE.md`.

## Activation conditions

T00-04A becomes **ACTIVE_CORE_FREEZE** only when all of these are true:

1. T00-01 baseline state is `ACCEPTED`;
2. current bskel/becoder/beval main SHAs equal the epoch-6 baseline;
3. current exact-head main CI is green;
4. PR #120 exact-head CI is green;
5. independent T19 epoch-6 review is `PASS`;
6. T01 exact-byte identity candidate is green, scope-compliant, legacy-compatible, and additive;
7. T03 five-state semantics are green and scope-valid, while certification/evidence wire shape remains unpromoted;
8. runtime-tested still requires verified runtime evidence;
9. T00-03 r1 lease/fencing remains green and fail-closed;
10. uncertainty, runtime-authority, and non-inferred-causality boundaries remain frozen.

## Current epoch-6 state

The baseline technical gates are green:

- bskel main: `5472a8b82655840d1d3ce76cb926987376e37ca6` — CI #319 / `36040486375` success
- becoder main: `37ffb1d8fab6a1e4485fb6b12515d5416963bc48` — CI #83 / `36083442722` success
- beval main: `6a767a4bc04cfd55c4b87362b47b898563ffc59e` — CI #924 / `36105784109` success
- epoch-6 PR #120: `f4407dc5d35738d95c8d8565c2824a36176cbfdf` on base `aac2b8254337ffc8961bcd086c1dc801c59ff6e9`
- PR #120 CI #1127 / `36115168765` success
- all nine required baseline artifact blobs re-read without drift

T00-01 is still **READY_FOR_ACCEPTANCE**, not ACCEPTED, because T19 has not yet produced `evidence/next/T19-T00-01-EPOCH6-REVIEW.md`.

Therefore this gate intentionally returns exactly two blockers:

- `BASELINE_NOT_ACCEPTED`
- `BASELINE_REVIEW_NOT_PASS`

Both resolve from the same independent-review event; T00 must not fabricate that event.

## T01 identity gate

T01 PR #82 remains at `e499073aaa7fe9c116e30fbff0536cccecb6eb69`; exact-head CI `36094807573` is successful.

The four 04A core blobs were re-read and remain exact:

- `contracts/next/identity.mjs` → `c880a606136536fc103db414e5bc39f83081ef8e`
- `schemas/next/artifact-ref.schema.json` → `d69366533844c4d002de8746140776edfdccbb25`
- `schemas/next/identity-envelope.schema.json` → `e4e5fdd38278179e7a6d717a429d63c7b52b78a9`
- `schemas/next/identity.golden.json` → `42177e1af597c445113258e8e81ba9b4a02cadd6`

## T03 capability gate

T03 PR #81 remains at `9795ab4ef3d24e0dd2d30646c373343c76a081c3`; exact-head CI `36084027973` is successful.

The T00 bridge lease file remains byte-identical:

- `test/capability-next.test.mjs` → `544b8bcc9f83738fb6dc10c4767e12ac90e3d7c5`

Only the five-state vocabulary is eligible for 04A. T03 certification/evidenceRefs remain draft.

## T00-03 lease gate

The merged T00-03 r1 lease/fencing implementation remains the coordination authority and is fail-closed.

## Not activated

This branch does **not** activate 04A. It is staged on top of epoch 6 so that, after an independent T19 PASS and a final no-drift check, T00 can record T00-01 ACCEPTED and change this snapshot to ACTIVE without rebuilding the gate implementation.

Plane-specific work remains governed by 04B; replacement PR #121 stays stacked on epoch 6 and changes only the two promotion-policy files.
