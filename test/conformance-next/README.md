# T19 conformance-next

Independent QA primitives for the T19 track. These files do not replace existing scanner or shadow-validation tests.

## Run

```bash
node --test \
  test/conformance-next/harness.test.mjs \
  test/conformance-next/certify.test.mjs \
  test/conformance-next/mutation-runner.test.mjs \
  test/conformance-next/product-mutation-runner.test.mjs \
  test/conformance-next/product-security-invariants.test.mjs
```

The repository's current `npm test` glob is `test/*.test.mjs`, so it does **not** include these nested tests. Wiring this command into shared CI/package scripts is intentionally left to the integration/release owners rather than changing shared files from T19.

## What the gate means

- unknown/abstention on a gold item remains a false negative in full-surface recall and is reported separately
- critical mutation survivors fail the mutation gate
- an empty noncritical mutation denominator is not reported as 100%
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
