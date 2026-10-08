# JS/TS language facts — T04 initial slice

This directory is the first T04 language-analysis boundary. Its `bskel.internal.js-ts-source-facts/0` shape is provisional and intentionally not an SBF cross-tool contract; T01 owns any future stable shared vocabulary. It is intentionally below framework adapters and intentionally **does not** execute target code.

## Shipped in this slice

`source-facts.mjs` extracts only source-backed literal module edges from JavaScript/TypeScript/JSX/TSX text. `module-resolver.mjs` consumes those facts plus an explicit repository file inventory; its `bskel.internal.js-ts-resolution/0` output is also provisional and T04-internal:

- ESM `import ... from` and side-effect imports
- TypeScript `import type` and named `type` bindings
- ESM `export ... from`
- CommonJS literal `require()` with simple direct/destructured bindings
- literal `import()` as a distinct dynamic edge
- UTF-8 byte spans and line numbers; diagnostics are also byte-positioned
- every emitted edge is explicitly `basis: lexical-literal`, `resolution: unresolved`
- `syntaxValidated: false` so `complete` cannot be mistaken for full JavaScript/TypeScript semantic completeness
- explicit diagnostics for non-literal/escaped/unparsed constructs
- hard byte/token limits that return no partial facts when exceeded
- relative module resolution only when exactly one inventory path matches; aliases/packages stay unresolved
- resolver `complete` means the pass finished, while `allResolved` separately says whether every edge actually resolved
- source lexical provenance and `syntaxValidated: false` propagate through resolution

It does **not** resolve package exports or tsconfig aliases, execute package hooks, infer framework semantics, evaluate TypeScript types, parse template-expression code, decode escaped module specifiers, or replace the existing Express adapters. Those are later T04 slices after the parser/backend comparison and interface freeze.

## Multi-file snapshot and backend comparison

`snapshot-graph.mjs` accepts an explicit in-memory repository snapshot, sorts paths deterministically, runs the lexical facts layer per file, and resolves only unambiguous relative edges against that supplied inventory. It does not walk the filesystem or execute project code. `complete`, `allResolved`, and `syntaxValidated` are separate so callers cannot confuse “the pass finished” with “every module resolved” or “JavaScript/TypeScript syntax was validated”.

`backend-comparison.mjs` defines a provisional first-party parser backend boundary and a deterministic corpus comparator. The bounded lexical backend is the current reference because it is the only implemented backend in this branch; that does **not** declare it semantically superior. Future Tree-sitter or TypeScript Compiler candidates can be plugged into the comparator after their dependencies, sandboxing, packaging, and version ranges are approved. Differences are reported by field instead of automatically selecting a winner.

## Validation boundary and Legacy A reconciliation

`complete: true` means the bounded lexical pass finished; it does **not** mean JavaScript/TypeScript syntax is valid. Delimiter damage can still leave literal module facts visible while `syntaxValidated` remains false. Actual syntax/semantic claims require a separately approved parser backend and its own execution evidence.

Coordinates are exact for the **source string supplied to this API**. If a caller extracts a `<script>` fragment from a Svelte/HTML container, these line/byte coordinates are fragment-relative unless the container parser supplies host-file offset/provenance. T04 does not duplicate Legacy A's Svelte parser or claim host-container coordinates.

Legacy A (the open, unmerged draft pull request 63; head commit `4e2e15e200eb965d4107acf59db21583d2657ea1`, with the cited commits pinned in `BASELINE.json`) contributes differential counterexamples only in this lane: comments, strings and regexes must stay inert; unterminated block comments/regexes are surfaced as lexical uncertainty and their trailing text is never promoted to module facts; syntax damage must never become a syntax-valid claim; source coordinates must remain explicit. Project IDs and game/runtime meaning remain owned by T02/T17/T18.

The Express handoff (issue 119, closed as completed on 2026-09-27; an issue has no commit, so `BASELINE.json` pins its state and timestamps) contributes an Express detector counterexample only: T04 preserves `import express, { Router } from 'express'` bindings as lexical facts, while T11 owns interpreting `express.Router()` as framework detector evidence.

## Parser dependency decision boundary

The repository root still has no approved parser dependency for T04. `backend-comparison.mjs` is the decision seam: a candidate backend must preserve the common source-fact shape, keep its syntax-validation capability explicit, accept only the bounded common options, and report differences instead of becoming authoritative automatically.

Before any package/lock change, T20/T23 approval is required for the exact parser package/version range, install/runtime trust boundary, package-size/build effect, supported source modes, execution permissions, and rollback path. T04 will not install Tree-sitter/TypeScript/compiler plugins or modify `package.json` / `package-lock.json` on this branch.

The current common comparison shape records `syntaxValidated` only. It has **no semantic-validation claim**: type resolution/type-checker correctness, framework meaning, and runtime behavior are outside this slice (the closed, unmerged draft pull request 73, head commit `1e2d037dedc5ba035248e4d67255c2850973afe8`, is not a contract). A future semantic capability requires a separately reviewed contract/evidence decision; it must not be inferred from `complete: true`, a parser process exiting 0, or `syntaxValidated: true`.

## Baseline record

`BASELINE.json` (schema `bskel.track-baseline-record/1`, provisional) fixes the behavior of this slice at one exact revision: base commit `9985dd9a51d2acf516fd38e27282c6a4398e16d0` (the origin/main head that the pull request adding the record was based on), the SHA-256 and Git blob id of every source and test file, the commands that were run with their exit codes and test counts, 27 fixtures (7 normal, 20 negative) with the SHA-256 of each full API result, the pinned Legacy A and issue evidence, and the remaining limits. `test/language-js-ts/baseline-record.test.mjs` recomputes the byte count, SHA-256 and Git blob id of every pinned source and test file and compares all three with the record. Against the checkout, a file that matches all three is fresh; a file whose hashes disagree in only one place, or whose size alone disagrees, fails the test as a damaged record; a file that matches neither hash means the tree has moved on, so the live replays are skipped and the pinned commit decides. The base commit is mandatory: it is read from the checkout, fetched once with `git fetch --no-tags --depth=1 origin <commit>` when a shallow checkout lacks it, and the `git:` tests fail with `pinned commit unavailable` when that is impossible, unless `BASELINE_ALLOW_UNVERIFIED=1` skips them explicitly. A shallow checkout is deepened once with `git fetch --unshallow origin` and the base commit must then be an ancestor of `HEAD`; a failed deepening fails the test unless the same variable skips it explicitly. The test also replays the fixtures and the recorded commands and rejects tampered records, including a changed hash or byte count of the same length. It is a baseline and not a support claim: `syntaxValidated` is false in every recorded output, and the limits list what is unsupported, unknown or not recorded.

## Test

T04-owned tests live only under the nested ownership path. On `main` the nested-next CI job runs them centrally as the `T04 language-js-ts` step (`.github/workflows/ci.yml` lines 132-133 at commit `9985dd9a51d2acf516fd38e27282c6a4398e16d0`, `node scripts/run-next-nested-tests.mjs T04`). The explicit command below still works for a direct local run:

```bash
node --test \
  test/language-js-ts/source-facts.test.mjs \
  test/language-js-ts/module-resolver.test.mjs \
  test/language-js-ts/snapshot-graph.test.mjs \
  test/language-js-ts/backend-comparison.test.mjs \
  test/language-js-ts/legacy-a-regressions.test.mjs \
  test/language-js-ts/baseline-record.test.mjs
```

No root test shim, package script, workflow, registry, stable schema, or lockfile change is owned by T04.
