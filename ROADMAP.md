# Roadmap: what has to be true to call `backend-skeleton` production-grade

This document is scoped deliberately. It is **not** a roadmap for the gate/scan/contract layer,
which is already the strongest part of this project: 1338/1338 tests pass locally (`npm test`,
re-run for this document, exit 0, `duration_ms 230829`), CI run
[`33598880914`](https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/33598880914)
(2026-09-02, `3c491d7`) is green on every job, the `java-spring` adapter carries
`verificationBasis: 'production-repo'` (`scanners/adapters/java-spring.mjs:366`), and `1.0.0`'s
CLI-surface stability promise (`D-stable-api-contract`) is a real, enforceable commitment. W7
(CI/billing) is closed and is not re-litigated here.

It is a roadmap for the two places where "functionally complete and well-tested" is still
measurably not the same as "production-grade":

1. **The `handles` codegen subsystem.** `README.md`'s own `## Status: 1.0.0` section says it
   plainly: handles "is functionally complete and tested the same way, but **has never been
   deployed to a real production repo**." Every gap below is downstream of that one fact.
2. **Verification-corpus diversity, and the single-oracle overfitting risk (W2/W6/W9).** Every
   quantitative constant in `contracts/openapi.mjs` and `contracts/export.mjs` — including two
   *permanently-unbuilt* design decisions justified by "0 real occurrences measured" — is measured
   against exactly one private repo (`Team-IZ-Backend`, reachable only as
   `${process.env.HOME}/Desktop/Team-IZ-Backend`, `test/contract.test.mjs:25`, `test/scan.test.mjs:17`,
   all ten of whose tests carry `skip: !repoPresent`).

"Production-grade," for this project specifically, means three things that are all currently false
for `handles`: (a) running `bskel handles emit` against a repo the authors have never seen produces
something that actually works rather than silently nothing; (b) the security posture the subsystem
advertises (`--enforce-registry`, revocation, per-action authority) is operable end-to-end by
someone who did not write it; and (c) at least one real deployment exists, so the design's
assumptions have been tested by something other than the design's own author.

Every item below is classified **[FIXABLE]** (there is a concrete definition of done) or
**[TRADEOFF]** (it can only be reduced, never eliminated — the residual risk is stated). Effort
sizes use this project's own `CATALOG.md` convention (`S`/`M`/`L`/`XL`; 54 catalog entries already
use it).

---

## Corrections to prior analyses, verified against `3c491d7`

Several claims that circulate about this repo are stale as of HEAD. Recording them here so this
roadmap isn't built on them:

