# JS/TS language facts: interface RFC (T04-02)

Status: **provisional**. Every shape below is `bskel.internal.*/0`, owned by T04, and is **not** an SBF
contract. Nothing in `contracts/next` or `schemas/next` describes it, and T01 owns any future stable shared
vocabulary. This layer does not execute target code and does not validate JavaScript or TypeScript syntax.

## 1. Modules and contract strings

| File (in `scanners/language/js-ts/`) | Exports | Job |
|---|---|---|
| `source-facts.mjs` | `JS_TS_FACTS_CONTRACT`, `analyzeJsTsSource` | lexical module edges from one source string |
| `module-resolver.mjs` | `DEFAULT_JS_TS_EXTENSIONS`, `JS_TS_RESOLUTION_CONTRACT`, `resolveJsTsModuleEdge`, `resolveJsTsModuleEdges` | edges against an explicit file inventory |
| `snapshot-graph.mjs` | `JS_TS_SNAPSHOT_CONTRACT`, `analyzeJsTsSnapshot` | many files: facts, then resolution, one graph |
| `backend-comparison.mjs` | `JS_TS_BACKEND_CONTRACT`, `analyzeWithJsTsBackend`, `compareJsTsBackends`, `lexicalJsTsBackend`, `validateJsTsBackend` | parser backend seam and corpus comparator |

Contract strings: `bskel.internal.js-ts-source-facts/0`, `bskel.internal.js-ts-resolution/0`,
`bskel.internal.js-ts-snapshot/0`, `bskel.internal.js-ts-backend/0`. The `/0` means unstable: any field can change.

## 2. Inputs

- `analyzeJsTsSource(source, { filePath = '<memory>', language = 'javascript', maxBytes = 4 MiB, maxTokens = 250000 })`.
  `language` is one of `javascript`, `typescript`, `jsx`, `tsx`. Another language, a non-string source or a
  non-positive limit throws `TypeError`.
- `resolveJsTsModuleEdges(sourceFacts, { knownFiles, extensions })`: `sourceFacts` must carry the facts contract;
  `knownFiles` is a non-string iterable of repository-relative paths; `extensions` defaults to `DEFAULT_JS_TS_EXTENSIONS`.
- `analyzeJsTsSnapshot(entries, { maxFiles = 20000, maxTotalBytes = 32 MiB, maxFileBytes, maxFileTokens, extensions })`:
  `entries` are `{ path, source, language? }`; the language is inferred from `.ts .mts .cts .tsx .jsx .js .mjs .cjs`.
  The snapshot is in memory; nothing walks the file system.
- A backend is `{ contract, id, syntaxValidated, analyze(source, options) }`. The common options are exactly
  `filePath`, `language`, `maxBytes`, `maxTokens`; any other option throws. `compareJsTsBackends(backends, corpus,
  { referenceBackendId = 'bounded-lexical', maxCases = 1000, maxCorpusBytes = 32 MiB })`.

## 3. Outputs

- Facts: `contract`, `filePath`, `language`, `complete`, `syntaxValidated` (always `false`), `inputBytes`,
  `moduleEdges`, `diagnostics`. An edge has `kind`, `specifier`, `bindings`, `typeOnly`, `basis`
  (`lexical-literal`), `resolution` (`unresolved`) and `source` (`byteStart`, `byteEnd`, `line`).
- Edge kinds: `import`, `export-from`, `require`, `dynamic-import`. Binding kinds: `named`, `default`,
  `namespace`, `commonjs-default`, `commonjs-named`.
- Resolution: `contract`, `sourceFactsContract`, `filePath`, `complete`, `allResolved`, `sourceSyntaxValidated`,
  `resolutions` (edge fields plus `status`, `reason`, `target`, `candidates`), `diagnostics`.
- Snapshot: `contract`, `complete`, `allResolved`, `syntaxValidated`, `totalBytes`, `files`, `moduleGraph`,
  `diagnostics` (each tagged with `filePath`).
- Comparison: `referenceBackendId`, `backendIds`, `corpusCases`, `corpusBytes`, `cases` of `outcomes` and `comparisons`.

## 4. Identity

