---
name: backend-skeleton
description: Use when scaffolding a new backend feature from a spec into an existing (brownfield) or new (greenfield) repo, and you need the plan to actually account for what already exists in the codebase instead of guessing. Covers pre-flight branch/worktree sanity, a brownfield collision scan before any spec/plan step, feature_id-scoped machine-readable contracts, UUID-addressable field handles, and stack-choice (e.g. ngrok) wiring.
license: MIT
metadata:
  version: 1.0.0
  author: popixoxipop
  based_on: "https://github.com/popixoxipop-collab/backend-skeleton"
  status: "Phase 0-6 implemented (spine, preflight, brownfield scan, feature_id contracts, stack-choice wiring, UUID handles, verify). All 5 gaps from the trial report closed."
---

# backend-skeleton

Spec-driven backend scaffolding built to close 5 gaps found by hands-on trial (not just
reading docs) of GitHub Spec Kit against a real brownfield repo vs. a greenfield one:
`~/Desktop/spec-kit-trial-report.md`. Full design and rationale: `DECISIONS.md` in this
directory, and the approved implementation plan at
`~/.claude/plans/noble-greeting-pnueli.md`.

**Core principle**: steps that matter are enforced by a disk-based gate (`bskel gate require
<name>` exits non-zero if unmet), not by asking the agent nicely. A prior trial proved an agent
*can* discover real collisions in existing code on its own — but that's luck, not a guarantee,
and this skill exists to make it a guarantee instead.

## Workflow (numbered, gated -- run in order, do not skip)

| # | Command | Gate | Status |
|---|---|---|---|
| 1 | `bskel preflight` | blocks everything below | **implemented** |
| 2 | `bskel feature init --slug <name>` | — | **implemented** |
| 3 | `bskel scan --feature <id>` (+ `scan disposition` if collision) | blocks 4-10 | **implemented** |
| 4 | `/speckit.specify` (or `bskel spec template`) | — | depends on spec-kit if present |
| 5 | `bskel contract emit` + `bskel contract validate` | blocks 6-10 | **implemented** |
| 6 | `/speckit.plan` (with scan disposition injected) | — | depends on spec-kit if present |
| 7 | `bskel handles plan` → `bskel handles emit` | — | **implemented** |
| 8 | `bskel stack apply --choice ngrok` | — | **implemented** |
| 9 | `/speckit.tasks` | — | depends on spec-kit if present |
| 10 | `bskel verify` | — | **implemented** |

D1: not sure where you are in this table, or what to run next? `bskel status [--feature <id>]`
shows every gate-backed phase's current state (1/2/3/5/7/8 -- the spec-kit phases 4/6/9 have no
gate, so `bskel` cannot track them); `bskel next [--feature <id>]` prints exactly the one
copy-pasteable command that resolves whatever's currently blocking, reusing the same gate
computation `verify` uses (see `D-status-next` in `DECISIONS.md`). Neither auto-runs anything --
`next`'s output is always read-only, even when the recommended command itself is mutating.

**You MUST run `bskel preflight` before anything else touches this repo.** Do not substitute
your own `git status`/`git log` reasoning for it -- the gate token is computed from a specific,
re-verifiable input set (current `HEAD` sha + locally-resolved default branch), and every
downstream command that checks the `preflight` gate will refuse to proceed without it having
actually run and passed.

**Handles (Phase 5) have a real, permanent scope boundary, not a "not yet built" gap**:
`bskel handles emit`'s generated `fetch()`, when it generates at all, is wired to an existing,
already-tested read-only service method -- but "safe to trust" depends on generation actually
having verified the right method and the right role, which is a fix from the post-v1.0.0 Codex
security review (`## Security hardening pass` in `DECISIONS.md`), not something to assume blindly:
`willGenerateResolver` is `false` (no resolver emitted at all) unless the service method's
argument count matches what `fetch()` always passes (one UUID -- `D-security-8`), and
`requiredAuthority()` is resolved from the SPECIFIC fetch method's own `@PreAuthorize`, not just
the first one found in the controller file (`D-security-7`, fails closed to `TODO_ROLE` on an
unsupported expression like `hasAnyRole`/SpEL rather than guessing). Still spot-check both before
trusting a generated resolver in anything sensitive -- this is a regex scanner, not a compiler.
`patchField()` is ALWAYS a stub requiring a human/agent to finish it, because this codebase uses
at least three different partial-update DTO conventions (see `D-resolver-scope` in
`DECISIONS.md`) and guessing wrong would silently bypass real validation. Do not "helpfully"
implement a guessed `patchField` body without checking which of the three patterns the target
DTO actually uses.

