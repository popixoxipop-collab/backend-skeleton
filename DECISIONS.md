# Decisions

Numbered decisions for `backend-skeleton`. Each entry: **WHY** (why this choice over the
alternatives), **COST** (what was given up), **EXIT** (how to undo/replace it later).

## D0: dedicated GitHub repo (`popixoxipop-collab/backend-skeleton`), symlinked into `~/.claude/skills/`

**WHY**: this skill ships executable code (a CLI, JSON Schemas, Java codegen templates) whose
compatibility needs to be traceable across projects that consume it — a bare directory under
`~/.claude/skills/` is untracked there (confirmed: `~/.claude` is its own git repo but
`skills/` was never `git add`ed).
**COST**: symlink indirection; every internal path must resolve from `import.meta.url`, never
assume `~/.claude/...`.
**EXIT**: `cp -R` the directory content into `~/.claude/skills/backend-skeleton` directly and
delete the symlink — zero code changes required, provided the path-resolution rule above held.

Correction to the premise this was chosen under: `~/.agents/skills/archify` was described (by
research done before this decision) as following "the same dedicated-repo pattern." On closer
inspection while executing this decision, that's not accurate — archify is a plain tracked
subdirectory of the `popixoxipop-collab/ax-os` home repo, not its own separate remote (the
`.skill-lock.json` metadata claiming a dedicated origin doesn't match what's on disk). The
dedicated-repo choice for `backend-skeleton` stands on its own merits (real versioning for real
code) and was the user's explicit choice regardless — noted here so the discrepancy doesn't
resurface as a false "but archify does it differently" objection later.

## D1: gate state as on-disk content-hash tokens, not prose instructions

