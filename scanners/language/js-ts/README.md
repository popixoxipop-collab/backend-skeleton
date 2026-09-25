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

## Why no parser dependency yet

The repository currently has no Tree-sitter or TypeScript compiler dependency in its root package. T04 begins with a small deterministic boundary and a regression corpus so candidate parser backends can be measured against stable facts before changing package/lock files or existing adapter behavior.

## Test

The plan assigns T04 a nested test namespace, so this slice is tested directly without changing the shared root `package.json` test glob:

```bash
node --test test/js-ts-source-facts.test.mjs test/js-ts-module-resolver.test.mjs
```

A tiny root bridge now imports the nested source-facts corpus so the existing `test/*.test.mjs` command sees it without changing `package.json`; the resolver test already lives at the root test level. No shared package/lock file was changed.