**`handles emit` is also fail-closed about overwriting, not just about authorization.** A rerun
never blows away a generated file it can't prove it wrote unchanged -- it tracks what it generated
in `.sbf/handles-manifest.json` and refuses to overwrite anything that diverged, whether that's a
hand-finished `patchField()` or a second feature's take on the same resource (see
`D-handles-ownership` in `DECISIONS.md`). This means completed handle work is safe across reruns
and across features by construction, not by convention -- and the escape hatch is audited
(`--force --reason "..."`), not silent. Do not "helpfully" reach for `--force` just to make a
conflict go away and read the diff first -- a conflict on a resolver usually means someone finished
`patchField()`, which is exactly the work this tool refuses to destroy.

## What's actually usable today

```bash
cd <target-repo>            # must be a git repo
bskel doctor [--workflow scan|handles|stack] [--json]
                              # checks: inside a git repo, git, a compatible Node runtime (always);
                              #    gh (preflight's soft cross-check, optional, unscoped view only);
                              #    rg (scan/handles); a recognized build wrapper -- gradlew/pom.xml+
                              #    mvnw/package.json at the repo root (handles, optional -- only
                              #    `verify --build` needs it, not `handles emit` itself); every
                              #    stack catalog entry's declared `runtime.requires` binaries
                              #    (stack, optional -- needed by the generated bootstrap script
                              #    later, not by `stack apply` itself). Only git/Node/rg are
                              #    `required` -- everything else is informational with a
                              #    remediation string. Also lists every installed scanner adapter's
                              #    specificity/capabilities and whether it detects THIS repo (scan/
                              #    handles/unscoped) -- see `bskel scan` below. See
                              #    `D-doctor-workflow` in DECISIONS.md.
bskel preflight               # 3-way default-branch cross-check + behind/ahead + worktree provenance
bskel preflight --json         # same, machine-readable
bskel preflight --allow-dirty  # skip the clean-working-tree requirement
bskel preflight --max-behind N # tolerate up to N commits behind (default: 0)

bskel gate require preflight   # exit 0 pass / 2 not-run / 3 awaiting-disposition / 4 stale (name must be one of: preflight|scan|contract|handles|stack -- an unknown name exits 14, it does not report not-run)
  #    S2: a `stale` result also carries `changed_inputs` (the exact input keys that moved, e.g.
  #    "resolution_hash" or "applied_file:scripts/dev-tunnel.sh") and `stale_reason`. A gate record
  #    written before S2 shipped has no snapshot to diff, so it reports `stale_reason:
  #    "no_recorded_inputs"` rather than guessing -- re-running the underlying command clears it.
bskel gate force preflight --reason "..."   # explicit, audited bypass
bskel gate show                # dump the full gate-state JSON for this repo -- includes each
  #    gate's `inputs` (the exact pre-hash input set its token was computed from). `show` is
  #    deliberately a state DUMP: it never recomputes, so `gate require` is what tells you whether
  #    the gate is CURRENTLY satisfied.
bskel gate show stack          # or just one gate's own record (optional <name> positional arg)

bskel scan --terms organization                      # ad-hoc, read-only, no files/gate touched
bskel scan --feature 001-organization-management      # writes specs/<id>/brownfield-scan.{json,md}, sets the `scan` gate
bskel scan --feature <id> --terms ... --accept-low-confidence   # required when confidence is "low" (see below) -- otherwise exit 16
bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel --note "..."
                                                        # required before anything downstream can pass the `scan` gate
                                                        # for a feature whose verdict was collision/adjacent
