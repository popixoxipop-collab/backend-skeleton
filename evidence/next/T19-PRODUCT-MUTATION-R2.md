# T19 product mutation coverage R2 — 2026-09-26

Status: QA implementation evidence only. No framework/runtime/release certification is granted by this file.

Active PR: #118
Base product revision for the tested source files: `9c4719f629ea72696b95160e643d1e6937bd7613`

## New product mutation fixtures

### NEG-GEN-01 — hand-edited generated file must not be overwritten

Product source:
- `lib/handles-manifest.mjs`
- Git blob: `e7a6ade3de64a9046e6c77016bb3405fd6ff6ae5`

Regression:
- `test/handles-manifest.test.mjs`
- Git blob: `6238faedd84cdef194e2848105bc411cbbeda7a2`

Mutation:
```text
if (!matchesPristineRender) return 'conflict';
->
if (!matchesPristineRender) return 'update';
```

EOE staged-source baseline:
- request id: `af33ebe6-d69c-4958-b39a-464642e986e9`
- command: `node --test t19_pmut_handles.test.mjs`
- result: **11/11 PASS**

EOE staged-source mutant:
- request id: `1f79eaca-1e2d-4fe6-9c2f-588fcd779039`
- result: **10 pass / 1 fail**
- killed by: `classifyFile: no manifest entry and disk content matches NO pristine render -> conflict`
- observed wrong value: `update` instead of `conflict`

Verdict: **KILLED**.

### NEG-TRUST-02 — lexical parent traversal must not escape approved root

Product source:
- `lib/fsutil.mjs`
- Git blob: `20e431552b0121dad5407be63b0c11017ff6a285`

T19 regression:
- `test/conformance-next/product-security-invariants.test.mjs`
- Git blob: `8c2c6ae4dc45fd57f447ddc503d6ed8219474a7b`

Mutation:
```text
if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
->
if (rel === '..' || path.isAbsolute(rel)) return null;
```

EOE staged-source baseline:
- request id: `85a28507-1899-48e8-9c92-f65e42282e52`
- command: `node --test t19_pmut_security.test.mjs`
- result: **2/2 PASS**

EOE staged-source mutant:
- request id: `3663b133-0be6-47f7-8c11-cf12c77d2de4`
- result: **1 pass / 1 fail**
- killed by: `T19 product invariant: resolveWithinRoot rejects lexical parent traversal`
- observed escape: `../outside.txt` resolved outside the approved root instead of returning `null`

Verdict: **KILLED**.

This TRUST-02 fixture proves the lexical `../` containment invariant only. It does not claim symlink-level containment or an OS sandbox guarantee.

## Catalog state after this slice

- T19 harness mutants: 7
- product-core mutants: 9
- total executable mutation fixtures represented: **16**
- newly added product mutants in this slice: **2**
- negative-vector catalog total: 79

The previous seven product-core mutants were already reported killed on the active T19 line before this slice. The two new mutants above were independently staged and killed against exact product source blobs.

A full nine-mutant `product-mutation-runner.mjs` campaign was **not rerun** in this slice because the current Tailnet sandbox exec policy no longer permits an arbitrary full-repository checkout command. This file therefore does not mislabel the individual staged kills as a new full-campaign run.

## CI limitation

PR #118's ordinary GitHub CI still does not prove the nested T19 suite ran unless T00/T23's central nested-test integration is present for the exact head. Generic CI success alone must not be used as mutation coverage evidence.

