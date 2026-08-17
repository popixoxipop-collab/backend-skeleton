# Enhancement idea catalog (Codex, 2026-08-15)

**Provenance**: produced by a Codex consultation (session `01a005a4-7d8f-7ac2-a4f6-255e967e76c7`,
`codex exec resume`) that read this repo's then-current state and proposed a full catalog of
follow-up work, organized by category with labels `A1-A5` (Architecture), `G1-G4`
(Generalization), `D1-D6` (DevEx), `S1-S6` (Gate/State mechanism), `P1-P4`
(Distribution/Adoption), `O1-O6` (Other).

**Recovery note (2026-08-16)**: this file did not exist until now -- the catalog was originally
only ever delivered as conversational Codex output, never written to a file in this repo. When a
later session tried to resume that same Codex thread (for what became A2's planning), the thread
itself was reported lost (`"No previous Codex task thread was found"`), so A2/A3 were planned from
a **fresh, independent** Codex consultation instead. **That fresh consultation's "A2"/"A3" labels
do NOT correspond to this original catalog's A2/A3** -- see the correspondence table below. The
catalog text itself was never actually gone: it survived in Codex CLI's own on-disk session
transcript (`~/.codex/sessions/2026/08/15/rollout-2026-08-15T22-37-41-01a005a4-....jsonl`),
independent of whether Claude's own thread-resume bookkeeping could reach it. Recovered by reading
that JSONL directly and extracting the `response_item` with `role: "assistant"` containing this
text, 2026-08-16.

**Label correspondence (original catalog vs. what was actually implemented under a same-looking label)**:

| Label (as implemented, this repo's history) | What was actually implemented | Matches this original catalog's same label? |
|---|---|---|
| A1 | OpenAPI operation reconciliation against a real generated document (`27fdc81`) | **Yes** -- matches A1 below almost exactly |
| A2 | Request body JSON Schema projection (`2b5ee8b`) | **No** -- this catalog's A2 is "staged Java analyzer" (regex -> balanced-token -> optional AST), never implemented |
| A3 | Response/error JSON Schema projection (`0205e3f`) | **No** -- this catalog's A3 is "approved patch-strategy generation" for `patchField()`, never implemented |
| A4 | (never implemented) | This catalog's A4 is "read-only database schema plane" -- still open |
| A5 | Contract completeness policy / waiver mechanism (`7513292`) | **Yes** -- matches A5 below closely |
| S1 | Unified gate definitions (`lib/gate-definitions.mjs`, `18d0838`) | **Yes** -- matches S1 below |
| S6 | Verify artifact-check fix (migration.sql disappearance now caught, `18d0838`) | **Yes** -- matches S6 below |

So of this catalog's 29 items (A1-A5, G1-G4, D1-D6, S1-S6, P1-P4, O1-O6), **4 are actually done**
(A1, A5, S1, S6) and **the rest (25 items) are still open**, including the real A2/A3/A4 (distinct
from what this repo's history calls "A2"/"A3"), all of S2-S5, and everything in G/D/P/O.

---

## Top 5 Priorities (Codex's own ranking, verbatim)

1. **Gate Engine v2: declarative dependencies, accurate invalidation, and history**

   Gates are the product's core differentiator, but current recomputers overstate their coverage: `handles` does not hash generated files, `stack` hashes only `.sbf/stack.json`, and `preflight` cannot notice a newly advanced remote tip. Move gate definitions, dependencies, input/output manifests, and verification policy into one registry before adding more phases.

2. **Make OpenAPI the typed contract plane**

   `buildContract()` currently derives only verb, path parameters, and a body-present boolean; this also causes the documented response/error gap and operation-correlation misses. A normalized OpenAPI 3.0/3.1 import and reconciliation layer delivers richer request, response, error, query, security, and cross-framework contracts, so it should precede both DB introspection and a heavier Java parser.

3. **Productionize handles before automating `patchField()`**

   `emitHandles()` unconditionally overwrites shared infrastructure and resolver files, while the generated controller does not enforce registry membership/revocation, field fetch always returns 501, and no code writes registry or snapshot records. First establish artifact ownership, a fail-closed authorization model, mint/register/snapshot lifecycle, and safe field reads; only then add assisted patch generation.

4. **Introduce a capability-based adapter IR and prove it with FastAPI**

   The Java scanner and downstream generators exchange an implicit, Spring-shaped object model, while `generic-grep` returns one `_generic` module with unknown verbs and no usable operation IDs. Define a versioned framework-neutral IR, then build FastAPI as the second first-class adapter because Python AST plus OpenAPI/Pydantic metadata provides a tractable validation of genuine portability.

5. **Turn the CLI into an installable onboarding product**

   The repository has no README, `package.json` is `"private": true`, there is no repo-level `bskel init`, and the hand-written flag parser produces inconsistent human/JSON errors. A packaged CLI with `init`, `status`, `next`, strict argument handling, installation smoke tests, and a minimal getting-started path is the shortest route from a personal skill to repeatable adoption.

**Status note (2026-08-16)**: #2 (OpenAPI typed contract plane) has since been substantially
delivered by A1+A2+A3 as actually implemented (request/response/error schema projection +
reconciliation) -- even though those don't map to this catalog's own A2/A3 labels, they cover the
same underlying gap Codex flagged here. #1 (Gate Engine v2) is partially delivered by S1+S6; S2-S5
(manifest-based partial invalidation, preflight freshness, append-only history, schema validation)
remain open. #3, #4, #5 are entirely open.

## Full Idea Catalog

## Architecture

### A1. OpenAPI import, reconciliation, and drift detection

- **What:** Add `bskel contract import-openapi --file …` and an explicitly opt-in `--url …`, plus `bskel contract diff`.
- **Why:** `contracts/emit.mjs::buildContract()` cannot derive query/header parameters, DTO fields, status codes, media types, security requirements, or response/error shapes. `scanners/index.mjs` also hardcodes `api_surface_source` without checking for a committed specification.
- **Scope/Effort:** **L** — new ingestion plane, normalized IR, diff classifier, and fixtures.
- **Concrete approach:** Normalize OpenAPI 3.0/3.1 operations into the contract IR, resolve internal `$ref`s with cycle protection, preserve source/hash provenance, and classify source-scan versus OpenAPI disagreements as breaking, additive, or metadata-only. Require a disposition for conflicting paths or operation IDs instead of silently choosing one source.
- **[IMPLEMENTED as A1, `27fdc81`]**

### A2. A staged Java analyzer rather than immediately replacing regex with JavaParser

- **What:** Improve the current scanner in two levels: a dependency-free balanced-token analyzer first, then an optional AST enhancer.
- **Why:** `extractController()` and `detectRequestBody()` depend on patterns such as `public\s+\S+`, nearby annotations, and fixed line structure. JavaParser Core would improve syntax handling, but DTO/service linking needs Symbol Solver and a bundled JVM helper, substantially weakening the lightweight Node CLI story.
- **Scope/Effort:** **M** for the balanced analyzer; **L** for an AST/symbol layer.
- **Concrete approach:** First mask strings/comments, balance annotation and method delimiters, record line spans, and add fixtures for generics, multiline annotations, records, package-private methods, and `@RequestMapping(method=…)`. Add an optional `java-spring-ast` capability later, invoked only when installed, for DTO fields, service signatures, validation, and security expressions; keep regex as the fallback.
- **[NOT implemented — do not confuse with this repo's own "A2" (request body schema projection)]**

### A3. Approved patch-strategy generation

- **What:** Generate a machine-readable patch strategy per resource and field instead of either guessing or always stopping at the same stub.
- **Why:** `ResourceResolverStub.java.tmpl` correctly documents three update conventions, but none of that knowledge is represented in the plan or contract. Capturing it explicitly would automate safe cases without erasing the permanent human-review boundary.
- **Scope/Effort:** **L**.
- **Concrete approach:** Analyze the update DTO, Bean Validation annotations, constructors/builders, and service update method; classify each pointer as `patch-wrapper`, `null-means-unchanged`, `fetch-merge-submit`, or `unsupported`. Add `bskel handles patch approve` to record the chosen strategy, generate only high-confidence mappings, and emit unit tests proving that validation and the existing service path are used.
- **[NOT implemented — do not confuse with this repo's own "A3" (response/error schema projection)]**

### A4. Read-only database schema plane

- **What:** Add local-migration and live-PostgreSQL schema adapters.
- **Why:** `runScan({includeDb})` has no actual introspection implementation; setting it directly would merely suppress the "DB not scanned" unknown. Source entities cannot reveal live drift, RLS, triggers, views, functions, or all database constraints.
- **Scope/Effort:** **L**.
- **Concrete approach:** Scan repository migrations first, then offer explicit live introspection through a named environment-variable reference such as `--database-url-env TEST_DATABASE_URL`—never by reading `.env`. Use a read-only transaction over `pg_catalog`/`information_schema`, capture tables, columns, keys, indexes, policies and migration metadata, and gate on a normalized schema hash.
- **[NOT implemented]**

### A5. Contract completeness policy

- **What:** Distinguish "schema emitted" from "contract complete enough to trust."
- **Why:** `cmdContractEmit()` passes the contract gate even when `buildContract()` emits zero operations or warnings for unmatched/duplicate operation IDs. That permits an apparently successful workflow whose usable contract is empty.
- **Scope/Effort:** **M**.
- **Concrete approach:** Give warnings stable IDs and severities, add `complete`, `partial`, and `blocked` contract states, and write explicit waivers to a resolution file. Empty operation sets and skipped endpoints should block by default; low-risk metadata warnings may remain non-blocking.
- **[IMPLEMENTED as A5, `7513292`]**

## Generalization

### G1. Versioned adapter IR and capability negotiation

- **What:** Define a JSON-schema-validated `ProjectProfile` and discovery IR for modules, operations, DTOs, resources, security policies, persistence, and update strategies.
- **Why:** `runScan()` hardcodes two adapters, while contracts and handles rely on undocumented fields such as `controller.file`, `ep.method`, and the `domain/<module>` layout.
- **Scope/Effort:** **M**.
- **Concrete approach:** Give each adapter `detect`, `scan`, `capabilities`, and `diagnostics` methods. Commands should require capabilities such as `api.operations`, `resource.fetch`, or `codegen.handles`, producing an actionable unsupported-capability result rather than failing later on Spring-specific assumptions.
- **[IMPLEMENTED as G1, `ae7b10e` — zero-registration adapter registry (`scanners/registry.mjs`, mirrors `stack/apply.mjs`'s `listCatalogChoices()`/D7): each `scanners/adapters/<id>.mjs` exports an `sbf.adapter/1`-contract `adapter` object (`id` must equal its filename, `specificity` for arbitration, `confidence`, `capabilities`, `detect`/`scan`/`diagnostics`), validated against new `schemas/adapter.schema.json`, discovered by directory scan + dynamic `import()` — adding an adapter touches exactly one file, adding a capability touches zero adapter files (fail-closed: undeclared = false). `scanners/index.mjs`'s hardcoded two-branch dispatch replaced with specificity-based arbitration that throws (naming every candidate) on a genuine tie, mirroring O6's `detectBasePackage()` refusal. Also fixed a real bug found while researching this: `schemas/scan-report.schema.json` was missing the `path_prefix_signals` property under `additionalProperties:false`, so every real scan report ever produced failed its own schema — proof it was never actually validated. New capability-checking layer (`scanners/capabilities.mjs`, `bin/bskel.mjs`'s `requireCapabilitiesOrExit()`) intercepts in `contract emit`/`handles plan`/`handles emit` *before* any Java-specific codegen runs, with a new exit 17 that names the missing capability and the adapter, instead of the previous confusing fall-through to `detectBasePackageOrExit`'s "is this a Spring Boot project?" for a non-Spring repo — a path that had zero test coverage before this. `bskel doctor` now lists every installed adapter's specificity/capabilities and whether it detects the current repo. Explicitly did NOT build G2 (a real FastAPI adapter) or G4 (splitting handle codegen into swappable providers) — `codegen.handles: false` for `generic-grep` is the correct, honest answer, not a limitation to paper over. Verified byte-identical against Team-IZ-Backend (scan/contract/handles output, generated Java files, and exit codes all unchanged pre/post-refactor) and the zero-registration claim demonstrated live (copied a fixture adapter file into `scanners/adapters/`, `bskel doctor` picked it up immediately, deleted it, no other file touched). See D-adapter-registry in DECISIONS.md.]**

### G2. FastAPI as the second first-class adapter

- **What:** Build `python-fastapi`, not a more elaborate generic grep, as the portability proof.
- **Why:** FastAPI exposes routes and Pydantic schemas through OpenAPI and has statically inspectable decorators via Python's standard `ast` module. This gives better coverage per unit of effort than Express router composition.
- **Scope/Effort:** **L**.
- **Concrete approach:** Use OpenAPI for operation/schema truth and Python AST for file/module provenance, dependency declarations, service collisions, and repository patterns. Never import or execute the target application during a source scan; runtime OpenAPI retrieval must be an explicit user action.
- **[IMPLEMENTED as G2 (1st slice), `21bea3c` — new `scanners/adapters/python-fastapi.mjs` (specificity 90, zero-registration), verified against a real cloned FastAPI oracle (`fastapi/full-stack-fastapi-template`, official reference repo). Two findings drove the design, both reproduced by execution: (1) the pre-G2 baseline reported `greenfield` (false negative) for the real oracle — `generic-grep` found all 23 routes but collapsed them into one unscored `_generic` module; (2) `--openapi-file` alone was NOT enough to adopt real operations — `contracts/openapi.mjs`'s prefix inference only builds anchors from endpoints that already have an operationId, which a FastAPI module has zero of, so `--path-prefix` is also required (both verified: 0 adopted without it, all real endpoints adopted with it). Extraction is pure Node regex, NOT Python `ast`/interpreter shell-out — this deliberately overrides this item's own "Python AST module" text, on the same reasoning A2 used to reject a JVM helper for Java (this CLI's only external binary dependency stays `rg`); verified 100% extraction fidelity (5/5 real Items + 10/10 real Users endpoints, correct verb/path/function-name, real entity table/idField cross-checked against the oracle's own Alembic migration) with zero accuracy loss. Capabilities declared honestly: `api.operations`/`api.request-shape` false (FastAPI generates operation ids at runtime; this project's request-body detection is Java-only), `resource.fetch` true (table/idField genuinely extracted), `codegen.handles` false (no Python provider — G4's job, `handles/*.mjs` completely untouched). New `CAPABILITY_SATISFIERS` in `scanners/capabilities.mjs` (data keyed by capability, not by adapter) lets `--openapi-file` bypass the `api.operations` gate at `contract emit` for ANY adapter with this honest weakness — including `generic-grep`, accepted rather than special-cased, tested to still end honestly `blocked`. `handles plan`/`emit` against a FastAPI-scanned feature still correctly exit 17 on `codegen.handles`, never attempting Java codegen. Tests 345 → 356. See D-fastapi-adapter in DECISIONS.md. G4 (Python codegen provider) explicitly NOT built.]**

### G3. Keep `generic-grep` as reconnaissance only

- **What:** Improve its evidence, but stop treating it as contract-grade.
- **Why:** `generic-grep.mjs` collapses every route into `_generic`, uses `verb: "?"` for some frameworks, omits method names, and provides no operation IDs. The current workflow can nevertheless resolve the scan and pass an empty contract.
- **Scope/Effort:** **S–M**.
- **Concrete approach:** Add repo-relative file/line evidence, framework confidence, route prefixes, and verb extraction where cheap. Require `--accept-low-confidence` or a forced gate before using it downstream; otherwise its role is to answer "something related exists."

### G4. Framework-specific codegen providers

- **What:** Separate handle semantics from Spring code generation.
- **Why:** `cmdHandlesPlan()` and `cmdHandlesEmit()` always detect a Java base package and write Java/Spring templates, even if a different scanner produced the contract.
- **Scope/Effort:** **L**.
- **Concrete approach:** Produce a framework-neutral handle manifest first, then dispatch to `providers/java-spring`, `providers/python-fastapi`, or `providers/typescript-express`. Each provider declares required capabilities and output ownership rules.
- **[IMPLEMENTED (1st slice), `627c214` — `handles/registry.mjs` (zero-registration provider dispatch, mirrors G1's `scanners/registry.mjs` exactly, `sbf.handles-provider/1` contract + `schemas/handles-provider.schema.json`), java-spring extracted behind that same interface into `handles/providers/java-spring/` with its safety-critical write/conflict/manifest/orphan logic pulled into a shared `handles/_engine.mjs` (27 pre-existing handles tests pass with exactly ONE line changed — an import path, nothing else, confirming the extraction preserved behavior rather than coincidentally passing), and a REAL second provider: `handles/providers/python-fastapi/` (codec ported from `handles/codec.mjs` and EXECUTED round-trip-verified against it, both directions, positive and negative parity — the first time this repo's "byte-identical" codec claim has ever been verified by running code rather than asserted in a comment; in-process registry, `fetch`/`to_public` really wired to `session.get(...)`/`<Entity>Public.model_validate(...)`, `check_access`/`patch_field` always fail-closed stubs, GET+PATCH router, deliberately no migration/`recover()`). `COMMAND_CAPABILITIES` narrowed to dispatch-only (`codegen.handles`); each provider now declares its own `requiresCapabilities`, producing an unfakeable biconditional (`codegen.handles === true` ⟺ a provider is loaded for that adapter id) pinned as a dedicated regression against every real shipped adapter. `python-fastapi`'s own `codegen.handles` flips to `true` — G2's "no Python provider exists" caveat is now false. Real-oracle verified (`fastapi/full-stack-fastapi-template`, throwaway branch): BOTH `items` and `users` modules generate a resolver, and BOTH correctly fail closed on `check_access()` — the oracle's real authorization logic lives inside route bodies, not decorators, which static scanning genuinely cannot see; the `User` resolver projects through `UserPublic` and never references the table's own `hashed_password` column (confirmed by grep across every generated file). Every generated file syntax-validated via `python3 -c "ast.parse(...)"`; re-emit is idempotent; a hand-edited resolver blocks re-emit at exit 15, byte-for-byte untouched. Tests 356 → 386. Explicitly NOT built: `recover()`/its tables for Python (dead code even on the Java side — O4 still unimplemented), field/object-level handle fetch (`kind=f`/`o`, matching Java's own current limit), a `--provider` override flag (no real N:1 case observed), `src/`-layout support, automatic router wiring into the app (two lines a human adds by hand). The matching JS↔Java codec "byte-identical" claim remains genuinely unverified by execution — left open, honestly, as a named EXIT, not silently claimed closed by association. See D-handles-providers in DECISIONS.md.]**

## DevEx

### D1. `status`, `next`, and guided workflow commands

- **What:** Add `bskel status --feature`, `bskel next`, and optionally `bskel next --execute`.
- **Why:** `gate show` exposes raw state and `verify` is primarily an end-of-flow aggregate; neither explains the next blocking action across repo- and feature-scoped gates.
- **Scope/Effort:** **M**.
- **Concrete approach:** Evaluate the dependency graph, show stale reasons and missing artifacts, then print one copy-pasteable next command. JSON output should include `blocked_by`, `next_actions`, and whether each action is read-only or mutating.
- **[IMPLEMENTED as D1, `b96cc56` — `bskel status`/`bskel next` built entirely on `collectGateStatuses()`/`checkArtifacts()` (the same primitives `verify` calls) plus S1's `GATE_NAMES` order and S2's `changed_inputs`/`stale_reason`, exactly the "unusually economical" case Codex's own P&L pass predicted. `blocked_by`/`next_actions`/per-action `mutating` all present in JSON; each gate's remediation matches its actual status (not_run/awaiting_disposition/stale get genuinely different commands, not a generic re-run). No dependency graph was built — `GATE_NAMES`'s documented order was sufficient, same reasoning S2 used to defer one. `--execute` deliberately not built (auto-running a mutating recommended command conflicts with this project's confirm-before-destructive-action default); spec-kit phases (4/6/9, no gate) are not tracked. See D-status-next in DECISIONS.md, including a real dead-code bug (a per-gate-loop special case that could never be reached given how the surrounding data flow actually works) caught by manually walking the CLI end to end, not by the test suite.]**

### D2. Stable CLI and diagnostic contract

- **What:** Replace `parseFlags()` and deep `process.exit()` calls with strict parsing and returned command results.
- **Why:** Unknown flags currently become positional arguments, missing values become `undefined`, and numeric values such as `--port`/`--max-behind` are not validated consistently. Errors are not reliably JSON even when `--json` is requested.
- **Scope/Effort:** **M**.
- **Concrete approach:** Use `node:util.parseArgs`, centralize exit-code definitions, and return `{ok, code, command, diagnostics, next_actions}` from handlers. Add global `--help`, `--version`, `--json`, and `--quiet`.
- **[IMPLEMENTED, `<pending-sha>` — `node:util.parseArgs`-based strict parsing (`lib/cli.mjs`, one `COMMANDS` table mechanically transcribed from the 18 old `parseFlags()` call sites, proven lossless by a default-value snapshot test), a single exit-code table (`lib/exit-codes.mjs`; `lib/gates.mjs`'s `EXIT` now assembles from it and re-exports unchanged, no renumbering), global `--help`/`--version`/`--json`/`--quiet`, and an additive `sbf.cli-diagnostic/1` JSON envelope on `--json` for payload-less early-exit failures. Three real bugs found and fixed, all reproduced live: (1) `bskel verify --feature --json` silently swallowed `--json` as `--feature`'s value and crashed with an **uncaught Node stack trace**; (2) `bskel preflight --max-behind abc` made the underlying bash comparison fail silently (`set -euo pipefail` doesn't catch an error inside `[ ]`), **disabling the stale-base check this whole tool exists for** — demonstrated live by running the actual pre-fix script against a genuinely-stale worktree (reported `PASS` at exit 0; the fixed script rejects it at exit 14, closing the exact bypass this project's own founding bug (a 658-commit-stale worktree) belongs to); (3) `bskel status 001-widget` silently ignored a stray positional (a common `--feature`-typo shape) and reported success. The catalog's own "every handler returns a uniform envelope" prescription was rejected with direct evidence: `scan`/`contract emit`/`handles plan --json` each print a schema-validated artifact document (two `additionalProperties:false`) that `cmdScan` also writes byte-identical to disk — wrapping it would break `bskel scan --json > brownfield-scan.json`'s own schema validation — and 12+ existing tests already depend on non-zero exits carrying real payloads (verify exit 1, scan exit 16/3, handles emit exit 15, contract validate exit 1). The approved design adds the diagnostic envelope only to previously-empty-stdout failure paths, touching zero payload-bearing outputs. Exit-code renumbering was also rejected (the numbers are an existing public contract — SKILL.md + 11 tests assert them); exit 2's long-standing double meaning is disambiguated by a new `reason` string in the envelope instead. Two side fixes found during the audit: a numeric guard added directly to `scripts/preflight-base-ref.sh` itself, and a `{{PORT}}` substitution site materialized in `stack/bootstrap/ngrok.sh` (`--port` had **zero effect** previously — `stack/apply.mjs` already computed and passed the template variable, but the template never referenced it). Tests 386 → 444, all 386 pre-existing tests pass completely unmodified. See D-cli-contract in DECISIONS.md.]**
- **Status note (2026-08-16):** the process.exit() pipe-truncation audit (`3b5106a`) fixed the specific truncation bug in some exit paths but did not touch the broader "unknown flags silently become positional args" / "errors not reliably JSON" issues this item is actually about — resolved above.

### D3. Explainable scanner evidence

- **What:** Make every relevance point traceable.
- **Why:** `scoreModule()` returns only a scalar, uses symmetric substring matching, and allows repeated endpoint matches to inflate a module score. Reports contain file paths but no source spans or score breakdown.
- **Scope/Effort:** **M**.
- **Concrete approach:** Emit evidence records such as `{signal, term, value, weight, file, line}` and add `bskel scan explain <module>`. Tokenize identifiers and paths, cap repeated-signal contribution, and use deterministic tie-breaking.

### D4. Uniform plan/check/diff before writes

- **What:** Extend stack's dry-run ergonomics to every generator.
- **Why:** `handles plan` reports resources but not exact file actions or diffs, while `handles emit` writes immediately.
- **Scope/Effort:** **M**.
- **Concrete approach:** Standardize `--plan`, `--check`, `--diff`, and `--apply`; report `create`, `unchanged`, `update-generated`, and `conflict-user-edited`. `--check` should be CI-friendly and never write.

### D5. Capability-aware doctor

- **What:** Make `doctor` workflow-specific.
- **Why:** `cmdDoctor()` always checks only `git`, `gh`, and `rg`; it misses Node compatibility, dependencies, Bash/curl/ngrok, Java/JDK, build wrappers, and adapter readiness.
- **Scope/Effort:** **S**.
- **Concrete approach:** Add `doctor --workflow scan|handles|stack --json`, distinguish required from optional checks, and include exact remediation.
- **[IMPLEMENTED as D5, `70c7721` — `bskel doctor [--workflow scan|handles|stack] [--json]`, new `lib/doctor.mjs::computeDoctorChecks()` (mirrors D1's `lib/workflow.mjs` split). Only `git`/a compatible Node runtime (checked against the real >=20.11.0 requirement `import.meta.dirname` needs, not package.json's inaccurate declared `>=18` -- see P1)/`rg` are `required`; `gh` (preflight's already-soft-guarded cross-check), build-wrapper presence (handles, reuses `lib/verify.mjs`'s newly-exported `detectBuildCommand()` — the exact function `verify --build` itself uses), and stack tooling are all optional with a remediation string. Stack tooling is sourced from a new optional `runtime.requires: string[]` field on `schemas/stack-choice.schema.json` (populated for `stack/catalog/ngrok.yml`: `[ngrok, curl]`) rather than hardcoded — a future catalog entry declares its own required binaries and doctor picks them up with zero code changes, the same declarative pattern D7/G1 established. Fixes a real over-strict bug: `gh` missing used to fail `bskel doctor`'s overall exit code even though nothing downstream actually breaks without it — now verified directly via a restricted-PATH test proving overall `ok` stays true. G1's adapter-readiness block is unchanged, just gated by workflow (shown for scan/handles/unscoped, not stack). Caught and fixed a real bug during implementation (not by the test suite): an early draft's `root ? a.detect(root) : null` collided with `detect()` itself legitimately returning `null` on a non-match, silently dropping java-spring's "-- does not detect this repo" line — fixed by coercing to `Boolean(...)`. Verified against Team-IZ-Backend: `--workflow handles` correctly detects the real `./gradlew`. Tests 337 → 345. See D-doctor-workflow in DECISIONS.md.]**

### D6. Feature lifecycle commands

- **What:** Add `feature list`, `show`, `rename`, `link`, and `archive`.
- **Why:** `feature init` is the only supported operation over `.sbf/feature-index.json`; manual editing is currently the documented recovery path for merges or re-keying. Auto-numbering also has a race between reading `specs/` and writing the new feature.
- **Scope/Effort:** **M**.
- **Concrete approach:** Treat the UID as primary, update index and feature paths transactionally, validate collisions, and preserve rename/link events in history.

## Gate/State mechanism

### S1. Declarative gate dependency graph

- **What:** Replace scattered recomputers and verifier lists with a single gate registry.
- **Why:** `GATE_RECOMPUTERS` and `GATE_SPECS` already disagree: `stack` is emitted and documented as optional verification state, but is absent from `verify`.
- **Scope/Effort:** **L**.
- **Concrete approach:** Define each gate's scope, upstream gates, required/optional policy, input resolver, declared outputs, freshness policy, and remediation in one module. Command execution, `require`, `verify`, `status`, and visualization should all consume that registry.
- **[IMPLEMENTED as S1, `18d0838`]**

### S2. Precise content manifests and partial invalidation

- **What:** Hash relevant inputs and outputs, not merely `HEAD`.
- **Why:** Uncommitted Java changes do not stale `scan`; unrelated commits stale every feature. `handles` hashes only the contract, and `stack` hashes only its record despite comments claiming applied-file drift is covered.
- **Scope/Effort:** **M–L**.
- **Concrete approach:** Store sorted manifests of repo-relative paths and hashes, adapter/template/tool versions, command options, and upstream gate tokens. Recompute only those files, report exactly which input changed, and invalidate downstream nodes transitively.
- **[PARTIALLY IMPLEMENTED as S2, `374ec92` — a stale gate now reports exactly which input changed (`changed_inputs`/`stale_reason`) for all five gates, `stack`'s token was upgraded to hash every applied file (dropping `head_sha`, since its input set is fully enumerable — this closes "unrelated commits stale every feature" completely for `stack`), and generated-handle-file existence is now verified (`checkArtifacts()`, matching S6's `migration.sql` precedent) without hashing generated content into the gate token (deliberately, to keep hand-edited `patchField()` from ever being reported stale). Still open: `scan`/`contract`/`handles` remain on repo-wide `head_sha` (uncommitted Java edits still don't stale `scan`; unrelated commits still stale every feature's `scan`/`contract`/`handles`) — three cheap alternatives were evaluated and rejected on the record; the real fix needs the scanners themselves to report their read-set. Transitive `upstream_token` invalidation is also still open, deferred to the same future slice that removes `head_sha` elsewhere. See D-gate-precision in DECISIONS.md.]**
- **[NOT implemented]**

### S3. Preflight freshness and failure semantics

- **What:** Make network freshness explicit and enforceable.
- **Why:** `preflight-base-ref.sh` ignores `git fetch` failure, while the stored token contains only HEAD and the local default-branch name. A preflight can therefore remain passed after the remote advances or after an unsuccessful refresh.
- **Scope/Effort:** **M**.
- **Concrete approach:** Record `origin_tip_sha`, fetch outcome, `checked_at`, dirty policy, and `max_behind`; fail closed on refresh failure unless `--offline` is explicit. Give online checks a TTL and let `require` detect movement of the local remote-tracking ref.
- **[NOT implemented]**

### S4. Append-only history and bounded overrides

- **What:** Keep gate events rather than only the latest record.
- **Why:** `setGate()` overwrites prior state, and a forced gate passes forever regardless of changed inputs.
- **Scope/Effort:** **M**.
- **Concrete approach:** Append pass, stale, disposition, force, and revoke events to per-feature JSONL; keep current state as a derived cache. Bind a force to the current input token and support expiry by time, commit, or next input change.
- **[NOT implemented]**

### S5. Schema validation, migration, and concurrency

- **What:** Enforce the existing schemas at every persistence boundary.
- **Why:** `state.schema.json`, `scan-report.schema.json`, `feature-contract.schema.json`, and `stack-choice.schema.json` are never loaded. The current repo-scoped `_repo` state would itself violate `state.schema.json`'s feature-ID pattern.
- **Scope/Effort:** **M**.
- **Concrete approach:** Validate reads and writes, create a separate repo-state schema, add version migrations, and use lock files or compare-and-swap around load/modify/save so concurrent commands cannot lose updates.
- **[NOT implemented — S1's work fixed the feature-ID pattern bug this item also mentions, but schema validation itself is still never wired in]**

### S6. Verification that cannot silently skip requested assurance

- **What:** Tighten artifacts and build verification.
- **Why:** `checkArtifacts()` checks little beyond the contract; generated handle outputs are not verified. `--build` still permits overall PASS when no build command is recognized, and the test named "reports a real build failure" actually exercises only the skipped-build branch.
- **Scope/Effort:** **S–M**.
- **Concrete approach:** Verify every gate's declared outputs and hashes, executable modes, resolver conflict state, and catalog artifacts. If the user explicitly asks for `--build`, unavailable build support should fail or require `--allow-skip-build`; capture both stdout and stderr.
- **[PARTIALLY IMPLEMENTED as S6, `18d0838` — the migration.sql disappearance case specifically was fixed; the broader "verify every gate's declared outputs", `--allow-skip-build`, and stderr capture are still open]**

## Distribution/Adoption

### P1. Publishable npm package and real README

- **What:** Package the CLI for reproducible installation.
- **Why:** `package.json` is private and the tracked repository has no README. It also claims Node `>=18`, while `contracts/validate.mjs` uses `import.meta.dirname`, which is not available across the declared Node 18 range.
- **Scope/Effort:** **M**.
- **Concrete approach:** Either replace `import.meta.dirname` with `fileURLToPath` or raise the engine floor; remove `private`, add a `files` allowlist covering templates/schemas/scripts, and test `npm pack` plus installation from the tarball. Add README quickstart, compatibility table, generated-file policy, security model, and troubleshooting.

### P2. Repo-level `bskel init` and greenfield bootstrap

- **What:** Separate adopting bskel from creating a feature.
- **Why:** `feature init` assumes a prepared Git repo and later commands infer Spring conventions; there is no persistent project configuration or new-project path.
- **Scope/Effort:** **L**.
- **Concrete approach:** `bskel init` should detect/select adapters, write `.bskel/config.yml`, establish state/spec directories and ignore policy, and validate the default branch. A separate `bskel new --stack spring|fastapi` can create a minimal supported starter—preferably through pinned official generators—then run `init`, rather than turning every command into implicit framework scaffolding.

### P3. Portable fixture corpus and CI/release pipeline

- **What:** Move real-world coverage into committed, anonymized fixtures.
- **Why:** The strongest Java scanner tests skip when `~/Desktop/Team-IZ-Backend` is unavailable, so CI would lose the main oracle. There is no tracked CI configuration.
- **Scope/Effort:** **M**.
- **Concrete approach:** Commit fixtures for the known Organization/Curriculum patterns, multiline annotations, security variants, multi-controller modules, malformed catalogs, gate invalidation, and codegen conflicts. Run Linux/macOS and supported Node versions, plus package-install and generated-Java compilation tests.

### P4. Extension conformance kit

- **What:** Provide supported interfaces for third-party scanners, code generators, and stack catalogs.
- **Why:** The catalog is described as generic, but entries are not schema-validated and templates can currently name unchecked relative paths.
- **Scope/Effort:** **M**.
- **Concrete approach:** Add `bskel catalog lint`, path-containment checks, declared variables, compatibility/version fields, fixture-based idempotence tests, and an adapter test harness. Keep extensions local/configured initially before designing a remote registry.

## Other

### O1. Enforce the secret-file boundary

- **What:** Remove `.env` reads from code-generation commands.
- **Why:** `planApply()` reads the entire target `.env` to detect keys, contradicting both the target-repo instruction and the generated script's claim that only the human-invoked runtime step touches `.env`.
- **Scope/Effort:** **S**.
- **Concrete approach:** Detect static application from generated files and `.env.example`; report runtime secret configuration as `unknown`. If runtime checking is needed, put it in the human-run bootstrap script and output presence-only status.
- **[ALREADY IMPLEMENTED, independently of this catalog — DECISIONS.md's security hardening pass item #6, `839259c`/`bcdc427`. `planApply()`'s `alreadyDetected` is now decided from `detect.files` alone, never reads `.env`; `test/stack-cli.test.mjs`'s "stack apply dry-run does not read .env" regression test covers exactly this. Flagged by Codex during the 2026-08-16 P&L pass, confirmed by grep against both files.]**

### O2. Conflict-safe generated-file ownership

- **What:** Prevent regeneration from overwriting human work or another feature's shared artifacts.
- **Why:** `emitHandles()` writes global infrastructure and resolver stubs unconditionally. A second feature can overwrite shared files, and rerunning the first can erase a completed `patchField()`.
- **Scope/Effort:** **M**.
- **Concrete approach:** Maintain an artifact manifest with owner, template version, generated hash, and last-seen hash. Treat global infrastructure as repo-owned, resolvers as resource-owned, create resolver stubs once, and refuse to overwrite diverged files unless a three-way merge or explicit approval succeeds.

### O3. Define and enforce the handle trust model

- **What:** Decide whether handles are registered identifiers or freely forgeable self-describing IDs, then make the code consistent.
- **Why:** The generated `fetch()` and `patch()` paths decode type/UUID/pointer but never query `HandleRegistry`, so nonexistent or revoked handles still operate. Resource `handle_uid` also equals the resource UUID regardless of type, permitting cross-type registry collisions for identical UUID values.
- **Scope/Effort:** **L**, potentially breaking.
- **Concrete approach:** Prefer registry enforcement because registry/revocation already exist: fetch the derived UID, require a non-revoked row, and compare every decoded component. For a versioned `sbf2` format, derive all UIDs from `kind:type:uuid:pointer` so type participates in identity; provide migration/dual-read support.
- **Status note**: this repo's history already tracked a conditional version of this exact warning ("O3: reverses to top priority if handles are ever deployed to production") and confirmed via `git grep`/GitHub code search across all branches that handles have never been deployed to Team-IZ-Backend -- still deferred on that basis, unchanged by this recovery.

### O4. Complete the handle read and snapshot lifecycle

- **What:** Add field reads, mint/register operations, snapshot recording, and real current-contract drift checks.
- **Why:** `HandleController.java.tmpl` always returns 501 for field fetches. No code calls `HandleRegistry.create()` or `HandleSnapshot.create()`, and `HandleSnapshot.java.tmpl` references a nonexistent `HandleAspect`.
- **Scope/Effort:** **L**.
- **Concrete approach:** Add an explicit handle service for mint/register/revoke, resolve approved JSON Pointers through Jackson `JsonNode`, and record snapshots through an opt-in interceptor with redaction and retention rules. Query the latest eligible snapshot directly in the repository and compare its hash with a real current-contract hash provider—not an unsynchronized registry string.

### O5. Replace role-string inference with authorization contracts

- **What:** Make resolver authorization action- and resource-aware.
- **Why:** `findRequiredAuthority()` recognizes only an exact class-level `hasRole('…')` expression and otherwise emits `"TODO_ROLE"`. It cannot preserve method-level checks, `hasAuthority`, multiple roles, ownership, organization membership, or service-layer policy.
- **Scope/Effort:** **L**.
- **Concrete approach:** Replace `requiredAuthority()` with a fail-closed `authorize(authentication, action, resourceUid, pointer)` contract. Generate only policies that an adapter can prove equivalent; otherwise require an explicit policy implementation before the controller bean is enabled. Test anonymous authentication, tenant isolation, revoked handles, and arbitrary-pointer attempts.
- **Status note**: same deferred-with-O3 status as above (this repo's history calls this pairing "O3/O5 보류").

### O6. Deterministic artifacts and documentation integrity

- **What:** Remove avoidable output churn and automatically detect stale documentation references.
- **Why:** Contracts contain `generated_at`, discovery order is not consistently sorted, and `detectBasePackage()` chooses the first discovered application class. Documentation/code also reference missing `D-db`, `D8`, and `HandleAspect`.
- **Scope/Effort:** **S–M**.
- **Concrete approach:** Keep timestamps in gate history rather than semantic artifacts, sort all discoveries, fail on ambiguous application roots, and add a test that validates decision anchors, documented commands/gates, generated-template references, and CLI help against implementation.
- **[IMPLEMENTED as O6, `7d31345` — `generated_at` removed from `contract emit`/OpenAPI-snapshot output (and the now-stricter feature-contract schema); every `rg --files` call site sorted (`scanners/adapters/java-spring.mjs`, `scanners/adapters/generic-grep.mjs`, `handles/emit.mjs`), plus a `.localeCompare()` tie-breaker for `scanners/index.mjs`'s score sort; `detectBasePackage()` now throws a named-candidates error on a genuinely ambiguous multi-application repo instead of silently picking `files[0]` (same-package multi-file repos, a real multi-module shape, still resolve quietly), with both `bin/bskel.mjs` call sites routed through a shared `detectBasePackageOrExit()`. All three dead documentation references this item names resolved to real anchors. New `test/doc-integrity.test.mjs` makes that class of drift a test failure going forward, including a self-verification subtest proving the checker can actually fail, and specifically models the `D-security-N` numbered-list convention that would otherwise produce ~10 false positives. Verified against Team-IZ-Backend in an isolated worktree: `scan`/`contract emit` produce byte-identical output (including the on-disk contract file) across two consecutive runs, and the emitted contract file no longer contains `generated_at`. No override flag for the ambiguous-base-package case was added speculatively — no real multi-application repo has been observed in this project's testing. See D-artifact-determinism in DECISIONS.md.]**

## Notes on DECISIONS.md gaps (Codex's own free-form notes, verbatim)

**OpenAPI bridge / drift detection.** Close this with a normalized operation IR shared by source scanners and OpenAPI, not a one-off spec diff. Support committed files and explicitly requested live URLs, retain both provenances, and require disposition only for semantic conflicts; this simultaneously closes endpoint-correlation, typed request, response/error, and cross-framework gaps.

**DB-schema scan plane.** Start with migration files, then add an explicitly credentialed, read-only PostgreSQL adapter that receives the name of an environment variable rather than opening `.env`. Diff declared migrations, scanned entities, and live catalog state as three separate sources so "code differs from DB" does not get collapsed into one ambiguous warning.

**Comment-preserving config patching.** Replace catalog regex notes with typed patch recipes: target file, semantic YAML path, expected old-state predicate, desired value, and postcondition. Use `yaml`'s Document API only when the predicate matches exactly, show a diff first, and refuse aliases, multi-document YAML, duplicate keys, or ambiguous paths until separately supported.

**Live DB-backed handle round trip.** The first closing step need not touch Supabase: run the emitted migration and generated repository/controller behavior against disposable Testcontainers PostgreSQL. Keep a separate opt-in Supabase compatibility test for RLS/extensions; this provides repeatable mint→fetch→patch→recover coverage without shared credentials or infrastructure mutation.

**`patchField()` generation.** Use an approved `PatchStrategy` manifest rather than direct inference-to-code. The analyzer can propose one of the three observed conventions per pointer, show the DTO/service evidence, and generate only after approval plus a compilation/unit-test check; ambiguous fields remain explicit stubs.

**Additional stack entries.** Build a catalog conformance suite before adding Supabase or Railway: validate schemas, path containment, idempotence, required tools, secrets handling, readiness probes, cleanup, and rollback behavior. Then add one database-oriented entry to pressure-test whether the current static/runtime split is expressive enough before introducing a `custom` escape hatch.

**Response/error envelopes.** Seed response schemas primarily from OpenAPI, then enrich errors from Spring `@ControllerAdvice`/`@ExceptionHandler` mappings and representative golden payloads. Validate status code plus media type plus payload schema, while allowing an explicit `unknown-response` waiver when no trustworthy shape exists.

**Status note (2026-08-16)**: this note has since been substantially addressed by A2+A3 as actually implemented (response schemas seeded from OpenAPI, `anyOf` unions, fail-closed on unresolved schemas) -- though not the `@ControllerAdvice` error-enrichment half, which remains open.
