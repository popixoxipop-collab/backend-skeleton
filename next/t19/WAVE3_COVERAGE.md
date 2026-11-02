# T19 wave 3: eight additional executable negative-vector representations

This is an additive QA change, not a runtime feature, release authorization or full T19 completion. Stable implementation files, previous catalogs, historical receipts and policies are unchanged. Mutants are applied only to the existing runner's disposable Git snapshots.

## Coverage and semantic boundary

Ten mutants represent eight formerly absent vector IDs: NEG-ID-02/03/04/05, NEG-RUN-07, NEG-RELEASE-03/04 and NEG-ROUTE-02. Nine mutants are critical and one is noncritical, using original planned severities and invariants.

- Identity: missing operation cannot be repaired by a display alias; field binding retains request location; same-named actions retain contract/project scope; exact-byte artifact identity never normalizes Unicode.
- Run evidence: nonterminal states cannot pass either compatibility-inventory validation or the release-blocker decision. This is decision-layer coverage, not real fleet-job enforcement.
- Package closure: real npm pack and offline installed-SDK consumption must contain both the SDK and its declared contract helpers. No package is published.
- Consumer-first migration: release-plan validation rejects premature writer-mode changes. This does not establish cross-repository runtime compatibility.
- Routes: a single statically proven Express router mounted twice preserves both literal absolute paths. Source is inspected, not served as a live web application.

The original catalogs represent 35 of 79 planned vectors. This candidate adds eight, making 43 represented and 36 still unrepresented. These are counts of executable development representations, not evidence that each broad invariant is universally solved. Until review and merge, main/canonical coverage remains 35/79 and official MET remains unchanged.

## Execution

From a clean checkout containing this change, with the ordinary locked dependencies installed:

```sh
node --test --test-concurrency=1 test/conformance-next/wave3-*.test.mjs
node test/conformance-next/product-mutation-runner.mjs \
  --repo-root "$PWD" \
  --source-commit "$(git rev-parse HEAD)" \
  --catalog test/conformance-next/product-mutations-wave3.json \
  --out /absolute/new-wave3-report.json
```

The existing `node scripts/run-next-nested-tests.mjs T19` CI entry automatically discovers the new tests. It executes the real ten-mutant campaign, not only static recorded metrics. No workflow or root-test ownership exception is required.

The campaign binds one immutable commit and makes a clean temporary clone before the existing runner operates. This avoids unrelated parallel tests contaminating the source. Every unmodified oracle must pass. Every mutated run must terminate with assertion-test exit 1, the expected number of discovered tests, no skipped/cancelled cases, no signal and no timeout. Replacement code is separately syntax-checked; parser/import failures are not valid substitutes for the expected test counts.

## Limitations and acceptance

Trusted Git/Node/npm/toolchain and cached dependencies are prerequisites for offline execution. Expected values are development fixtures, not private holdout data or signed attestations. Full T19 coverage, Node18/20 failures, Windows and wider platform validation, original-oracle failure and incomplete-assertion vectors remain outside this slice. Historical 18/23 and corrected 23/23 wave2 records are preserved.

Independent review, exact-head required CI, normal protected merge and final source-bound replay are separate requirements. Test counts and local mutant detection never self-authorize a canonical MET change. Current independent-review quota blocking in another PR is not waived or bypassed here.
