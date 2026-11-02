# T19 Wave7 — OpenAPI schema fidelity negative-vector controls

This is an **unmerged T19 QA candidate stacked on PR #295** (exact base HEAD `d883b334fd374e41aa0f712dbb881c9faadc8090`). It changes only T19 test files and this T19 document; the original OpenAPI converter, prior mutation catalogs, protected CI, published packages, T00 ledger and releases are unchanged.

## Six original negative vectors, eight live source mutations

| Original ID | Meaning and actual first-party check |
|---|---|
| `NEG-SCHEMA-01` | Unsupported `patternProperties` schema is explicitly rejected; no silent loss of a constraint or capability promotion |
| `NEG-SCHEMA-04` | `oneOf`, `anyOf` and source discriminator metadata survive schema projection without inventing a different union semantics (two mutations: branch handling and discriminator) |
| `NEG-SCHEMA-05` | `type:['string','null']` remains distinct from required/optional property presence; 3.0-style `nullable:true` is explicitly rejected as unsupported in this OpenAPI 3.1 projection |
| `NEG-SCHEMA-06` | Matched request-body vs success-response schema retain their separate required fields; unsupported `writeOnly` annotation fails closed instead of being copied across directions |
| `NEG-SCHEMA-07` | A `multipart/form-data` binary source request retains its original transport metadata and is marked non-JSON rather than emitted as a JSON-body schema |
| `NEG-SCHEMA-08` | `int64` remains precision-marked, unknown `decimal` format fails closed, and copied query parameter `style:form` / `explode:true` remain present (two mutations: safe format and serialization) |

All eight code mutations are T19 test inputs applied only to disposable **exact-Git-source** snapshots by the existing mutation runner: **seven critical, one noncritical**, severity and invariants copied byte-for-byte from the original 79-vector catalog. Each candidate test file is a single-case original first-party source-converter oracle. A true kill requires that the unmodified oracle passes and the mutated source exits code 1 due to an actual failed assertion, with exactly the same one-case count, no timeout, signal, skip, cancellation or TODO. Import/parse/setup failures are never knowingly counted as killed; the separate generic semantic-kill fix remains pending in PR #294 and is not silently included here.

## Reproduction

From an authenticated/reviewed clean checkout with the committed T19 wave7 files and pre-warmed npm dependencies:

```sh
node --test --test-concurrency=1 --test-reporter=tap test/conformance-next/wave7-*.test.mjs
node test/conformance-next/product-mutation-runner.mjs \
  --repo-root "$PWD" \
  --source-commit "$(git rev-parse HEAD)" \
  --catalog test/conformance-next/product-mutations-wave7.json \
  --out /absolute/new-wave7-report.json
```

## Non-claims

The converter's source-backed schema projection is a subset of OpenAPI 3.1 / JSON Schema 2020-12. These tests specifically inspect the existing behavior and **do not add support** for `writeOnly`, decimal, `patternProperties`, OpenAPI 3.0 `nullable`, path parameter serializers, or actual multipart upload execution. A `readOnly` documentation annotation's retention with `includeFieldDocs:true` is not dynamic access-control enforcement. Schema validation units are synthetic and are not real network/API or provider runs; source inventory hashes prove exact data identity, not cryptographic host attestation.

Original planned corpus: 79 vectors. Protected main currently has 35 represented. Only if the separate upstream Draft PRs #291→#292→#293→#295 are all reviewed and merged, these additional six proposed vector representations would bring the stacked candidate to **67/79, leaving 12 unrepresented**. This is a measure of *development test representation*, not universal product correctness or T19-04 MET. Node18/20, Windows and live external holdout evidence remain separate. No MET change, production service mutation, npm publication, Tailnet release activation, waiver or independent review approval is claimed from this draft.
