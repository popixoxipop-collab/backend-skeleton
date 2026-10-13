# T00-01 baseline lock

Pins the three repositories of the integration baseline (bskel is public; becoder and beval are private) and ships a
verifier that recomputes every fact the pin states. The heads, blob SHAs and CI results live in `baseline.lock.json`
and are not repeated here, so this page cannot drift from them.

| File | Role |
|---|---|
| `capture-observation.mjs` | Read-only live capture through an authenticated `gh` (needs read access to all three repositories). Runs and jobs are read page by page (100 per page) until GitHub's `total_count` is reached, and the count and page number are recorded; the `total_count` of the first page is pinned and every later page must report the same number, so a list that changes while it is read fails the capture. A list the API cannot serve completely (a head search serves at most 1000 runs) also fails it instead of recording fewer runs. |
| `fixtures/observation.json` | The captured observation; the verifier's input and the source of every derived fact. |
| `build-lock.mjs` | CLI that writes `baseline.lock.json` from an observation with `deriveLock` of `verify-baseline.mjs`, the function `--record` re-derives the lock with; the `limits` sentences are carried over by hand. |
| `baseline.lock.json` | The lock: heads, artifact blob SHAs, package facts, exact-head CI results, inventory pins, limits. |
| `verify-baseline.mjs` | Verifier and CLI. |
| `make-negative-report.mjs`, `negative-report.json` | Real CLI runs on mutated copies (exit code, error codes, stdout hash); `--check` recomputes them. |

## Commands

```
node next/t00/verify-baseline.mjs --remote --record next/t00/baseline.lock.json next/t00/fixtures/observation.json
node next/t00/verify-baseline.mjs next/t00/baseline.lock.json --checkout bskel=<dir> --checkout becoder=<dir> --checkout beval=<dir>
node next/t00/make-negative-report.mjs --check
node --test test/t00-baseline.test.mjs
```

Exit code 0 means verified, 2 means verification errors (one `FAIL <code> <role> <detail>` line each), 1 means usage
or unreadable input. The first command prints `OK 3 repositories verified`. Without `--remote` the same observation
fails with `DIRTY_STATE_UNKNOWN`, because a GitHub observation has no work tree.

## Error codes

| Code | Raised when |
|---|---|
| `MISSING_REPOSITORY_OBSERVATION` | the observation has no entry for a locked role |
| `REPOSITORY_SET_MISMATCH` | the set is fixed by the verifier, not by the files: the lock must pin bskel, becoder and beval once each under their repository names, the observation must not hold a repeated, renamed or unknown repository, and the inventory pins of the lock and of the observation must hold each of the three roles exactly once |
| `MALFORMED_RECORD` | a lock or observation entry lacks a field the comparison reads or holds it in the wrong shape: a missing or non-list `required_artifacts` or artifact list, an entry that is not an object, an artifact set that is not exactly package.json, package-lock.json and .github/workflows/ci.yml, an observation without the schema `bskel.t00-observation/1` or with a timestamp that is not UTC, a run, package or inventory pin of the wrong shape, `limits` that is not a list of statements |
| `DIRTY_CHECKOUT` | the work tree has uncommitted or untracked changes |
| `DIRTY_STATE_UNKNOWN` | cleanliness was not observed (null) and `--remote` is not given |
| `DEFAULT_BRANCH_MISMATCH` | the observed branch is not the locked default branch |
| `HEAD_SHA_MISMATCH` | the observed head is not the locked head |
| `MISSING_ARTIFACT` | a locked artifact (package.json, package-lock.json, ci.yml) is absent |
| `ARTIFACT_BLOB_MISMATCH` | an artifact's git blob SHA differs from the lock |
| `OBSERVATION_HASH_MISMATCH` | `--record`: the lock's observation hash is not the canonical sha256 of the observation |
| `DERIVED_FACT_MISMATCH` | `--record`: the lock differs from what `deriveLock` builds from the observation in any field but `limits`: schema, task id, repositories, inventory pins, and every `capture` field except the hash (which has its own code); a field the builder never emits counts too |
| `CI_RUNS_INCOMPLETE` | `--record`: GitHub's run count for the head (`ci_runs_total_count`) or the number of pages read (`ci_runs_pages`) is absent or does not match the runs the observation lists |

