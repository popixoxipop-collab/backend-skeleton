# T02 historical package promotion/rollback evidence

Status: **disposable installed-package rehearsal only**. No live T02 project-graph
routing is wired, so this is not a running-service deployment or rollback plan.
T00 release remains blocked. T19 owns independent certification and T23 owns
release admission.

The T02-owned `test/project-graph/package-replay.test.mjs` builds npm packages
from immutable Git sources:

| Slot | Commit | Expected installed capability |
|---|---|---|
| previous | `271d5d747d7ef99fb7ce990a95db32fbdf4e46bd` | stable Java Spring scanner works; T02 graph and T21 cache-plan modules absent |
| candidate | `4eadad45031391e61e68cfebcc3aee26a0d8b5c1` | stable scanner plus installed T02 graph and T21 cache plan select all five current first-party HTTP adapters |

Both commits use the same 21 dependency lock entries; the test pins each
`package-lock.json` hash. It packs exact Git snapshots with lifecycle scripts
disabled, verifies every npm package member against its Git blob and mode,
and compares every installed file's path, size, mode and SHA-256 to the
expected package inventory. Installs prefer cached dependencies and may fetch
missing registry metadata. The test never publishes a package, changes a
running service, or grants release authority.

Run in a checkout containing both commits:

```bash
node --test test/project-graph/package-replay.test.mjs
```

For independently retained evidence, set `T02_REPLAY_OUTPUT_DIR` to an
absolute path that **does not exist yet**. The test creates that directory
and writes the two package archives, manifest and SHA-256 pin, normal receipt
and fault receipt. A reused path is rejected. The normal rehearsal installs
previous → candidate → previous in a disposable consumer and checks byte-for-byte
restoration of the previous installed package. The fault rehearsal delivers
`SIGTERM` during the candidate probe, records a failed candidate stage, and
still restores the previous package through the surviving parent process.

The manifest pin is checked before either replay. A wrong pin, archive drift,
changed Git member, installed inventory mismatch, failure to run the stable
scanner, missing candidate graph/cache module, wrong five-adapter selection,
or failed rollback is a hard failure. A candidate failure is **not** a
successful promotion; only restoration may be reported from that path.

Limits: this cannot prove atomicity of an npm install interrupted mid-write,
running-process state restoration, production router switching, framework
runtime fidelity, planned Prisma/TypeORM/R3F combinations, real-cohort CI,
T03 policy activation, signed T19 QA, T23 admission or T00 release. The
five-adapter fixture is authored synthetic input. The T02/T21 schemas are
still drafts and `project_id` is not a cross-tool stable identity. A real
production promotion would need a separate operator plan and approvals.