- A file is its canonical repository-relative path: `\` becomes `/`; absolute, drive-letter and `..`-escaping
  snapshot paths throw `TypeError`. A resolved `target` is exactly one path of the supplied inventory.
- An edge has no id. It is located by file, `source.byteStart`, kind and `specifier`, and outputs are sorted by
  that key, so input order does not change the output.
- `byteStart` and `byteEnd` are UTF-8 byte offsets and `line` is 1-based, relative to the string passed in. A
  script fragment cut from an HTML or Svelte file is fragment-relative.
- Project identity (`project_id`) belongs to T02. This layer has none.

## 5. Unknown and partial semantics

Unknown stays unknown: a construct the lexer cannot prove becomes a diagnostic, never an edge and never
"supported".

| Outcome | Layer | Codes |
|---|---|---|
| Hard stop: `complete: false`, empty edge, resolution, file and graph lists | facts | `input-too-large`, `token-limit` |
| | resolver | `source-facts-incomplete` |
| | snapshot | `file-limit`, `snapshot-too-large`, `unsupported-extension` |
| Partial: `complete: true`, a diagnostic and no edge for that construct | facts | `dynamic-import-nonliteral`, `require-nonliteral`, `import-unresolved`, `escaped-module-literal`, `unterminated-string`, `template-expression-unparsed`, `unterminated-template`, `unterminated-block-comment`, `unterminated-regex` |

A file whose facts are incomplete stops the whole snapshot. Edges the resolver cannot settle stay in the graph:

| `status` | `reason` | Diagnostic |
|---|---|---|
| `resolved` | none; `target` is the single inventory match | none |
| `missing` | `no-inventory-match` | `module-missing` |
| `ambiguous` | `multiple-inventory-matches` (all listed in `candidates`) | `module-ambiguous` |
| `bare` | `package-or-alias-resolution-not-in-lexical-layer` | `module-bare` |
| `unsupported` | `absolute-specifier`, `query-or-fragment-specifier`, `invalid-specifier` | `module-unsupported` |
| `blocked` | `repository-root-escape` | `module-blocked` |

`complete` means the pass finished. `allResolved` is separate, and `syntaxValidated` is always `false` for the
lexical backend; a backend declared `syntaxValidated: false` may not return `true`. The comparator reports
differences by field (`complete`, `syntaxValidated`, `moduleEdges`, `diagnostics`, `normalized-output`) and
`backend-error` when a backend throws. It never picks a winner.

## 6. File ownership

T04 owns `scanners/language/js-ts/` and `test/language-js-ts/` only. It edits nothing else.

| Track | Owns, and T04 does not touch |
|---|---|
| T01 | stable shared vocabulary: `contracts/next`, `schemas/next` (no entry for this layer yet) |
| T02 | project roots and `project_id`; T04 sees only an explicit file inventory |
| T11 | Express and other HTTP framework meaning; T04 keeps `import express, { Router } from 'express'` as bindings |
| T17 | game and runtime meaning |
| T20, T23 | approval of any parser dependency; `package.json` and lockfile |

## 7. Evidence

| Command | Exit |
|---|---|
| `node --test test/language-js-ts/interface-rfc.test.mjs` | 0 |
| `node scripts/run-next-nested-tests.mjs T04` | 0 |

Fixture artifact: sha256 of the canonical JSON (object keys sorted at every level) of the whole
`analyzeJsTsSnapshot` result for the seven in-memory files in `test/language-js-ts/interface-rfc.test.mjs`:
`d7b4c2107e11dd82c79bd73bd4611c24796c01dd07d271a4d482ebf04f5f2d6b`. The record is
`test/language-js-ts/interface-rfc.vocabulary.json`; the test recomputes the hash, compares the vocabulary with
the source, runs one negative case per hard stop, and shows the comparison can fail. It does not check the field
lists and defaults in sections 2 and 3, which were read from the source.

## 8. Remaining limits

1. Provisional and not in `contracts/next`: this RFC freezes nothing.
2. No syntax validation, type resolution or framework meaning. `complete: true` is not "valid code".
3. Edges exist only for single trusted quoted literals; escaped, non-literal and unterminated specifiers give a
   diagnostic and no edge.
4. Resolution is relative-only against the supplied inventory. Package exports, tsconfig aliases and
   `node_modules` are never consulted (`bare`).
5. `allResolved` is vacuously `true` when a snapshot has no edges; read the edge list too.
6. One backend exists (`bounded-lexical`). The comparator has never compared two real parsers.
7. Verified on macOS with Node v24.19.0 only; there is no Windows run.
