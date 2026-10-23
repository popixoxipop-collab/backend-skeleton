# T04 JavaScript/TypeScript source analysis — internal interface RFC

Status: **source-evidence-locked T04-internal v0 behavior**, not an SBF stable contract, runtime support declaration, production registration, parser certification, or T01 `contracts/next` freeze. This document describes existing executable boundaries only. Its Git-revision/hash receipt is `next/t04/INTERFACE_RFC_EVIDENCE.json`; it may be absent before the first clean source commit.

## 1. Purpose and ownership

The T04 lexical layer extracts bounded source facts without evaluating project code. Four existing modules are authoritative: `source-facts.mjs`, `module-resolver.mjs`, `snapshot-graph.mjs`, `backend-comparison.mjs`. Their public values remain provisional T04-internal contracts with suffix `/0`. They do not supply stable cross-tool SBF identities or a typechecker.

T04 may modify `scanners/language/js-ts`, `test/language-js-ts`, and its evidence workspace `next/t04`. T01 owns stable `contracts/next` and `schemas/next`; T02/T11/T17 and framework adapters own interpretation of JS/TS facts; T20/T23 must approve any future parser dependency or trust-boundary change. T04 does not edit `package.json`, `package-lock.json`, CI workflows, or upstream modules. The original `scanners/language/js-ts/BASELINE.json` is T04-01 historical evidence and must not be rewritten.

## 2. Inputs, outputs, and exact meaning

| API | Input | Return or refusal |
| --- | --- | --- |
| `analyzeJsTsSource(source, options)` | JavaScript/TypeScript/JSX/TSX source string, `filePath`, `language`, `maxBytes`, `maxTokens` | `bskel.internal.js-ts-source-facts/0`: `contract`, `filePath`, `language`, `complete`, `syntaxValidated`, `inputBytes`, `moduleEdges`, `diagnostics`; non-string input or invalid mode/limit throws TypeError |
| `resolveJsTsModuleEdge(edge, options)` | A literal specifier plus repository-relative `filePath`, explicit iterable `knownFiles`, optional extensions | Status `resolved`, `missing`, `ambiguous`, `bare`, `unsupported`, or `blocked`; validation errors throw TypeError |
| `resolveJsTsModuleEdges(sourceFacts, options)` | Source-facts contract plus inventory | `bskel.internal.js-ts-resolution/0`: `contract`, `sourceFactsContract`, `filePath`, `complete`, `allResolved`, `sourceSyntaxValidated`, `resolutions`, `diagnostics` |
| `analyzeJsTsSnapshot(entries, options)` | In-memory path/source entries, optional explicit language and size/file limits | `bskel.internal.js-ts-snapshot/0`: `contract`, `complete`, `allResolved`, `syntaxValidated`, `files`, `moduleGraph`, `diagnostics`; `totalBytes` on complete output |
| `lexicalJsTsBackend()` and `validateJsTsBackend(backend)` | Trusted first-party backend with `contract`, `id`, boolean `syntaxValidated`, `analyze` function | `bskel.internal.js-ts-backend/0` descriptor; invalid descriptors throw TypeError |
| `analyzeWithJsTsBackend(backend, source, options)` and `compareJsTsBackends(backends, corpus, limits)` | Bounded string inputs, flat common options, explicit ordered corpus and trusted backend functions | Validation of result shape, deterministic normalized `cases`, `outcomes` and `comparisons`; comparison reports differences but does not select a winner |

An emitted module edge has `kind`, literal `specifier`, `bindings`, `typeOnly`, `basis: lexical-literal`, `resolution: unresolved`, and source `byteStart`, `byteEnd`, `line`. Byte offsets are UTF-8 offsets **into the supplied source string**. They are not automatically host-file coordinates for Svelte/HTML fragments. Comments, string literals, regex text, imported aliases and template expressions are not promoted to executable authority.

## 3. Identity, resolution, and partial/unknown behavior

The source-facts `filePath` labels the caller-supplied input. The resolver and snapshot normalize inventory paths to repository-relative POSIX paths; they never derive runtime module identity, package exports, tsconfig aliases or symlink identity. A relative specifier becomes `resolved` only with a single matching candidate. Multiple candidates produce `ambiguous`, not a guessed priority. Bare package/alias specifiers produce `bare`; root escapes produce `blocked`. Explicitly unsupported or missing forms remain visible as such.

`complete: true` means the bounded lexical/resolution/snapshot pass finished, **not** that JS/TS syntax is valid, types are checked, every import resolved or runtime code is safe. The current bounded lexical backend always reports `syntaxValidated: false`. A completed resolver may have `allResolved: false`; a snapshot may have `complete: true` and `allResolved: true` while still reporting `syntaxValidated: false`. Empty graphs and empty imports do not provide type or syntax certification.

Unknown conditions are visible through diagnostics and resolution statuses, **not** an exhaustive proof that all source semantics were classified. Nonliteral dynamic imports, escaped module strings and unsupported lexical constructs do not create verified module edges. `maxBytes` defaults to 4 MiB and `maxTokens` to 250,000 for the lexical pass; a limit violation returns `complete: false`, no partial module edges and diagnostics. Snapshot defaults: `maxFiles` 20,000, `maxTotalBytes` 32 MiB; oversize/unsupported extension returns `complete: false` with **empty** `files` and `moduleGraph`, plus diagnostics. Malformed paths and duplicate normalized file paths throw. No truncated partial graph is certified.

The comparator defaults to `maxCases` 1,000 and `maxCorpusBytes` 32 MiB, rejecting over-limit corpora before executing any backend. Individual backend errors are recorded as `status: error`, not promoted to success. A backend marked `syntaxValidated: false` cannot return a result claiming true. **The comparator invokes supplied backend code in-process**: it is *not* a sandbox or permission boundary for untrusted parser plugins. No dependency, runtime parser or arbitrary third-party backend is approved.

## 4. Observed test and negative cases

The source-backed interface tests exercise a normal literal ESM import, a nonliteral dynamic import, Unicode UTF-8 source spans, resolved and bare or ambiguous imports, false syntax-validation claims, file and byte limits, an in-memory deterministic graph, a deliberately invalid backend result, and source text that attempts target-code side effects. They check that no source or runtime support declaration is fabricated.

A source-bound receipt records the **exact Git source revision**, SHA-256 for the RFC, README, T04 analyzer implementation, existing historical baseline, test suite and verifier, the executable Node TAP command, its actual exit code, and pass/fail/skipped counts. `node test/language-js-ts/interface-rfc-evidence.mjs --check` reruns the command and checks the original Git commit blobs against both working source bytes and recorded digests. A forged source commit, incomplete pin list, changed implementation, inaccurate command result or false MET/release/signed-attestation assertion must fail closed.

## 5. Promotion gates and exclusions

The RFC is an **internal, evidence-pinned snapshot**, not an SBF v1 promotion. The following remain OPEN: a T01-owned stable shared contract; independently reviewed parser dependencies; syntactic/type-semantic validation; package/alias resolution; source-container provenance; trusted runtime execution evidence; framework capabilities and registration; signed independent attestation; and global T00 release approval. The internal source/test evidence does not close any of these gates.

Only an independently verified PR, required CI, normal protected merge, exact merged-source replay and an explicitly authorized single-task T00 CAS can change the official verdict of T04-02. The evidence recorder itself states `official_MET_delta: 0` and `release_activation: false`; it never edits the T00 official ledger, T01 contracts, production or release state.