- **Growth idea "runtime contract-conformance receipts" is not unbuilt — it shipped, and then some.**
  `D-runtime-conformance-receipts` (`DECISIONS.md:8943`) landed as O8, and has since been extended
  well past its declared java-spring-only v1 scope: `bin/bskel.mjs:2794/2809/2824` dispatches to
  `emitObserveJavaSpring`, `emitObservePythonFastApi`, **and** `emitObserveTypeScriptExpress`; the
  `conformance` gate is real (`lib/gate-definitions.mjs:387-402`); and the `--fail-on-violation`
  policy layer the entry's own EXIT deferred is closed (`DECISIONS.md:9279`). Note that
  `DECISIONS.md:9250-9277` still reads as if typescript-express was *held* — that note is now stale
  relative to its own code; `CATALOG.md`'s O8 entry carries the correcting `**Update
  (typescript-express, ...)**`.
- **Growth idea "cross-feature impact graph with mandatory dispositions" is not thin.** O10 shipped
  four collision signals (`lib/cross-feature-collisions.mjs:195/208/215/235`), and the
  `cross_feature` gate genuinely hashes *other* features' contract files
  (`lib/gate-definitions.mjs:200-201`, `OTHER_FEATURE_CONTRACT_PREFIX`) — a downstream contract
  change really does stale this feature's gate. What is thin is *semantic* impact (which operation
  changed and what a consumer must do), not staleness detection. `D-cross-feature-collision`'s EXIT
  bullet claiming "no cross-feature DB foreign-key inference" is itself stale — closed by
  `D-cross-feature-fk-inference` (`DECISIONS.md:9990`).
- **`java-spring`'s `production-repo` tier is Team-IZ-Backend, not spring-petclinic.**
  `spring-projects/spring-petclinic` is not any adapter's declared basis; it is a *shadow-validation*
  oracle used in a separate, later pass (`D-module-attribution-base-package`, `DECISIONS.md:10858`).
- **W6/W9 are not untouched.** A multi-repo shadow-validation sweep has already run
  (`DECISIONS.md:10860-10870`) against `spring-projects/spring-petclinic` and
  `tiangolo/full-stack-fastapi-template`, and it found four real defects — the four most recent fix
  commits on `main` (`8d5de4b`, `654bcaf`, `5ff1a1a`, `e922f7f`). This roadmap treats corpus
  expansion as *continuing a method that already works*, not starting one.
- **W8's `waivable` mismatch is real, and now has an in-code explanation.**
  `CONTRACT_OPENAPI_UNSUPPORTED_ANNOTATION_PRESENT` is `{ severity: SEVERITY.WARN, waivable: true }`
  (`contracts/completeness.mjs:126`), but `cmdContractWaive` filters `w.severity === 'error'`
  (`bin/bskel.mjs:1573`), so it can never be dispositioned. `contracts/completeness.mjs:22-26`
  documents this as intentional. The behavior is fine; the field name is still misleading.

---

## Phase 0 — Close the write-safety gaps in the `handles`/`stack` write path

**Status: items 1-3 closed, `3c491d7`..`e5584da`-era HEAD → see `D-write-safety-phase0` in
DECISIONS.md for the full implementation record and what was found while building it (notably: a
first draft of item 1 emptied `provider.outputs.spec`, which turned out to silently break a real,
already-tested safety property unrelated to this item's own goal -- caught by re-running the full
suite, corrected before landing). Item 4 status below was corrected after implementation started.**

**Effort: S–M. Risk: low. Depends on: nothing. Blocks: Phase 4 (pilot).**

You cannot responsibly point this tool at someone else's production repo while it still has three
named, unclosed paths that destroy hand-written work. All three were found and documented by this
project's own grounding pass (`D-patch-transactions`, `DECISIONS.md:10214`'s write-surface
inventory) and explicitly *not* closed there.

Deliverables:

1. **[FIXABLE] Bring `specs/<id>/handles/migration.sql` under `emitUnits()`/`classifyFile()`.**
   Today `handles/providers/java-spring/emit.mjs:250-266` regenerates it "fresh every run,
   unconditionally, regardless of the resolver/infra conflict-block state above -- it has never been
   manifest-tracked (no conflict detection for it at all)". A human who hand-edits a generated
   migration (adding an index, a `NOT NULL`, a tenant column) loses it silently on the next
   `handles emit`. Done = the same treatment `resolvers_index.ts` just received
   (`DECISIONS.md:10390-10435`): manifest-tracked, `classifyFile()`-classified, blocked on divergence,
   `--force --reason` as the audited escape hatch, dirty-tree guarded. The `postResolverUnit`
   parameter added to `handles/_engine.mjs` for the barrel is the exact precedent; `migration.sql`
   needs no deferred render at all, so it is strictly simpler.
   *Note the counter-argument on record:* `D-patch-transactions` deferred this as "a materially
   different, higher-risk domain per `D-migration-scope`." That reasoning explains why `bskel` never
   *applies* the migration; it does not explain why it silently *overwrites* one.

2. **[FIXABLE] Give `stack apply` a preimage check.** `stack/apply.mjs:145` is a bare
   `fs.writeFileSync(targetPath, f.content)`. The plan does compute an `unchanged` action
   (`stack/apply.mjs:94-98`) by exact content comparison — so a byte-identical file is skipped — but
   a file a human *edited* is classified `update` and clobbered with no hash check and no `--force`.
   Done = `stack apply --apply` refuses a target whose content matches neither the last-applied
   render nor the fresh render, with `--force --reason`, matching the handles path exactly.

3. **[FIXABLE] Make the handles manifest crash-safe.** `handles/_engine.mjs:328` is
   `if (!dryRun && manifestChanged) saveManifest(repoRoot, manifest)` — one write, after the whole
   resolver/infra loop. A crash mid-loop leaves files on disk that the manifest has no record of,
   which `classifyFile()` then reads as `conflict` on the next run (fail-closed, so not a data-loss
   bug — but it turns a crash into a manual `--force` recovery for every file written before the
   crash). Done = either per-unit manifest persistence, or a documented recovery command. Given
   `classifyFile()`'s content-derived fallback already fails closed, this is the lowest-priority of
   the three.

4. **[CORRECTED — not a fixable rough edge, a deliberate decision this roadmap mischaracterized.]**
   The claim above ("a documented lie in a `1.0.0`-stable JSON shape") does not survive contact with
   the actual code. Two things this item got wrong: **(a)** `waivable` is not in any `1.0.0`-stable
   JSON shape at all — `schemas/feature-contract.schema.json`'s `warnings[]` definition
   (`code`/`severity`/`subject`/`message`/`detail`) has no `waivable` field; it is purely an internal
   `WARNING_CODES` lookup property `contracts/completeness.mjs` and `bin/bskel.mjs` share, never
   serialized into any contract. `D-stable-api-contract` does not cover it either way. **(b)**
   `contracts/completeness.mjs:15-26` already carries a direct comment addressing this exact
   question: "`waivable` only has functional meaning for ERROR-severity codes... Every WARN-severity
   code below is marked `waivable: true` anyway — read that as 'this finding is conceptually the
   kind of thing a human might choose to acknowledge,' not as 'this can currently be passed to
   `bskel contract waive`' — it can't, and isn't meant to. **This is deliberate**
   (`test/contract-completeness.test.mjs` asserts the exact shape below, repeatedly)... **not an
   unnoticed inconsistency.**" A prior session already made and tested this call. Overwriting it
   with `waivable: false` would not be a bug fix — it would be silently reversing someone else's
   considered decision, recorded in the exact place a future reader would look. Left as-is pending
   the maintainer's own explicit call on whether to keep, rename, or reverse it — not decided by
   this roadmap.

---

## Phase 1 — Make `--enforce-registry on` operable end-to-end

**Status: items 1-3 closed as scoped; item 4 closed in a corrected, smaller scope than originally
written below — see `D-write-safety-phase1` in DECISIONS.md for the full record. Cloning the real
`spring-projects/spring-petclinic` to verify item 4's own "non-zero resolver count" success
criterion found it's unsatisfiable by ANY amount of path-fallback or repository-direct-call
engineering: petclinic's entities are `Integer`-keyed (`BaseEntity.java`), and the whole `handles`
identity model is UUID-addressable — no amount of engineering on path resolution or a second
resolver strategy changes that. Repository-direct-call support was explicitly decided against for
exactly that reason (real effort spent on a case that fails at the PK-type gate regardless). Item 4
was rescoped mid-implementation to (4a) an honest, specific PK-type diagnostic — confirmed live
against the real petclinic clone: all four entities now report the accurate reason instead of
silence — and (4b) a real, smaller, independent path fallback for a different, plausible repo
shape (UUID-keyed, has a Service layer, just not nested under `domain/`) that does NOT close the
petclinic gap and was never claimed to.**

**Effort: M. Risk: medium. Depends on: nothing (parallel with Phase 0). Blocks: Phase 4, Phase 6.**

The decision that `--enforce-registry` stays `off` by default is settled and is not reopened here
(`lib/handles-manifest.mjs:19,26` — `enforceRegistry: false` when no manifest exists). This phase
defines what "prerequisites land" concretely means, so that the flip *becomes* a decision someone
can make on evidence rather than a decision that would currently break every fresh project.

Today, turning it on requires a human to independently discover and perform three integration steps
that the tool mentions only after the fact, in a `postEmitNotes` line:

1. **[FIXABLE] `spring-boot-starter-aop` must stop being an undiscoverable prerequisite.**
   `new/spring.mjs:27` is `BASE_DEPENDENCIES = Object.freeze(['web', 'data-jpa', 'security',
   'validation', 'lombok'])` — **no `aop`** (confirmed: `/usr/bin/grep -n aop new/spring.mjs` returns
   nothing). So a project scaffolded by `bskel new --stack spring` cannot use
   `--enforce-registry on` out of the box; `HandleAspect` never intercepts anything, so the registry
   stays empty, so every enforced `fetch()`/`patch()` 404s. The only signal is
   `handles/providers/java-spring/emit.mjs:274`, printed *after* the code is already written.
   Done — and deliberately **not** by auto-editing `build.gradle`, which would violate
   `D-config-patch`'s standing boundary ("never auto-edits an application config file") — by two
   changes that are both disk-verified facts rather than edits:
   (a) `bskel handles emit --enforce-registry on` **hard-fails** (a new `MISSING_CAPABILITY`-class
   exit, or a gate refusal) when `spring-boot-starter-aop` is absent from the target's
   `build.gradle`/`pom.xml`, with the remediation string inline. This is a grep against disk — exactly
   the kind of check every other gate in this tool already is.
   (b) Optionally, `bskel new --stack spring` gains `aop` to `BASE_DEPENDENCIES`, or a documented
   `--add-dependencies aop`. `--add-dependencies` already extends the baseline, so this is a
   one-line change plus a `new-params.test.mjs` case.
   A third option worth considering instead of (a): route the dependency add through the existing
   `lib/patch-kinds.mjs` lifecycle as a third kind alongside `config-apply`/`ddl-apply`
   (`lib/patch-kinds.mjs:13-36`) — propose/approve/apply with a preimage hash. That is more work
   (**M** on its own) but it reuses machinery that exists and keeps the "never auto-edit, always
   propose" invariant intact. Pick (a) first; (c) only if a pilot shows the manual step is where
   people actually stall.

2. **[FIXABLE, with a caveat] Promote the static `@RecordHandleSnapshot` check from soft-warn to
   blocking-with-audited-override.** Today it is a `postEmitNotes` string
   (`handles/providers/java-spring/emit.mjs:278-287`; `handles/providers/python-fastapi/emit.mjs:212-224`)
   that never blocks and never fails a gate. The caveat, which the briefing version of this idea
   misses: `DECISIONS.md:8318-8333` says the check is **deliberately biased toward false positives**
   — a resource registered by a hand-written `HandleService.register()` call, or decorated in a file
   other than the one canonical file the regex reads, produces a warning that is simply wrong. Turning
   a check tuned for false positives into an *unconditional* block would break legitimate repos.
   Done = the check becomes a **block with `--force --reason`**, this project's own established
   convention for exactly this situation (`--enforce-registry off` after `on` already requires
   `--reason`, `bin/bskel.mjs:2287-2288`). That preserves the false-positive bias's whole value (loud
   by default) without making it a wall.

3. **[FIXABLE] Close the live registry-emptiness gap by extending `handles audit`, not by building
   new plumbing.** `D-handle-registry-enforcement`'s EXIT (`DECISIONS.md:8266-8272`) defers this on
   the grounds that it "would need live target-app database access at doctor-time, a larger scope
   than this item's own." That is now substantially cheaper than when it was written:
   `handles/audit.mjs` already opens a live Postgres connection via `--database-url-env`, inside a
   `BEGIN TRANSACTION READ ONLY`, already `LEFT JOIN`s `sbf_handle` to `sbf_handle_snapshot`, already
   filters by `feature_uid` and `--resource`, and already distinguishes `42P01` ("migration was never
   applied") from a real error (`D-handle-audit-report`, `DECISIONS.md:8013-8020`). Both real
   providers emit a byte-identical table shape (`DECISIONS.md:8003-8008`).
   Done = a `bskel handles audit --check-registry-coverage` (or a new field on the existing report)
   that answers, for each resource type the current plan will generate a resolver for: *does
   `sbf_handle` contain at least one non-revoked `kind='r'` row for this `resource_type`?* Zero rows
   under `--enforce-registry on` is the exact production trap, detected against the real database
   rather than a regex proxy. Effort **S–M**: one query, one flag, reusing an existing connection
   path.

4. **[CORRECTED mid-implementation — see `D-write-safety-phase1` in DECISIONS.md for the full
   record.]** The success criterion below ("verified... by asserting a non-zero resolver count"
   against petclinic) is unsatisfiable — petclinic's entities are `Integer`-keyed
   (`model/BaseEntity.java`: `private Integer id`), and the whole `handles` identity model is
   UUID-addressable. No path fix or repository-direct-call engineering changes that. What actually
   shipped: an honest PK-type diagnostic (`idFieldIsUuid`, mirroring `typescript-express.mjs`'s own
   already-established field) that fires correctly against the real petclinic clone, replacing
   silence with a specific reason — plus the real, smaller, independent path fallback described
   below, which helps a *different* plausible repo shape and was never capable of closing the
   petclinic gap on its own. The original finding is kept below as the historical record of what
   was investigated and why it seemed larger than it was; treat the "worthless without" framing and
   the petclinic success criterion as superseded, not current.

   De-hardcode the java-spring handles plan layer's path conventions (original finding, superseded
   success criterion above). This is the largest single finding in this review and
   it is not in any prior weakness list. `handles/providers/java-spring/plan.mjs:198-201`:

   ```js
   function findServiceFile(javaSrcRoot, module, entityClassName) {
       const guessedType = `${entityClassName}Service`;
       const guessedPath = path.join(javaSrcRoot, 'domain', module, 'application', `${guessedType}.java`);
       return fs.existsSync(guessedPath) ? { serviceType: guessedType, file: guessedPath } : null;
   }
   ```

   A single hardcoded `domain/<module>/application/<Entity>Service.java`, no fallback.
   `findUpdateDtoFile` (`plan.mjs:80-83`) is the same shape for
   `domain/<module>/presentation/dto/<Type>.java`. `willGenerateResolver` is false when
   `findServiceFile()` returns `null` (`plan.mjs:279`: "resolver NOT generated for this entity").
   Meanwhile `D-module-attribution-base-package` (`DECISIONS.md:10879-10892`) *proved* against a real
   clone that `spring-projects/spring-petclinic` has no `domain` segment anywhere — the scanner
   layer got a `findBasePackage()` fallback for exactly this (commit `8d5de4b`); **the handles
   provider layer did not.** The consequence: `bskel handles emit` against any package-by-feature
   Spring repo generates **zero resolvers**, and — because the `@RecordHandleSnapshot` check at
   `emit.mjs:281` only runs for resources with `willGenerateResolver: true` — emits **no warning at
   all** about it. `DECISIONS.md:11095-11099` names `findUpdateDtoFile()`'s half of this as a known
   deferred item; `findServiceFile()`'s half is not named anywhere.
   Done = `findServiceFile()`/`findUpdateDtoFile()` gain the same `findBasePackage()`-anchored
   fallback `moduleOf()` already has, verified the same way it was: by calling the real plan
   function against a real disposable `spring-petclinic` clone and asserting a non-zero resolver
   count. Effort **M**.

**Why this phase blocks Phase 4:** a pilot run with enforcement off exercises roughly half of what
`handles` claims to be, and a pilot run on a repo that isn't `domain/`-shaped exercises none of it.

---

## Phase 2 — Settle the third provider's scope, honestly, before the pilot

**Status: closed — the user picked "build it" (full parity, not permanent-scope-declaration).
`typescript-express` now generates the same `sbf_handle`/`sbf_handle_snapshot` schema, `recover()`
route, and `--enforce-registry` gating java-spring/python-fastapi do. See
`D-typescript-express-registry-parity` in DECISIONS.md for the full record, notably the one real
architectural fork this required: no decorator/AOP-equivalent interception mechanism exists in
TypeScript this provider's own `codec.ts.tmpl` constraint (no decorators) could use, so
registration is a higher-order wrapper function (`recordSnapshotWrapper.ts`) applied by hand,
instead of an annotation/decorator. Verified with a real `tsc --noEmit` against real
`typeorm`/`express` types (twice — default posture and `--enforce-registry on`), and a real,
disposable-Postgres confirmation that `handles audit --check-registry-coverage` (Phase 1 item 3)
already worked for this provider with zero code changes.**

**Effort: S (decision) or L (build). Risk: low. Depends on: nothing. Blocks: Phase 4's provider
choice, Phase 6's default-flip scope.**

`--enforce-registry` applies to two of three codegen providers. `typescript-express`'s
`registry.ts.tmpl:3-6` is explicit: an "In-process registry mapping a handle `type` string to its
resolver instance -- deliberately NOT a database table. This 1st-slice scope carries no
recover()/snapshot lifecycle equivalent (no sbf_handle/sbf_handle_snapshot table)". There is no
`migration.sql.tmpl` in `handles/providers/typescript-express/templates/` (compare java-spring's and
python-fastapi's, which both have one). Registry enforcement, revocation, and `recover()` are all
structurally inapplicable there.

**[FIXABLE, but it is a real fork]** Two acceptable outcomes, one unacceptable one:

- **Build it** (**L**): a `migration.sql.tmpl` + `sbf_handle`/`sbf_handle_snapshot` tables + a
  `handle_service.ts` equivalent + `ENFORCE_REGISTRY` threading, bringing the provider to parity.
  Only worth it if a real TypeScript pilot is actually on the table.
- **Declare it permanently out of scope** (**S**), the way `postgres-dev-db.yml:5-7` declares its own
  boundary ("a permanent, deliberate scope limit, not a to-do"), and make `bskel handles emit
  --enforce-registry on` fail fast with that explanation rather than silently ignoring the flag.
- **Unacceptable:** leaving it as an undocumented asymmetry where the same flag on the same command
  means "security enforcement" for two adapters and nothing for a third.

Whichever is chosen, `README.md`'s `## Status: 1.0.0` already tells this truth
("TypeScript Express has no persistent handle table at all"); the CLI should tell it too.

