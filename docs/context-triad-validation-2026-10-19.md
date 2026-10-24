# BSKEL / BECODER / BEVAL context integration verification

Observed on 2026-10-19 UTC. This report records the first integrated context-packet implementation, inspired by ECC's selective codebase-onboarding approach. The implementation is original code in the three existing products.

## Implemented behavior

| Product | Added behavior | Existing responsibility retained |
| --- | --- | --- |
| BSKEL | `context pack` selects the original feature contract, requested files and existing root metadata from one committed Git snapshot, with whole-file count/byte budgets. | Source scanning, contract production and existing gate logic. |
| BECODER | `plan --context-packet` passes the embedded contract to its existing SurfacePlan builder, records contract-to-plan hashes, and can write a development handoff directory. | UI/client SurfacePlan generation; the existing planner module is unchanged. |
| BEVAL | `context check` reads the actual Git objects and externally expected commit, verifies packet admission and provenance, then independently checks operation coverage and core plan projections. | Existing evaluation, metrics and promotion paths. |

The shared wire version is `sbf.context-packet/1`, with current feature-contract version `9`. The packet schema is vendored byte-identically in all three repositories. Its SHA-256 is `a8ad015076ddc76a7e05d759f69ba32d5c160792a2ee04faeb7f9a530f7098cf`.

The packet defaults to 16 files and 65,536 raw UTF-8 bytes, including the contract. Sources are included whole or explicitly omitted. No model token estimate or inferred test result is produced.

## Source identity

