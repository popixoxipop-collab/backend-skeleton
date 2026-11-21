# T19 wave4: six additional executable negative-vector representations

This is a **stacked, draft-only T19 QA slice** based on exact PR #291 head `81a46f62b052227cfa64d7a64849c7b1be4f183b`, not the protected main branch. No product code, previous catalog, historical evidence, workflows or global release controls are changed.

## Scope and guards

The original program has 79 planned negative vectors. Completed/accepted main currently has **35 represented**. PR #291 adds eight unmerged representations (candidate 43), and this separate wave4 candidate adds six more (combined **49 represented / 30 not represented**). These are overlapping development representations, **not proof that 49 invariants are universally enforced**. They have no signing authority or unseen holdout status.

| Vector | Executed invariant |
|---|---|
| NEG-PROJ-03 | Reference fixture roots stay visible in project graph but do not enter default scan plan; vendor path is excluded |
| NEG-ROUTE-04 | A diamond-shaped Express router mount retains both distinct concrete absolute paths |
| NEG-ROUTE-06 | `router.use` and `router.all` do not appear as concrete GET/POST (or invented `ALL/USE`) operations |
| NEG-ROUTE-07 | Original case and percent-encoding characters in route literals are preserved instead of guessed normalization |
| NEG-RUN-02 | A deliberately failed original oracle makes a mutation campaign fail, even when the mutant fails as well |
| NEG-RUN-06 | One passed assertion cannot mask another missing/failed required assertion; explicitly optional skips remain allowed |

Six source mutations are inserted only into disposable immutable Git snapshots by the existing strict T19 runner; **three critical and three noncritical** retain original program severities and invariant wording. The live campaign requires every baseline to pass, each mutated run to exit **1 due to an actual assertion**, the same known number of tests, and no signals, timeouts, skipped or cancelled tests. A parser/module error, failed unmodified baseline, or runner interruption is never counted as a killed mutant.

Existing nested `node scripts/run-next-nested-tests.mjs T19` discovers the tests in `test/conformance-next/**` without CI modification. For a clean committed checkout with dependencies installed:

```sh
node --test --test-concurrency=1 --test-reporter=tap test/conformance-next/wave4-*.test.mjs
node test/conformance-next/product-mutation-runner.mjs \
  --repo-root "$PWD" --source-commit "$(git rev-parse HEAD)" \
  --catalog test/conformance-next/product-mutations-wave4.json \
  --out /absolute/new-wave4-report.json
```

## Limits

Project role tests check synthetic folder layouts and scan-plan choices, not the true intent of all vendor code. Express source is lexically scanned, not served as an HTTP application. Literal case/percent preservation does not claim case-sensitive runtime routing. The failing original-oracle fixture verifies a **QA decision**, not a deployed model's behavior. Some unrelated dynamic Express prefixes are currently emitted as unqualified local paths and are **not claimed solved** (NEG-ROUTE-01 remains open).

Trust the exact Git repository/Node/npm toolchain and the reported dependency cache. Future private holdout, Node18/20, broader OS coverage and remaining30 planned vectors are not supplied here. PR #290 and PR #291 independent reviews remain quota-blocked; this PR cannot inherit an approval from them. Full CI, independent code review, protected merge, actual main replay and one-row T00 adjudication are separate gates. Until those gates complete, main coverage remains35/79 and MET remains88.