---

## Phase 3 — Freeze the handle-identity contract before any real handle exists

**Status: closed — see `D-handle-identity-contract-freeze` in DECISIONS.md for the full record.**
**The `sbf1_` wire format and `deriveHandleUid` algorithm are now a frozen, named commitment**
**(distinct from, not folded into, `D-stable-api-contract`'s own enumerated CLI-surface scope).**
**All 4 codec implementations gained a dual-scheme decode-dispatch hook (`sbf1` the only entry**
**today), reserving the discriminant a future `sbf2_` scheme (Phase 6) can register into**
**additively, verified with 8 new tests (golden-vector pins + unknown-scheme rejection, one pair**
**per language) executed against the real rendered/compiled artifact in each language, not just**
**the JS reference. The pilot redaction/retention checklist below (item 3) is produced now for**
**Phase 4 to consume.**

**Effort: M. Risk: high if skipped. Depends on: nothing. Blocks: Phase 4 (irreversibly).**

This phase exists because of a single sentence in `D-handle-uid-type-binding`'s EXIT
(`DECISIONS.md:8151-8160`): the O3-part-1 fix that bound `type` into `deriveHandleUid` for `kind=r`
"would orphan any already-registered `kind=r` `sbf_handle` row relative to the newly-derived
`handle_uid` for the same already-issued token, **if a real deployment existed**." It was correctly
shipped without a migration mechanism *because there are zero real instances to migrate*.

Phase 4 creates the first ones. From that moment, every future change to `handles/codec.mjs`,
`HandleCodec.java.tmpl`, `codec.py.tmpl`, or `codec.ts.tmpl` becomes a live migration problem for a
real production database, and the current design has no version discriminant to hang a migration on:
`handles/codec.mjs:53` emits a flat `sbf1_<base64url(kind:type:uuid[:pointer])>` and
`decodeHandle` (`codec.mjs:57-58`) rejects anything without that exact prefix.

Deliverables:

1. **[FIXABLE] Decide and document the token/UID compatibility policy before the pilot.** Concretely:
   is `sbf1_` covered by `D-stable-api-contract`'s major-version promise, or is it explicitly
   excluded? `D-stable-api-contract` covers "CLI surface... every `--json` output shape... gate names
   and pass/fail semantics, and exit codes" — a token format baked into *generated code running in
   someone else's production app* is arguably a stronger commitment than any of those, and it is
   currently unaddressed either way. Done = an explicit `D-` entry stating the policy, and a test
   that pins the four codec implementations' current output (cross-language parity tests exist
   already: `test/handles-codec.test.mjs`, `handles-java-codec`, `handles-python-codec`,
   `handles-typescript-codec`).