| Repository | Upstream base used | Implementation commit |
| --- | --- | --- |
| `popixoxipop-collab/backend-skeleton` | `1895450c1108a25bb149ee6be3793a3f0e2513d3` | The commit containing this report; see the content fingerprints below. |
| `popixoxipop-collab/backend-decoder` | `ebfff2205244f4866655476a828f05b9bf971cff` | [`78c7f02e166ad5ad5e1ef10358fe790c8022ed23`](https://github.com/popixoxipop-collab/backend-decoder/commit/78c7f02e166ad5ad5e1ef10358fe790c8022ed23) |
| `popixoxipop-collab/Backend-evaluation` | `60aa59b41d9ab2beed8790d08319aa9454e14e13` | [`5e239253d9598699bcd3eaeff0a11af3547eb840`](https://github.com/popixoxipop-collab/Backend-evaluation/commit/5e239253d9598699bcd3eaeff0a11af3547eb840) |

Source subsets from these exact bases were used for local tests. Patches were then applied to clean full checkouts of the real bases. Every changed file was checked byte-for-byte using SHA-256 before creating the real commits. Local synthetic fixture/baseline commits are not upstream implementation commits.

## Verification results

Tests ran locally on Node.js `v24.19.0`, using temporary committed Git fixtures. They did not invoke a model, backend server or database.

| Verification | Observed result |
| --- | --- |
| BSKEL `node --test test/context-packet.test.mjs` | 8 / 8 passed. |
| BECODER `node --test test/context-packet.test.mjs` | 9 / 9 passed; after subsequent output/presence guard changes, the 3 handoff tests and the 1 ambiguous-input test were individually rerun and passed. These are not additional unique tests. |
| BEVAL `node --test test/context-packet-eval.test.mjs` | 8 / 8 passed on the final verifier, including strengthened uncertainty and expansion checks. |
| BSKEL selected documentation/CLI contract tests | 4 / 4 passed: top-level dispatch coverage, help/flag agreement, `context pack` required input, and COMMANDS coverage. |
| Final cross-repository smoke runner | 8 / 8 cases passed after the final BEVAL changes. |
| Patch and shared-schema checks | All three staged diffs passed `git diff --cached --check`; shared packet schema bytes matched. |

This comprises 25 new focused tests, 8 integration cases and 4 selected compatibility checks. It is not a full-suite or full-runtime compatibility result. The broader Node 22 / CI matrix was not run for this slice.

### Integrated fixture and evidence

The complete observed smoke output is [context-triad-smoke-2026-10-19.json](context-triad-smoke-2026-10-19.json). The runner is [scripts/context-triad-smoke.mjs](../scripts/context-triad-smoke.mjs).

The runner creates a small FastAPI source fixture and OpenAPI document, uses BSKEL's actual scanner and reconciliation to produce a two-operation contract, then invokes all three product CLIs. The resulting packet held 6 files and 4,502 UTF-8 bytes, with 2 original contract warnings. These are fixture measurements, not a performance or token-saving benchmark. The temporary fixture is removed after the run; repeating the test creates a new commit.

The eight observed cases were:

1. Actual scanner → packet → unchanged existing planner → independent verifier succeeds, with development handoff files created.
2. Ordinary planning remains identical; explicit empty security stays distinct from absent security.
3. Working-tree edits cannot replace the pinned Git evidence.
4. A different externally expected commit is rejected even when it has an identical tree.
5. A forged contract with a rebuilt packet and newly generated plan is rejected against the real Git source.
6. A removed operation is rejected even when handoff and plan hashes are recomputed.
7. A weakened security projection is rejected even when all consumer hashes are recomputed.
8. Valid budget omissions yield `incomplete`, with exit code 3.

The separate BEVAL focused tests additionally cover exact BOM/CRLF content, forged source bytes, core parameter/payload/security/schema mutations, uncertainty text, operation rebinding, false omission reasons, symlinks, invalid paths, duplicates and byte accounting.

## Reproduction

Install each checkout's locked dependencies first. Run only the focused files listed above. From the BSKEL checkout, with the other two repositories available locally:

```sh
node scripts/context-triad-smoke.mjs \
  --becoder-dir ../backend-decoder \
  --beval-dir ../Backend-evaluation
```

The [context packet guide](context-packet-v1.md#end-to-end-cli-use) contains the actual product command sequence. BECODER's complete JSON stdout record `{plan, readWarnings, context_handoff}` is the BEVAL `--plan` input; the handoff directory's bare `surface-plan.json` is a different artifact.

## Meaning and limits

BEVAL returns `verified` / exit 0 when the requested context and the checked contract-to-plan relationships match the supplied Git snapshot. It returns `incomplete` / exit 3 for an otherwise valid chain with documented requested-file omissions, and `invalid` / exit 2 for evidence mismatch. Argument errors use exit 1.

The verifier independently checks verb/path, operation identity and coverage, provenance, summaries/tags, expansion, parameters, security, core request/response/error schema projections and uncertainty-bearing blanks. Complete UI `formFields` projection and renderer behavior are outside this verification scope.

This result establishes context and core plan traceability. It does not establish application functionality, implementation quality, improved model performance, official T19 acceptance, MET changes or release promotion. No automatic pattern learning is implemented in v1. A future learning loop should use separately verified outcomes.

## Content fingerprints

The following fingerprints cover the changed implementation, schema, documentation and test files used in this verification. This report and its smoke-output copy are excluded to avoid self-referential hashing.

| Repository | Changed file | SHA-256 |
| --- | --- | --- |
| bskel | `README.md` | `4b89ba97cec39c4ede181eeb89c3b877057447f91302899063821910d5a62f8b` |
| bskel | `bin/bskel.mjs` | `f8ecf7e28693df3894fa115aa497d6ad1d50786e48e7d7730ff867d2225a9113` |
| bskel | `docs/context-packet-v1.md` | `5a1da3c8f899627f71bc75630a16f4d63833b1b0ca01c1ba020a252155c929ee` |
| bskel | `lib/cli.mjs` | `dc5a38cbd37118496bfa6ca66edeb0f60c1300697789ce63195008185c74abf7` |
| bskel | `lib/context-packet.mjs` | `12f9c6a8521df4d69e45b2f0b244c9a7ef2d03a707cc2d7d5877ccf2d091ecb6` |
| bskel | `schemas/context-packet.schema.json` | `a8ad015076ddc76a7e05d759f69ba32d5c160792a2ee04faeb7f9a530f7098cf` |
| bskel | `scripts/context-triad-smoke.mjs` | `810a5a03ae02cb80734b30341043be51cfa65aea099d4d2ed4762babd3a49a80` |
| bskel | `test/cli-contract.test.mjs` | `3a6bcc42fac3aa622ec779a1befba0995a719f947c8b134a1f84ab060d1078d6` |
| bskel | `test/context-packet.test.mjs` | `c3a874b0c942709a526373782a91e8a64d92e385ebce913162710089ae8f4416` |
| becoder | `README.md` | `a4cd9af53c0d9981eecca730bf242fed88838a58fe0e489e51bae8e4954b811f` |
| becoder | `bin/becoder.mjs` | `8efbfe4d5b1621c0e25d1d9620b645ae61b7a1ec784c8a52e846dc6adf66fdc9` |
| becoder | `docs/context-handoff-v1.md` | `fd736ebf77ffe85fbe0b9bf6510b3933c06ff97c6bbdf6de8b5432f8cdf35a6c` |
| becoder | `lib/context-packet.mjs` | `a5ce20be45ec5eb56ab80c92f600d8f31381fa04fb795569e6d4a97380132cb1` |
| becoder | `lib/read-contract.mjs` | `12ecb4c5a79c54c4db219573ea86c8a165bdd07502c5d0dc8b91e3e3fd36be3e` |
| becoder | `schemas/context-packet.schema.json` | `a8ad015076ddc76a7e05d759f69ba32d5c160792a2ee04faeb7f9a530f7098cf` |
| becoder | `test/context-packet.test.mjs` | `2b83683568fb2f7efda88fa8cf91d3c5960961e2edd5e9a1c6b086893c0b3685` |
| beval | `docs/context-check-v1.md` | `1aad8b3626eef8501952c2f42bb10e747529065491e67896baa678ddfa035f3c` |
| beval | `lib/cli.mjs` | `3733dbb3fbcc543c9bfbeff603e1d1e1325109cbc337cb26e66f4fac2ea7bb60` |
| beval | `lib/context-packet-eval.mjs` | `e3cd726e6bd94b7d3c11b4843b6093f28afa5b0a600dcb74ca080518d30f5a22` |
| beval | `lib/schemas.mjs` | `34f1fc9f06d74ac91e694e51930ec71d8ba719ec91f7a4ea8adf5266296100d1` |
| beval | `schemas/context-packet.schema.json` | `a8ad015076ddc76a7e05d759f69ba32d5c160792a2ee04faeb7f9a530f7098cf` |
| beval | `test/context-packet-eval.test.mjs` | `1b15144645b1c1de401977522aec21003b932117aa51ce271b92140bd63d33f3` |
