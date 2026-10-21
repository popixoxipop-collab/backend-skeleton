# T19 wave5: six more executable negative-vector representations

This additive QA slice is **stacked on PR #292** at exact commit `d88f3b3dd18abef247d7e267df76e9219be0c14e`, which is itself stacked on unmerged PR #291. It changes only T19-owned `next/t19/**` and `test/conformance-next/**` paths. It does not modify stable product implementations, prior mutation catalogs, previous baseline receipts, CI, release policy or the T00 ledger.

## Concrete scope

The original strict corpus has 79 negative vector IDs. Protected main currently represents **35/79**. Prior unmerged waves would represent 43 (wave3) and 49 (wave4). This wave adds six new IDs, making the **fully stacked candidate 55/79 represented, 24 still missing**. These are executable *development test representations*, not certified enforcement of all 55 broad invariants, holdout scores, or global task completion.

| Original vector | Concrete first-party execution |
|---|---|
| NEG-DB-01 | Composite foreign-key local/referenced ordered columns are preserved; equal counts cannot silently promote unknown FK pairing to proven pairing. Two separate mutations cover pairing and referenced-column order. |
| NEG-DB-02 | Similar logical resource / entity / physical-table names cannot implicitly activate a data-read binding; explicit entity_ref is permitted but not live-verified by that alone. |
| NEG-DB-03 | Two same-named tables in `tenant_a` and `tenant_b` remain separate in exact physical table matching, including an unspecified-schema control. |
| NEG-DB-06 | Source / migration / live DB snapshots are compared on three distinct evidence planes; a changed live PK cannot silently erase migration/live disagreement. |
| NEG-GEN-05 | A source/live-verified persistence binding is not enough for key-codec promotion if its key type is bigint/non-UUID/unknown; current handles handoff accepts only the approved single UUID shape. |
| NEG-PROJ-06 | An invalid local package manifest emits an explicit unresolved package-metadata diagnostic instead of claiming complete framework certainty. |

**7 executable source mutations**: 6 original critical, 1 noncritical. Every unmodified oracle must first pass; every mutation must fail an actual assertion with exactly the same discovered case count, exit code 1, no signal, timeouts, skip, cancellation or TODO. Mutation code is injected only into temporary Git-exported snapshots by the pre-existing T19 mutation runner. The edited stable implementation is never published.

The existing nested T19 CI discovers these files without a workflow or root ownership exception. From a clean, committed checkout with locked dependencies:

```sh
node --test --test-concurrency=1 --test-reporter=tap test/conformance-next/wave5-*.test.mjs
node test/conformance-next/product-mutation-runner.mjs \
  --repo-root "$PWD" \
  --source-commit "$(git rev-parse HEAD)" \
  --catalog test/conformance-next/product-mutations-wave5.json \
  --out /absolute/new-wave5-report.json
```

## Limitations and admission

- Persistence facts are synthetic IR fixtures, **not an actual live database query**. Composite FK mapping retains unknown pairing unless the source supplies an explicit claim; the test does not certify the truth of that claim against a live schema. Identical table-name separation is tested in the explicit-schema lookup layer, not as universal ORM behavior.
- Migration/live drift is decision-layer evidence, not an actual PostgreSQL/MySQL migration rollback.
- `NEG-GEN-05` proves the existing **handoff gate** rejects a non-UUID type; it does not prove every generated runtime codec across languages.
- `NEG-PROJ-06` covers a malformed JSON package descriptor, not every kind of incomplete checkout. Reference roots and dynamic route uncertainty remain distinct problems.
- Trusted Git/Node/npm/OS and an offline prewarmed npm dependency cache are prerequisites; Node18/20, Windows and private prospective holdouts remain outside this slice.
- PR #291 and #292 remain Draft and unmerged pending ordinary independent review; **this proposal does not waive or substitute that independent approval**. Required exact-head CI, source-bound actual replay, protected main merge, and a scoped T00 ruling are separate gates.
- Until upstream waves are individually accepted and merged, protected main coverage remains **35/79** and official **T19-04 PARTIAL / MET 88**. Successful local tests or candidate counts cannot promote T19-04 or the global release.
