# T19 conformance-next

Independent QA primitives for the T19 track. These files do not replace existing scanner or shadow-validation tests.

## Run

```bash
node --test test/conformance-next/harness.test.mjs test/conformance-next/certify.test.mjs
```

The repository's current `npm test` glob is `test/*.test.mjs`, so it does **not** include these nested tests. Wiring this command into shared CI/package scripts is intentionally left to the integration/release owners rather than changing shared files from T19.

## What the gate means

- unknown/abstention on a gold item remains a false negative in full-surface recall and is reported separately
- critical mutation survivors fail the mutation gate
- an empty noncritical mutation denominator is not reported as 100%
- a pass evidence pack cannot hide skipped/blocked required commands
- artifact bytes are re-hashed from an approved root before disk-backed evidence is accepted
- path traversal and symlink artifacts are rejected
- the public reference corpus has no committed holdout entries, so full certification is BLOCKED by default
- `--allow-no-holdout` exists only for explicit reference-corpus/internal validation; it is not release certification

## CLI

`certify.mjs` reads one JSON object on stdin and writes one certification report to stdout.

```bash
node test/conformance-next/certify.mjs --artifact-root ./qa-artifacts < qa-input.json
```

Exit codes:

- 0 — pass
- 1 — invalid input / CLI failure
- 2 — blocked
- 3 — failed conformance

A holdout set should be injected only at certification time from an independent source. Committing the actual holdout list to a public development branch would allow implementation agents to tune against it and defeat the purpose of the holdout.