2. **[FIXABLE] Add the dual-scheme dispatch hook, even if unused.** The EXIT correctly rejected
   *building the migration* speculatively. It did not reject *reserving the discriminant*. A decoder
   that recognizes a prefix and dispatches on it costs ~10 lines per language and makes a future
   `sbf2_` (Phase 6) additive rather than breaking. Doing this after a production deployment costs
   dramatically more than doing it before.

3. **[TRADEOFF] Snapshot-payload retention and PII.** `HandleAspect`'s `redact()` exists
   (`D-handle-lifecycle`), and `HandleService.pruneSnapshotsOlderThan` exists but is "never
   auto-invoked, retention never auto-scheduled" (`CATALOG.md:493`). A production pilot means real
   customer data landing in `sbf_handle_snapshot` with no default retention policy. This can be
   mitigated (a documented pilot-time retention decision, a `--redact` audit in the pilot checklist)
   but never fully solved by the tool: `bskel` cannot know which of a target app's fields are
   sensitive, and `D-resolver-scope`'s "never guess-modify hand-written code" boundary means it
   should not try. **Residual risk after mitigation:** a pilot operator who does not configure
   `redact` correctly persists real PII into a table this tool created. The honest mitigation is to
   make the pilot checklist require an explicit redaction decision per resource, not to build
   detection.

