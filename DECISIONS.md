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

**Superseded location (S1, see `D-gate-definitions` below)**: `GATE_RECOMPUTERS` as described
above lived only in `bin/bskel.mjs` — the write side. `lib/verify.mjs` (the read side) kept its
own separate `GATE_SPECS` list, and the two drifted (`stack` was in one and not the other). The
recompute functions themselves are unchanged; they now live in `lib/gate-definitions.mjs` as
`GATE_DEFINITIONS[name].recompute`, and both `bin/bskel.mjs` and `lib/verify.mjs` read from that
one place.

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

**Update (A3)**: this EXIT clause's prediction happened, via a different mechanism than it
named — not a new Java DTO-field scanner, but the OpenAPI document `--openapi-file` already reads
for A1/A2's path/body work. `contract validate` now DOES constrain `direction:"response"`/`"error"`
payloads, for `matched`/`adopted` operations with a projected schema; see
`D-openapi-response-schema` for the full design. The scope cut above still holds exactly as
described for everything else: no `--openapi-file`, or an operation that isn't matched/adopted, or
a schema that couldn't be projected, all still leave response/error fully unconstrained.

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

## D-verify: required vs. optional gates, and an opt-in real build check

**WHY**: `bskel verify --feature <id>` aggregates the same `requireGate` machinery every other
command already uses (no new gate-checking logic invented) rather than re-implementing status
checks -- `preflight`/`scan`/`contract` are REQUIRED for an overall PASS (a feature with an
unresolved collision or ungenerated contract genuinely isn't ready), `handles`/`stack` are
OPTIONAL (not every feature needs UUID handles or a stack-choice decision, so `not_run` there
must not fail verify). The `--build` flag actually invokes the detected build tool
(`./gradlew compileJava`, `mvnw compile`, or `npm run build`) rather than just checking gate
JSON -- verified against Team-IZ-Backend for both directions: a clean tree reports `[PASS]
gradle`, and a deliberately-broken Java file (one extra garbage line appended to a generated
file, reverted after) correctly reports `[FAIL] gradle` with the real compiler output attached.
**COST**: `--build` is slow (a real Gradle invocation) and requires a build tool `bskel`
recognizes; an unrecognized project type gets an honest `ran: false` rather than a false PASS
or FAIL.
**EXIT**: `detectBuildCommand` in `lib/verify.mjs` is the single place to extend for a new build
tool.

**Correction (S1/S6 hardening pass)**: "`stack` is OPTIONAL" above was the intended design from
the start, but the implementation didn't actually deliver it -- `lib/verify.mjs`'s old local
`GATE_SPECS` list simply never included `stack` at all, so `bskel verify` never queried it: a
`stack apply` could pass the gate and `bskel verify` would report nothing about it either way
(not pass, not fail, not even present in the report). Not a design change, a bug fix -- see
`D-gate-definitions` below. Separately, `checkArtifacts()`'s `handles/migration.sql` check only
ever added itself to the checks array when the file already existed, so a `handles` gate that
had passed and then had its migration.sql deleted could never be caught (the `exists: false`
outcome was structurally unreachable). Both fixed together since they're the same underlying
class of bug: `bskel verify` believed something was fine because it never actually looked.

## D-gate-definitions: one declared gate list, not a write-side list and a read-side list

**WHY**: the `stack`-missing-from-verify bug above wasn't a one-off typo -- it was the natural
consequence of the structure. `bin/bskel.mjs`'s `GATE_RECOMPUTERS` (what gets written, and how
its token is computed) and `lib/verify.mjs`'s `GATE_SPECS` (what verify reads and aggregates)
were two hand-maintained lists with no mechanism forcing them to agree. `lib/gate-definitions.mjs`
replaces both with one `GATE_DEFINITIONS` object (plus an explicit `GATE_NAMES` order array,
checked against `GATE_DEFINITIONS`' own keys by `test/gate-definitions.test.mjs`) declaring, per
gate: `scope` (`repo` or `feature`), `verifyPolicy` (`required` or `required-when-present`), and
`recompute`. `lib/gates.mjs` gained name-based wrappers (`passNamedGate`,
`awaitNamedGateDisposition`, `requireNamedGate`) so call sites in `bin/bskel.mjs` no longer
hand-assemble a gate's scope id or token inputs -- they ask for a gate by name and the definition
supplies both. `bskel gate require/force/show` also gained validation against this same list: an
unknown gate name now exits 14 with the list of real gate names, instead of `getGate` silently
returning `null` and being reported as `not_run` -- which read exactly like "a real gate that
hasn't run yet," so a typo could be waited on forever.

`verifyPolicy: required-when-present` (used by `handles`/`stack`) formalizes what "optional"
was always supposed to mean: a gate that's never run does not block `bskel verify`, but a gate
that HAS run and is `stale` or `awaiting_disposition` still blocks -- optional means "not every
feature needs this," not "once run, its correctness stops mattering." The old code's `required:
false` boolean couldn't express that distinction at all; it only ever checked `code === PASS`
against the required gates, so an optional gate's stale/awaiting status was invisible to the
overall verdict by construction (a second, independent reason `stack` staleness could never have
failed verify even after the `GATE_SPECS` omission was fixed on its own).

**COST**: one more indirection layer (`gate name -> definition -> scope/policy/recompute`)
between a call site and the actual gate primitives in `lib/gates.mjs`; a contributor unfamiliar
with the module has one more file to read before touching gate logic.
**EXIT**: `lib/gate-definitions.mjs`'s `GATE_DEFINITIONS` is the single place to register a new
gate (both `scope`/`verifyPolicy` for verify AND `recompute` for staleness detection) or change
an existing one's policy -- `bin/bskel.mjs` and `lib/verify.mjs` need no further changes to pick
it up, and `test/gate-definitions.test.mjs`'s `GATE_NAMES`-vs-`GATE_DEFINITIONS` set-equality
test fails loudly if a new gate is added to one but not the other.

**Housekeeping done alongside this (zero runtime risk)**: `schemas/state.schema.json` is
documentation only -- nothing in the codebase loads it (`lib/state.mjs` only string-compares
`parsed.schema === 'sbf.state/1'`) -- but it was out of sync with reality on two points, fixed
while `_repo` was being promoted to a first-class scope concept here: its `feature_id` pattern
rejected the literal string `"_repo"`, even though `.sbf/_repo.json` genuinely stores
`feature_id: "_repo"` for every repo-scoped gate; and its `status` enum listed `fail`/`stale`,
neither of which `lib/gates.mjs` ever writes to disk (only `pass`/`awaiting_disposition` are
ever stored -- `not_run`/`stale`/`pass (forced)` are `requireGate()`'s derived READ-time return
values, recomputed from current inputs, never persisted).

## D-contract-completeness (A5): "schema emitted" is not "complete enough to trust"

**WHY**: after S1+S6, Codex's next suggested item was distinguishing a contract that was
successfully *written* from one that's actually *usable*. `buildContract()`
(`contracts/emit.mjs`) always succeeds and always returns some object, even with zero usable
operations -- and the old `cmdContractEmit` passed the `contract` gate unconditionally,
regardless of `operation_count` or `warnings.length`.

**The scenario this isn't hypothetical about**: Team-IZ-Backend's `codeanalysis` module (1
entity, 0 controllers) reproduces it exactly. Captured against the pre-A5 code, in an isolated
worktree:
```
$ bskel contract emit --feature 001-code-analysis-baseline
wrote specs/.../001-code-analysis-baseline.schema.json -- 0 operation(s)
gate: contract -> pass
$ bskel verify --feature 001-code-analysis-baseline --json | jq .pass
true
```
Zero operations, zero warnings (the endpoint loop that would generate an unmatched-endpoint
warning never runs when there are zero controllers to loop over), gate pass, verify PASS. No
signal anywhere that anything is wrong. After A5, the same sequence: `completeness: blocked`,
one `CONTRACT_EMPTY` warning, `contract` gate `awaiting_disposition` (exit 3), `verify` FAILs.

**Repo-wide module survey** (16 Team-IZ-Backend modules, measured per-module since that's
`contract emit`'s actual unit, not a repo-wide sum): 10/15 endpoint-bearing modules already had
zero unmatched endpoints (`complete`); 5/15 (member, projectexecution, submission, curriculum,
assessment) had at least one unmatched endpoint (`partial`); `codeanalysis` had zero controllers
(`blocked`); duplicate `operationId` occurred 0/96 times anywhere in the repo. Compared against
the `scan` gate, which already blocks 15/15 modules (100%) on first contact until a human runs
`scan disposition` -- `contract`'s new default-blocking behavior for `partial` (33% of modules)
is a smaller, not larger, imposition than a mechanism this project already ships and the user
already accepted.

**Design choice: no new gate status.** Completeness (`complete`/`partial`/`blocked`) is decided
by `contracts/completeness.mjs` and stored as *data* in the gate's `evidence` -- the gate's own
status stays exactly `pass` / `awaiting_disposition`, reusing S1's existing
`VERIFY_POLICY.REQUIRED` + `awaitNamedGateDisposition` machinery unchanged.
`awaiting_disposition`'s existing meaning ("ran, produced an artifact, but needs an explicit
human decision before it's trusted downstream") already covers `partial`/`blocked` exactly --
adding a third on-disk status would have meant touching the `EXIT` enum, `requireGate()`,
`isBlockingGateResult()`, `renderVerifyReport()`, `state.schema.json`, and the exit-code table in
SKILL.md all at once, for a distinction that already had a home. `lib/verify.mjs` required zero
changes as a direct result -- `isBlockingGateResult` already treats a REQUIRED gate's non-PASS
result as blocking, so a `partial` contract propagates to `bskel verify` and `bskel handles emit`
automatically.

**`bskel contract waive`, not a config flag**: mirrors `bskel scan disposition` exactly --
warnings get stable `{code, severity, subject}` identity (`contracts/completeness.mjs`'s
`WARNING_CODES`; `subject`, not `message`, is the waiver key, since message text is expected to
get reworded over time and a prose-keyed waiver would silently stop matching), and a human
explicitly accepts specific ones into `specs/<id>/contracts/<id>.resolution.json`. **No wildcard
waivers**: `--all` expands to the exact `{code, subject}` pairs present at waive time, recorded
as individual entries -- a new unmatched endpoint added later is never silently covered by an
old `--all` (`test/contract-cli.test.mjs`'s "waiving all current unmatched endpoints does not
cover a new one added later" locks this in by literally adding a new endpoint after waiving and
confirming it re-blocks). `CONTRACT_EMPTY`/`CONTRACT_NO_MODULE` are never waivable -- a `blocked`
contract has no content for a waiver to accept; `bskel gate force contract --reason "..."`
remains the universal escape hatch, unaffected.

**Gate token now covers the resolution file** (`resolution_hash` added to `lib/gate-
definitions.mjs`'s `contract.recompute`): deleting or hand-editing a waiver must make the gate go
stale, the same way corrupting `stack.json` does for the `stack` gate. **Migration cost**: any
contract gate that was already `pass` under the old (2-input) token goes `stale` the first time
it's re-verified after this change, since `resolution_hash` is a new, previously-uncomputed
input. Acceptable -- the only real consumer so far is disposable validation worktrees, not a
long-lived shared state file.

**`lib/verify.mjs`'s `checkArtifacts()` was deliberately NOT extended** to re-derive
completeness from the contract file's content. Unlike `handles`' migration.sql (whose token does
NOT cover that file, making the artifact check the *only* defense against it going missing), the
`contract` gate's token already covers `contract_hash` directly -- any edit to the contract file
invalidates the gate on its own. Re-checking completeness in `checkArtifacts()` too would be
pure duplication, not a second line of defense.

**`schemas/feature-contract.schema.json` was dead code** (confirmed via grep: no test or command
loaded it) until this pass -- promoted to a live regression guard
(`test/contract.test.mjs`'s "an emitted contract validates against
schemas/feature-contract.schema.json"). `sbf_contract` bumped `"1"` -> `"2"` since `warnings`
changed shape from bare strings to `{code, severity, subject, message, detail}` objects (the
only in-repo consumer of that shape, `cmdContractEmit`'s warning-printing loop, was updated in
the same change).

**COST**: `bskel contract emit` now exits 3 (not 0) for ~1/3 of Team-IZ-Backend's real modules on
first run, requiring a `contract waive` step that didn't exist before A5. Judged acceptable given
the `scan` gate precedent above, and because the failure mode being closed (a feature silently
shipping with 2 of its intended 8 operations wired up, and nobody noticing because nothing said
otherwise) is exactly the class of "agent got lucky, not the tool guaranteeing correctness" bug
this whole project exists to close -- see D-pressure-test below, where a fresh agent avoided
exactly this trap on `registerCurriculum` by chance, not because anything forced it to.
**EXIT**: `contracts/completeness.mjs`'s `WARNING_CODES` table is the single place to add a new
warning code, adjust its default severity, or change whether it's waivable.

## D-openapi-reconciliation (A1): a source-annotation contract cannot see a framework-level path prefix

**WHY**: after A5, Codex's next suggested item was OpenAPI operation reconciliation, scoped to a
first vertical slice (recovering unmatched `operationId`s against a real OpenAPI document — full
request/response schema projection and live drift detection stay out of scope). Verifying that
recommendation directly, before designing anything, surfaced a bigger defect than "recover a few
unmatched endpoints": Team-IZ-Backend's `ApiPathConfig.java` applies a global `/api/v0` path
prefix to every controller in `com.bigproject.backend.domain` via
`WebMvcConfigurer.configurePathMatch`, independently confirmed by `application.yaml`'s
`springdoc.paths-to-match: /api/v0/**`. `scanners/adapters/java-spring.mjs` is a regex scanner
over `.java` source — it never reads Java config classes or YAML, so it cannot see this prefix.
**Every contract this tool had ever emitted had a wrong `path` field**, including modules already
`complete` with 100% of operationIds matched (organization: 15/15 matched, `findOrganization.path`
was `/organizations/{organizationId}` — the real, deployed path is
`/api/v0/organizations/{organizationId}`). Path correction on already-matched operations, not
unmatched-endpoint recovery, is therefore A1's primary function; recovery is secondary.

**Real OpenAPI document, not a fixture, for the "does this actually work" question**: Team-IZ-
Backend already ships `DumpSpecTest` (H2 + MockMvc against `/v3/api-docs`), so
`build/api-docs.json` reflects the real, currently-annotated API surface, not a hand-maintained
spec that can drift from source on its own. Read `SwaggerConfig.java`'s `OpenApiCustomizer`
directly before trusting operationId-exact-match as safe: it touches error schemas, security
requirements, and nullability — never operationId or path — so matching on operationId and
adopting the document's path/verb for that operation is sound.

**Resolution kind taxonomy** (`contracts/openapi.mjs`'s `reconcileModule`), one of six per
endpoint: `matched` (operationId agrees between scan and doc — path/verb corrected to the doc's
value, `provenance: 'scan+openapi'`), `adopted` (operationId recovered from the doc for a scan
endpoint the regex correlator couldn't tag — `provenance: 'openapi'`, flagged
`CONTRACT_OPENAPI_DERIVED_OPERATION_ID`, WARN, never blocks), `drift` (operationId agrees but
verb/path conflict is NOT explainable by the inferred prefix — kept at the scan's own path/verb,
fail-closed, `CONTRACT_OPENAPI_DRIFT`, ERROR), `missing` (scan's operationId isn't in the doc at
all — same fail-closed treatment, `CONTRACT_OPENAPI_MISSING_OPERATION`, ERROR), `ambiguous`
(unmatched endpoint's verb+path resolves to 2+ doc candidates — `CONTRACT_OPENAPI_AMBIGUOUS`,
ERROR), `unresolved` (no candidate at all, or prefix could not be inferred — falls through to the
pre-existing `CONTRACT_UNMATCHED_ENDPOINT`, unchanged). **`MISSING` is a separate code from
`DRIFT`**, not folded together, because a waiver is keyed on `{code, subject}` — collapsing them
would let a waiver recorded for one root cause silently cover an unrelated later failure on the
same endpoint (the same reasoning A5 used to reject wildcard `--all` waivers).

**Path-prefix inference is anchor-based, not configured by default**: for every endpoint where
scan and doc agree on operationId, `computeDelta(scanPath, docPath)` requires
`docPath.endsWith(scanPath)` and the remainder to match `PATH_PREFIX_RE`
(`^(?:\/[A-Za-z0-9._~%-]+)+$`) — segment-boundary-safe, so `/api/v0/suborganizations` can never
collapse onto `/organizations`. A single consistent delta across all anchors → `inferred`; zero or
conflicting deltas → `origin: 'none'` (no guessing). Critically, this inconclusive case only
disables *unmatched-endpoint recovery* — operations that already matched by operationId need no
prefix inference at all, they take the document's path directly. `--path-prefix` overrides
inference explicitly (`origin: 'flag'`) when a module's endpoint set is too small to anchor on
(verified live: `organization`'s 15 anchors converge on a single `/api/v0` delta with zero
conflicts).

**Repo-wide module survey** (18 Team-IZ-Backend domain packages, real `build/api-docs.json`,
isolated worktree, `--openapi-file` applied to every module): 16/18 modules resolved to
`complete` with zero unmatched operations after reconciliation (up from a pre-A1 baseline where
`member`, `projectexecution`, `submission`, `curriculum`, `assessment` were `partial`);
`curriculum` went from 3/9 matched (`partial`) to 9/9 (`complete`, 3 matched + 6 adopted, all
correctly path-corrected to `/api/v0/...`); `codeanalysis` stayed `blocked` (0 controllers — the
document has nothing relevant to adopt, confirming reconciliation doesn't pull in unrelated
operations when a module genuinely has no HTTP surface); `audit` returned 0 operations because
`--terms audit` fuzzy-matched the unrelated `auth` module by scan-scoring, not an OpenAPI
reconciliation defect. **One real, unplanned finding**: `projectexecution` stayed `partial` with
2 genuinely `unresolved` endpoints (`findProjectsByClass` at `GET /classes/{classId}/projects`,
`findActiveProjectsByClass` at `GET /classes/{classId}/active-projects`) — confirmed by grepping
`build/api-docs.json` directly that neither path exists in the document at all. This is exactly
the fail-closed design working as intended: rather than guess, A1 surfaces a real gap between
what the source annotates and what the running application actually serves (dead/disabled routes,
or an annotation ahead of a not-yet-wired handler) for a human to investigate — out of scope for
this tool to resolve on its own.

**`buildContract()` stays pure** (mirrors A5's "waiver stays external to `buildContract`"):
`contracts/openapi.mjs` does all I/O (`loadOpenApiDocument` is the only function in this slice
that reads a file) and pre-computes a `Reconciliation` object passed into `buildContract({...,
openapi})` as plain data — `openapi = null` (the default) produces byte-identical output to the
pre-A1 code, locked in by a dedicated regression test. `selectModule`/`endpointKey` were promoted
from inline logic in `contracts/emit.mjs` to exports so `openapi.mjs` can import them —
one-directional (`emit.mjs` never imports `openapi.mjs`) — rather than reimplementing module
selection a second time with a chance to drift from the original.

**Prototype-pollution surface, closed structurally**: every OpenAPI-document index in
`openapi.mjs` (`byOperationId`, `byRoute`) is a `Map`, not a plain object — `JSON.parse` can put
`__proto__` as an *own* property on a parsed object (unlike literal syntax), which a plain-object
index (`obj[k] = v`) would be vulnerable to; `Map.set` has no such path structurally.
`OPERATION_ID_RE` (`^[A-Za-z][A-Za-z0-9_.-]{0,199}$`) additionally rejects `__proto__` via its
leading-letter requirement (still allows `constructor`/`toString`, which is fine — `Map` access to
those keys is always a real, safe entry, never a prototype-chain hit). Input distrust: 16MB
document-size cap, 5000-path / 10000-operation caps, malformed JSON / non-object root / oversized
input all fail closed (`{ok:false, error}`, never throws across the module boundary) rather than
processing a truncated partial result. **Same-class fix applied elsewhere**: `bin/bskel.mjs`'s
`cmdContractToolSchema` did a plain `contract.operations[flags.operation]` lookup — the exact
shape of bug D-security-1 fixed in `contracts/validate.mjs`, missed there because at the time no
operationId could come from outside the source scan; A1 makes that no longer true (operationIds
can now be adopted from an external document), so the same `Object.hasOwn` fix was applied here
too.

**Gate token extended, not a new gate status** (same mechanism as A5's `resolution_hash`):
`lib/gate-definitions.mjs`'s `contract.recompute` gained `openapi_snapshot_hash`, covering
`specs/<id>/contracts/<id>.openapi.snapshot.json` — deleting or hand-editing the snapshot after a
`--openapi-file` emit makes the gate `stale` immediately, verified live (require → pass, delete
snapshot → stale/exit 4, restore → pass again, exact bytes). The snapshot itself is written before
`passNamedGate`/`awaitNamedGateDisposition` is called — the token reads current file state at
that call, so writing after would leave the gate itself the sole means of noticing a bad
snapshot. `null` when a feature has never used `--openapi-file` (the common case), which is a
stable input for `sha256File` and needs no special-casing. **`lib/verify.mjs` unchanged**, for the
identical reasoning D-contract-completeness gave for not extending `checkArtifacts()`: the gate
token already covers the snapshot's hash directly, so any tampering invalidates the gate on its
own — a second check would be pure duplication. **Migration cost**: any contract gate already
`pass` under the 3-input token goes `stale` on first re-verification after this change, same
acceptable cost A5 already took for `resolution_hash`.

**Snapshot content is scoped to what the feature actually used**, not a copy of the whole
document (`snapshotFromReconciliation`) — `source.file` is repo-relative when the OpenAPI file is
inside the repo, basename-only + `outside_repo: true` otherwise, to avoid baking a machine-
specific absolute path into a committed artifact.

**Known limitation, by design, out of scope for this slice**: the gate defends the snapshot
against tampering, not the *upstream* document against going stale — re-running `contract emit
--openapi-file` against a `build/api-docs.json` nobody regenerated after a real source change
will happily reconcile against outdated truth. Catching that is live drift detection, explicitly
deferred to a later item, not this one.
**EXIT**: `contracts/openapi.mjs`'s exports are the single place resolution-kind logic lives;
`contracts/completeness.mjs`'s `WARNING_CODES` table remains the single place to add/adjust an
OpenAPI-reconciliation warning code the same way it already is for every other contract warning.

**§7 addendum (implemented later, same session as A1-A3): the scanner now flags the defect it
can't fix.** Everything above defends against a global path prefix once a user already knows to
pass `--openapi-file` — nothing told a user who *doesn't* know that flag exists that the defect is
likely present. `scanners/adapters/java-spring.mjs`'s `detectGlobalPathPrefixSignals()` greps for
three independent Spring config signals, none of which the endpoint scanner (which reads one
controller file at a time) can otherwise see: (1) `WebMvcConfigurer.configurePathMatch` +
`addPathPrefix("...", ...)` — Team-IZ-Backend's own mechanism (`ApiPathConfig.java`), confirmed
live: detects `/api/v0` exactly; (2) `server.servlet.context-path` in `application.yml`/
`.properties` — Spring Boot's own built-in global-prefix mechanism, same blind spot, unused by
Team-IZ-Backend but real for other brownfield repos; (3) `springdoc.paths-to-match` — doesn't
itself apply a prefix, but a pattern narrower than `/**` is strong circumstantial evidence one is
documented, confirmed live: detects `/api/v0/**`. All three are **detection only, never a fix** —
`scanners/index.mjs`'s `runScan()` surfaces them as structured `path_prefix_signals` on the report
plus a human-readable note in `unknowns` naming the exact file(s) and pointing at
`--openapi-file`/this decision entry; nothing auto-corrects a path or infers a prefix from this
alone (that stays A1's job, and only with a real OpenAPI document as the oracle). Deliberately
Spring-only — the `generic-grep` adapter gets an empty `path_prefix_signals: []` unconditionally,
since all three signals are Spring-specific concepts with no non-Spring equivalent this tool
currently knows how to detect.

**`api_surface_source`'s dishonesty, fixed at the same time.** The field had unconditionally
claimed `'source-annotations (no committed openapi spec found)'` since Phase 2 — a scan that never
actually checked for a committed spec file, asserting a negative it never verified. Replaced with
a description of what this scan does/doesn't check (`'source-annotations only (this scan does not
check for a committed OpenAPI document -- if one is generated by the build, pass it via
--openapi-file to \`contract emit\`)'`) rather than an unverified per-repo claim — the same
"describe the method, not an unchecked fact about the repo" discipline the prefix-signal note
above follows too (it names exactly what was grepped and where, not "this repo probably has a
prefix").
**COST**: two more regex signals that can mismatch a Spring config shape this tool hasn't seen yet
(e.g. a custom `PathPatternParser` bean, `WebFluxConfigurer` instead of `WebMvcConfigurer` for a
reactive stack) — silently detects nothing rather than guessing, consistent with every other
regex-based signal in this codebase.
**EXIT**: `detectGlobalPathPrefixSignals()` in `scanners/adapters/java-spring.mjs` is the single
place to add a new signal pattern; `runScan()`'s `unknowns` note is the single place the
human-readable warning text lives.

## D-openapi-request-schema (A2): a contract that says "some object" isn't a contract

**WHY**: A1's own DECISIONS.md entry explicitly deferred "full request/response schema projection"
out of scope. Before this change, `contracts/emit.mjs`'s `detectRequestBody()` only recorded
whether an operation takes a body at all (`body: true|false|'unknown'`), and
`contracts/validate.mjs`'s `operationPayloadSchema()` turned `body:true` into a bare
`{type:'object'}` — **any object validated**, with zero field constraints. Real before/after
against Team-IZ-Backend's `createOrganization`: pre-A2, `{}`, `{dataRetentionDays:9999}`, and
`{typo:'x'}` all validated as a correct request. Post-A2, all three fail — enum, required-field,
and unknown-field-shape violations respectively are now real, caught defects, not silently passed.

**Scope**: request body only. Response/error schema projection is deliberately a separate later
item ("A3") — `schemas/agent-envelope.schema.json` has no status-code field (`properties`:
`sbf`/`feature_id`/`feature_uid`/`operation_id`/`direction`/`handles`/`payload`, nothing else), so
"which response schema does this payload validate against" is a genuine open design question
(single success status? union of all documented error shapes? add a status field to the envelope,
a breaking `sbf:'1'→'2'` change?) that deserves its own decision, not a quiet default buried in a
larger change. Confirmed with the user via `AskUserQuestion` before starting, mirroring the same
scope-narrowing instinct A1 used ("path correction is a bigger, more certain win than unmatched-
endpoint recovery — do that first").

**`matched`/`adopted` only**, same as A1's path/verb correction: `drift`/`missing`/`ambiguous`/
`unresolved` operations haven't earned trust on path/verb, so they don't get schema enrichment
either — a body shape attached to an operation whose very identity is still in question would be
worse than no shape at all.

**Full inlining, zero `$ref` in the output, for two independent reasons**: (1) Ajv would otherwise
need every one of a document's `components.schemas` registered by `$id` just to validate ONE
operation's body — Team-IZ-Backend has 308; (2) `bin/bskel.mjs`'s `cmdContractToolSchema` already
promised its `input_schema` output is "a JSON Schema subset ... directly usable as-is" for
Anthropic tool-use, which forbids `$ref`/`$defs` outright. `contracts/openapi.mjs`'s `inlineSchema`
is the one function that upholds both. A projected schema's `format:'uuid'` is rewritten to
`pattern: BARE_UUID_PATTERN` rather than copied — D-security-2 (ajv-formats' `uuid` format accepts
a `urn:uuid:` prefix Spring's binder rejects) re-applies one layer down: springdoc renders a Java
`UUID` request-body field exactly this way, and A2 is what makes that field reachable through this
codebase for the first time. `$id` is treated as an unsupported keyword outright (not copied, not
dropped) — the shared `ajv()` singleton in `contracts/validate.mjs` already has
`urn:sbf:envelope:1` registered; a projected schema carrying its own `$id` risks colliding with or
polluting that process-wide registry.

**Two risk classes new to this codebase, with real measured defenses, not guesses**: repo-wide
grep before writing any code confirmed no prior `D-security-N` fix addresses (a) unbounded
recursion from untrusted nested JSON Schema, or (b) ReDoS from a `pattern` string Ajv compiles and
matches. `inlineSchema` in `contracts/openapi.mjs` adds, for the first time in this repo:
- `MAX_SCHEMA_DEPTH = 32` — real max structural depth reachable from a request body, measured
  across all 54 real `application/json` request-body schemas in Team-IZ-Backend: **8**. 32 is 4x
  headroom, chosen to bound the JS recursion stack regardless of what a hostile document claims,
  not tuned to the measured value.
- `MAX_SCHEMA_NODES = 2000` (shared counter per top-level call, `enum` entries count toward it) —
  real max single-operation node count measured: **23**.
- `MAX_PATTERN_LENGTH = 300` — real max `pattern` length measured: **77**
  (`CreateOrganizationRequest.emailDomain`'s domain-format regex).
- Cycle detection via a `visiting` Set of component names, delete-on-exit (a diamond — two sibling
  properties referencing the SAME component — stays legal; only a true ancestor-chain cycle
  fails). Real data has zero cycles (verified via a full $ref-graph DFS over all 308 component
  schemas before writing any code), so this is pure defense-in-depth against a document this
  codebase doesn't currently see, not a fix for an observed problem.
- **ReDoS is explicitly, honestly only partially mitigated.** The 300-char cap bounds the SIZE of
  what gets compiled into a `new RegExp(...)`; it performs no structural analysis of the regex
  itself. `CreateOrganizationRequest.emailDomain`'s real, already-shipping pattern
  (`^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$`) contains a
  nested quantifier well within the 300-char cap — a general ReDoS-detection system was judged
  over-engineering for this vertical slice and was not built. Named here as an accepted residual
  risk, in the same register as this document's other honestly-flagged known limitations, rather
  than silently assumed solved.
- Java `@Pattern(regexp=...)` and JS `RegExp` are different regex dialects. `inlineSchema` catches
  the case where a Java-only construct fails to compile in JS (`invalid-pattern`, e.g. possessive
  quantifiers, `\p{Alpha}`), but NOT the case where a construct compiles in both but means
  something different — that gap is a known, documented limitation, not a silent bug.

**Keyword whitelist is a measurement output, not an input assumption.** Before writing
`inlineSchema`, a Stage-0 script measured the keyword/format histogram over exactly the 54 schemas
actually reachable from a real `requestBody.content['application/json'].schema` in Team-IZ-Backend
(not all 308 component schemas — most of those are response-only and irrelevant to this slice).
Measured keywords: `$ref`(67), `type`(202), `properties`(56), `required`(52), `enum`(17),
`items`(11), `minItems`(6), `format`(52), `minimum`(10), `maxLength`(25), `minLength`(38),
`pattern`(6), `maxItems`(1), `maximum`(3), `minProperties`(1), `oneOf`(3) — every one of these is
covered by `inlineSchema`'s `RECURSED_KEYWORDS`/`COPIED_KEYWORDS`. Measured `format` values:
`uuid`(20, rewritten), `int32`(10), `email`(7), `date`(10), `date-time`(3), `int64`(2) — all in
`SAFE_FORMATS`. `oneOf`'s 3 real occurrences (and 41 across the full 308-schema document) are
**always** the springdoc OpenAPI-3.1 nullable-object idiom, `[{"$ref":...},{"type":"null"}]` —
`inlineSchema` needs no special case for this; recursing into each `oneOf` array element handles
it for free. `anyOf`/`allOf`/`discriminator`/`patternProperties` all measured **zero** occurrences
anywhere in the 308-schema document. `additionalProperties` appears only as either a `$ref` value
(a real Java `Map<UUID,DTO>`) or a primitive-type value, never a boolean `false` on a
request-relevant schema. All 308 component-schema names passed `COMPONENT_SCHEMA_NAME_RE` with
zero rejections. Confirmed a second time end-to-end: the 18-module real survey's total
`schema_resolved` (54) plus `schema_skipped_media_type` (4, all real `multipart/form-data`
uploads) sums exactly to the Stage-0-measured request-body count — no drift between the static
measurement and the dynamic per-module run.

**`additionalProperties:false` is deliberately NEVER added to a projected body schema.** Verified
directly against Team-IZ-Backend's source before deciding this: no `spring.jackson` config in
`application.yaml`, no `@Bean ObjectMapper` anywhere in `src/main/java` — Spring Boot's default
`FAIL_ON_UNKNOWN_PROPERTIES=false` applies, so the real, deployed endpoints accept and silently
ignore unknown body fields. A contract that rejects what the real API accepts is a false negative,
not a safety improvement — it would contradict the entire reason this tool exists (the contract is
supposed to tell the truth about the real endpoint). The payload envelope's own top-level
`additionalProperties:false` (in `operationPayloadSchema`, unrelated — it governs the envelope's
`{pathParams, body}` shape, not the body's own internal fields) is unaffected.

**Prototype-pollution surface, extended to two new classes of externally-influenceable string,
both closed the same way A1 closed `operationId`**: OpenAPI component-schema names
(`COMPONENT_SCHEMA_NAME_RE`) and, inside a resolved schema, `properties` keys and `required[]`
entries (`SCHEMA_PROPERTY_NAME_RE`) — both become plain-object keys downstream
(`inlineSchema`'s output `properties` object, later `JSON.stringify`'d into the contract file and
re-`JSON.parse`'d by `loadContract`). A violating key **fails the whole schema closed**, not a
per-property drop — dropping one bad property would silently emit a schema *weaker* than the real
one, the identical reasoning behind rejecting an unsupported keyword outright rather than ignoring
it. Verified live with `JSON.parse('{"__proto__":...}')` fixtures (a JS object *literal* with a
`__proto__` key sets the prototype instead of creating an own property — a real gotcha hit while
writing this test suite, not a hypothetical; the fix was building the fixture via `JSON.parse` to
match the actual attack surface `loadOpenApiDocument` sees).

**`WARN`, not `ERROR`, for `CONTRACT_OPENAPI_SCHEMA_UNRESOLVED`** — two reasons: the pre-A2
fallback (`body:true → {type:'object'}`) is still *correct*, just less specific, so a projection
failure is a missed enhancement, not a contract defect; and making it `ERROR` would couple
`partial`/`blocked` status to how exotic a downstream DTO's validation annotations happen to be.
The 18-module real survey backs this up directly: `schema_unresolved` was **0 across every one of
the 18 real modules** — the measurement-driven whitelist (above) already covers everything real,
so this WARN path exists for defense-in-depth against an OpenAPI document this repo doesn't
currently produce, not because real modules routinely hit it.

**Dialect gate, once per document, not per operation.** OpenAPI 3.0 and JSON Schema 2020-12 (what
`Ajv2020` speaks, already a runtime dependency before A2 — see `D-ajv-runtime`) disagree on
`exclusiveMinimum` (3.0: boolean modifier of `minimum`; 2020-12: a number) and `nullable` (3.0: a
keyword; 2020-12: `type` becomes an array). Rather than silently misinterpreting a 3.0 document,
`indexOpenApiDocument` checks `/^3\.1(?:\.|$)/` against `doc.openapi` and disables schema
projection for the **whole document** if it doesn't match — path/verb reconciliation (dialect-
independent) stays fully active either way. One stderr note, not N per-operation warnings, for the
one root cause. Team-IZ-Backend's real document is `3.1.0` (confirmed), so this path is exercised
only by the dedicated test fixture, not by anything in the real survey.

**`ajv().compile()` guarded for the first time.** Before A2, every schema `contracts/validate.mjs`
compiled was 100% synthesized by this codebase, so `ajv().compile()` never threw. A2 embeds
externally-derived content, and a contract file is hand-editable on disk (the `contract` gate goes
stale, but `contract validate`/`contract tool-schema` don't consult gates) — a malformed schema
now fails with a clean `{ok:false, errors}`, not an uncaught exception.

**`sbf_contract` bumped `"2"` → `"3"`, no migration cost.** The new `requestBodySchema`/
`requestBodyRequired` operation fields are additive and optional — **omitted entirely** (not
`null`/`false`) when there's nothing to project, so `openapi:null` and any non-matched/adopted
operation stays byte-identical to pre-A2 output, the same discipline A1 established for its own
fields. Nothing in this codebase loads the meta-schema at runtime (only
`test/contract.test.mjs`'s regression guard does), so there's no live-consumer migration cost the
way A5's `resolution_hash`/A1's `openapi_snapshot_hash` gate-token additions had.

**No new gate-token field, unlike A1 and A5.** `lib/gate-definitions.mjs`'s `contract.recompute`
is unchanged (`test/gate-definitions.test.mjs`'s exact 4-key assertion —
`contract_hash, head_sha, openapi_snapshot_hash, resolution_hash` — was left untouched
deliberately, and would fail loudly if a 5th key were added by mistake). The new schema fields
live inside the contract file itself, already covered end-to-end by `contract_hash` — verified
live by hand-editing a `requestBodySchema` in a real emitted contract and watching the gate go
stale, then restoring it and watching it pass again. Contrast with A1's `openapi_snapshot_hash`
and A5's `resolution_hash`, both of which needed a new token input because they cover *separate*
files the contract's own hash doesn't reach.

**`requestBodyRequired` is recorded but never acted on.** Acting on it could only ever *loosen*
validation (the scan remains the oracle for whether an operation takes a body at all — A1's
provenance split), so a `body:false` scan verdict alongside a document that actually declares a
requestBody is a visible, deliberately un-warned disagreement in the contract file for a human to
notice — a natural candidate for a future A3 warning code, not something this slice resolves.

**COST**: larger contract files (Team-IZ-Backend's `createOrganization` operation grew from a
handful of fields to a full nested schema); a new WARN code that didn't exist before (though
measured zero occurrences in the real repo); a keyword whitelist that will need extending,
correctly failing closed with a diagnosable reason, the day a new annotation shape appears in a
DTO this whitelist hasn't seen yet.
**EXIT**: `contracts/openapi.mjs`'s `RECURSED_KEYWORDS`/`COPIED_KEYWORDS`/`DROPPED_KEYWORDS`/
`SAFE_FORMATS` constants are the single place to extend keyword/format support;
`contracts/completeness.mjs`'s `WARNING_CODES` remains the single place for severity. Response/
error schema projection is the natural next slice, gated on first resolving how `direction:
'response'|'error'` payloads map to a specific documented status code — see the envelope-schema
scope note above.

## D-openapi-response-schema (A3): the envelope question A2 deferred, answered by measurement

**WHY**: A2's own EXIT clause named this as the natural next slice, gated on resolving how
`direction:'response'|'error'` payloads map to a specific documented status code — the envelope
(`schemas/agent-envelope.schema.json`) has no status-code field. Before writing any code, the
actual Team-IZ-Backend OpenAPI document was measured directly: **every one of 142 operations
documents exactly one distinct error schema** (`{"$ref":"#/components/schemas/ErrorResponse"}` —
literally the same node, not just the same shape, on all 508 error-status response entries across
the whole document), and **125/142 operations document exactly one distinct success schema** (the
other 17 document zero — a 204-only response, or none at all). Real before/after against
`createOrganization`: pre-A3, a `direction:"response"` payload of `{}` validated for every
operation; post-A3 the same payload fails (`organizationId` required), and a `direction:"error"`
payload missing `code` now fails too. **Conclusion: no envelope change, no `sbf` bump.** A
status-code field would buy nothing measurable — error is already unambiguous regardless of
status, and success is unambiguous in every real case — so the breaking change A2 wanted to avoid
was never actually necessary.

**Same `matched`/`adopted`-only, don't-guess-on-drift discipline as A1/A2.** `drift`/`missing`/
`ambiguous`/`unresolved` operations get no `responseSchema`/`errorSchema`, same reasoning: an
operation whose own identity hasn't been confirmed against the document has no business getting a
richer body shape either.

**`anyOf`, not `oneOf`, for the (real-data-rare) multi-schema case.** A2 established that projected
schemas never carry `additionalProperties:false` (Team-IZ-Backend has no Jackson customization —
real endpoints accept and ignore unknown fields), which means two documented response shapes for
different statuses routinely *overlap* (a minimal 202/204 body is often a strict subset of the 200
body's fields). `oneOf` requires *exactly one* branch to match; verified directly against the
installed `Ajv2020` that a payload matching two overlapping branches is **rejected** by `oneOf` and
**accepted** by `anyOf`. `oneOf` would have made this feature reject real, valid API responses —
exactly the false-negative class A2 refused to introduce with `additionalProperties:false`. `anyOf`
states precisely what's true given the envelope carries no status code: "matches at least one
documented shape." (In real data this almost never fires — of the two operations with 2+ documented
2xx statuses, both `findCurrentProject`/`findCurrentSession`, the extra status either shares the
identical schema ref or has no body at all, so the distinct-shape count is 1 either way; the `anyOf`
path is defense-in-depth for a shape this specific document doesn't actually need, same posture as
A2's cycle detection.)

**Fail closed on the FIRST unresolvable schema, never union the rest.** Unlike A2 (where dropping
a bad property emits a schema *weaker* than reality, the failure mode to avoid), a partial
response/error union runs the opposite risk: a union missing one of several documented shapes is
*narrower* than reality, i.e. it would reject a real response the API actually produces. The fix
runs in the opposite direction from A2's, but the underlying principle — never emit something that
contradicts what the document says — is identical.

**Deduplication, twice, before emitting a union.** Every matching status's raw schema node is
deduplicated first by `JSON.stringify` (cheap, and collapses the overwhelmingly common case of many
statuses pointing at the literal same node — this alone is what makes "508 error responses" become
"1 resolution per operation"), then the *resolved* schemas are deduplicated again by a
`canonicalJson` (key-sorted) comparison, since two different `$ref`s occasionally resolve to
identical shapes. `canonicalJson` is deliberately array-order-sensitive, which makes the comparison
conservative: two semantically-equal schemas that differ only in array order compare as distinct,
producing an extra (still-correct) `anyOf` branch — the comparison can never falsely collapse two
genuinely different schemas into one.

**`MAX_RESPONSES_PER_OPERATION = 64`, the one new cap A3 needed.** A2 resolved at most one schema
per operation (a request body has exactly one); A3 can resolve as many as an operation documents
statuses for, so an adversarial document could declare unboundedly many. Real max observed: 9
(`submitZip`). Every other defense (`inlineSchema`'s cycle detection, `MAX_SCHEMA_DEPTH`,
`MAX_SCHEMA_NODES`, `MAX_PATTERN_LENGTH`, the keyword/format whitelist) is reused **completely
unchanged** — decisive evidence for this, not just a keyword-histogram argument like A2 needed:
every one of the 634 real response/error schema roots in the document resolves successfully through
the shipped `inlineSchema()` at the shipped caps, zero failures. That single fact is why A3 skipped
A2's Stage 0 measurement phase entirely — the hardest, riskiest part of this feature (the recursive
resolver and its defenses) was already built and already proven against exactly this input shape.

**Depth/node measurement correction, recorded honestly.** The naive keyword-histogram walker used
to scope A2 (and initially reused to scope A3) counts a `properties`/`items` container object as
its own recursion level — `inlineSchema()` itself does not. Re-measuring by binary-searching
`opts.maxDepth` against the real function: max structural depth reachable from a response is **14**
(not 21, the naive walker's number), and — re-measuring the same way on the request side —
**A2's DECISIONS.md entry recording "8" was the same naive-walker artifact; the real number is 5.**
Recorded here rather than silently editing A2's already-shipped entry: `MAX_SCHEMA_DEPTH=32` carries
2.3x headroom over the real depth-14 maximum (not the 1.5x the naive number implied), and
`MAX_SCHEMA_NODES=2000` carries 8.7x headroom over the real max node count (231, `getMy
AssessmentRounds`, vs. 23 on the request side). Both caps are left unchanged — real usage doesn't
approach either one, and there is no measured trigger to widen them; the actual defense the depth
cap provides (bounding the JS recursion stack against a hostile document) is indistinguishable at
32 vs. 64.

**Genuine `oneOf` polymorphism, resolved with zero code change.** Every one of A2's real `oneOf`
occurrences was the springdoc nullable-object idiom (`[{$ref}, {type:'null'}]`); A3's real data
includes one genuine discriminated union with no `discriminator` keyword —
`MySubmissionResponse.properties.content: oneOf: [GithubSubmissionContent, ZipSubmissionContent]`
(distinguished by which of `repoUrl`/`fileName` is present). `inlineSchema()` already recurses into
every `oneOf` array element generically, regardless of content, so this resolves correctly with the
exact code A2 shipped — confirmed live, both through a synthetic unit test and end-to-end through
the real CLI against `findMySubmission`.

**`required` flips meaning; springdoc's own `type`-omission is deliberately not corrected.** In a
request, `required` means "the client must send this"; in a response, it means "the server always
sends this" — a real, intended behavioral change (an agent-authored response/error payload that
used to validate against `{}` can now fail on a missing field). Separately, the real `ErrorResponse`
root has `properties`+`required` but **no `type` keyword at all** (springdoc's own choice) —
`inlineSchema` does not synthesize a `type:'object'` the document never stated, the same
never-add-an-undocumented-constraint rule A2 applied to `additionalProperties:false`. (JSON
Schema's `required`/`properties` are simply vacuous against a non-object payload in this case —
accepted as-is, not worked around.)

**Payload wrapper: `{body: <response>}`, not the response body directly** —
`operationPayloadSchema(opContract, direction)` returns
`{type:'object', additionalProperties:false, properties:{body: schema}, required:['body']}` for
`response`/`error`, mirroring the shape `request` already had. Rejected the simpler alternative (the
envelope's `payload` field *is* the response body, no wrapper) after direct verification that no
existing code, test, or SKILL.md text asserts any response/error payload shape — a genuinely
green-field choice either way — because the wrapper keeps a future status-code field purely
*additive* (`payload.status` as a new optional property) instead of forcing the breaking `sbf`
version bump A2 already declined once, and keeps `operationPayloadSchema`'s return shape uniform
across all three directions ("a named-parts object, `additionalProperties:false`") rather than
returning a structurally different kind of thing depending on `direction`.

**Two new WARN codes — `CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED` /
`CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED` — neither reusing nor renaming A2's
`CONTRACT_OPENAPI_SCHEMA_UNRESOLVED`.** `warningKey` is `{code, subject}` where `subject` is
always the operationId, so a shared code would let one direction's projection failure silently
cover an unrelated failure on another direction for the same operation — the exact reasoning A1
used to keep `CONTRACT_OPENAPI_DRIFT` and `CONTRACT_OPENAPI_MISSING_OPERATION` separate. Honestly
noted: today this specific collision is inert, since `evaluateResolution`/`cmdContractWaive` only
ever consider `ERROR`-severity warnings waivable, and all three of these codes are `WARN` — the
argument becomes load-bearing the moment any one of them is promoted to `ERROR` in a future slice.
The operative reasons *right now* are that `evidence.warning_codes` (surfaced on the gate record)
would otherwise be unreadable (`{CONTRACT_OPENAPI_SCHEMA_UNRESOLVED: 3}` — request, response, or
error?), that severity is set per-code globally, and that the three codes' messages are genuinely
different (A5's "one specific, actionable message per code" discipline). A2's shipped code is not
renamed to `..._REQUEST_..` — no live benefit large enough to justify a migration of a name already
in shipped tests, real gate records, and (potentially) recorded waivers. Confirmed WARN, not ERROR,
for the same two reasons A2 gave its own code: the pre-A3 unconstrained check is still *correct*,
just less specific, and 0/634 real schema roots actually fail projection, so this exists as
defense-in-depth, not because real modules routinely need it.

**No new gate-token field, the third time this reasoning has applied (A1 needed one, A5 needed
one, A2 and now A3 don't).** `lib/gate-definitions.mjs`'s `contract.recompute` is unchanged — its
`contract_hash` already covers the whole contract file, including the two new fields, so tampering
with either is caught without a dedicated token input. `test/gate-definitions.test.mjs`'s exact
4-key assertion (`contract_hash, head_sha, openapi_snapshot_hash, resolution_hash`) was left
untouched deliberately. Verified live: hand-editing a real `responseSchema` in an emitted contract
stales the gate; re-emitting restores it.

**`sbf_contract` bumped `"3"` → `"4"`, additive, no migration cost** — same reasoning as A2's `"2"`
→ `"3"` bump: the new fields are optional, omitted (not `null`) when nothing was projected, and
nothing in this codebase loads the meta-schema at runtime except the regression-guard test.

**A real bug this feature's own verification found, unrelated to the schema-projection logic
itself**: `bin/bskel.mjs`'s `cmdContractEmit` called `process.exit(...)` immediately after
`console.log(JSON.stringify(contract, ...))` for `--json` output. This was silent and harmless
through A1/A2 because no contract JSON had ever crossed roughly 64KB; A3's response/error schemas
routinely push a real module's contract (organization, member, projectexecution) well past that.
Reproduced directly during Team-IZ-Backend verification: `contract emit --json` for the real
organization module, captured via a subshell, came back truncated at **exactly 65536 bytes** — a
classic pipe-buffer-sized cutoff — while the identical command redirected to a file wrote its full,
correct length. Node does not guarantee a large asynchronous pipe write completes before
`process.exit()` forcibly tears the process down. Fixed by setting `process.exitCode` instead of
calling `process.exit()` at that one call site (the last statement in the function, with nothing
else pending in `main()`'s call path) — Node's event loop then drains (flushing the write) before
exiting on its own with the same code. Locked in with a dedicated regression test that synthesizes
a >64KB contract and confirms full, valid JSON comes back through the same `execFileSync` path the
rest of the CLI test suite uses. **Scope note (superseded, see D-process-exit-audit below)**:
`bin/bskel.mjs` has 67 `process.exit(...)` call sites in total; only this one was fixed here. A
sweep of the other 66 for the same latent risk was flagged as a legitimate future hardening item.

## D-process-exit-audit: sweeping the other 66 `process.exit(...)` call sites A3 flagged

A3's own real-world verification found one genuine pipe-truncation bug (`cmdContractEmit`, above)
and explicitly deferred a sweep of the remaining 66 call sites. That sweep found **2 more genuine
bugs, at 3 call sites**, by the same mechanism: `console.log(JSON.stringify(x))` immediately
followed by `process.exit()`, where Node does not guarantee a large async pipe write completes
before a forced exit tears the process down.

**`cmdScan`, both exit points** (the ad-hoc no-`--feature` branch and the `--feature` tail exit):
reproduced live against the real Team-IZ-Backend checkout (main worktree, read-only ad-hoc mode --
no files written, no git state touched), `scan --terms a --json` (a deliberately broad term
matching 16 real modules) is a correct 177583-byte report that a piped capture truncated at
exactly 65536 bytes before the fix, and came back complete after it.

**`cmdContractValidate`**: reproduced live in an isolated worktree, a validation failure against a
schema-rich A2/A3 contract can make ajv's `allErrors: true` produce a very large `errors` array --
5000 wrong-typed array elements against the real `registerTrainees` contract produced a correct
243926-byte result, truncated at exactly 65536 bytes before the fix, complete after it.

Both fixes follow the same `process.exitCode =` pattern as `cmdContractEmit`, with one added
correctness wrinkle the first fix didn't need to handle: **`process.exitCode = X` does not stop
execution the way `process.exit(X)` does.** `cmdContractValidate`'s exit is the true last statement
in its function, so a direct swap was safe. `cmdScan`'s ad-hoc-branch exit is a **guard clause** --
more code follows below it for the `--feature` path -- so the swap there required adding an
explicit `return;` immediately after, or execution would have incorrectly fallen through into the
`--feature` write path on every ad-hoc invocation. Both regression tests for `cmdScan`
(`test/scan-cli.test.mjs`) assert on this directly: the ad-hoc test additionally checks that
`specs/`/`.sbf/` were NOT written, which would only be true if the `return` is actually there.

**The rest of the 65 remaining call sites were examined and left unchanged**, each for a
specifically checked reason, not by assumption:
- `cmdGateRequire`/`cmdGateForce`/`cmdContractToolSchema`/`cmdContractWaive`/`cmdHandlesPlan`/
  `cmdHandlesEmit`/`cmdStackApply` -- measured real output sizes against real Team-IZ-Backend
  fixtures (schema-rich where applicable): all well under 2KB, nowhere close to the 64KB boundary.
- `cmdGateShow`'s no-`--feature` branch was the one candidate that looked risky by reasoning alone
  (a repo-wide state dump that could plausibly grow with feature count) -- checked against
  `lib/state.mjs`'s actual `loadState(repoRoot, featureId)` before including it, and confirmed
  state is one file per feature/scope, never aggregated across features. Genuinely bounded, not
  excluded on a guess.
- `cmdVerify` -- `lib/verify.mjs`'s `runBuildCheck()` already caps failure output to the last 30
  lines, and its `gates`/`artifacts` arrays are bounded by the fixed 5-gate count.
- `cmdPreflight`, `cmdFeatureInit`, `cmdScanDisposition`, `cmdDoctor`, all `usage()`-then-exit
  dispatch paths in `main()`, and every simple `console.error('usage: ...')` guard clause
  throughout -- trivially small or fixed-size output regardless of repo content.

**COST**: none beyond the two fixes themselves -- no interface change, no new gate-token field, no
new WARN code (this is a CLI-transport bug fix, not a contract/schema behavior change).
**EXIT**: if a future `process.exit(...)` call site's output genuinely starts scaling with repo/
contract content (a new command, or an existing one whose output shape changes), the same
live-reproduction-via-pipe technique used here is the right way to check it before assuming safety.

**COST**: contract files for schema-rich modules are now substantially larger (Team-IZ-Backend's
`createOrganization` operation gained a ~20-field response schema and a shared ~7-field error
schema); the `required`-flips-meaning behavioral change is real and could surprise an agent that
previously got away with an incomplete response payload; the same keyword-whitelist-extension COST
A2 already accepted applies here too, though 0/634 real occurrences suggests it's a smaller
practical risk on the response side than it was for requests.
**EXIT**: the response/error status-mapping question this entry answers is specific to Team-IZ-
Backend's *current* document shape (a single shared error schema, near-uniform single-success-status
operations) — if a future document has genuinely per-status-varying error bodies or routine
multi-schema successes, the `anyOf` union path (already built, just rarely exercised today) is what
absorbs that without further design work. `contracts/openapi.mjs`'s `projectResponseSchemas`/
`applyResponseSchemas` are the single place this logic lives.

## D-pressure-test: the real Phase 6 oracle was a fresh agent, not another self-review

**WHY**: the whole project exists because the original Spec Kit trial showed "the agent
happened to behave correctly" isn't the same as "the tool guarantees correct behavior." Every
prior phase's oracle was ME (with full session context) re-testing my own code -- useful for
catching implementation bugs, but it can't test whether `SKILL.md` alone, read cold by an agent
with zero memory of this build process, actually produces the gated workflow instead of getting
skipped or hand-waved. So Phase 6's actual verification step was dispatching a genuinely fresh
`general-purpose` agent with only a pointer to `SKILL.md` and a deliberately underspecified task
(scaffold a contract for the `curriculum` module -- untouched by any prior phase -- with the
exact `bskel` command sequence and the target feature scope both withheld on purpose).

**What it actually did, independently re-verified against the files it left behind (not just
its self-report)**: `doctor` -> `preflight` (PASS) -> `feature init --slug curriculum-material`
-> `scan --feature 001-curriculum-material` (verdict `collision`, gate `awaiting_disposition`,
exit 3 -- it hit the block) -> `scan disposition --mode extend` (gate flips to `pass`) ->
`contract emit` -> `contract validate` (tried both a correct and a deliberately-broken
envelope). Gate state (`.sbf/001-curriculum-material.json`) and the emitted contract
(`specs/001-curriculum-material/contracts/...json`) were read directly after the agent
finished and matched its report exactly: `scan:pass, contract:pass`, 2 operations
(`findCurriculum`, `findOrganizationCurricula`) with 6 warnings for the endpoints the regex
scanner couldn't correlate an operationId for (including `registerCurriculum`).

**The load-bearing finding**: faced with that scan gap, the agent did NOT hand-write
`registerCurriculum` into the contract to "complete" it, and did NOT fake `/speckit.specify`
output when it found spec-kit wasn't installed -- it let the tool's own honest limitation stand
and reported it as such. It also independently noticed the local `develop` ref was ~310 commits
stale and branched its worktree off `origin/develop` explicitly instead -- the exact failure
mode that started this whole project (the `EnterWorktree` bug in the original Spec Kit trial),
avoided on its own, unprompted. This is the actual evidence that hard gates (not agent luck)
are doing the work: a completely fresh agent, given no command sequence, produced correct,
honest, non-fabricated behavior because the gates and the scan's explicit warnings forced it to.
**COST**: one real agent-hour-ish of tokens for a test that, by construction, can't be
fully scripted/automated the way the rest of this test suite is.
**EXIT**: re-run this kind of pressure test whenever `SKILL.md`'s workflow section changes
significantly -- it's checking the DOCUMENT's clarity as much as the code's correctness.

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

## Security hardening pass (Codex review)

**WHY**: v1.0.0 was built and pressure-tested (see D-pressure-test above) for whether the
*intended* workflow gets followed by a cold agent, not for whether the tool is safe against an
*adversarial* one — different question. Asked Codex to review the whole codebase independently,
security-only lens (no context from this build process). It returned 8 findings with file:line
citations and, for several, an actual reproducing payload — re-verified each by reading the
cited code directly before touching anything, then fixed all 8 plus 3 lower-priority items from
its "other things worth checking" pass, in the order below. Each fix has an inline `D-security-N`
comment at its exact location; this section is the index, not a duplicate of the reasoning.

1. **`contracts/validate.mjs` — prototype chain lookup** (Low). `contract.operations[operation_id]`
   on a plain object let `operation_id: "constructor"` resolve to an inherited property instead
   of correctly failing "unknown operation". Fixed with `Object.hasOwn`.
2. **`contracts/emit.mjs` — `urn:uuid:` accepted by generated path-param schemas** (Low). ajv's
   `format: "uuid"` accepts the URN form; Spring's `UUID` path-variable binder does not — a
   generated contract could describe an input shape the real endpoint would 400 on. Fixed by
   emitting a `pattern` (bare UUID regex) instead of `format: "uuid"`.
3. **`bin/bskel.mjs` — `gate require/force/show` skipped `--feature` validation** (Low, path
   traversal). Every other feature-scoped command validated `--feature` through
   `requireValidFeatureId`; these three didn't, so `--feature ../../evil` could read/write state
   outside `.sbf/`. Fixed with `requireValidFeatureOrRepoId` (`lib/featureid.mjs`).
4. **`stack/apply.mjs` — catalog entry paths were unvalidated** (Medium). `--choice` went
   straight into a path join with no shape check, and a catalog YAML's own `template`/`path`
   fields had no containment check at all — a malicious catalog entry could write outside the
   target repo. Fixed with a `choiceId` regex, ajv validation against
   `schemas/stack-choice.schema.json`, and `assertContained()` on every resolved path.
5. **`stack/bootstrap/_lib.sh` + `ngrok.sh` — predictable temp files, silent permission
   downgrade** (Medium). `env_upsert`'s swap file was `${file}.$$` (PID-based, guessable) and the
   `mv` from it silently dropped `.env` to the process umask instead of keeping 0600; `ngrok.sh`'s
   log file had the same PID-based naming. Fixed with `mktemp` in both places plus an
   unconditional `chmod 600` after every `env_upsert` write.
6. **`stack/apply.mjs` `planApply()` — dry-run read the target repo's `.env`** (boundary
   violation, not a leak — nothing from it was ever printed). Violated this project's own D8 and
   the target repo's CLAUDE.md rule that the agent never reads/edits `.env`. Fixed by deciding
   `alreadyDetected` from `detect.files` alone.
7. **`handles/plan.mjs` `findRequiredAuthority()` — wrong method's `@PreAuthorize`** (Medium). Took
   the file's FIRST `@PreAuthorize(hasRole(...))` match regardless of which method the resolver
   was actually being generated for — a controller whose first-declared method carries a weaker
   role than the fetch method being planned would silently wire the resolver to that weaker role.
   Fixed by searching the region between the previous method's mapping annotation and the target
   method's (method-level first, class-level only as a genuine fallback), and by failing closed to
   `TODO_ROLE` (not silently falling back) when an `@PreAuthorize` is present but not the simple
   `hasRole('X')` shape this regex scanner understands.
8. **`handles/plan.mjs` — service method argument count was never checked** (Medium, IDOR-shaped).
   `ResourceResolverStub.java.tmpl`'s `fetch()` always calls the service method with exactly one
   argument (the resource UUID) by construction. A service method actually requiring more (e.g.
   anything scoped under an organization/cohort) would either fail to compile or, worse, silently
   call a same-named single-arg overload and drop the scoping argument. Fixed with
   `countServiceMethodParams()`; a mismatch (including "method not found at all") now sets
   `willGenerateResolver: false` with an explanatory note instead of generating.
9. **`HandleController.java.tmpl` `recover()` — handle type confusion** (the most severe finding).
   `recover()` checked the resolver's `requiredAuthority()` for the attacker-controlled `type`,
   but then looked up snapshot history purely by `handleUid` — and `kind=r`'s derivation returns
   the resource UUID verbatim, with no type binding baked in. An attacker who named a real but
   weaker-privileged resolver type sharing the same UUID as a more sensitive resource could
   recover that resource's snapshot history under the weaker role. Fixed by looking up the
   `HandleRegistry` row for the derived `handleUid` and requiring `resourceType`/`kind`/`pointer`
   to exactly match the decoded token AND the row not be revoked, 404ing (without saying which
   check failed) on any mismatch — before any snapshot query runs.
10. **Three defensive-hardening items** from Codex's broader pass, all low severity but cheap:
    no upper bound on handle token length before decoding (added a 2048-char cap, both sides);
    Node's `Buffer.from(str, 'base64')` silently ignores out-of-alphabet characters where Java's
    decoder throws, so the "JS/Java byte-identical behavior" claim (D5/D6) didn't actually hold
    for malformed input (added an explicit charset check to the JS side); `encodeHandle`/`encode`
    only validated "kind=f requires a pointer", not the symmetric "non-f must not carry one" (now
    both are checked), and `patch()` inferred "field handle" from pointer-presence alone rather
    than checking `kind` explicitly (now it checks kind first).

**COST**: none of these were caught by the Phase 1–6 pressure tests, because those tested
*intended-workflow* correctness, not adversarial input — a reminder that a cooperative-agent
oracle and a security review are answering different questions and neither substitutes for the
other.
**EXIT**: re-run an independent security-focused review after any change that touches
`contracts/`, `stack/apply.mjs`'s path handling, or the `handles/` codec/resolver-generation
path — those are exactly the modules this pass found issues in.
