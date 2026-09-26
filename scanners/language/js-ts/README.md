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

Legacy A PR #63 contributes differential counterexamples only in this lane: comments, strings and regexes must stay inert; unterminated block comments/regexes are surfaced as lexical uncertainty and their trailing text is never promoted to module facts; syntax damage must never become a syntax-valid claim; source coordinates must remain explicit. Project IDs and game/runtime meaning remain owned by T02/T17/T18.

Issue #119 contributes an Express detector counterexample only: T04 preserves `import express, { Router } from 'express'` bindings as lexical facts, while T11 owns interpreting `express.Router()` as framework detector evidence.

## Parser dependency decision boundary

The repository root still has no approved parser dependency for T04. `backend-comparison.mjs` is the decision seam: a candidate backend must preserve the common source-fact shape, keep its syntax-validation capability explicit, accept only the bounded common options, and report differences instead of becoming authoritative automatically.

Before any package/lock change, T20/T23 approval is required for the exact parser package/version range, install/runtime trust boundary, package-size/build effect, supported source modes, execution permissions, and rollback path. T04 will not install Tree-sitter/TypeScript/compiler plugins or modify `package.json` / `package-lock.json` on this branch.

The current common comparison shape records `syntaxValidated` only. It has **no semantic-validation claim**: type resolution/type-checker correctness, framework meaning, and runtime behavior are outside #73. A future semantic capability requires a separately reviewed contract/evidence decision; it must not be inferred from `complete: true`, a parser process exiting 0, or `syntaxValidated: true`.

## Test

T04-owned tests live only under the nested ownership path. They are executed explicitly until T00/T23 provides centrally-owned nested-test discovery:

```bash
node --test \
  test/language-js-ts/source-facts.test.mjs \
  test/language-js-ts/module-resolver.test.mjs \
  test/language-js-ts/snapshot-graph.test.mjs \
  test/language-js-ts/backend-comparison.test.mjs \
  test/language-js-ts/legacy-a-regressions.test.mjs
```

No root test shim, package script, workflow, registry, stable schema, or lockfile change is owned by T04.