### Pilot redaction & retention checklist (produced here, required reading before Phase 4 registers its first real resource)

This is procedural, not code — `bskel` cannot know which of a target app's fields are sensitive,
and `D-resolver-scope`'s "never guess-modify hand-written code" boundary means it must not try to
guess. Every item below must be explicitly resolved (not silently skipped) before Phase 4 runs
`handles emit --enforce-registry on` against a real resource for the first time:

1. **Per-resource redaction decision.** For each resource whose `recordSnapshotWrapper.ts` /
   `@RecordHandleSnapshot` / `@record_snapshot` registration is being wired in, explicitly decide
   and record (in `DECISIONS.md`, same as any other pilot finding) the `redact` pointer list for
   that resource — which fields of the request/response payload must never land in
   `sbf_handle_snapshot.payload` unredacted. "No fields need redaction" is an acceptable answer,
   but it must be a stated decision, not an unconsidered default.
2. **Retention decision.** `HandleService.pruneSnapshotsOlderThan` exists in all three registry-
   capable providers but is never auto-invoked by anything `bskel` generates. Before real customer
   data starts accumulating in `sbf_handle_snapshot`, the pilot must explicitly pick one: (a) wire
   a scheduled call to `pruneSnapshotsOlderThan` with a stated retention window, or (b) document
   "no automatic pruning, accepted risk" as a deliberate decision, with whoever owns the pilot's
   data-retention policy signing off. Either is acceptable; silence is not.
