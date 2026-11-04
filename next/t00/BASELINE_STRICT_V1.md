# Versioned strict baseline candidate (v1)

This document describes only `verify-baseline-strict-v1.mjs` and its independent strict derivation and report. The historical `verify-baseline.mjs`, `make-negative-report.mjs` and `negative-report.json` are preserved byte-for-byte for existing evidence pins, and retain historical semantics. The strict candidate does not change historical CLI acceptance. Both use the same unchanged recorded inputs.

## Recorded baseline inputs

Pins the three repositories of the integration baseline (bskel is public; becoder and beval are private) and ships a
verifier that recomputes every fact the pin states. The heads, blob SHAs and CI results live in `baseline.lock.json`
and are not repeated here, so this page cannot drift from them.

| File | Role |
|---|---|
| `capture-observation.mjs` | Read-only live capture through an authenticated `gh` (needs read access to all three repositories). Runs and jobs are read page by page (100 per page) until GitHub's `total_count` is reached, and the count and page number are recorded; the `total_count` of the first page is pinned and every later page must report the same number, so a list that changes while it is read fails the capture. A list the API cannot serve completely (a head search serves at most 1000 runs) also fails it instead of recording fewer runs. |
| `fixtures/observation.json` | The captured observation; the verifier's input and the source of every derived fact. |
| `build-lock-strict-v1.mjs` | CLI that writes `baseline.lock.json` from an observation with `deriveLock` of `verify-baseline-strict-v1.mjs`, the function `--record` re-derives the lock with; the `limits` sentences are carried over by hand. |
| `baseline.lock.json` | The lock: heads, artifact blob SHAs, package facts, exact-head CI results, inventory pins, limits. |
| `verify-baseline-strict-v1.mjs` | Verifier and CLI. |
| `make-negative-report-strict-v1.mjs`, `negative-report-strict-v1.json` | Real CLI runs on mutated copies (exit code, error codes, stdout hash); `--check` recomputes them. |

## Commands

```
node next/t00/verify-baseline-strict-v1.mjs --remote --record next/t00/baseline.lock.json next/t00/fixtures/observation.json
node next/t00/verify-baseline-strict-v1.mjs next/t00/baseline.lock.json --checkout bskel=<dir> --checkout becoder=<dir> --checkout beval=<dir>
node next/t00/make-negative-report-strict-v1.mjs --check
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
| `DIRTY_STATE_UNKNOWN` | cleanliness is neither false nor explicit null in remote mode; checkout mode requires false. Missing fields and error strings are not remote observations |
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

Recorded dirty state must be boolean or explicit null. CI success requires both a completed status and a success conclusion.
Record validation accepts the six workflow statuses and nine conclusions modeled by the [GitHub CLI run implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/run/shared/shared.go), including `startup_failure` as a non-success result. A nonterminal run needs a null conclusion; a completed run needs a recognized conclusion. Unknown or contradictory states are `MALFORMED_RECORD`, even if the lock and observation hash were regenerated together.
The historical inventory source must name the canonical BSKEL repository, inventory path, pin field and the BSKEL head recorded in the same document. This binds historical metadata, not a future inventory carrier, current-main freshness, authenticated CI, signatures or freeze authority. The coordinated-forgery limit above remains.

## Isolated candidate workflow and limits

Run `node --test next/t00/baseline-strict-v1.test.mjs` for the strict suite alone. The root baseline test imports this suite alongside alignment and cross-repository tests, while preserving all original historical assertions. `npm test` discovers these suites; this is not adoption into a release workflow.

The versioned builder can derive a prospective lock at an explicitly supplied separate output path. This candidate does not authorize recapture, overwriting the historical lock or observation, or editing T23 inventory. The checked-in inputs and all historical evidence receipts remain unchanged.

The strict report has its own schema and includes SHA-256 pins for its strict verifier and generator bytes. Regenerate only this new report with `node next/t00/make-negative-report-strict-v1.mjs --write`. Historical reports and downstream evidence receipts must not be rewritten to hide failures.

Passing these tests does not establish current inventory alignment, all-writer enforcement, freeze, MET, exact-head hosted CI or independent review approval. The actual committed inventory still fails alignment with the recorded baseline. Previously failed local and CI runs remain evidence of the earlier candidate, not successful runs of this isolated tree.
