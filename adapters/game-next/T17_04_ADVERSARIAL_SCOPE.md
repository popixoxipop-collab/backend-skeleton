# T17-04 adversarial tests for the draft game intake

This record covers the current **shadow, data-only** T17 envelope, normalizer and text-source boundary. It does not certify a real Unreal, Unity or Godot exporter, engine behavior, the absent legacy-webgame bridge, the T16 runtime plane or a T20 sandbox. `T17-04` asks whether this draft boundary preserves unknowns and fails closed when declarations or byte identities are damaged.

## Executed differential and negative matrix

`test/game-next/t17-adversarial-matrix.test.mjs` reads the seven T19 `NEG-GAME` catalog records and exercises each against the current intake. `NEG-GAME-01` preserves unknown causality despite adjacent names. `NEG-GAME-02` rejects self-certified runtime claims at the envelope boundary; there is no observation bridge to execute. `NEG-GAME-03` retains separate local IDs for duplicate display names. `NEG-GAME-04/-05` deliberately do **not** turn screenshot hash or timing/seed differences into functional or deterministic verdicts: those inputs are outside this plane and injected payload fields are rejected. `NEG-GAME-06` leaves unexported Blueprint/editor content unknown. `NEG-GAME-07` rejects changed exact source bytes and does not infer asset-registry identity. These are bounded intake probes, not T19 runtime conformance verdicts.

The same suite kills changed-export-byte, true-claim, engine/profile, unknown-field, conflicting RPC and conflicting replication mutations. The existing `native-export-envelope-schema.test.mjs` compares schema, constructor and verifier judgments, including their documented differences. The version-label probe compares hand-authored payloads under UE `5.8.3` and `5.8.4` metadata and demonstrates that no installed identity or cross-version engine compatibility is inferred. Exact Node 22/24 CI and Bob Node 26 executions provide **JavaScript runtime** cross-version replay only, not cross-version engine export.

## Permission boundary and reproduction

A child Node process runs the intake with `--permission` and read access only to `adapters/game-next`. It must normalize data while an unrelated T19 file read, a writable file open and process spawning are denied with `ERR_ACCESS_DENIED`. This checks the current data-only path under Node's permission model; it does not supply a T20 engine/editor runtime profile, network isolation or a security certification. [Node 22 permission documentation](https://nodejs.org/download/release/v22.17.0/docs/api/permissions.html) and [Node 24 permission documentation](https://nodejs.org/download/release/v24.19.0/docs/api/permissions.html) describe the tested flag.

Run `node --test test/game-next/t17-adversarial-matrix.test.mjs`, `node --test test/game-next/native-export-envelope-schema.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact source revision. Record exits, TAP totals, Node versions, source hashes and ownership in `T17_04_ADVERSARIAL_VALIDATION.json`. Then require exact-head CI, zero-unresolved independent review, protected merge and Bob exact-merge replay before any one-row T00 adjudication.

The absence of a real engine export remains a T17 producer/integration gap, and screenshot, simulation and Blueprint semantics remain untested at runtime. No target runtime, signed attestation or release authority is awarded by these tests.