3. **Both decisions are per-resource, not global** — a pilot registering more than one resource
   type records this checklist once per resource, not once for the whole pilot.

---

## Phase 4 — A real production pilot of `handles`

**Status: partially closed — see `D-handles-pilot-cohort` in DECISIONS.md for the full record.**
**Items 1 (one real service/feature/provider), 2 (`--enforce-registry on` from day one), 3**
**(every manual step/false-positive/permanent-stub cost recorded), and 5 (signed gate**
**attestation, real `attest verify`) are done, for real, against `Team-IZ/Backend`'s `Cohort`**
**resource. Two real backend-skeleton bugs found and fixed live in the process**
**(`D-resolver-authentication-context`, `D-handle-aspect-transaction-isolation`) — neither was**
**anticipated; both were found by the pilot's own real disposable-Postgres lifecycle test failing,**
**not by code review. Item 4 (wiring `bskel observe` against real, non-synthetic production**
**traffic) is explicitly NOT done — it requires the branch to actually be merged, deployed, and**
**see real usage over time, which a single session cannot do or fast-track. The work stays on a**
**local, reviewable branch (`feat/handles-pilot-cohort`) — not pushed, no PR opened — per explicit**
**user scope. The honest posture after this: "verified against one real target application," not**
**"production-ready."**

**Effort: L (calendar-dominated, not code-dominated). Risk: high. Depends on: Phases 0, 1, 2, 3.
Unblocks: Phases 5b and 6.**

This is the keystone. `README.md` says handles "has never been deployed to a real production repo";
`CATALOG.md`'s O3 status note says the same ("no evidence handles have ever been deployed to
production, re-confirmed as still true"); and `DECISIONS.md:10860` says `1.0.0`'s own next steps are
"genuinely blocked on a real production deployment this session cannot manufacture." Everything
labelled "opt-in, off by default, treat as a scaffold" in this subsystem stays that way until this
phase happens.

**[FIXABLE — this is entirely a matter of doing it]** Concrete definition of done:

1. **One real service, one feature, one provider.** The obvious candidate is a `java-spring` service,
   since that is the only provider with a `production-repo` verification basis, a live
   `@SpringBootTest` + real-Postgres integration harness (`scripts/java-integration-smoke.mjs`, which
   already runs a two-phase enforcement-off/enforcement-on suite,
   `DECISIONS.md:8248-8264`), and a real `HandleRegistryEnforcementIntegrationTest`.
2. **Run with `--enforce-registry on` from day one.** A pilot with it off does not test the half of
   the subsystem that has never been exercised outside a fixture. Phase 1 exists to make this
   possible.
3. **Record, in `DECISIONS.md`, in the same format every other entry uses**: every manual step the
   operator had to perform that `bskel` did not prompt for; every `postEmitNotes` line that turned
   out to be a false positive; the real observed value of every constant this project currently
   derives from Team-IZ-Backend alone (operation counts, parameter counts, schema-name lengths,
   `$ref` occurrence — the histograms in `contracts/openapi.mjs:24/46/57/114/273/1212`); and every
   place `patchField()`'s permanent-stub boundary cost real time.
4. **Wire `bskel observe`.** The pilot is the first real chance to close the static→runtime loop with
   traffic that isn't synthetic: `bskel observe emit` + `observe import --fail-on-violation` against
   real production requests, feeding the `conformance` gate. If the contract and reality disagree in
   production, this is the only mechanism in the tool that will say so.
5. **Sign the pilot's gate attestations.** `bskel gate export --sign` + `bskel attest verify`
   (`D-gate-attestation-signing`) exists and is tested (17 tests across `test/attest.test.mjs` /
   `test/attest-cli.test.mjs`) but has never had a real consumer. A pilot gives it one.

**[TRADEOFF] What a pilot cannot prove.** n=1 is n=1. A single successful pilot upgrades `handles`
from "never tested outside its author's fixtures" to "tested against one real app" — a genuine and
large improvement, and still not a general claim. The honest posture after a successful pilot is
"verified against one production deployment," phrased the same careful way
`verificationBasis: 'production-repo'` already is, not "production-ready."

---

## Phase 5 — Verification-corpus diversity (W2 / W6 / W9)

**Effort: L, and genuinely ongoing. Risk: medium. Runs in parallel with Phases 0–4; sub-item 5c
depends on Phase 4.**

This is the phase most likely to be under-scoped, because the method already works and looks cheap.
It found four real defects in one pass — but the four fixes it produced are the *easy* class
(missing fallbacks), and the corpus is still one repo per adapter.

### 5a. **[FIXABLE] Turn the ad-hoc shadow-validation pass into a repeatable script.**

The pass that produced `8d5de4b`/`654bcaf`/`5ff1a1a`/`e922f7f` was manual: clone a real repo, run
`scan`/`contract emit` read-only, record false positives and refusals
(`DECISIONS.md:10860-10870`). There is no committed script for it, unlike every other verification
discipline in this project (`scripts/java-compile-smoke.mjs`, `python-import-smoke.mjs`,
`typescript-typecheck-smoke.mjs`, `db-introspect-smoke.mjs`, and six more in `package.json:38-47`).
Done = `scripts/shadow-validation-smoke.mjs` taking a list of `owner/repo[@ref]` pairs, cloning to a
temp dir, running the real read-only flow, and emitting a machine-readable finding report
(`_unknown` module count, zero-resolver entities, refused operations, low-confidence fallbacks). This
is the single highest-leverage item in the phase: it converts a one-off into something a small team
can re-run on every adapter change. Effort **M**.