## What a pass means

The lock is what `deriveLock` builds from exactly this observation, field for field (the hand-written `limits` aside),
and the observation matches the lock. In `--record` mode the verifier first checks the shape of both documents and
reports a malformed list as `MALFORMED_RECORD` with exit code 2 instead of failing on it. The test also recomputes the bskel facts from git objects (head commit, artifact blobs, package scripts, inventory file
and pins, pin ancestry and distance) and fails if those objects cannot be obtained. It does not prove that GitHub
still reports the same facts: a lock committed to main is always behind the main that contains it, and the becoder and
beval facts can only be re-checked by running the capture again from a session that can read those repositories.
The recorded run count and page number catch an observation that lost runs after the capture. An observation edited consistently (runs, count, pages, observation hash and lock all together) cannot be told from a real one offline; only a new capture from GitHub refutes it.
The `limits` in the lock state what else is not covered, including the exact-head CI failures of bskel and beval.

## Re-baselining

1. `node next/t00/capture-observation.mjs next/t00/fixtures/observation.json`
2. `node next/t00/build-lock.mjs next/t00/fixtures/observation.json next/t00/baseline.lock.json next/t00/baseline.lock.json`
3. Review `limits` against the new facts, then `node next/t00/make-negative-report.mjs --write`.
4. `node --test test/t00-baseline.test.mjs`

The inventory file `release/next/compatibility-inventory.json` is owned by T23 and is not edited here; the lock only
records how far each of its pins is behind the observed head.

## Provenance of the earlier lock

The scale-plan lock this work follows is blob `e506b744e7ec8c06ba3262b20d74082fe13d03d9` at commit
`14583a4c4024affcd1a1cea234a30464de203707` on the coordination branch `scale/T00/bootstrap-baseline` (schema
`bskel.scale-baseline-lock/1`, epoch 7, captured 2026-09-25 at bskel `5472a8b82655840d1d3ce76cb926987376e37ca6`,
becoder `37ffb1d8fab6a1e4485fb6b12515d5416963bc48`, beval `882b185655f9166cda4a64b5b49a6eab477f2410`). It is recorded
for provenance only; that branch may be deleted, so nothing here depends on it.

## T00-02 ownership map

Which track may write which path in which repository, and the gate that checks it. The interface is `INTERFACE_RFC.md`.

| File | Role |
|---|---|
| `ownership.mjs` | Pure model: scope grammar, collisions, path classification and the code lists `MAP_CODES` and `PATH_CODES`. |
| `snapshot-plan.mjs` | Snapshots the write scopes of the plan backlog; `--check` validates the committed snapshot and compares it with a backlog. |
| `build-ownership-map.mjs` | Derives `ownership-map.json` from its inputs and writes it only if every check passed. |
| `check-ownership.mjs` | CLI: `map` verifies the committed map, `paths` verifies that given paths or a git diff belong to one track only. |
| `recorded-runs.mjs` | Spawns the real CLI once per case and records the exit code, the error codes and a hash of stdout. |
| `make-ownership-report.mjs`, `ownership-report.json` | Real CLI runs on this checkout and on scaffold copies with one input broken; `--check` recomputes them. |
| `ownership-map.json` | The generated map. `check-ownership.mjs` fails a map that differs from the one derived from the inputs, so a hand edit fails. |
| `fixtures/plan-write-scopes.json` | Snapshot of the write scopes in the plan backlog (the plan folder is outside this checkout). |
| `fixtures/ownership-rules.json` | The reserved hot paths and the limits the map states. |
| `INTERFACE_RFC.md` | Inputs, rules, unknown and partial cases, codes, and how a track uses the gate. |

```
node next/t00/check-ownership.mjs map
node next/t00/check-ownership.mjs paths --track T05 --git-diff <merge-base> HEAD
node next/t00/build-ownership-map.mjs
node next/t00/make-ownership-report.mjs --check
node next/t00/snapshot-plan.mjs --check <backlog.json>
node --test test/t00-ownership.test.mjs
```

