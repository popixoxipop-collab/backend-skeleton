# T19 conformance-next

Independent QA primitives for the T19 track. These files do not replace existing scanner or shadow-validation tests.

## Run

```bash
node --test \
  test/conformance-next/bounded-process.test.mjs \
  test/conformance-next/harness.test.mjs \
  test/conformance-next/certify.test.mjs \
  test/conformance-next/mutation-runner.test.mjs \
  test/conformance-next/product-mutation-runner.test.mjs \
  test/conformance-next/product-security-invariants.test.mjs
```

The repository's `npm test` glob is `test/*.test.mjs`, so it does **not** include these nested tests. On `main` the nested-next CI job runs them as the `T19 conformance-next` step (`.github/workflows/ci.yml:158-159`, `node scripts/run-next-nested-tests.mjs T19`). T19 itself still does not change shared CI or package scripts; that wiring is owned by the integration/release owners.

## What the gate means

- unknown/abstention on a gold item remains a false negative in full-surface recall and is reported separately
- critical mutation survivors fail the mutation gate
- an empty noncritical mutation denominator is not reported as 100%
- a product mutant whose unmodified baseline is killed by a signal or by its timeout gets exactly one more baseline attempt (`baseline.attempts`, with the first in `baseline.prior_attempts`); a baseline that still does not exit 0 is `baseline-failed` and never counts as killed, a baseline that exits non-zero by itself is not retried, and mutated runs are never retried
- a pass evidence pack cannot hide skipped/blocked required commands
- artifact bytes are re-hashed from an approved root before disk-backed evidence is accepted
- corpus/holdout inventory evidence must record successful controlled-checkout provenance pinned to the exact repository commit
- path traversal and symlink artifacts are rejected
- the public reference corpus has no committed holdout entries, so full certification is BLOCKED by default
- `--allow-no-holdout` exists only for explicit reference-corpus/internal validation; it is not release certification

## CLI

`certify.mjs` reads one JSON object on stdin and writes one certification report to stdout.

```bash
node test/conformance-next/certify.mjs \
  --artifact-root ./qa-artifacts \
  --source-commit <40-hex-release-SHA> \
  --holdout-manifest ./private-holdout.json \
  < qa-input.json
```

The mutation runners require a clean Git checkout, emit the tested HEAD as `source_commit`, and emit `catalog_sha256` for the exact parsed mutation definitions. Callers may additionally pass `--source-commit <40-hex-SHA>` to require an exact checkout match; certification rejects reports whose catalog digest differs from the committed catalog.

Exit codes:

- 0 — pass
- 1 — invalid input / CLI failure
- 2 — blocked
- 3 — failed conformance

A holdout set should be injected only at certification time from an independent source. Committing the actual holdout list to a public development branch would allow implementation agents to tune against it and defeat the purpose of the holdout. Private holdout artifacts must be signed by an independent Ed25519 runner key whose public key is already approved in the committed `holdout-attestors.json` registry. Caller-supplied trust anchors are not accepted. The registry is intentionally empty until an independent attestor key is separately reviewed and provisioned, so release certification remains fail-closed in the meantime.


## Mutation inventory

Current catalog:

- T19 harness mutants: 7
- product-core mutants: 13
- total executable mutation fixtures represented: **20**
- planned negative-vector catalog: 79

The product-core catalog contains **13** executable mutants, including generated-file overwrite protection (`NEG-GEN-01`) and lexical root traversal containment (`NEG-TRUST-02`). The current-main campaign and **13/13 killed** result are recorded in `evidence/next/T19-CURRENT-MAIN-ACCEPTANCE.md`.

Mutation fixture count is not negative-vector certification coverage. A single vector may need additional runtime/platform evidence, and the remaining catalog items are not considered executable merely because they are documented.

## Wave-2 product mutations, permission matrix and evidence records

- `product-mutations-wave2.json` adds executable mutants for negative vectors that the pilot catalog (`product-mutations.json`) leaves without one. `product-mutation-runner.mjs` applies and runs them.
- `product-wave2-invariants.test.mjs` holds the killer tests that close the gaps the wave found. Some mutants still survive because the owning tracks have no test for them; the survivor register in the mutation record lists them and their analysis.
- `permission-matrix.json` and `permission-matrix.test.mjs` hold a normal and a negative case for every cell, at the policy-decision layer only. They do not test runtime enforcement.
- `evidence/next/T19-WAVE2-MUTATION-RECORD.json` and `evidence/next/T19-WAVE2-CROSS-VERSION.json` are self-computed records of local campaigns and suite runs. `wave2-evidence.test.mjs` recomputes them from Git history and the committed logs. No signed attestation exists. To refresh them, re-run the campaigns against a new source commit, rebuild the records, and commit them as an evidence-only descendant of that commit.