**Status: closed — see `D-shadow-validation-script` in DECISIONS.md for the full record.**
**`scripts/shadow-validation-smoke.mjs` exists, plus a fast local, non-network regression guard**
**(`test/shadow-validation-cli.test.mjs`, 4/4) and a real network-dependent run against all 3**
**default oracles, which came back clean — no fresh `_unknown` surprises, confirming**
**`8d5de4b`/`654bcaf`/`e922f7f`'s fixes still hold. The approved plan's own "blank terms = see**
**everything" assumption was found wrong by empirical verification before any code was written**
**(`scan` hard-refuses zero terms) and corrected: every repo spec now carries real search terms.**
**Deliberately NOT wired into `test:all-smoke`/CI (network-dependent, unpinned third-party repos) —**
**that is 5b's job. `npm run test:shadow-validation` runs it standalone.**

### 5b. **[FIXABLE] Grow each tier from one repo to a small corpus, and pin refs.**

Current state, verified: every adapter's `verificationBasis`
(`schemas/adapter.schema.json:22-25`, required, `sbf.adapter/2`) names exactly one oracle, and **no
oracle is pinned anywhere** — not by URL, not by commit, not by tag. `Team-IZ-Backend` has no public
identity at all. `mkosir/typeorm-express-typescript`'s own TypeORM is pinned `^0.2.45` and last
pushed 2022-10-14 (`DECISIONS.md:2758`), which is why `typescript-express` "generates zero resolvers"
against it as it exists today (`CATALOG.md:235`) — the community-sample tier is verified against a
repo the adapter deliberately no longer matches.

Done = for each adapter, 3–5 real repos, each pinned to a commit SHA in a committed manifest, driven
by 5a's script. Priorities in order of current weakness:
- `javascript-express` — `synthetic-only`, zero real-world oracle, and `DECISIONS.md:11000-11004`
  notes candidly that "a real, publicly findable plain-JS-ESM-Express-no-ORM repository is genuinely
  uncommon." **[TRADEOFF]**: this tier may be structurally unpromotable. If a real corpus cannot be
  found after a genuine search, the honest outcome is to say so in the adapter's own comment (it
  already does) and accept `synthetic-only` permanently rather than promote it on a weak sample.
- `typescript-express` — replace or supplement a 2022-stale sample with a current-`DataSource`-API
  repo, which is exactly the shape the provider actually targets.
- `python-fastapi` — one official template is a strong tier but still n=1; the shadow pass already
  ran one repo against it clean.
- `java-spring` — petclinic is now effectively a second oracle; formalize it as one.

### 5c. **[TRADEOFF, mitigable only] Re-derive the single-oracle-measured constants.**

This is W9's hard core and it cannot be phased away. These are all real, cited, load-bearing numbers
measured against one private repo: `contracts/openapi.mjs:46` ("max 9 parameters on one
[operation]"), `:57` ("148 operations, 146 carry a..."), `:114` ("all 308 real Team-IZ-Backend
component-schema names with zero rejections"), `:273` (the format-value histogram), `:1212` ("694
response objects, 0 $ref"), and — most consequentially — `contracts/export.mjs:105` ("**Permanently
unbuilt: 0 real occurrences** of any of these five measured against the Team-IZ-Backend oracle"),
which is the sole justification for `title`/plural `examples`/`externalDocs`/`xml`/schema-level
`deprecated` being dropped from OpenAPI export.

Done, as far as it can be: once 5b and Phase 4 give ≥2 real corpora, re-run the same measurements
and either (a) confirm the constants hold, recording the second corpus's numbers next to the first,
or (b) find they don't, and either widen the caps or convert a "permanently unbuilt" decision into a
real backlog item. **Residual risk after mitigation:** two or three oracles is still not a
distribution. A cap derived from n=3 is better-founded than one from n=1 and is still not a general
guarantee. The correct long-term posture is the one this project already takes elsewhere — state the
measurement basis inline at the constant, so a future reader can see exactly how much evidence is
behind the number. That posture is already followed rigorously; the fix is more evidence, not better
prose.

### 5d. **[FIXABLE] Make the unpinnable oracle honest in CI.**

Ten tests in `test/contract.test.mjs`/`test/scan.test.mjs` carry `skip: !repoPresent &&
'Team-IZ-Backend not present'` and resolve it from `${process.env.HOME}/Desktop/Team-IZ-Backend`.
In CI, on any machine but one, those ten tests silently do nothing — and the 1338/1338 headline
number includes them as passing. Done = either the skip count is surfaced explicitly in CI output as
a warning, or the real-repo smoke tests are formally retired in favour of the frozen fixtures that
already replaced them (`D-fixture-corpus` already made that transition for the assertions; the
smoke tests are the leftover). Effort **S**.

---

## Phase 6 — Post-pilot: capability-scoped handles, and the default-flip decision

**Effort: L–XL. Risk: medium. Depends on: Phase 4 (hard), Phase 3 (hard), Phase 1 (hard).**

Both items in this phase are *deliberately* gated on the pilot, and that gating is not this
document's invention — `CATALOG.md:534` records it explicitly: delegatable capability-scoped handles
are "explicitly deferred per Codex's own note that it should follow a real production handles pilot,
not precede one."

1. **[FIXABLE] `sbf2` — signed, revocable, audience/tenant-aware handles.** Today's `sbf1_` is an
   unsigned base64url composite address (`handles/codec.mjs:53`), not a capability token: possession
   of the string conveys no authority, and all authority comes from the target app's own
   `@PreAuthorize`-derived check. That is a coherent design, not a bug. A capability token is a
   *different* design, and building it before a pilot means designing a delegation model against zero
   real delegation requirements. Done, after the pilot: a `sbf2_` format carrying issuer, audience,
   expiry, and a scope, dispatched through the Phase 3 prefix hook, with `sbf1_` continuing to decode
   unchanged. Reuse `lib/attest.mjs`'s Ed25519 primitives (Node built-in `crypto`, zero new
   dependencies) rather than adding a JWT library.
   **[TRADEOFF] within this item:** `D-gate-attestation-signing`'s EXIT already names the parts that
   stay hard — "key rotation, multiple valid signers, or a revocation list... A rotated/compromised
   key has no built-in 'no longer trust this' mechanism." A capability token inherits all of that and
   adds distribution. A small team can ship single-keypair signed handles; it cannot ship a key
   management story, and should say so rather than imply one.

