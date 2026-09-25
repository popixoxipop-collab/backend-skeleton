# T19 QA corpus-next

This directory is owned by the T19 independent QA track.

## Admission rules

- Every corpus entry uses an exact 40-hex commit, never a branch or tag.
- License metadata is recorded before admission.
- A `source_family` identifies forks/templates so the same family cannot leak across reference and holdout splits.
- `golden_basis` explains where the expected result comes from. Candidate-adapter output must not be copied into its own golden.
- Known limitations are recorded explicitly instead of being removed from the denominator.
- `holdout_entries` stays empty until T19 has independently selected and reviewed repositories that were not used to design the adapter.

The initial reference entries intentionally reuse four already-pinned real repositories from the existing `test/fixtures/oracle-manifest.json`. This file adds QA split/licensing/golden-basis metadata; it does not replace the existing shadow-validation oracle.

## Metrics

For full-surface inventory evaluation, an abstention/unknown on a gold item is counted as a false negative and also reported separately as abstention. This prevents recall inflation by excluding unknowns.

## Negative vectors

`negative-vectors.json` begins with 24 cross-cutting invariants: identity, project scoping, routes, schema, auth, database, cache, run evidence, game behavior, trust, generation, and release. These are catalog entries, not claims that every executable mutation fixture already exists.

## Task status

- T19-01: this slice implements the corpus manifest rules and a reference split. Holdout selection is deliberately still empty.
- T19-02: this slice implements the initial 24-vector catalog and validates its structure/coverage.
- T19-03/T19-04/T19-06: `../conformance-next/harness.mjs` contains reusable metric/mutation/evidence primitives and tests, but these tasks are not declared complete until their upstream dependencies and real execution artifacts exist.