**WHY**: the Spec Kit trial (`~/Desktop/spec-kit-trial-report.md`) proved agent-honored steps
are luck, not guarantee — the underlying Claude Code agent *did* discover a real collision with
existing code unprompted, but nothing forced it to check and nothing recorded the answer
machine-readably. Separately, spec-kit's own `optional:false` extension hooks were verified (by
reading `EXTENSION-API-REFERENCE.md` in `github/spec-kit`) to just inject `EXECUTE_COMMAND:`
text into the agent's context — not a process gate. So gates here are implemented as: `bskel
gate require <name>` recomputes a token from the CURRENT state of specific inputs (see
`GATE_RECOMPUTERS` in `bin/bskel.mjs`) and compares it to the token stored when the gate last
passed; mismatch or absence exits non-zero.
**COST**: extra `.sbf/*.json` files per feature; a gate can go `stale` mid-session if its inputs
change, requiring a re-run.
**EXIT**: `bskel gate force <name> --reason "..."` bypasses a gate but records `{forced:true,
reason}` so every bypass is auditable instead of silent.

**Implementation note (bug found and fixed while building this)**: the token a gate is written
with and the token it's re-verified against **must come from the exact same recompute
function**, or `require` degenerates into comparing stored data against itself and can never
detect drift — this happened once already (wrapped `{evidence: result.evidence}` at write time
vs. bare `result.evidence` at read time, so a gate that had just passed was immediately reported
`stale`). Fixed by centralizing one `GATE_RECOMPUTERS[gateName]` function per gate name in
`bin/bskel.mjs`, used at both `passGate` and `requireGate` call sites. Any new gate-emitting
command (scan, contract — later phases) must register its own recomputer here, or it inherits a
"cannot detect staleness" fallback (falls back to trusting stored evidence, which is honest but
weaker than a real gate).

## D2: `bash`, not POSIX `dash`-strict `sh` or Node, for `scripts/preflight-base-ref.sh`

**WHY**: the script needs to be reusable outside this skill (drop into any repo or CI job) with
zero package dependencies; bash ships on every target machine/CI image, and the 3-way
default-branch cross-check (symbolic-ref / `git remote show` / `gh api`, detecting disagreement
rather than picking one) is painful to write correctly in strict POSIX sh.
**COST**: won't run under a minimal container that only has `/bin/sh` (dash/ash) and no bash.
**EXIT**: `bskel preflight --native` in `lib/` can reimplement the same algorithm in Node if that
ever becomes a real blocker.

**Implementation note (bug found and fixed while building this)**: `gh api repos/<bogus>` on a
non-2xx response can print the error body (a 404 JSON payload, with raw CRLF bytes) to stdout
while exiting non-zero — the original `SRC_GH_API=$(gh api ...) || true` pattern still captured
that garbage into the variable, because `$(...) || true` only suppresses `set -e` on the
*assignment statement*, it doesn't discard the captured stdout. This corrupted the tool's JSON
output (`Bad control character in string literal`) whenever the remote wasn't reachable as a
real GitHub repo (surfaced immediately by `test/preflight.test.mjs`'s local-fixture-repo tests,
which use a `file://`-style origin with no real GitHub API behind it). Fixed two ways: (1) `gh
api`'s exit code is now checked explicitly (`if OUT=$(gh api ...); then SRC_GH_API="$OUT"; fi`)
so a failed call leaves the source empty rather than garbage; (2) the owner/repo extraction now
only fires for remotes that actually match a `github.com` host pattern, so `gh api` is never
invoked at all against a local path or non-GitHub remote in the first place.

## D3: verdict -> disposition state machine instead of an agent question (implemented)

**WHY**: the Spec Kit trial's agent *did* ask and *did* recommend the right disposition when it
found a real collision -- but nothing forced the question and nothing recorded the answer
machine-readably, so a later `/speckit.plan` run couldn't be constrained by it. `bskel scan`
computes a verdict (`greenfield` / `adjacent` / `collision`, threshold-scored per module) and,
for anything other than `greenfield`, leaves the `scan` gate in `awaiting_disposition` --
`bskel contract emit`/future commands checking this gate will refuse to proceed until `bskel
scan disposition --mode reuse|extend|replace|parallel --note "..."` records a human decision,
which then writes `plan-constraints.md` (injected into the plan step) and flips the gate.
**COST**: one extra CLI round-trip whenever a real collision is found; `replace` mode requires
an explicit `--breaking-approved` flag as a deliberate speed bump.
**EXIT**: `bskel scan disposition --feature <id> --mode greenfield-equivalent` isn't a real mode
-- to bypass entirely, `bskel gate force scan --reason "..."` remains available and is audited
the same way as any other forced gate.

**Verified against the real Team-IZ-Backend repo** (not just a synthetic fixture): `bskel scan
--terms organization` reproduces the trial's lucky discovery by construction -- finds
`OrganizationController`'s all 10 operationIds in document order with correct verb+path
correlation for every one of them, and `OrganizationStatus`'s exact 4 constants
(`ACTIVE, SUSPENDED, DELETION_PENDING, DELETED`). This is now `test/scan.test.mjs`'s oracle
test, run directly against that repo (skipped automatically if the repo isn't present on the
machine running the tests).

**Implementation notes from building this**:
- Module relevance scoring also surfaces modules that don't semantically match the search terms
  but whose routes are *nested under* a matching module's path (e.g. scanning for
  "organization" against Team-IZ-Backend also surfaces `curriculum`/`member`/
  `platformgovernance`/`usagemetering` at lower scores, because they expose endpoints like
  `/organizations/{organizationId}/curricula`). Kept as intended behavior, not filtered out --
  a feature touching `organization` plausibly needs to know about its dependents too, and the
  score ordering (organization=175 vs. the next-highest=49) already makes the primary match
  obvious.
- The `@Operation`-to-mapping-annotation correlation heuristic is not 100% coverage across the
  whole codebase -- it correctly resolves all 10 endpoints of `OrganizationController` (the
  oracle), but some other controllers (`CurriculumController`, `CommitEmailController`) show
  `operationId: (unmatched)` for a handful of endpoints, likely due to a structural pattern the
  heuristic doesn't anticipate. Left as an honest gap: the renderer prints `(unmatched)` rather
  than silently guessing, and `related_modules[].controllers[].endpoints[]` still reports the
  verb+path either way. Revisit only if a real disposition decision is ever blocked by a missing
  operationId for a non-organization module.

## D4: feature_id (spec-kit's NNN-slug) + minted feature_uid (UUIDv4), both required in every envelope

**WHY**: `feature_id` (`NNN-slug`) is human-legible and is spec-kit's own folder-naming
convention (reused, not reinvented) -- but it isn't stable across renames and isn't globally
unique across repos. `feature_uid`, minted once by `bskel feature init` and never reused, closes
both gaps: a stale envelope copy-pasted from a renamed/recreated feature fails on `feature_uid`
mismatch even if `feature_id` still happens to match. UUIDv4 over a v5-derived-from-slug: v5
would be recomputable from the slug alone, which is exactly the "stable identity survives
rename" property we don't want -- a rename should count as a different feature unless a human
explicitly re-points `.sbf/feature-index.json`.
**COST**: an extra `bskel feature init` step before `scan`/`contract emit` can be meaningfully
gated (both require it to exist -- see `requirePreflightPassed`/`loadFeatureRecord` in
`bin/bskel.mjs`); numbering can only be assigned by this tool, so a feature_id typed by hand
without running `feature init` first has no `feature_uid` and contract emit will refuse it.
**EXIT**: `.sbf/feature-index.json`'s `by_uid` map is the reassignment point if a feature ever
needs to be manually re-keyed (e.g. two features merged).

## D-ajv-runtime: ajv is a real dependency, not a devDependency (deviates from archify)

**WHY**: archify's `ajv` is a devDependency used only by `scripts/generate-validators.mjs` to
standalone-compile a FIXED set of 5 diagram schemas, known at package-build time, into a
zero-runtime-dependency validator bundle. `backend-skeleton`'s per-feature operation schemas
don't exist until `bskel contract emit` runs for that specific feature -- there is nothing to
pre-compile in advance, so `bskel contract validate` needs `Ajv2020`/`ajv-formats` at actual
runtime. Kept the fixed `schemas/agent-envelope.schema.json` un-standalone-compiled too, for
consistency (compiling only that one schema ahead-of-time while everything else needs runtime
ajv anyway wouldn't remove the runtime dependency, just add asymmetry).
**COST**: `bskel` itself now has 2 real npm dependencies (`ajv`, `ajv-formats`) instead of zero
-- `npm install` is required after cloning, unlike a hypothetical pure-stdlib version.
**EXIT**: if per-feature contracts ever become a small, closed enum of shapes (unlikely, given
the whole point is scanning arbitrary existing code), revisit standalone compilation then.

## D-contract-scope: `contract validate` only constrains `direction: "request"` payloads

**WHY**: the per-operation schema built by `contracts/emit.mjs` is derived from what Phase 2's
scan can see -- HTTP verb, path (with path-param names), and whether `@RequestBody` appears in
the method signature. None of that describes a RESPONSE body's shape (that would need actual
Java DTO field-level parsing, out of scope for a ripgrep+regex scanner). So `response`/`error`
envelopes pass envelope-structure validation but are not checked against any operation-specific
shape.
**COST**: an agent could send a malformed response payload and `contract validate` wouldn't
catch it -- request-side is where feature_id/operation_id scoping matters most (an agent acting
on the wrong feature/operation is the failure mode the trial actually surfaced), so this was
judged an acceptable scope cut, not silently -- this note plus the code comment in
`contracts/validate.mjs` say so explicitly.
**EXIT**: a future DTO-field scanner (reading `@Schema`/getter return types from the response DTO
class already located by Phase 2) could seed `response` schemas the same way `body` is seeded for
requests now.

## D7 (implemented): declarative catalog + generic apply, not per-stack bespoke code

**WHY**: "add a stack choice" must be a data edit (one YAML file, optionally one template), or
the mechanism rots as more choices get added. `stack/apply.mjs`'s `planApply`/`applyPlan` are
entirely generic over any `stack/catalog/<id>.yml` matching `schemas/stack-choice.schema.json`
-- adding e.g. `supabase` or `railway` later is exactly one new YAML + template pair, zero new
JS. Verified for real: dry-run against Team-IZ-Backend correctly detected `allowed-origins` is
already environment-variable-driven (`already-externalized`), so `--apply` there only needed to
create `scripts/dev-tunnel.sh` + `scripts/_bskel-lib.sh` + `.env.example` entries -- nothing
else, and re-running `--apply` afterward is a verified no-op (`alreadyDetected: true`, every
file `unchanged`).
**COST**: the YAML can't express genuinely exotic wiring (e.g. a multi-step OAuth dance).
**EXIT**: a catalog entry could grow a `custom: <script>` escape hatch if that's ever needed;
not built now since nothing requires it yet.

## D-config-patch: `config_check` is informational only -- never auto-edits application config

**WHY**: the target config file (Spring's `application.yaml` here) is often comment-dense and
hand-tuned -- a wrong automatic YAML edit is a worse failure mode than asking a human to add one
line. The plan's original design called for the `yaml` package's comment-preserving Document
API to actually patch it; deferred because the real target (Team-IZ-Backend) turned out not to
need it at all (`auth.login.allowed-origins` was already `${AUTH_LOGIN_ALLOWED_ORIGINS:...}`),
so there's no concrete case yet to validate a patcher against.
**COST**: a repo where the relevant config is genuinely hardcoded gets a `needs-manual-patch`
status and a note, not an automatic fix.
**EXIT**: build the Document-API patcher once a real target that actually needs it shows up --
`config_check` entries in the catalog schema already carry the pattern/note a future `apply`
action would need.

## D-ngrok-no-static-config-file: no templated `ngrok.yml`, the bootstrap script calls `ngrok http` directly with CLI flags

**WHY**: a static ngrok config file template would need to track ngrok's own config schema
version (v2/v3 have different shapes) with no way to test it against a real tunnel start until
runtime -- CLI flags (`ngrok http $PORT [--domain $NGROK_DOMAIN]`) are simpler, avoid an extra
templated file, and were what got actually live-tested (see below).
**COST**: doesn't support ngrok config features that only exist in the YAML config format
(traffic policies, multiple simultaneous endpoints, etc.) -- fine for "expose one dev port."
**EXIT**: a catalog entry's `static.files` list already supports adding a config-file template
later without changing `stack/apply.mjs`.

**What was actually verified, and how** (ngrok itself was NOT live-tunneled in the automated
test suite -- see below for why):
- Real dry-run + `--apply` + idempotent re-run against Team-IZ-Backend (see D7).
- `scripts/_bskel-lib.sh`'s helpers (`env_upsert`, `env_append_unique`, `extract_https_url`,
  `wait_for_tunnel`) unit-tested directly, including `wait_for_tunnel` against a real local
  HTTP server standing in for ngrok's `/api/tunnels` API, and a real timeout case.
- **Bug found while writing that test**: `wait_for_tunnel`'s `curl` call had no
  `--connect-timeout`/`--max-time`, so a port that accepts a connection but never responds
  could block a single poll far longer than the caller's overall `timeout_s` budget. Added
  both flags. (A red herring on the way to finding this: the test's first attempt used
  `execFileSync` to call `curl` against an in-process `http.createServer` from the SAME Node
  process -- that hangs unconditionally regardless of the shell script's correctness, because
  `execFileSync` blocks the event loop the server needs to respond. Fixed by using the async
  `execFile` for that specific test. Worth remembering: never test a same-process mock HTTP
  server with a synchronous child-process call.)
- **Not done**: an actual live `ngrok http` invocation (ngrok CLI + a real authtoken are both
  present on this machine). Starting a real tunnel is a visible external action (a live public
  URL, under this machine's ngrok account) -- deliberately left for the user to try manually
  (`./scripts/dev-tunnel.sh` after filling in `.env`) rather than have an agent do it
  unprompted. If this needs closing later, the mock-server test above already proves the
  request/response handling is correct; what's unverified is ngrok's actual CLI behavior itself.

## D5/D6 (implemented): composite encoded handle + derived-and-registered UUID, not bare UUID PKs

**WHY**: bare UUID PKs (already present throughout Team-IZ-Backend, e.g. `Organization.orgId`)
can't address a *field*, can't dispatch a *type*, and can't *recover* history -- they're just
row identity. The handle format (`sbf1_<base64url(kind:type:uuid[:pointer])>`) extends Relay's
`base64(Type:id)` global-ID pattern with an RFC 6901 JSON Pointer for field-level addressing;
`deriveHandleUid` gives a PLAIN UUID identity for the same address (kind=r: the resource's own
uuid; kind=f: a UUIDv5 derived from type+uuid+pointer) so it can be a DB primary/foreign key
without ever needing a lookup to mint or re-derive it.
**COST**: two representations of the same identity to keep straight (the self-describing
`sbf1_...` token for transport, the plain UUID for DB keys) -- documented explicitly in both
the JS and Java codec's top comments to head off "why are there two."
**EXIT**: `deriveHandleUid`'s algorithm is isolated behind one function on each side (JS/Java);
changing it would need a migration path for already-issued handle_uids, not attempted here.

**Verified, not just designed**: `uuidv5()` matches the standard test vector
(`NAMESPACE_DNS` + `"example.com"` -&gt; `cfbff0d1-9375-5685-968c-48ce8b15ae17`, cross-checked
against Python's `uuid.uuid5` stdlib implementation) in BOTH the JS reference (`handles/codec.mjs`)
and a standalone-compiled-and-run Java version -- and, critically, the JS and Java
implementations were run side-by-side on the exact same inputs and produced byte-identical
tokens and handle_uids (see `test/handles-codec.test.mjs`). This is the actual "UUID로 짜두면
양방향" (mint a UUID, get bidirectional round-trip) property the user asked for, confirmed
across languages, not assumed.

## D-resolver-scope: `fetch()` is auto-wired to a real service method; `patchField()` is deliberately a stub

**WHY**: `fetch()` for a resource is a read-only call into an EXISTING, already-tested service
method (`bskel handles plan` locates it by finding a controller whose class name matches the
entity and a `GET {basePath}/{id}` endpoint on it, then reads the Java method name off that
endpoint) -- low risk to auto-wire. `patchField()` is NOT auto-wired, because inspecting real
update DTOs in this codebase during Phase 5 turned up THREE different partial-update
conventions in active use (some fields use `PatchField<T>` because null is meaningful; most
fields in the same DTO just treat null as "unchanged" with no wrapper; and `Organization`'s own
update DTO isn't partial at all -- `status` is `@NotNull` even when only the name changes, so a
field-level patch there means fetch-then-merge-then-resubmit). There's no way to pick the right
one from scan data alone without guessing, and a wrong guess here would silently bypass real
validation/business rules -- worse than leaving an honest `UnsupportedOperationException` stub.
**COST**: `patchField` always needs a human/agent to finish it per resource before PATCH via a
handle actually works for that resource.
**EXIT**: none needed -- this is a permanent scope boundary, not a temporary gap; document it
loudly in the generated resolver's own javadoc (done) so whoever completes it sees the three
real patterns before choosing.

**A second real bug found and fixed while testing this** (not a design decision, a mistake
caught by testing against the actual module): the first version of `findFetchOperation` used a
single shared `basePath` (`targetModule.controllers[0].basePath`) for every entity in the
module. Team-IZ-Backend's `organization` module has TWO controllers --
`OrganizationController` (`/organizations`) and `OperatorController`
(`/organizations/{organizationId}/operators`) -- and depending on scan order, `controllers[0]`
could be either one. Using the wrong controller's base path either found nothing or (in a
differently-shaped module) could match an unrelated controller's endpoint. Fixed by having each
candidate controller checked against ITS OWN base path, gated by a name-affinity check (only
consider a controller whose class name contains the entity's name) -- `test/handles-plan.test.mjs`
reproduces this exact two-controller shape as a fixture so it can't silently regress.

## D-migration-scope: `bskel handles emit` never applies its own SQL migration, and this session never opened a live DB connection

**WHY**: same rationale as D-config-patch -- Team-IZ-Backend has no Flyway/Liquibase (confirmed
by Phase 2's scan), so there is no existing "apply a migration" convention to hook into safely,
and this repo's own `CLAUDE.md` requires explicit human approval for anything touching shared
infrastructure. The migration is written to `specs/<feature_id>/handles/migration.sql` for a
human to review and run.
**COST**: the registry/snapshot tables described by that SQL do not exist anywhere yet -- a
live `fetch`/`patch`/`recover` round trip against a real database was NOT performed this
session (there is no test database available, and creating one -- even a "throwaway" one --
against Supabase wasn't done without explicit user sign-off first).
**EXIT**: once a target repo actually applies the migration, `bskel handles emit`'s output is
ready to use as-is; nothing about the generated code assumes it was verified against a live DB,
by design (the codec's correctness -- the part that doesn't need a DB -- is what was verified,
per D5/D6 above).

**What Phase 5 verification actually consisted of, concretely** (so this isn't taken as more
than it is): (1) the codec algorithm, cross-language, against a known UUIDv5 test vector and
against itself JS-vs-Java on identical inputs; (2) `bskel handles plan`'s controller/service
matching logic, via both a real-repo run (which is what surfaced the two-controller bug above)
and a fixture-based regression test; (3) **a real `./gradlew compileJava` run against
Team-IZ-Backend with all 9 generated files in place, which succeeded (BUILD SUCCESSFUL) with
zero errors** -- this is the meaningful oracle available without a live DB: does the generated
code actually compile against the real project's real classes (`OrganizationService`,
`PatchField`, Spring/Jakarta/Lombok/Hibernate versions all real, not mocked). Compiling cleanly
does NOT mean the DB-backed registry/snapshot/PATCH-via-service-layer behavior has been
exercised end-to-end; that remains unverified until a real migration is applied somewhere.

(Aside, not a design decision: compiling this required a JDK 17 toolchain, which wasn't
discoverable by Gradle on this machine even though `openjdk@17` was already installed via
Homebrew -- `/usr/libexec/java_home` doesn't see brew kegs unless linked into the standard
`JavaVirtualMachines` location. Symlinked `~/Library/Java/JavaVirtualMachines/openjdk-17.jdk` ->
the brew keg to fix this; harmless and reversible, but a real, persistent change to this
machine worth knowing about if anyone wonders why JDK 17 shows up in `java_home -V` now.)

## D-name / D-repo / D-handles / D-ngrok

User-confirmed choices, recorded in the approved plan
(`~/.claude/plans/noble-greeting-pnueli.md` as of 2026-08-15):
- **name**: `backend-skeleton` (deviates from the verb-first skill-naming convention in
  `obra-writing-skills` — intentional, user's explicit choice).
- **repo**: dedicated `popixoxipop-collab/backend-skeleton` (see D0).
- **handles endpoint**: `GET/PATCH /handles/{handle}` is exposed in production, defended only by
  per-resolver `@PreAuthorize` — not restricted to a dev/admin profile. Real security surface;
  resolver implementation quality is the entire defense. Revisit if a resolver ever ships
  without an explicit `requiredAuthority()`.
- **ngrok domain mode**: both ephemeral and reserved-domain flows are supported in one
  bootstrap script, switched by whether `NGROK_DOMAIN` is set in the environment — not
  hardcoded to one mode.