Exit code 0 means verified, 2 means errors (one `FAIL <code> <subject> <detail>` line each), 1 means usage or unreadable
input. After a change to `SUITES`, to a plan write scope or to `test/t00-*.test.mjs`, run `build-ownership-map.mjs`, then
`make-ownership-report.mjs --write`, and commit both files.

## T00-03 lease ledger

Which worker may write which paths until when (a lease), and the gate that checks a worker's result against its lease. The
protocol is `LEASE_PROTOCOL.md`. Both gates, this one and the ownership gate, are run by hand and are not wired into CI: no
workflow calls `check-lease.mjs` or `check-ownership.mjs`, and no job runs a gate on the diff of a pull request or on a real
ledger. The CI test job runs `npm test`, which includes `test/t00-lease.test.mjs` and `test/t00-ownership.test.mjs`; they run
the gates on fixtures, on this checkout and on scaffold copies of it.

| File | Role |
|---|---|
| `lease-ledger.mjs` | Pure model: lease time, claim scopes inside the ownership policy, fencing order, scope conflicts, the digest chain and the judgement of one result; the code lists `LEDGER_CODES`, `RESULT_CODES` and `LEASE_CODES`. |
| `check-lease.mjs` | CLI: `ledger` verifies a lease ledger at an instant, `result` verifies that one claim's result is in time, comes from the holder of the claim, carries the claim's token and base and stays inside the claim. |
| `seal-lease-ledger.mjs` | Prints a ledger with its `prev_digest`, `entry_digest` and `head_digest` computed. It signs whatever it is given, judges nothing and writes nothing. |
| `make-lease-report.mjs`, `lease-report.json` | Real CLI runs against this checkout's ownership map with one change to the ledger or the result per case; the report records the command, the exit code, the codes and the stdout hash of each case, and `--check` recomputes them. |
| `lease-mutants.mjs` | Mutation check: each mutant replaces one piece of text of a temporary copy of the gate, and a recorded case that guards it has to fail. Writes only to a temporary directory that it removes. |
| `fixtures/lease-ledger.json` | A sealed ledger that passes at the instant the report uses; the report's cases change it one at a time. |
| `LEASE_PROTOCOL.md` | Inputs, identity, rules, digests and pin, versions and exit codes, the seal tool, unknown and partial cases, commands, codes and limits. |

```
node next/t00/check-lease.mjs ledger --ledger next/t00/fixtures/lease-ledger.json --at 2026-10-09T01:00:00Z
node next/t00/check-lease.mjs result --ledger <file> --at <instant> --claim <id> --worker <name> --worktree <name> --token <n> --base <sha> --head <sha> [<path>...]
node next/t00/seal-lease-ledger.mjs <ledger.json>
node next/t00/make-lease-report.mjs --check
node next/t00/lease-mutants.mjs
node --test test/t00-lease.test.mjs
```

Exit code 0 means verified, 2 means errors (one `FAIL <code> <subject> <detail>` line each), 3 means a ledger of another schema
version, 1 means usage or unreadable input. Both `check-lease.mjs` commands take `--head-digest <sha256>`: kept outside the
ledger file, that pin is what tells a ledger rewritten and sealed anew from the original, and the `OK` line of `ledger` says
whether the head was pinned. After a change to the ownership map, to the fixture or to a source the report hashes
(`check-lease.mjs`, `lease-ledger.mjs`, `ownership.mjs`, `build-ownership-map.mjs`, `check-ownership.mjs`), run
`make-lease-report.mjs --write` and commit the report.

Node: `package.json` allows Node `>=18` and the CI test job runs `npm test` on Node 22.x and 24.x, so no job runs Node 18. The T00
tests therefore scan every `next/t00/*.mjs` file and every `test/t00-*.test.mjs` file for the names of APIs that Node 18 lacks.
That is a list of known names, not a proof, and Node 18 itself was not run.