2. **[FIXABLE] Re-open the `--enforce-registry` default as a decision, per provider.** Not
   re-litigating it now — the current `off` is correct given Phase 1's items are open. The point is
   that after Phases 1–4, the question becomes answerable on evidence: did the pilot's operator hit
   the bootstrapping trap? Did the hard-fail on missing `aop` fire, and was it useful or annoying?
   Did `--check-registry-coverage` find real empty registries? Did the false-positive rate on the
   static `@RecordHandleSnapshot` check turn out to be tolerable? Done = a `D-` entry that answers
   those with real numbers and sets the default per provider (java-spring and python-fastapi can
   diverge from typescript-express, whose answer is determined by Phase 2).

3. **[FIXABLE] Extend authority extraction only where the pilot proves it's needed.**
   `hasAnyRole(...)`/`hasAnyAuthority(...)` still fail closed to `TODO_ROLE`
   (`DECISIONS.md:8470-8473`), and ownership/tenant policy is unaddressed
   (`DECISIONS.md:8504-8508`). `python-fastapi`'s `check_access()` and `typescript-express`'s
   `checkAccess()` are always hand-written fail-closed stubs (`DECISIONS.md:8402-8405`). The current
   `TODO_ROLE` poison pill is a genuinely effective fail-closed default. `DECISIONS.md:8380-8384`
   argues correctly that building more without a proven need repeats a mistake this project has
   already measured and rejected. Let the pilot decide which of these is real.

---

## The fundamental risks, stated plainly

These do not have a phase, because no phase closes them.

- **`patchField()` will always be a stub, and that is correct.** `D-resolver-scope` /
  `D-patch-strategy` establish it: "Real codebases mix at least three different partial-update DTO
  conventions; guessing wrong would silently bypass real validation." Every `handles emit` therefore
  ships incomplete code by design. The residual cost is permanent human work per resource, and no
  amount of pilot evidence changes it — the only thing a pilot can improve is how well the tool
  *tells* you what's left to do.

- **`verificationBasis` can be improved but never made sufficient.** Even five real repos per
  adapter is a sample, and `schemas/adapter.schema.json`'s own description is careful about this:
  the field means "how well was this adapter's own parsing/codegen logic checked against real code,
  ever." Deterministic, no-runtime-LLM source analysis of an ecosystem with no canonical convention
  (`typescript-express`'s DTO problem: "interface/type alias/class-validator/Zod/undecorated-class
  are all real, structurally different DTO conventions," `DECISIONS.md:10950-10952`) has an
  irreducible false-negative rate. Corpus growth reduces it; nothing eliminates it.

- **Single-oracle overfitting (W9) can be reduced by exactly one method — more oracles — and that
  method has diminishing returns.** The most a small team can honestly promise is that every derived
  constant states its measurement basis inline, which this project already does better than most.

- **New frameworks require real engineering (W4).** There is no `bskel adapter init`, and building
  one would be building a scaffold for a task whose hard part (detect/scan/diagnostics/read-set +
  provider planning/emission, per framework, with no runtime LLM) is irreducibly bespoke. This is a
  deliberate consequence of the no-LLM determinism choice, not laziness — the same choice that makes
  every gate reproducible. Accept it and say so.

- **The deployment plane (W1) is out of scope, and the catalog says so.** `stack/` ships exactly two
  catalog entries (`ngrok.yml`, `postgres-dev-db.yml`); `{{PORT}}` is the only substituted variable
  (`stack/bootstrap/ngrok.sh:19`); and `postgres-dev-db.yml:5-7` states its own permanence: "this is
  a LOCAL DEV database only, not a production deployment recipe (no TLS, a fixed default password,
  single unreplicated container) -- a permanent, deliberate scope limit, not a to-do." Adapter-aware
  Dockerfiles, health checks, CI snippets, and contract-derived MockMvc/TestClient/Supertest
  conformance harnesses would each be a real, separate product. The honest move is to keep saying
  what the catalog already says, not to add a roadmap phase that implies otherwise.

- **`--openapi-file` drift is undetectable by construction (W5).** The `contract` gate hashes
  `specs/<id>/contracts/<id>.openapi.snapshot.json` (`lib/gate-definitions.mjs:251`), never the
  original source document, which typically lives outside the repo. This is the right call — a gate
  that depends on a file outside the repo is not reproducible — but it means an OpenAPI source that
  changes upstream produces no signal. Mitigable by recording the source path and its hash-at-capture
  in the snapshot and warning on mismatch when the path is still resolvable; never solvable, because
  the source may be unreachable at gate time.