```

`scan`'s verdict: `greenfield` (no related code found -- gate auto-passes), `adjacent` (weak
relation found, still needs a disposition), `collision` (strong match -- e.g. an existing
controller/entity/enum for the same module).

Adapter selection is a zero-registration, capability-declaring registry, not a hardcoded
if/else (see `D-adapter-registry` in DECISIONS.md) -- every `scanners/adapters/<id>.mjs` file
declares its own `specificity` (an arbitration number; higher wins) and which capabilities
(`api.operations`, `api.request-shape`, `resource.fetch`, `codegen.handles`) it supports. The
highest-specificity adapter whose `detect()` matches this repo is chosen; `bskel doctor` lists
every installed adapter and whether it detects the current repo. Shipped today: `java-spring`
(specificity 100 -- ripgrep + full-file regex, no real Java parser, see
`scanners/adapters/java-spring.mjs`; detects `build.gradle`/`pom.xml` + `src/main/java`;
declares every capability) and `generic-grep` (specificity 0, unconditional last-resort fallback
-- route-pattern grep for Express/Flask/FastAPI-shaped code, see
`D-generic-grep-reconnaissance` in DECISIONS.md; declares no capabilities).

**`generic-grep` is reconnaissance only, never contract-grade** -- no real parser, no operationId
(so `contract emit` can never build a usable operation from it, per `D-contract-completeness`),
`confidence: "low"` always. A `--feature`-scoped scan with `confidence: "low"` refuses to write
`specs/<id>/brownfield-scan.{json,md}` or touch the `scan` gate at all -- **regardless of verdict,
including `greenfield`** -- unless `--accept-low-confidence` is passed (exit `16` otherwise; the
report is still printed so you can see what triggered the block). Ad-hoc mode is unaffected (it
never wrote files or touched a gate to begin with). Its role is to answer "something
route-shaped exists here", not to drive a trustworthy contract -- do not "helpfully" pass
`--accept-low-confidence` reflexively just to unblock a feature; if this repo is actually
Java/Spring-shaped, run `bskel doctor` -- it reports exactly why the `java-spring` adapter did
not detect it.

**Capability negotiation, exit `17`**: `contract emit`, `handles plan`, and `handles emit` each
require specific capabilities from the adapter that produced the feature's scan report
(`api.operations` for `contract emit`; `resource.fetch` + `codegen.handles` for both `handles`
commands) and refuse cleanly -- naming the missing capability, the adapter, and what you can do
about it, writing nothing -- rather than falling through into Java-specific codegen that was
never going to work. A `generic-grep`-scanned feature always hits this at `contract emit`
(`api.operations` is always false for that adapter, see `D-generic-grep-reconnaissance`) and,
if forced past that, at `handles plan`/`handles emit` too (`resource.fetch`/`codegen.handles`
are also false -- no codegen provider exists for a non-Spring stack yet, see `G2`/`G4` in
CATALOG.md). See `D-adapter-registry` in DECISIONS.md.

For a `java-spring` scan, `report.path_prefix_signals` (also surfaced as a plain-language note in
`unknowns` when non-empty) flags a global path prefix applied outside controller source -- a
`WebMvcConfigurer.configurePathMatch`+`addPathPrefix(...)`, a `server.servlet.context-path`, or a
`springdoc.paths-to-match` narrower than `/**` -- none of which the endpoint scanner can see on
its own (it reads one controller file at a time). This is detection only, never a fix: it exists
so a repo like Team-IZ-Backend (whose `ApiPathConfig.java` prefixes every path with `/api/v0`,
invisible to source annotations alone) gets pointed at `--openapi-file` even by a user who doesn't
already know that flag exists. See `D-openapi-reconciliation`'s §7 addendum in DECISIONS.md.

`preflight` exit codes: `0` PASS, `10` not a git repo, `11` STALE_BASE (HEAD is behind the real
default branch -- this is the exact bug class the tool exists to catch: a worktree silently
based on a stale/abandoned branch), `12` WRONG_DEFAULT (the three independent sources for "what
is the default branch" disagree, or none could be determined -- never guess `main`), `13` DIRTY
(uncommitted changes present, pass `--allow-dirty` to override), `14` bad arguments.

```bash
bskel feature init --slug organization-management
  # -> mints feature_id (e.g. 001-organization-management, auto-numbered) + a UUIDv4 feature_uid,
  #    writes specs/<id>/feature.json + .sbf/feature-index.json. Requires preflight to have passed.

bskel contract emit --feature <id> [--module <name>] [--json] [--openapi-file <path>] [--path-prefix /api/v0]
  # -> requires the `scan` gate to have passed (greenfield auto-pass, or a recorded disposition).
  #    Seeds specs/<id>/contracts/<id>.schema.json's operations from the scan's controller
  #    endpoints for the given module (defaults to the top-scoring related module): verb, path,
  #    path-param schema (uuid-format for *Id-named params), and whether the endpoint takes a
  #    body (re-checks the source for @RequestBody per-method -- verb alone is not reliable,
  #    e.g. a DELETE that still takes a confirm-name body).
  #    ALWAYS writes the contract file, even when incomplete -- but the `contract` gate only
  #    passes when completeness is `complete`. `partial` (endpoints exist with no correlated
  #    operationId, or a duplicate operationId) and `blocked` (zero operations -- no module
  #    matched, or the matched module has zero controllers) both leave the gate
  #    awaiting_disposition (exit 3), which blocks `handles emit` and `bskel verify` downstream
  #    the same way an unresolved scan collision does. See `bskel contract waive` below to
  #    resolve `partial`; `blocked` has no waiver path (nothing to waive) -- fix
  #    --module/--terms, or `bskel gate force contract --reason "..."` if genuinely intentional.
  #
  #    IMPORTANT LIMITATION: the scan is source-annotation-only (ripgrep + regex over .java
  #    files) -- it CANNOT see a framework-level path prefix applied outside the controller
  #    source (a WebMvcConfigurer.configurePathMatch global prefix, server.servlet.context-path,
  #    a gateway rewrite, etc). Team-IZ-Backend applies exactly this via ApiPathConfig.java --
  #    every contract path this tool emits without --openapi-file is missing `/api/v0`. Pass
  #    --openapi-file pointing at a real generated OpenAPI document (e.g.
  #    `./gradlew test --tests "...DumpSpecTest"` -> build/api-docs.json) to reconcile against
  #    it: operations that already matched by operationId get their path/verb corrected to the
  #    document's real value (provenance becomes `scan+openapi`); endpoints the scanner couldn't
  #    correlate an operationId for may get adopted directly from the document instead
  #    (provenance `openapi`, flagged CONTRACT_OPENAPI_DERIVED_OPERATION_ID -- a WARN, does not
  #    block). An operationId that agrees between scan and document but whose verb/path conflict
  #    can't be explained by the inferred prefix is left at its scan value and flagged
  #    CONTRACT_OPENAPI_DRIFT (ERROR, blocks) rather than silently guessed -- same fail-closed
  #    treatment for a scan operationId absent from the document entirely
  #    (CONTRACT_OPENAPI_MISSING_OPERATION). The prefix itself is inferred from operations that
  #    matched by operationId (no guessing when anchors disagree or there are none -- pass
  #    --path-prefix explicitly in that case). Writes
  #    specs/<id>/contracts/<id>.openapi.snapshot.json, covered by the `contract` gate's token --
  #    deleting or hand-editing it makes the gate go stale the same way tampering with the
  #    contract file itself does. See `D-openapi-reconciliation` in DECISIONS.md for the full
  #    design and a real before/after measured against Team-IZ-Backend. Known limitation: this
  #    only defends the snapshot against tampering, not the upstream OpenAPI document against
  #    going stale (regenerate it after any real source change) -- live drift detection against
  #    a running server is a separate, not-yet-built item.
  #
  #    ALSO source-annotation-only (no @Schema field-level shape on request DTOs): every
  #    `matched`/`adopted` operation's request body is likewise only known to exist, never its
  #    actual field shape, so `contract validate`/`tool-schema` accepted ANY object for a
  #    body-bearing operation. `--openapi-file` closes this too: an operation's real
  #    `application/json` requestBody schema (with `$ref`s fully inlined against
  #    components.schemas -- never left as `$ref`) is projected onto that operation as
  #    `requestBodySchema`, and `contract validate`/`tool-schema` enforce it from then on.
  #    Requires an OpenAPI 3.1.x document (a 3.0 document still gets path/verb reconciliation, but
  #    schema projection is disabled for the whole document -- one stderr note, not a flood of
  #    per-operation warnings -- since 3.0/2020-12 disagree on `exclusiveMinimum`/`nullable`
  #    semantics). A schema that references an unsupported construct (an unrecognized keyword,
  #    a `$ref` cycle, an over-long or uncompilable `pattern`, more nesting/nodes than the fixed
  #    caps allow) is left unprojected -- CONTRACT_OPENAPI_SCHEMA_UNRESOLVED (WARN, never blocks)
  #    and the operation falls back to the pre-existing bare-object check, same as if
  #    --openapi-file had never been passed for that one operation. See `D-openapi-request-schema`
  #    in DECISIONS.md for the full design, the real Team-IZ-Backend before/after, and the
  #    ReDoS/recursion-depth caps (measured against 54 real request bodies, not guessed).
  #
  #    Response/error bodies are projected too (A3): every documented 2xx `application/json`
  #    schema becomes `responseSchema`, every documented 4xx/5xx becomes `errorSchema` -- both
  #    fully inlined, and unioned with `anyOf` (never `oneOf` -- projected schemas can legally
  #    overlap) when an operation documents 2+ distinct shapes for that direction. No envelope
  #    change was needed for this: in the real Team-IZ-Backend document every operation shares
  #    exactly one error schema and (with 2 harmless exceptions) exactly one success schema, so a
  #    status-code field would have bought nothing. Same fail-closed rule as the request side --
  #    an unprojectable response/error schema gets its own WARN code
  #    (CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED / CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED,
  #    never blocks) and that direction alone falls back to unconstrained. See
  #    `D-openapi-response-schema` in DECISIONS.md.

bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path"|--all) --reason "..."
  # -> the `scan disposition` of contracts: explicitly accepts specific `partial` warnings so the
  #    `contract` gate can pass, recorded in specs/<id>/contracts/<id>.resolution.json (kept
  #    separate from the contract artifact itself, so re-emitting after a re-scan doesn't erase
  #    the waiver, and waiving doesn't touch contract_hash). `--all` expands to the SPECIFIC
  #    {code, subject} pairs present right now, as individual entries -- never a wildcard, so a
  #    new unmatched endpoint added later is never silently covered by an old `--all`. Unknown
  #    code, or a {code, subject} pair not currently present, exits 14. `blocked` contracts
  #    cannot be waived at all (exit 14) -- see contracts/completeness.mjs's WARNING_CODES for
  #    the full code table and which are waivable.

bskel contract validate --feature <id> --file envelope.json
  # -> validates a {sbf, feature_id, feature_uid, operation_id, direction, payload} envelope:
  #    structural check against schemas/agent-envelope.schema.json, then feature_id/feature_uid
  #    must match this exact contract, operation_id must be one it defines, and payload must
  #    satisfy that operation's specific shape for the envelope's `direction`:
  #      - "request":          payload = {pathParams, body} -- body checked field-by-field
  #                             (required/type/enum/pattern/length/...) when the operation has a
  #                             projected `requestBodySchema` (--openapi-file), else the
  #                             pre-existing bare-object check.
  #      - "response"/"error": payload = {body: <the actual response/error body>} -- checked
  #                             against `responseSchema`/`errorSchema` (A3, --openapi-file) when
  #                             present; unconstrained (any payload passes) otherwise, exactly as
  #                             every direction behaved before A2/A3. See
  #                             `D-openapi-response-schema` in DECISIONS.md for why `payload` is
  #                             `{body: ...}` and not the response value directly (keeps a future
  #                             status-code field additive instead of a breaking `sbf` bump).
  #    Wrong feature, wrong operation, missing a required path param, and an unexpected body on a
  #    bodyless operation all fail distinctly -- see test/contract.test.mjs.

bskel contract tool-schema --feature <id> --operation <operationId>
  # -> prints {name, description, input_schema} for that operation's REQUEST shape only (response/
  #    error schemas, even when projected, never appear here -- unchanged by A3). input_schema is
  #    plain JSON Schema (no $ref/$defs, even with a projected requestBodySchema --
  #    contracts/openapi.mjs's inlineSchema() guarantees this), usable directly as an Anthropic
  #    tool-use tool definition.

bskel stack apply --choice ngrok                # dry-run (default): prints the plan, writes nothing
bskel stack apply --choice ngrok --apply        # actually writes; always idempotent to re-run
bskel stack apply --choice ngrok --apply --port 3000   # if the app doesn't run on 8080
  # -> requires preflight. Creates scripts/dev-tunnel.sh + scripts/_bskel-lib.sh (both
  #    self-contained -- no dependency on backend-skeleton being installed to run them later)
  #    and appends NGROK_AUTHTOKEN/NGROK_DOMAIN/PUBLIC_BASE_URL doc entries to .env.example.
  #    Also reports whether auth.login.allowed-origins is already environment-variable-driven
  #    (it is, in Team-IZ-Backend) or needs a one-line manual patch -- never auto-edits
  #    application config files, see D-config-patch in DECISIONS.md.
  #
  #    The runtime half is NOT run by this command: after --apply, a human fills in
  #    NGROK_AUTHTOKEN in .env and runs ./scripts/dev-tunnel.sh themselves (starts the tunnel,
  #    writes PUBLIC_BASE_URL + appends to AUTH_LOGIN_ALLOWED_ORIGINS in .env once the tunnel
  #    is confirmed up, then either execs a given --exec "..." command or waits). Works in both
  #    ephemeral mode (no NGROK_DOMAIN set) and reserved-domain mode (NGROK_DOMAIN set) --
  #    same script, switched purely by env var presence, per D-ngrok.
  #
  #    S2: the `stack` gate now hashes the CONTENT of every applied file (scripts/dev-tunnel.sh,
  #    scripts/_bskel-lib.sh, .env.example) -- deleting OR editing any of them stales the gate,
  #    naming the exact file (D-gate-precision). It no longer stales merely because an unrelated
  #    commit landed elsewhere in the repo. Re-running `--apply` (idempotent) is the remedy.
```

```bash
bskel handles plan --feature <id> [--module <name>] [--resource Type1,Type2]
  # -> read-only. For each entity found by `bskel scan` in the target module, reports whether
  #    a resolver CAN be generated: a single-resource GET endpoint on a controller whose class
  #    name contains the entity's name (for fetch), a matching <Entity>Service.java file, AND
  #    that service's same-named method taking exactly the one UUID argument fetch() always
  #    passes (D-security-8 -- a 2+ arg service method, e.g. one scoped under an org/cohort id,
  #    blocks generation instead of silently dropping the extra scope). If any of these is
  #    missing, says so and will not generate a broken (or wrongly-scoped) stub for that entity.

bskel handles emit --feature <id> [--module <name>] [--resource Type1,Type2] [--force --reason "..."]
  # -> requires the `contract` gate to have passed. Writes, under the detected base package:
  #      global/handle/{HandleCodec,HandleRegistry,HandleSnapshot,HandleRegistryRepository,
  #        HandleSnapshotRepository,ResourceResolver,HandleController}.java
  #      domain/<module>/infrastructure/<Type>Resolver.java   (one per resource `plan` approved)
  #      specs/<id>/handles/migration.sql   (sbf_handle + sbf_handle_snapshot tables -- NOT applied)
  #    <Type>Resolver's fetch() calls the real service method directly -- a read-only call into
  #    existing, tested code, and only ever emitted once `plan`'s D-security-7/8 checks above
  #    passed, not assumed safe by default. patchField() is ALWAYS a stub -- see the workflow
  #    section above and D-resolver-scope in DECISIONS.md for why.
  #
  #    O2: every generated file's provenance is tracked in .sbf/handles-manifest.json (D-handles-
  #    ownership). A file untouched since bskel last wrote it is regenerated normally; a diverged
  #    one (hand-edited, or a different feature's take) BLOCKS with exit 15 and does not pass the
  #    `handles` gate this run, though every other safe file still gets written. Infra
  #    (global/handle/*) is one all-or-nothing unit; resolvers block independently per file.
  #    Remediate with `--force --reason "..."` (refused if the target has uncommitted/untracked
  #    changes -- force only ever overwrites content already recoverable from git history). A
  #    resolver a feature no longer generates (e.g. after a service-signature change) is reported
  #    as an orphan and left untouched, never deleted -- suppressed entirely under --resource.

bskel verify --feature <id> [--build] [--json]
  # -> aggregates all 5 gates (lib/gate-definitions.mjs is the single source both this and every
  #    gate-writing command consume) via the same machinery every other command uses, plus
  #    artifact existence checks: the contract file, the handles migration if applicable, and
  #    (S2) every generated handle file this feature owns plus repo-owned global/handle/* infra,
  #    tracked via .sbf/handles-manifest.json (D-handles-ownership) -- existence-only, by design:
  #    hand-finishing patchField() must never fail this, only the file being GONE does. Each gate
  #    carries a verifyPolicy: `required` (preflight/scan/contract -- not_run or stale always
  #    fails overall) or `required-when-present` (handles/stack -- not_run does NOT fail overall,
  #    but a gate that HAS run and is stale/awaiting_disposition still does -- "optional" means
  #    "not every feature needs this", not "once run, correctness stops mattering"). Each gate's
  #    JSON entry reports `scope`/`policy`/`blocking`/`ran` alongside its status, and (S2) when
  #    stale, `changed_inputs`/`stale_reason` -- the non-JSON report shows this inline too, e.g.
  #    `[FAIL] contract (stale: resolution_hash)`. --build actually runs the detected build tool
  #    (gradlew/mvnw/npm) and reports real pass/fail, not just gate status -- exits 0 only if
  #    everything blocking passed. The `contract` gate's evidence additionally carries
  #    `completeness` (complete/partial/blocked) and `waived_count` -- the non-JSON report shows
  #    this inline, e.g. `[PASS] contract (partial: 6 waived)`.

bskel status [--feature <id>] [--json]
  # -> D1: same gate/artifact data `verify` computes (lib/verify.mjs's collectGateStatuses/
  #    checkArtifacts, called directly -- not re-derived), framed as "where am I" rather than a
  #    pass/fail verdict. No --feature: only the repo-scoped `preflight` gate is evaluated
  #    (feature-scoped gates have nothing to look up without a feature_id). Also reports which
  #    optional gates (handles/stack) haven't run yet.

bskel next [--feature <id>] [--json]
  # -> D1: prints exactly ONE copy-pasteable next command -- the earliest gate (in GATE_NAMES
  #    order) that's currently blocking, with the remediation matching its ACTUAL status: a
  #    not-run gate gets the command that establishes it, an awaiting_disposition gate gets that
  #    gate's specific resolution (`scan disposition` for scan, `contract waive`/`gate force
  #    contract` for contract -- never a generic re-run), and a stale gate gets the establishing
  #    command again with S2's `changed_inputs` folded into the reason. Once every required gate
  #    passes, recommends `bskel verify`. No --feature and preflight already passed: recommends
  #    `feature init` (no feature exists yet) or points at `--feature <id>` naming known features.
  #    Non-JSON output is stdout = the command only, reason on stderr -- safe for `$(bskel next)`.
  #    No --execute flag: this never runs the command it recommends, even when it's read-only
  #    (see D-status-next in DECISIONS.md for why auto-running mutating commands is out of scope).
```

**Handle format**: `sbf1_<base64url(kind:type:uuid[:pointer])>` -- `kind` is `r` (whole
resource), `f` (one field, via an RFC 6901 JSON Pointer), or `o` (reserved, unused). A plain-
UUID `handle_uid` is derivable from the same components (`kind=r`: the resource's own uuid;
`kind=f`: a UUIDv5 of `type:uuid:pointer`) without any DB round-trip. Verified byte-identical
between the JS reference implementation (`handles/codec.mjs`) and the generated Java
(`HandleCodec.java`) on the same inputs, and `uuidv5` independently matches the standard RFC
4122 test vector -- see `test/handles-codec.test.mjs` and `D5/D6` in `DECISIONS.md`.

**Contract scope note**: without `--openapi-file`, only `direction: "request"` payloads are
checked against an operation-specific shape (path params + whether a body is required/disallowed)
-- `response`/`error` payloads pass envelope-structure validation but aren't checked further, since
that needs real field-level shapes Phase 2's ripgrep+regex scanner alone can't produce. With
`--openapi-file` (A1-A3), all three directions get field-level checks for `matched`/`adopted`
operations whose schema resolved -- there is still no status-code precision (a `response`/`error`
envelope is checked against a union of every documented shape for that direction, not the one
specific status that actually occurred), and anything not covered by the above (no
`--openapi-file`, an unmatched operation, an unprojectable schema) stays exactly as unconstrained
as before. See `D-contract-scope` and `D-openapi-response-schema` in `DECISIONS.md`.

## Design reference / extension points

All 6 phases are implemented (`scanners/`, `contracts/`, `stack/`, `handles/`, `lib/verify.mjs`)
-- the 5 gaps from the trial report are closed. This section is for extending it further.

- **Pressure-tested with a fresh agent, not just self-reviewed**: a `general-purpose` agent with
  zero memory of building this skill was pointed only at this file and given an underspecified
  task on the `curriculum` module (never touched during development). It independently followed
  the full gated sequence (preflight -> feature init -> scan -> disposition -> contract emit ->
  validate) without being told the command order, correctly stopped at a real scan limitation
  (`registerCurriculum` had no correlatable operationId) instead of hand-writing around it, and
  independently avoided the exact stale-worktree-base bug that started this whole project. See
  `D-pressure-test` in `DECISIONS.md` -- this is the actual evidence the gates work, not a
  hypothetical.
- Generated Java was verified with a real `./gradlew compileJava` run against Team-IZ-Backend
  (BUILD SUCCESSFUL, all 9 generated files including a working `OrganizationResolver`) -- not
  just eyeballed. A live DB-backed round trip (mint -> fetch -> patch -> recover against an
  actual `sbf_handle` table) was NOT performed -- no test database, and migrations are
  deliberately emit-only (see `D-migration-scope`).
- `stack/apply.mjs` is generic over any `stack/catalog/<id>.yml` -- adding a new stack choice
  (Supabase, Railway, ...) is a new catalog YAML + template pair, not new JS (see `D7`). Config
  files that need surgical, comment-preserving edits (rather than whole-file creation) are
  deliberately NOT auto-patched yet -- see `D-config-patch`.
- `~/.agents/skills/archify/` is the packaging precedent for `schemas/` + `bin/` + `test/`
  layout generally. Its ajv-standalone-compilation technique (`archify/scripts/
  generate-validators.mjs`) does NOT apply directly here, though -- see `D-ajv-runtime` in
  `DECISIONS.md` for why `bskel` uses `ajv`/`ajv-formats` as real runtime dependencies instead
  (per-feature contract schemas don't exist until `contract emit` runs, so there's nothing
  fixed to pre-compile the way archify's 5 diagram schemas are).
- `~/.claude/skills/graphify/SKILL.md` is the structural precedent for this file's own
  numbered/gated workflow style, once later phases add more real steps here.
- Every new gate needs an entry in `GATE_DEFINITIONS` (and `GATE_NAMES`) in
  `lib/gate-definitions.mjs` (see `D1` and `D-gate-definitions` in `DECISIONS.md`) -- `scope`,
  `verifyPolicy`, and `recompute` all live there now, consumed by both the write side
  (`bin/bskel.mjs`'s `passNamedGate`/`awaitNamedGateDisposition`) and the read side
  (`lib/verify.mjs`'s `collectGateStatuses`). Registering in one but not the other is no longer
  possible -- there is only one list. Forgetting `recompute` degrades that gate to "cannot detect
  staleness"; forgetting to add the name to `GATE_NAMES` makes `bskel verify` silently skip it
  entirely (`test/gate-definitions.test.mjs` catches exactly this).
- S2: if a gate's real inputs are manifest-shaped (many files, one hash each -- see `stack`'s
  `recompute` for the reference shape), flatten them into distinctly-prefixed top-level keys in
  `recompute`'s returned object (`stack` uses `applied_file:<relpath>`), don't nest them under one
  key. `lib/gates.mjs`'s `diffInputs()` only compares top-level keys, so flattening is what lets a
  stale gate's `changed_inputs` name the exact file that drifted instead of just "some nested value
  changed". See `D-gate-precision` in `DECISIONS.md`.
