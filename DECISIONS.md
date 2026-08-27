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

**Update (2026-08-24, real dogfooding, Phase 3, Team-IZ/Backend)**: this module's own
`classifyContract()` never looked at A1 §7's `path_prefix_signals` at all -- only `contract
export` (D-openapi-export, A6, below) did, via `unreflectedPathPrefixes()`. A real Codex-run
dogfooding pass against the real `organization` module (which genuinely has an unaddressed
`/api/v0` prefix) surfaced that this let a contract with wrong paths classify as `complete` --
`contract export` still caught it before publishing, but the contract's own completeness verdict
was misleadingly clean before that point. Fixed by adding `CONTRACT_UNREFLECTED_PATH_PREFIX`
(ERROR, waivable -- same severity class as `CONTRACT_OPENAPI_DRIFT`, for the same "a wrong path is
a correctness defect, not a missed enhancement" reason) to `WARNING_CODES`, and having
`contracts/emit.mjs`'s `buildContract()` call the SAME `pathPrefixCandidates()`/
`unreflectedPathPrefixes()` functions A6 already had (contracts/export.mjs), rather than
re-deriving prefix detection. Runs against the final `operations` (post-reconciliation, if any),
not gated on `!openapi`, for the same "a partially-corrected contract is the dangerous mixed case"
reason A6's own guard already cared about. Real consequence: the real `organization` module's
smoke test (`test/contract.test.mjs`) now correctly asserts `partial` with exactly this one
warning, where it previously (wrongly) asserted `complete`/zero-warnings -- that assertion was
itself encoding the bug. `test/contract-fixture.test.mjs`'s frozen fixture (which mirrors the real
`/api/v0` setup) updated identically. `test/contract-export.test.mjs`'s refusal test restructured:
`contract emit` now blocks (exit 3, `awaiting_disposition`) before `contract export` is even
reached in the un-waived case; a waiver demonstrates defense-in-depth -- `contract export`'s own
guard does not trust an upstream completeness waiver and still refuses without `--allow-unprefixed`.
Tests 840 -> 841 (net; three updated in place, one new). See D-openapi-export below for the
companion `--path-prefix` fix from the same dogfooding pass.

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
   violation, not a leak — nothing from it was ever printed). Violated this project's own
   convention and the target repo's CLAUDE.md rule that the agent never reads/edits `.env`
   (this item is itself `D-security-6`, referenced elsewhere in this codebase by that label — see
   `stack/apply.mjs`'s inline comment). Fixed by deciding `alreadyDetected` from `detect.files`
   alone.
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

## D-catalog-recovery: the Codex enhancement-idea catalog was never lost, only its resume path was

The full A1-A5/G1-G4/D1-D6/S1-S6/P1-P4/O1-O6 enhancement catalog (Top 5 + 29 items) that a Codex
consultation produced on 2026-08-15 was originally only ever delivered as conversational output,
never written to a file in this repo -- so when a later session's attempt to resume that same
Codex thread failed (`"No previous Codex task thread was found"`), the catalog appeared permanently
lost, and A2/A3 (this repo's own labels) ended up being planned from independent, freshly-derived
Codex consultations whose "A2"/"A3" do NOT correspond to this original catalog's A2/A3.

**It was not actually lost.** Codex CLI persists every session's full transcript to disk regardless
of whether Claude's own `--resume-last`/thread bookkeeping can still reach it --
`~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<session-id>.jsonl`. The original
catalog's `session_index.jsonl` entry (id `01a005a4-7d8f-7ac2-a4f6-255e967e76c7`) pointed straight
at its rollout file; the `role: "assistant"` `response_item` containing the full catalog text was
still there, byte-for-byte, on 2026-08-16. Recovered and committed verbatim to `CATALOG.md`, with
a label-correspondence table documenting which of this repo's own A1-A5 (and S1/S6) actually match
the original catalog's same-numbered items and which don't.
**WHY this matters going forward**: "no previous thread found" is a claim about Claude's/the
wrapper's resume bookkeeping, not about whether the content exists. Before treating any past Codex
consultation as unrecoverable, check `~/.codex/sessions/` for a rollout file under that session ID
first.
**COST**: none -- this was pure recovery, no design change.
**EXIT**: `CATALOG.md` at the repo root is now the durable source for this catalog. Recurrence is
also addressed outside this repo: a global Claude Code hook
(`~/.claude/hooks/scripts/codex-consult-persist.py`, PostToolUse on `Agent`/`Bash`) now appends
every Codex consultation's prompt/result to `~/.claude/hooks/logs/codex-consultations.jsonl` the
moment it completes, so a future consultation's content no longer depends on `--resume-last`
staying reachable.

## D-handles-ownership (O2): generated files have owners, and a diverged file is never overwritten without an audited reason

**WHY**: `emitHandles()` wrote every generated file (`global/handle/*.java`,
`domain/<module>/infrastructure/<Type>Resolver.java`) with a bare `fs.writeFileSync`, no
existence or diff check at all. Rerunning `handles emit` (e.g. after changing `--module`/
`--resource`, or after a controller/service refactor) erased a hand-completed `patchField()` --
the one part of a resolver `D-resolver-scope` *requires* a human to write -- with zero warning.
A second feature generating a resolver for the same resource type silently took over the file the
same way. And a case this repo's own code surfaced that the original catalog entry didn't call
out: `willGenerateResolver` is recomputed live from source on every run (`handles/plan.mjs:183`),
so a service-signature change can flip it to `false` for a resource that already has a completed,
hand-edited resolver on disk -- `emit.mjs`'s `if (!resource.willGenerateResolver) continue;` meant
that file was never even mentioned in `written`, just silently orphaned.

Safety here is **content-derived, not manifest-derived**. A new repo-scoped manifest
(`.sbf/handles-manifest.json`, `lib/handles-manifest.mjs`) records the hash of what backend-
skeleton actually wrote for each generated file, so a rerun can tell "untouched since generation"
(safe to regenerate) from "diverged" (a human, or something else, touched it -- refuse). But the
manifest's *absence* (a fresh checkout, CI, or a repo that doesn't commit `.sbf/`) is never treated
as evidence of anything: `classifyFile()`'s adoption path falls back to comparing disk content
against a pristine render, and a mismatch there can only ever produce a **conflict**, never a
silent overwrite. The manifest is an optimization that reduces false-positive conflicts; it is not
what makes the tool safe.

The single biggest correctness catch from planning, not in the original catalog text: every
resolver template bakes in `{{FEATURE_ID}}` (`ResourceResolverStub.java.tmpl:11`, the only one of
the 9 templates that does), while the 7 infra templates take only `{{BASE_PACKAGE}}` and are
therefore feature-independent. A naive "does disk content match a fresh render" adoption check
would make every second feature touching an already-generated resource type produce a guaranteed
false CONFLICT -- exactly the cross-feature case this feature exists to make safe, turned into
constant friction instead. Fixed by recovering the original owner from the resolver's own javadoc
marker (`Generated by backend-skeleton (...) for feature (.+?)\.`) and re-rendering with THAT id
for the pristine-content comparison; the captured value is only ever used in a string comparison,
never a path, so there's no traversal surface (same class as `D-security-3`).

**Regenerate when provably untouched, not "create once."** Codex's original suggestion was to
generate resolver stubs once and never touch them again. Rejected: `requiredAuthority()` is also
re-derived live from the controller's `@PreAuthorize` every run (`D-security-7`), and "once" would
let a resolver's enforced role silently go stale after a legitimate authorization change on the
controller -- a security regression, not just staleness. `classifyFile()` returns `'update'`
(not `'unchanged'`) whenever a provably-untouched file's fresh render differs from what's on disk,
so template upgrades and `@PreAuthorize` changes propagate automatically -- and this can only ever
apply to a file with NO human edits, by construction (a human edit moves the disk hash away from
the manifest's recorded hash, which routes to `'conflict'` instead).

Infra is repo-owned and treated as **one coherent unit, all-or-nothing**: `HandleCodec.java.tmpl`
itself says "Do not hand-edit -- change the source template and regenerate, or the JS/Java
implementations will silently diverge," so a half-upgraded infra set (6 of 7 files on a new
template version, 1 stuck on an old one because it happened to conflict) is worse than either
extreme. Resolvers are feature-owned and **independent per file** -- deliberately the opposite
choice, because all-or-nothing there would mean one hand-finished `patchField()` blocks every
OTHER resolver in the same `handles emit` call from ever being (re)generated, pushing a user
toward a blanket `--force` just to make progress. That's a safety argument, not just an
ergonomics one: partial writes keep the incentive gradient pointing at the narrow, audited
`--force --reason <path-scoped-by---resource>` action instead of a wide one.

`--force --reason "..."` (mirrors `cmdContractWaive`'s `--reason` requirement) overwrites only
conflicts found within the current invocation's own scope (`--feature`/`--module`/`--resource`
already narrow it -- no separate per-file flag needed). One extra guard: `--force` refuses any
target with uncommitted or untracked changes (`git status --porcelain -- <path>`), because a
`--force` overwrite is only actually *recoverable* if the content it destroys is already in git
history. Any conflict -- even a single resolver's, with infra and every other resolver written
fine -- blocks the `handles` gate from passing this run; partial writes happen, but the gate does
not silently treat them as complete.

**Orphan detection** (a resolver the current plan no longer generates) warns and never touches the
file, matching `D-migration-scope`/`D-config-patch`'s existing bias: this tool doesn't mutate what
it can't prove is safe, and an orphaned resolver may hold a completed `patchField()` -- deleting it
would be exactly the failure this whole feature exists to prevent. **Suppressed entirely when
`--resource` scopes the run**, or every resource outside the filter would report as a false
orphan.

**COST**: a new repo-scoped state file (`.sbf/handles-manifest.json`) whose absence produces
conservative false-positive conflicts, never false overwrites -- when it's missing (fresh clone,
CI, or a repo that ignores `.sbf/`) a legitimate `@PreAuthorize`/template-version drift on an
otherwise-untouched file can present as a conflict requiring one `--force --reason` to clear, since
there's no recorded hash to prove "untouched" without re-deriving it from the file's own content.
A new CLI exit code (`15`, ownership conflict) that any script driving this CLI must learn.
Resolver adoption depends on the javadoc marker line surviving byte-for-byte; a reformatter that
reflows it turns adoption into a conflict (still safe, just noisier).
**EXIT**: a real three-way merge (keep a human's `patchField()` edits AND propagate an authority
change) is deferred on purpose -- it needs the file's *base content*, not a hash, which is why the
manifest deliberately has no `last_seen_hash` field; adding one without a shadow-copy mechanism to
diff against would be dead weight. If ever wanted, it's a separate, larger design. Pruning
orphaned resolvers, if ever wanted, belongs in a new explicit verb (`bskel handles prune --feature
<id> --reason "..."`), never a flag on `emit`. The `handles` gate token is deliberately **left
unchanged** by this feature (still just `head_sha` + `contract_hash`) -- hashing generated files
into it would make every intended human edit to `patchField()` report the gate `stale` and fail
`bskel verify`, which is exactly backwards for a workflow where hand-editing that method is the
point. The manifest's `generated_hash` set is, however, exactly the per-file input a future Gate
Engine v2 (catalog item `S2`) would need for handles' own partial invalidation -- this feature
builds it as a side effect without committing to using it that way yet.

**A real bug this feature's own verification found, unrelated to the ownership logic itself**:
the CLI's "`--force` had no effect" note originally keyed off `conflicts.length === 0` after
`emitHandles()` returned -- but a successfully force-resolved conflict is REMOVED from
`conflicts` (it's no longer blocking), so that check was also true right after a real,
effectful `--force` run, misreporting "no effect" when a file had in fact just been overwritten.
Reproduced live against Team-IZ-Backend's real `OrganizationResolver.java`: a genuine
force-overwrite printed `--force had no effect: 0 conflicts found`. Fixed by adding a dedicated
`forced` array to `emitHandles()`'s return value, populated only at the point a conflict is
actually overwritten -- the CLI now checks `forced.length`, not `conflicts.length`, to tell "force
had nothing to resolve" from "force resolved N things." Locked in with a regression test
(`test/handles-ownership-cli.test.mjs`, "(d)") asserting the JSON `forced` array and the correct
note text, plus a sibling test ("(d-1)") for the genuine zero-conflict no-op case.

## D-generic-grep-reconnaissance (G3): a route-pattern grep is evidence, not a verdict

**WHY**: `scanGenericGrep()` (the non-Java fallback scanner) is real-project safety-net code, not
a target adapter -- it's regex over route-declaration syntax, with no operationId, no real
parser, and no way to distinguish a genuine route from a string that merely looks like one.
Codex's original concern ("the current workflow can nevertheless resolve the scan and pass an
empty contract") turned out to be **stale at the contract stage**: `contracts/completeness.mjs`'s
`classifyContract()` already makes a zero-operation contract unconditionally `blocked` (not
waivable, only `gate force`-able) regardless of *why* it has zero operations, and every
generic-grep endpoint has `operationId: null` by construction, so it always hits that path. The
real gap this entry closes is one level earlier: `bin/bskel.mjs` never referenced `confidence` or
`adapter` anywhere (confirmed by grep across all ~1000 lines) -- a low-confidence scan's verdict
(including `greenfield`, which auto-passes the `scan` gate) was acted on with zero
confidence-awareness, and `scan disposition`'s reuse/extend/replace/parallel judgment call was
made without any forcing function requiring the human to have actually registered that the
evidence behind it was regex noise.

Two concrete bugs found while implementing the "add file/line evidence and route prefixes" half
of this item, neither in the original catalog text:
1. **Score inflation from route count, not module relevance**. `scanGenericGrep()` turned every
   matched *route* into its own separate fake "controller" object. `scoreModule()`'s className
   match (+10 for module name is separate, but the +6 controller-className rule) then got counted
   once per route instead of once per source file -- a file with 50 Express routes could score
   300 on the term "express" alone, nothing to do with whether that file is actually related to
   the searched module. Fixed by grouping matched routes by source file (the natural code-module
   boundary for this adapter, playing the same role a controller class plays for java-spring)
   before scoring, with `basePath` computed as the real segment-aware shared path prefix across
   that file's routes (not one route's own full path standing in for the whole file).
2. **express-router/fastapi regex overlap, found while writing the grouping fix**: `router\.(get
   |...)\(` (express-router) and `@router\.(get|...)\(` (fastapi) share the bare `router.get(`
   substring with no anchor between them, so every FastAPI route matched BOTH patterns and was
   silently double-counted (once tagged `express-router`, once `fastapi`) -- invisible before this
   change because each route was already its own separate entry either way, but became an
   obviously duplicated pair of endpoints once grouped by file. Fixed with a `(?<!@)` negative
   lookbehind on the express-router pattern.

Also fixed as genuinely cheap, per the catalog's own framing: `verb: '?'` was hardcoded even
though 3 of the 4 route patterns (express, express-router, fastapi) already capture the HTTP verb
in a regex group and simply discarded it; and file/line evidence (`endpoints[].line`) was added
via a straightforward byte-offset-to-line-number walk, since `matchAll()` already returns the
match index for free.

**`--accept-low-confidence`** (new flag on `bskel scan --feature <id>`): when `confidence ===
'low'`, blocks (new exit code `16`) before writing `specs/<id>/brownfield-scan.{json,md}` or
touching the `scan` gate at all, regardless of verdict -- the report is still printed so the
human/agent can see what triggered the block. Ad-hoc mode (`bskel scan --terms ...` without
`--feature`) is unaffected: it was already read-only and gate-untouched, so there is nothing for
this flag to protect there.

**What was deliberately NOT done**: per-route or per-framework confidence scoring. There is no
real corpus of non-Java target repos analogous to what Team-IZ-Backend provides for java-spring,
so any confidence tier finer than the existing flat `'low'` would be an unmeasured guess -- this
project's own Data-First Numerics convention (no invented thresholds without data to calibrate
them) rules that out until a real target repo exists to measure against. Flask's `methods=[...]`
kwarg is also not parsed (verb stays `'?'` for `@app.route(...)`) -- doing so safely needs actual
argument parsing, not a cheap regex tweak like the other three frameworks' verb extraction was.
Module inference (grouping generic-grep's routes into real domain modules the way java-spring
infers `organization`/`member`/etc.) is explicitly out of scope -- G3's own text says to keep this
adapter reconnaissance-only, not to grow it into a second real adapter (that's G1/G2's territory).

**COST**: a repo whose real backend genuinely lives behind Express/Flask/FastAPI now requires an
extra `--accept-low-confidence` flag on every `--feature`-scoped scan, forever (there is no
"upgrade path" to high confidence for a non-Java repo short of building a real adapter). New test
infrastructure (`test/generic-grep-cli.test.mjs`) had to be built from scratch -- no existing
fixture-building helper for a non-Java repo existed anywhere in `test/`.
**EXIT**: if a real non-Java target repo (a G2-class FastAPI adapter's future oracle, or any
other) becomes available, the per-framework confidence tiers this entry deliberately withheld
could be measured and added then, following the same "measure the real target, whitelist from the
measurement" discipline A2's `inlineSchema()` keyword whitelist used.

## D-gate-precision (S2, partial): a stale gate says which input moved; only the gate whose inputs are actually enumerable hashes them

**WHY** -- three separate problems, closed with three different mechanisms because they're not
actually the same problem:

1. **`requireGate()` compared two sha256 strings and had no way to say more than "stale".** Once
   both sides of a comparison are hashed down to one `sha256:...` string, there is nothing left to
   diff -- "report exactly which input changed" needed the pre-hash inputs stored somewhere, not a
   new flag. Fixed structurally: `passGate`/`awaitDispositionGate`/`forceGate` now persist
   `inputs: sortKeysDeep(inputs)` alongside `token`, and `requireGate()`'s stale branch calls a new
   `explainStaleness()` that diffs `record.inputs` against `currentInputs` key by key
   (`lib/gates.mjs`'s `diffInputs()`) and returns `changed_inputs`/`stale_reason`. This applies to
   all five gates immediately, with **zero change to what any gate currently hashes** -- pure
   diagnostic upgrade. A gate record written before this shipped has no `inputs` to diff against;
   `requireGate()` reports it `stale_reason: "no_recorded_inputs"` -- still definitively stale
   (never a false pass), just honest that the reason is unavailable. The next real re-run of the
   underlying command writes a record with `inputs`, so this self-heals; no migration, no
   retroactive snapshot (a fabricated one would only fail the `RECORDED_INPUTS_MISMATCH` integrity
   check this same mechanism adds -- `computeToken(record.inputs) === record.token` is now a total
   invariant over every record this module writes, and a record that fails it, e.g. hand-edited
   `.sbf` state, is reported as an integrity failure rather than diffed as if it were trustworthy).

2. **`stack`'s token hashed only `.sbf/stack.json`'s own bytes, while the comment directly above
   the old `recompute()` claimed "the applied files ... are gone/changed" was covered.** It wasn't
   -- `stack.json`'s `applied_files` was a bare array of path strings, never a hash. Deleting or
   editing `scripts/dev-tunnel.sh` after `stack apply` left the gate `pass` forever. Fixed at the
   token level (not an existence check, unlike (3) below): `stack`'s `recompute()` now hashes every
   file in `applied_files`, flattened into `applied_file:<relpath>` keys (so `diffInputs()` can name
   the exact file). `head_sha` was deliberately **dropped** from this one gate -- its input set is
   now precisely enumerated on disk, so a repo-wide "something, somewhere, moved" proxy adds nothing
   except staling the gate on every unrelated commit. This is the one gate in this slice where the
   catalog's full "unrelated commits stale every feature" complaint is completely closed, not just
   diagnosed.

   Designing this exposed a real, previously-harmless bug: `cmdStackApply` stored
   `applied_files: written`, and `applyPlan()` (`stack/apply.mjs`) returns only files it actually
   wrote *this run* (it skips `action: 'unchanged'`) -- so a second, idempotent `stack apply
   --apply` silently overwrote `applied_files` with `[]`, erasing the record of what the choice
   owns. Harmless while nothing read that array; would have silently gutted the new token's
   protection the moment it shipped. Fixed in the same change: `applied_files` is now rebuilt from
   `plan.files`/`plan.envExampleActions` every apply -- the choice's full desired file set in this
   repo, not just this run's diff.

3. **`handles`'s token never hashed the actual generated Java files, and nothing else did
   either.** Unlike `stack`, this is **not** fixed at the token level, and that asymmetry is
   deliberate: `ResourceResolverStub.java.tmpl`'s `patchField()` is *meant* to be hand-finished
   (`D-resolver-scope`), so hashing generated content into the gate token would report every
   intentional human edit as `stale` -- exactly backwards, and precisely the trap
   `D-handles-ownership` already flagged this item would need to avoid. What's never legitimate is
   the file being **gone**: nothing regenerates it implicitly, and the feature doesn't compile
   without it. So this is checked the same way S6 checked `migration.sql` -- `lib/verify.mjs`'s
   `checkArtifacts()` gained `handlesManifestChecks()`, which reads O2's
   `.sbf/handles-manifest.json` and confirms every file this feature owns (plus repo-owned
   `global/handle/*` infra, since every feature's resolvers depend on it) still exists on disk --
   existence only, at verify time, entirely outside the gate token. A feature that never ran
   `handles emit` gets zero items (no cross-feature bleed from another feature's manifest entries);
   an unreadable/unrecognized manifest is reported as a `handles manifest (unreadable)` finding
   instead of crashing `bskel verify`. Manifest paths are resolved through a new
   `lib/fsutil.mjs::resolveWithinRoot()` (non-throwing sibling of `stack/apply.mjs`'s
   `assertContained`) since they come from JSON, the same D-security-4 class of defense.

**COST**: every gate record now carries a (usually small) `inputs` snapshot, so `gate show`/`verify
--json` output grows a little. `schemas/state.schema.json` needed a new `inputs` property
declaration (nothing loads this schema at runtime, but `D-gate-definitions` already treats keeping
it accurate as a housekeeping obligation). Every repo with an already-passed `stack` gate goes
stale exactly once after this ships (the token's shape changed) -- one idempotent `stack apply
--choice <id> --apply` clears it; no other gate's token shape changed, so nothing else re-stales.
A generated resolver a human deliberately wants gone now fails `verify` until its manifest entry is
removed (or the feature re-emits) -- the same deliberate strictness S6 already established for a
missing `migration.sql`, not a new kind of friction.

**EXIT** -- what this slice deliberately did NOT do, and why, so it isn't quietly re-litigated
later without checking this first:

- **Complaints (a) "uncommitted Java changes do not stale `scan`" and (b) "unrelated commits stale
  every feature" remain open for `scan`/`contract`/`handles`** (only `stack` is fully fixed, per
  (2) above). Three cheap-looking alternatives were evaluated and rejected, on the record, so this
  doesn't get re-explored from scratch next time: (i) `git log -1 -- <paths>` needs a narrow path
  set that doesn't exist for a whole-repo collision scan -- `scanJavaSpring()` globs every `.java`
  under `src/main/java`, and scoping to `src/` removes roughly none of a Spring backend's commits.
  (ii) Building a manifest from the scan report's own matched files is structurally blind to a
  **newly added** colliding controller -- the exact case `scan` exists to catch -- so it would make
  `scan` look precise while being wrong about the one thing that matters most. (iii) Hashing the
  whole `.java` glob fixes (a) but makes (b) strictly worse (every uncommitted edit anywhere, not
  just every commit, would now stale every feature). The real fix is the scanners themselves
  (`scanJavaSpring()`/`scanGenericGrep()`) reporting which files they actually read, plus a
  per-feature narrowing policy built on top of that -- a real design, not a token tweak, and it's
  the natural next S2 slice. Until then these four gates keep `head_sha`, and at least
  `changed_inputs: ['head_sha']` now tells a human *why* they went stale instead of just that they
  did.
- **Transitive invalidation via an `upstream_token` input is deferred on a sequencing argument, not
  effort.** While every gate but `stack` still hashes `head_sha`, any event that changes an
  upstream gate's stored token also moves `head_sha`, which downstream gates already hash -- so an
  explicit `upstream_token` input would be almost entirely redundant today, at the cost of
  re-staling `contract`/`handles` for every existing repo for no real behavior change. It becomes
  necessary in the exact slice that removes `head_sha` from those gates (the item above) and
  belongs bundled with it, not built ahead of it.
- Extension point for both: `lib/gate-definitions.mjs`'s `recompute` remains the single place to
  make any gate's inputs more precise; the flat `prefix:<relpath>` key convention `stack` now uses
  is what lets `diffInputs()` name an exact file, and any future manifest-shaped input (a `scan`
  read-set, say) should follow it rather than nesting an object under one key.

### Continued: the `scan` gate drops `head_sha` for a real, content-based read-set

**WHY**: this slice's own EXIT above named the real next step -- "the scanners themselves report
which files they actually read" -- and grounding confirmed both complaints this closes were still
live: reproduced directly, editing a real controller's content WITHOUT committing left `scan`
reporting `pass` (complaint (a)); an unrelated commit (e.g. a doc file) staled every feature's
`scan` gate simultaneously (complaint (b)). `contract`/`handles` are deliberately NOT touched here
-- narrowing THEM to just a feature's own matched module needs a genuinely new piece of data
(`scan disposition` never records which module was chosen today) and is a separate, larger slice;
see EXIT below.

Each adapter's `scan()` already computed a complete, sorted, `rg --files`-derived read-set as a
local variable before this item (`listJavaFiles(srcRoot)`, `listCandidateFiles(repoRoot)`, `files =
listPythonFiles(projectRoot)`) and simply discarded it on return -- exposing it as a new
`filesRead`/`files_read` field (adapter return value -> `scanners/index.mjs::runScan()` -> the
persisted report, new required property on `schemas/scan-report.schema.json`) was pure plumbing,
not new file-walking.

**The harder design question, and the trap D-gate-precision's own rejected alternative (ii) already
named**: staleness detection must catch a brand-NEW file too, not just an edit to a known one -- but
`scan.recompute()` runs independently of `runScan()`, long after the fact, so it cannot simply
re-hash the STALE `files_read` list the last scan run happened to persist (that list, by
definition, never contains a file that didn't exist yet when it was written -- the exact blindness
(ii) already flagged for a matched-files-only manifest, which applies just as much to a full-but-
stale read-set list). Fixed by giving each adapter an optional `listReadSet(repoRoot)` on its
`sbf.adapter/1` descriptor (`scanners/registry.mjs`'s validator now destructures it out alongside
`detect`/`scan`/`diagnostics` before JSON-Schema-validating the rest, same "functions checked
separately" mechanism those three already use) -- a thin wrapper around the exact same
`listJavaFiles`/`listCandidateFiles`/`listPythonFiles` helper `scan()` itself calls, so
`scan.recompute()` re-derives the CURRENT read-set fresh on every check, genuinely re-globbing, not
replaying history. Optional, not required by `schemas/adapter.schema.json` -- a hypothetical future
adapter without it just gets the coarser `scan_report_hash`/`spec_hash`-only fallback, never a
crash (same graceful-degradation shape `lib/verify.mjs`'s `checkResolverConflicts` already
established for S6). Hashed per-file into `source_file:<relpath>` keys, the same flattened-manifest
convention `stack`'s `applied_file:`/`applied_file_mode:` already established -- `diffInputs()`
needed zero changes, it was already fully generic over key names.

**A real, live-caught false-positive this item's own design introduced, then fixed before
shipping**: the first working version made `test/handles-cli.test.mjs`'s pre-existing
hand-finished-`patchField()` regression test fail -- a GENERATED resolver file (O2) lives INSIDE
the same `src/main/java` tree the java-spring adapter globs, so `handles emit` writing its own
output looked, from `scan`'s new read-set's perspective, indistinguishable from a human adding a
real new controller -- staling `scan` on every single `handles emit` run, a serious regression to
the normal happy-path workflow, not a hypothetical edge case. Fixed by filtering `listReadSet()`'s
output against O2's own generated-file registry (`lib/handles-manifest.mjs::loadManifest()`,
wrapped in try/catch mirroring `handlesManifestChecks()`'s own defensive shape) before hashing --
the authoritative answer to "did backend-skeleton itself write this," reused rather than guessed at
via a directory-name/filename pattern. A new dedicated regression test
(`test/handles-cli.test.mjs`: "running handles emit does not stale the scan gate") pins this
directly.

**Verified**: `npm test` 694/694 (688 baseline + 6 net new -- 4 CLI-level staleness tests in
`test/scan-cli.test.mjs` covering the uncommitted-edit case, the brand-new-file case, the
unrelated-commit-no-longer-stales case, and 1 unit-level read-set-shape test in
`test/scan-fixture.test.mjs`, plus the handles-emit-doesn't-stale-scan regression above). Every new
test runs against a real git repo and the real CLI (`execFileSync`), not mocked.

**EXIT** -- the deliberately deferred next slice, unchanged from this section's own earlier EXIT:
`contract`/`handles` still hash `head_sha` (complaints (a)/(b) remain open for them), and
`upstream_token` is still not built. Both need `scan disposition --module <name>` (a genuinely new
field -- today nothing persists which module a feature disposed onto; `contracts/emit.mjs`'s
`selectModule()` only ever resolves it transiently, from an ephemeral `--module` CLI flag or the
top-scored module) before per-feature narrowing to just that module's own
`controllers`/`entities`/`enums` files is reachable (that file-level data itself is already sitting
in the persisted report today, zero new adapter tracking needed for those three -- confirmed by
direct tracing of `related_modules[].{controllers,entities,enums}[].file`). DTO file paths are a
separate, smaller gap (`scanJavaSpring()` currently pushes a bare class-name-stem string, no
`file` field) -- real but not blocking the slice above.

### Continued (part 2): per-feature narrowing for `contract`/`handles`, and why `upstream_token` was replaced

**WHY**: this section's own EXIT above named the next step. Direct grounding (re-reading
`cmdScanDisposition`, `selectModule()`, and the `contract`/`handles` recompute()s themselves)
found the originally-sketched `upstream_token` design (an opaque input equal to `scan`'s own
current token) does not actually narrow anything: `scan`'s token is deliberately whole-Java-tree
sensitive (Part 1's own correct design for collision detection), so inheriting it wholesale would
just relocate that same "any Java file anywhere stales this" behavior one level down, reintroducing
complaint (b) for `contract` -- the exact thing this slice exists to fix. **Replaced with two
concrete, precise signals instead**: `scan_report_hash` (the same hash `scan`'s own token already
computes -- catches an explicit re-scan/re-disposition, including this module's membership
changing) and `module_file:<relpath>` per-file content hashes, scoped to ONLY the disposed
module's own `controllers`/`entities`/`enums` files (not the whole adapter read-set) -- the same
"uncommitted change must be visible" property Part 1 established for `scan`, applied one level
down. DTOs stay excluded (Part 1's own named gap: no `.file` field yet).

**A genuine simplification found for `handles`, not originally anticipated**: `handles`'s existing
token already carries `contract_hash` (the emitted contract file's own content hash). Once
`contract`'s own token is precise (this slice), `contract_hash` alone is already sufficient --
`handles` is derived from the *contract*, not directly from source, and `contract` is a `REQUIRED`
verify policy, so `bskel verify`'s overall verdict is already blocked whenever `contract` itself is
stale. `handles` reporting `pass` (its emitted Java still matches the currently-emitted contract)
stays accurate and useful even then -- each gate is responsible for its own direct dependency's
integrity, and the required-gate chain carries the rest. `handles.recompute()` simply drops
`head_sha`, with nothing added in its place.

**`scan disposition --module <name>`** (new, optional): if named explicitly, must be a real entry
in `report.related_modules` (`BAD_ARGS`, naming the real choices, otherwise -- same shape
`cmdScanExplain`'s unknown-module error already uses). If omitted, defaults to
`related_modules[0]?.module` -- **deliberately identical to `contracts/emit.mjs::selectModule()`'s
own existing default** -- so a `--module`-less disposition can never silently disagree with what
`contract emit`/`handles plan` would ALSO pick by default. Persisted as `report.disposition.module`
(new schema property). `contract emit --module`/`handles plan --module`/`handles emit --module`
themselves are UNCHANGED -- this slice only wires the recorded module into gate *tokens*, not into
those commands' own selection logic (a real, separate ergonomics question, deliberately left
alone).

**Found live while writing the new tests, not assumed**: `related_modules[].{controllers,
entities,enums}[].file` are stored as ABSOLUTE paths (unlike Part 1's own `files_read`, which this
item's earlier design deliberately made repo-relative) -- confirmed by inspecting a real scan
report before writing `path.relative(root, item.file)` in the new recompute().

**A second real interaction found live, this time triggered by the new tests themselves rather
than an existing regression test**: two pre-existing `handles emit --check --diff` tests
(`test/handles-check-cli.test.mjs`) edit a controller's `@PreAuthorize` role WITHOUT committing,
then call `handles emit --check` directly. That edit is now inside BOTH `scan`'s (Part 1) and
`contract`'s (this part) own tracked file sets, so it correctly stales both -- which blocks
`handles emit` at its existing `requireNamedGate('contract', ...)` check before ever reaching the
live-diff logic these tests exist to exercise. This is a genuine correctness IMPROVEMENT, not a
regression: previously, editing a controller's authorization annotation without re-running
`contract emit` had ZERO effect on any gate (`head_sha` only moves on commit), silently letting
`handles emit` proceed against a contract that no longer reflects the controller's real content.
Fixed the tests by re-running the scan -> disposition -> contract chain after the edit (the same
"re-run the upstream chain" pattern `test/contract-cli.test.mjs`'s own pre-existing tests already
established) -- confirmed this doesn't undermine what those tests actually prove, since
authorization/role is not part of `contract`'s own schema, so re-emitting produces byte-identical
contract output, just with a token that matches the controller's current state.

**Known, accepted limitation, unchanged from this section's own earlier note**: a brand-new file
added to the SAME already-disposed module, before the next explicit `bskel scan` re-run, is caught
only by `scan_report_hash` at the next re-scan, not immediately -- closing that precisely would
mean re-running full module-assignment logic (`moduleOf()`) on every `verify`/`gate require` call,
real added cost for an edge case. DTO file paths remain a separate, smaller, still-open gap.

**Verified**: `npm test` 699/699 (694 baseline + 5 net new -- `scan disposition --module`
persistence/validation/default-matching, and the two-module narrowing proof itself: editing the
disposed module's own file stales `contract` naming the `module_file:` key; editing a DIFFERENT,
ALSO-matched-but-not-disposed module's file does not; an unrelated commit does not). All against a
real two-module fixture (not a synthetic single-module stand-in), so the narrowing proof is
against a genuine disposition CHOICE between two real candidates, not a trivially-excluded
unmatched file.

**EXIT**: with this, S2's original catalog text ("uncommitted Java changes do not stale scan;
unrelated commits stale every feature") is closed for `scan`, `contract`, and `handles` alike.
What remains open, named explicitly rather than silently: DTO file paths (no `.file` tracking in
`scanJavaSpring()`'s DTO extraction), and the new-file-in-an-already-disposed-module latency
tradeoff above.

## D-status-next (D1): `bskel status`/`bskel next` are presentation logic on top of gate state that already existed

**WHY**: `bskel verify` already computes everything a human/agent needs to know where a feature
stands -- `collectGateStatuses()` gives per-gate `blocking`/`status`/`stale_reason`/
`changed_inputs` (S2), `checkArtifacts()` finds missing generated output -- but it flattens all of
that into one pass/fail verdict for CI-style gating. `bskel gate show` goes the other way: raw
state, zero interpretation. Neither answers "what do I actually run next" across the five-gate
workflow, which is exactly the gap Codex's own P&L pass called out as unusually cheap to close
*because* S1 already built `GATE_NAMES`/`GATE_DEFINITIONS` as the single ordered source of the
workflow, and S2 already computes precisely why a gate is stale. `bskel next`/`bskel status` are
almost entirely reuse: `lib/workflow.mjs`'s `computeWorkflowState()` calls `collectGateStatuses()`
and `checkArtifacts()` directly (same functions `cmdVerify` calls), and only adds sequencing --
walk `GATE_NAMES` in order, stop at the first blocking gate, and emit the one command that
actually resolves *that* gate's *current* status (not a generic "re-run everything"): `not_run`
gets the establishing command, `awaiting_disposition` gets the gate-specific remediation
(`scan disposition` for scan, `contract waive`/`gate force contract` for contract -- the exact
phrasing `cmdContractEmit`/`cmdHandlesEmit` already print inline), and `stale` gets the
establishing command again but with S2's `changed_inputs` folded into the reason so it's not just
"stale, try again."

`bskel next`'s non-JSON stdout is **exactly one line, the command** -- the reason goes to stderr --
specifically so `$(bskel next)` is safe to eval directly in a shell without accidentally executing
prose. With no featureId given, feature-scoped gates cannot be evaluated at all (there's nothing to
look up), so `computeWorkflowState(root, null)` only ever considers the repo-scoped `preflight`
gate; once that passes, `next` falls back to either `bskel feature init --slug <name>` (no feature
exists yet) or `bskel next --feature <id>` naming the known ones (`specs/*/feature.json` scanned
directly via a new `listFeatures()` -- `.sbf/feature-index.json` is keyed by `feature_uid` with a
single-element array per key, not a convenient "list every feature_id" source).

**A real bug caught during manual verification, not by the test suite**: the first draft's "no
feature specified" fallback lived *inside* the per-gate loop, keyed on `gateName === 'scan' &&
!featureId`. It was dead code -- when `featureId` is `null`, `computeWorkflowState` never builds a
`scan` gate entry at all (only `preflight`), so that branch could never be reached; `bskel next`
with no `--feature` (after preflight passed) silently reported "nothing blocking" instead of
recommending `feature init`. Caught immediately by manually walking the CLI end to end (not by any
written test -- worth remembering that this class of bug, dead branches guarded by a condition
that's never actually reachable given the surrounding data flow, doesn't show up from reading the
code in isolation). Fixed by moving that case into the post-loop fallback, alongside the "all
required gates pass" case, both keyed on `nextActions.length === 0` rather than being reachable
only from inside the loop.

**COST**: the gate-specific remediation phrasing in `lib/workflow.mjs` (`ESTABLISH_COMMAND`,
`awaitingDispositionCommand`) is a second copy of text that also lives inline in
`requirePreflightPassed`/`cmdContractEmit`/`cmdHandlesEmit` -- not exported/shared in this slice,
so the two could drift if one is edited without the other. Accepted rather than refactored now:
unifying them would mean pulling CLI-layer string-building into `lib/`, and the two copies are
covered by tests on both sides (the existing blocked-message tests, and this slice's new
`status-next-cli.test.mjs` asserting the `contract waive` wording matches `cmdHandlesEmit`'s own
hint verbatim) that would catch drift if it happened.

**EXIT**: `bskel next --execute` (the catalog's own "optionally") is deliberately not built --
auto-running a recommended command that's frequently `mutating: true` (writes gate state, generates
files, applies a stack choice) without a human confirming first runs directly against this
project's "confirm before destructive/hard-to-reverse actions" default. If ever wanted, it needs
its own explicit opt-in and confirmation step, not a flag that just shells out to whatever
`next_actions[0].command` says. Tracking `/speckit.specify`/`/speckit.plan`/`/speckit.tasks`
(SKILL.md's phases 4/6/9) is also out of scope -- none of them have a gate, so `bskel` has no way
to know whether they've actually happened; `next`'s action computation only ever considers
gate-backed phases (1/2/3/5/7/8, i.e. preflight/feature-init/scan/contract/handles/stack). A
generic gate dependency graph was not built either, for the same reason S2 didn't build one:
`GATE_NAMES`'s documented order is sufficient today, and a real graph only earns its cost once a
gate has more than one direct predecessor.

## D-artifact-determinism (O6): rerunning a command with nothing real changed must produce byte-identical output, and a doc reference must point at something that exists

**WHY** -- three separate, small correctness gaps, plus a documentation-hygiene one, bundled
because each is cheap and none depends on the others:

1. **`generated_at` was baked into `contract emit`'s and the OpenAPI snapshot's output on every
   run**, via `new Date().toISOString()` in `contracts/emit.mjs::buildContract()` and
   `contracts/openapi.mjs::snapshotFromReconciliation()`. No test asserted its value
   (`test/contract.test.mjs` explicitly strips it before comparing), so it was pure output churn
   -- but `lib/gate-definitions.mjs`'s `contract` gate token hashes the emitted contract file's
   bytes, so this churn moved the gate token on every re-emit even when nothing semantic changed.
   Removed from both artifacts; `schemas/feature-contract.schema.json` updated in lockstep
   (`additionalProperties: false` meant leaving it in `required`/`properties` while removing it
   from the code would have made every future contract fail its own meta-schema). "When was this
   generated" already lives in the right place -- the gate record's own `at` field
   (`lib/gates.mjs`'s `passGate`/`awaitDispositionGate`/`forceGate`), which is the established
   precedent this item generalizes: timestamps belong in gate history, not in the semantic
   artifact itself.
2. **Discovery order was never sorted.** `rg --files` (no `--sort` flag, used at every call site
   in `scanners/adapters/java-spring.mjs`, `scanners/adapters/generic-grep.mjs`, and
   `handles/emit.mjs::detectBasePackage()`) is explicitly unordered/parallel by ripgrep's own
   documentation -- two runs against an *identical, unchanged* repo could return files in a
   different order, propagating into non-deterministic controller/entity/module array order in
   every scan report and contract. Fixed with a `.sort()` immediately after each `rg` call;
   sorting the input file list is sufficient to make everything built by iterating it
   deterministic too, no downstream sort needed. `scanners/index.mjs`'s
   `scored.sort((a,b) => b.score - a.score)` also had no tie-breaker for equal-score modules --
   added `|| a.module.localeCompare(b.module)` as a stable secondary key.
3. **`detectBasePackage()` silently picked `files[0]`** when more than one `*Application.java`
   matched, with no ambiguity handling at all -- combined with (2)'s non-determinism, which
   package a multi-application repo got could vary run to run. Fixed to only treat this as
   ambiguous when the candidates declare *genuinely different* packages (multiple
   `*Application.java` files sharing the same package -- a real multi-module-monorepo shape --
   isn't actually ambiguous, and now resolves quietly); a real mismatch throws, naming every
   candidate file, caught at both call sites (`cmdHandlesPlan`/`cmdHandlesEmit` in `bin/bskel.mjs`,
   both now routed through a new shared `detectBasePackageOrExit()`) and reported the same way the
   pre-existing "no `*Application.java` found" case already was (`process.exit(2)`).
4. **Three dead documentation references**, found by grepping the whole repo for every `D-<x>`/
   `D<N>` token and checking it against DECISIONS.md's real headings. `scanners/index.mjs`'s
   `--db` unknowns note pointed at a DECISIONS.md heading that could never exist, because the
   feature it would document -- DB introspection -- was never built; repointed at CATALOG.md's
   `A4`, the actual place that gap is tracked, rather than inventing a decision for unshipped
   work. `stack/apply.mjs`'s security-hardening item #6 comment carried two different labels for
   the same fix, one real (`D-security-6`, matching this file's own numbered-list item #6 below)
   and one that never existed as a heading anywhere; unified on the real one (this item's own
   earlier self-reference above has already been cleaned up the same way). `HandleAspect`
   (`HandleSnapshot.java.tmpl`'s Javadoc referenced a class that is generated by no template and
   exists nowhere in this codebase; reworded to say plainly that snapshot-recording is opt-in and
   not yet implemented, pointing at CATALOG.md's `O4`).

**A new regression mechanism for (4) specifically**: `test/doc-integrity.test.mjs` parses every
`##`-level heading in DECISIONS.md into a real anchor set (handling combined headings like
`D5/D6` and `D-name / D-repo / D-handles / D-ngrok` by splitting on `/`), greps the whole repo
(`.mjs`/`.tmpl`/`.md`, excluding `node_modules`/`.git`) for every `D-<x>`/`D<N>` token referenced
in code or prose, and fails if any doesn't resolve. The single biggest false-positive trap, found
while building this: `D-security-1` through `D-security-10` are documented as a **numbered list**
under one `## Security hardening pass (Codex review)` heading, not as ten separate `##
D-security-N` headings -- that section already says so explicitly ("this section is the index,
not a duplicate of the reasoning"). The test counts the list items and synthesizes
`D-security-1..N` anchors rather than expecting individual headings, which is what keeps it from
producing ~10 false positives against this repo's own real content. It also cross-checks
`usage()`'s documented top-level commands against `main()`'s dispatch `switch` (by static source
parsing, not runtime probing -- an earlier draft ran each verb bare and checked for usage()'s own
banner in the output, which produces a false positive for any two-word command whose PARENT verb
legitimately prints that same banner when called with no subcommand, e.g. `bskel feature` alone),
and locks in that a `HandleAspect` mention anywhere in a generated template must carry an explicit
not-yet-implemented caveat.

`CATALOG.md` is deliberately **excluded** from the dangling-reference scan: it's an explicitly
frozen, verbatim-recovered historical record of Codex's original catalog text (see
`D-catalog-recovery`), and it still quotes both of the dead references fixed in item (4) above as
evidence of the problem this very entry fixes -- editing that quoted text would misrepresent what
Codex actually wrote. The doc-integrity test's own source file is also excluded from its own scan
(it legitimately constructs the security-hardening synthetic-anchor prefix via template literal
and references synthetic nonexistent tokens in its self-verification subtests -- neither is a
real documentation reference).

**COST**: `schemas/feature-contract.schema.json`'s change has no real backward-compatibility cost
(nothing ever validated an *old* contract file against a *new* schema version -- contracts are
regenerated, not migrated). The ambiguous-base-package error is untested against any real
multi-application repo (none exists in this project's real-world testing, per `handles/emit.mjs`'s
own comment) -- it could turn out to be too strict or insufficiently informative the first time it
actually fires against a genuine case.
**EXIT**: if a real multi-application-root repo is ever encountered and the "different packages
throw" behavior is wrong for it, the fix is an explicit override (e.g. `--base-package
com.example`) added to `detectBasePackageOrExit()`'s call sites -- not designed speculatively now,
per this project's Data-First Numerics convention, since there's no real case yet to design
against.

## D-adapter-registry (G1): adapters are discovered from a directory, and every command declares the capability it needs

**WHY** -- three separate problems, found in that order while researching this item:

1. **`runScan()` hardcoded exactly two adapters as an if/else, not a registry.** `scanJavaSpring()`
   ran first unconditionally; only on `null` did `scanGenericGrep()` run. Adding a third adapter
   meant editing that dispatch function directly, `schemas/scan-report.schema.json`'s closed
   `adapter` enum, and the confidence/`pathPrefixSignals` special-casing around it -- three edits
   for one addition, exactly the kind of mechanism-rots-as-choices-accumulate problem D7 already
   solved for stack choices (`stack/catalog/*.yml`, discovered by a pure `readdirSync`, zero
   registration array).
2. **`scanReport.adapter` was recorded and never read.** `contracts/emit.mjs` already round-tripped
   it into `contract.source.adapter` -- but `contract emit`/`handles plan`/`handles emit` ran the
   identical Java-only code path for any adapter's output. For a repo scanned by `generic-grep`
   (zero Java anywhere), the only visible failure was `handles/emit.mjs`'s `detectBasePackage()`
   throwing "could not detect the base package ... is this a Spring Boot project?" -- a message
   that reads as a broken Spring detector, not "the adapter that scanned this repo doesn't support
   handle codegen." This path had **zero test coverage**: `test/generic-grep-cli.test.mjs` (6
   tests) only ever exercised `bskel scan`, never `contract emit` or `handles plan`/`emit` against
   a generic-grep-scanned feature.
3. **`schemas/scan-report.schema.json` was not merely unenforced, it was wrong.** It declared
   `additionalProperties: false` with no `path_prefix_signals` property, while `runScan()` has
   emitted that field on every report since A1 §7. Every real scan report this tool has ever
   produced therefore failed its own schema -- hard proof the schema was never actually loaded or
   validated anywhere (confirmed: no non-test code path does).

**The mechanism**: `scanners/registry.mjs` mirrors `stack/apply.mjs`'s `listCatalogChoices()`
structurally -- `readdirSync('scanners/adapters')`, filtered to `.mjs` files not prefixed `_`/`.`,
`.sort()`ed for determinism (same discipline as O6), each dynamically `import()`ed via
`pathToFileURL` and validated against a new `schemas/adapter.schema.json`. Each adapter module
exports one named binding, `adapter` (`sbf.adapter/1` contract): `id` (must equal the filename
stem -- the same identifier discipline `stack/apply.mjs`'s `CHOICE_ID_RE` already enforces),
`specificity` (an arbitration number -- 100 for `java-spring`, a build-file-plus-source-layout-
confirmed match, the strongest signal any adapter here can give; 0 for `generic-grep`, the
unconditional last-resort fallback), `confidence`, `capabilities`, and `detect`/`scan`/
`diagnostics` functions. `scanners/index.mjs`'s `runScan()` now sorts every adapter that detects
the repo by specificity (id as tiebreak, computed fresh regardless of input order -- specificity
is the sole source of truth for arbitration, not caller-supplied ordering), picks the top one, and
**throws, naming every candidate, when two adapters tie at the same specificity and both detect**
-- refusing silently to pick one, the same principle `detectBasePackage()`'s O6 fix already
established for an ambiguous multi-application repo. A broken adapter file is caught per-file (its
error collected in `LOAD_ERRORS`) so it can never brick every `bskel` command; every `scan` run
warns about it on stderr, and `bskel doctor` lists every installed adapter's specificity/
capabilities, whether it detects the current repo, its `diagnostics()` output, and exits 1 if any
`LOAD_ERRORS` remain -- replacing the previously unactionable "investigate why `scanJavaSpring()`
didn't detect it first" advice with a command that actually answers it.

`runScan`/`cmdScan`/`main()` all stay synchronous even though `import()` is inherently async:
`registry.mjs` resolves the adapter list via a **top-level await**, and `scanners/index.mjs`
statically imports the resulting constants -- Node resolves that top-level await while resolving
the static import, before any of `index.mjs`'s own code runs. This is what keeps `runScan`'s five
existing synchronous test call sites (`test/scan.test.mjs`, `test/contract.test.mjs`) untouched.

**Capabilities -- four, fail-closed**: `api.operations`, `api.request-shape` (declared but
non-blocking -- its absence already degrades gracefully to `body: "unknown"`), `resource.fetch`,
`codegen.handles`. `schemas/adapter.schema.json` uses `propertyNames: {enum: [...]}` +
`additionalProperties: {type: 'boolean'}`: a typo (`api.operation`) is a hard load error, not a
silently-false capability; an omitted key normalizes to `false`. This is the property that makes
both halves of the zero-hardcoding bar hold: **adding a capability touches zero adapter files**
(an adapter that doesn't mention it is `false` by construction), and **adding an adapter touches
one file** (nothing else has to change to register it). `test/adapter-registry.test.mjs` locks in
both directions (a schema/`CAPABILITY_NAMES` drift guard, and five distinct malformed-adapter
failure modes each isolated to `LOAD_ERRORS` without blocking the adapters that did load).

`bin/bskel.mjs`'s new `requireCapabilitiesOrExit()` intercepts in `cmdContractEmit` (right after
the scan report is parsed, before anything is written), `cmdHandlesPlan`, and `cmdHandlesEmit`
(both right after `loadScanReportOrExit`, before `detectBasePackageOrExit` -- so the misleading
Spring-specific message can no longer fire at all for a capability-blocked feature) with a new
**exit 17**. Real captured output (generic-grep-scanned fixture, `contract emit`):

```
blocked: `bskel contract emit` requires the `api.operations` capability, which the `generic-grep`
adapter -- the adapter that produced .../specs/001-widget-management/brownfield-scan.json -- does
not declare.

  api.operations: endpoints carry a source-pinned, non-null operationId. a contract operation must
  be addressable by id -- generic-grep's route-pattern grep never correlates one (operationId is
  always null by construction, see D-generic-grep-reconnaissance in DECISIONS.md).

Nothing was written.

What you can do:
  - run `bskel doctor` -- it reports why each installed adapter did or did not detect this repo.
  - hand-write the required artifact against its schema yourself, then `bskel gate force contract
    --feature 001-widget-management --reason "..."` if you're confident it's correct.
  - no adapter/codegen provider exists for this stack yet -- see G2/G4 in CATALOG.md.
```

`test/generic-grep-cli.test.mjs` gained three regression tests for this exact path -- one of them
directly asserts the misleading "is this a Spring Boot project?" string never appears in
`handles plan`/`emit`'s stderr for a generic-grep-scanned feature, a direct regression guard
against re-introducing the confusing failure this item exists to remove.

**Behavior change, stated plainly**: before this, a `generic-grep`-scanned feature could reach
`contract emit`'s zero-operation `blocked` state (exit 3), then `bskel gate force contract
--reason "..."`, producing a green `contract` gate and (with `handles` optional) a passing `bskel
verify` over a contract with zero real operations. After this, `contract emit` exits 17 and writes
nothing at all -- a human must either hand-write a real contract or explicitly force the gate with
nothing on disk to point at. Stricter, and more honest, but a real behavior change -- documented
here and in SKILL.md rather than discovered.

**What was deliberately NOT done**:
- **No scan-report byte/field change beyond the schema-accuracy fix.** Capability is a property of
  the currently-installed adapter's code, checked at command time via `adapterById(report.adapter)`
  -- not baked into the persisted report, which could otherwise claim a capability the installed
  adapter no longer has. `lib/gate-definitions.mjs` hashes the report's bytes into the `scan` gate
  token; a new field would stale every in-flight feature's scan gate for zero semantic gain.
- **No ajv validation wired into `runScan()`'s actual write path.** That is S5's boundary ("enforce
  the existing schemas at every persistence boundary") -- doing it for just this one artifact here
  would be inconsistent with contract/state/resolution staying unvalidated. Instead,
  `test/adapter-registry.test.mjs` adds a **test-time bridge**: a real `runScan()` output must
  validate against the (now-corrected) `scan-report.schema.json`. Free at runtime, proves the
  schema describes reality, and means S5 can flip on enforcement later without immediately
  rediscovering the `path_prefix_signals` gap this item just fixed.
- **No G2 (FastAPI adapter) or G4 (codegen provider split).** The registry is proven with the two
  adapters that already exist. `handles/plan.mjs`/`handles/emit.mjs` stay exactly as Java/Spring-
  hardcoded as before -- `codegen.handles: false` for `generic-grep` is the correct, honest answer,
  not a limitation to work around with a generic fallback implementation.
- **No `--adapters-dir` CLI flag or environment variable.** `loadAdapters({adaptersDir})` is a test
  seam only. Wiring it to user input would turn "which directory of JS gets executed" into
  attacker-controllable input -- a materially different trust model from `stack/catalog/`'s
  schema-validated YAML data. Stated here so it doesn't get added later as a "convenience."
- **No IR field renames** (`ep.method`, `controller.file`, `endpoints[].line` all stay exactly as
  they were) and **no confidence tiers** (still blocked on real corpus data, per
  `D-generic-grep-reconnaissance` -- unchanged by this item).

**Verification**: `npm test` 321 -> 337 (13 new registry/arbitration/malformed-adapter tests, 3
new generic-grep-CLI capability-block tests, both suites green). Real-world, against
Team-IZ-Backend in isolated worktrees comparing a pre-G1 checkout against this change: `scan
--terms organization` and `scan --terms a` (the largest known scan output) byte-identical across
both versions; the full `feature init` -> `scan` -> `scan disposition` -> `contract emit` ->
`handles plan` -> `handles emit` flow produces byte-identical `specs/` output and identical exit
codes at every step (differences found were exactly the two expected non-deterministic
timestamps -- `disposition.at` and the `handles` gate's `at` -- nothing else); generated Java files
under `global/handle/` and `domain/organization/infrastructure/` diff byte-for-byte identical;
`./gradlew compileJava` still `BUILD SUCCESSFUL`. The zero-registration claim itself was
demonstrated, not just asserted: a synthetic adapter file was copied into the real
`scanners/adapters/`, `bskel doctor` listed it immediately, it was deleted, and `git status`
confirmed no other file had changed.

**COST**: with exactly one codegen provider in existence, `codegen.handles: true` is currently
synonymous with "this adapter is java-spring" -- this item's entire present-day payoff for that
capability is a clearer error message; its real payoff arrives once G2/G4 exist. Adapter discovery
now runs on every `bskel` invocation via top-level await (directory read + a couple of dynamic
imports; sub-millisecond, but real I/O where there was none before). The registry is
bundler-hostile (no build step exists today, so this costs nothing now, but would silently break
if one were added later). `scanners/adapters/` is now a code-execution plugin directory, a
different trust model from `stack/catalog/`'s validated-data one (see the explicit no-CLI-flag
decision above).

**EXIT**: G2 (a real FastAPI adapter) needs an actual FastAPI oracle repo to build and verify
against, which doesn't exist on this machine -- the same "no corpus to calibrate against" reasoning
`D-generic-grep-reconnaissance` used to withhold confidence tiers. G4 (splitting handle codegen
into `providers/java-spring`, `providers/python-fastapi`, etc.) needs at least two real providers
to factor a boundary against, or the split is guesswork about which seams matter, per this
project's Data-First Numerics convention. If recorded-vs-live capability divergence ever actually
bites (an adapter's capabilities changing between when a feature was scanned and when it's acted
on), the correct fix is a versioned `sbf.scan-report/2` with an explicit `adapter_capabilities`
snapshot block -- not designed speculatively now, since no real case has been observed.

## D-doctor-workflow (D5): doctor's checks are workflow-scoped, required-vs-optional, and sourced from the same data the commands themselves already trust

**WHY** -- `cmdDoctor()` checked exactly three binaries (`git`/`gh`/`rg`) unconditionally, all
treated as equally required, with no relation to which command a user was actually about to run:

1. **`gh` failing `bskel doctor` was a real, over-strict bug.** `gh` is used in exactly one place
   in this codebase -- `scripts/preflight-base-ref.sh`'s 3-way default-branch cross-check, which
   already `command -v gh`-guards it (missing `gh` just means one fewer cross-check; preflight
   itself does not hard-fail without it). Doctor nonetheless folded `gh` into the same unconditional
   `checks.every((c) => c.ok)` as `git`, so a machine without the `gh` CLI installed reported
   `bskel doctor` as an overall FAIL even though nothing downstream was actually broken.
2. **Every check applied to every workflow, whether relevant or not.** `bskel doctor` before a
   `stack apply` told you nothing about whether the generated bootstrap script's `curl`/`ngrok`
   dependencies were present; before a `handles emit` it told you nothing about whether this repo
   even has a recognized build wrapper. Node version and adapter readiness (closed by G1) weren't
   checked at all.
3. **No remediation.** A FAIL line said what was missing, never what to do about it.

**The mechanism**: new `lib/doctor.mjs::computeDoctorChecks(root, {workflow})` (mirrors D1's
`lib/workflow.mjs` split -- pure-ish decision logic separate from `bin/bskel.mjs`'s CLI glue).
`WORKFLOWS = ['scan', 'handles', 'stack']` -- deliberately not all five `GATE_NAMES`: `preflight`
and `contract` need nothing beyond the two universal checks (`git`, a compatible Node runtime), so
giving them their own `--workflow` value would offer a choice with no distinguishing content.
Every check carries `required` (only `git`-repo / `git` binary / Node version / `rg` are `true`;
everything else is informational) and a `remediation` string, populated only when `ok:false`.
`bskel doctor`'s exit code and `--json`'s `ok` field are computed from `required` checks only --
this is the direct, minimal fix for the `gh` bug above, not a special case for `gh` specifically.

Two checks are reused, not reimplemented, from code that already had to solve the same problem:
- **Build-wrapper detection** (`handles` workflow) calls `lib/verify.mjs`'s `detectBuildCommand()`
  (newly `export`ed, logic unchanged) -- the exact function `bskel verify --build` already uses,
  so doctor and `verify --build` can never disagree about what counts as "a build tool was found"
  for the same repo. Note this is a **repo-content check** (does `./gradlew`/`pom.xml`+`./mvnw`/
  `package.json` exist at the target repo's root), not a PATH-binary check -- `bskel` itself never
  invokes `java`/`javac`/`gradle`/`mvn` directly; `handles emit`/`handles plan` only write `.java`
  files, they never compile them. Marked `required: false` for exactly that reason: no build
  wrapper blocks nothing about `handles emit` itself, only a later, explicit `verify --build`.
- **Stack tooling** (`stack` workflow) reads `entry.runtime.requires` off every
  `stack/catalog/*.yml` entry via the already-exported `listCatalogChoices()`/`loadCatalogEntry()`
  (`stack/apply.mjs`) -- a new optional `requires: string[]` field on `schemas/stack-choice.
  schema.json`'s `runtime` object, populated for the one entry that exists today
  (`stack/catalog/ngrok.yml`: `[ngrok, curl]`, the two binaries `stack/bootstrap/ngrok.sh`/`_lib.sh`
  actually shell out to at runtime). `bskel stack apply` itself never invokes either -- it only
  *writes* the bootstrap script; a human runs it later. This is the same "fill a schema field, it
  applies globally" pattern D7 established for the stack catalog and G1 just replicated for scanner
  adapters: a future catalog entry declares its own `requires`, and `doctor --workflow stack` picks
  it up with **zero code changes** -- not a hardcoded `["curl", "ngrok"]` literal in `bin/bskel.mjs`.

Node version is checked against the **real** requirement (>=20.11.0, for `contracts/validate.mjs`'s
`import.meta.dirname`), not `package.json`'s declared (and known-inaccurate) `>=18` floor --
`nodeVersionCheck()`'s remediation names this discrepancy explicitly and points at CATALOG.md's P1,
which owns actually fixing the declared floor. Doctor reports reality; it does not silently repeat
the wrong number.

G1's adapter-readiness block (specificity/confidence/capabilities/detect-result/diagnostics) is
unchanged, just now gated by `showAdapters` (true for `scan`/`handles`/unscoped, false for
`stack`) -- shown for `handles` too, since that workflow's actual readiness (`resource.fetch`/
`codegen.handles`) depends on exactly the adapter capability G1 already computes.

`bin/bskel.mjs`'s `cmdDoctor(args)` (previously took zero arguments -- `main()` captured `rest` but
never passed it) now parses `--workflow`/`--json` via the existing `parseFlags()`; an unknown
`--workflow` value throws from `computeDoctorChecks()` and is caught into **exit 14**, the same
bad-argument convention `resolveGateArg`'s `requireGateDefinition` typo-defense already uses (S1).

**Behavior change, stated plainly**: `bskel doctor` on a machine without `gh` installed used to
report overall FAIL (exit 1); it now reports PASS (exit 0) with a `WARN` line, because `gh`'s
absence never actually blocked anything. Verified directly: `test/doctor-cli.test.mjs` builds a
restricted `PATH` containing only real, symlinked `git`/`rg` binaries (deliberately excluding
whatever `gh` install this machine happens to have) and asserts `bskel doctor --json`'s `ok` field
is still `true`.

**Verification**: `npm test` 337 -> **345** (8 new tests in `test/doctor-cli.test.mjs`: unknown
`--workflow` exit 14; `--workflow stack` shows no rg/gh/build-wrapper and sources curl/ngrok from
the real `ngrok.yml` catalog entry; `--workflow handles` shows rg + a build-wrapper check that
correctly flips `ok` based on whether the target fixture has a `gradlew`; `--json` shape; the `gh`-
missing-does-not-fail-overall proof above; three `lib/doctor.mjs` unit tests). Real-world against
Team-IZ-Backend (isolated worktree): unscoped `doctor` and `--workflow handles` both correctly
detect the real `./gradlew` wrapper (`build wrapper (gradle (./gradlew))`) and both scanner
adapters correctly report `DETECTS this repo`; `--workflow scan --json` parses cleanly.

**A real bug caught before it shipped, during implementation, not by the test suite**: the first
draft mapped each adapter's `detect()` result straight into the JSON/text output as
`root ? a.detect(root) : null`. `detectJavaSpringRoot()` (java-spring's `detect`) legitimately
returns `null` on a non-match, not `false` -- so for any non-Java repo, `a.detects` was `null`
regardless of whether `root` was present or absent, and the renderer's `a.detects !== null` check
silently dropped the "-- does not detect this repo" line for java-spring specifically (confirmed
by running `bskel doctor` against this skill's own repo and noticing java-spring's line was
missing that suffix, while generic-grep's wasn't). Fixed by coercing to `Boolean(a.detect(root))`
so `null` unambiguously means "not evaluated, no root" and never collides with a legitimate falsy
detection result -- caught by actually running the command and comparing output to G1's original
behavior, not by code review.

**COST**: `schemas/stack-choice.schema.json` gained one optional field -- no migration needed
(`requires` defaults to absent/empty for any entry that doesn't declare it). `bskel doctor`'s
output shape changed (new `WARN` marker for optional-and-failing checks, new `--workflow`/`--json`
flags, new top-level JSON fields) -- no test previously asserted doctor's output, so no
compatibility break, but any human muscle-memory around its old plain-text shape will notice.

**EXIT**: `bash` itself was deliberately not added as its own check (near-universally present on
any *nix target, low value); if that ever proves wrong for a real user's environment, it's a
one-line `binaryCheck('bash', ...)` addition. If a future stack catalog entry's bootstrap script
needs something `execFileSync(bin, ['--version'])` can't probe correctly (a binary with no
`--version` flag, or one that needs arguments to run at all), `runtime.requires` can grow richer
entries (`{binary, versionFlag}` objects) without breaking existing YAML -- not built now, since
`ngrok`/`curl` both probe cleanly with the current shape and there is no second real case to design
against yet.

## D-fastapi-adapter (G2): a second first-class adapter, and the capability a real OpenAPI document can satisfy

**WHY** -- two findings, both reproduced by executing code against a real, official FastAPI
reference repo (`fastapi/full-stack-fastapi-template`, cloned as the verification oracle per the
user's explicit choice -- this project verifies every adapter against something real, and G2 is no
exception), not inferred from reading:

1. **The pre-G2 baseline was a false negative, not just shallow.** `bskel scan --terms item,items`
   against the real oracle reported `adapter: generic-grep, verdict: greenfield` -- "nothing here"
   -- for a repo with a complete, working Items resource (5 real endpoints) and a complete Users
   resource (10 real endpoints). `generic-grep` found all the routes but collapsed them into one
   `_generic` module with unresolved router-local paths, so `scoreModule()` scored it 0. This is
   the exact failure class this tool exists to prevent -- portability was never the only motive
   for a second adapter; correctness was the stronger one.
2. **The capability gate alone was not enough to make `--openapi-file` actually work.**
   `contracts/openapi.mjs::reconcileModule()`'s adoption path only fires when
   `inferPathPrefix()` resolves a prefix, and `inferPathPrefix()` only builds anchors from
   endpoints that ALREADY have a non-null `operationId` -- which a FastAPI module has zero of, by
   construction. Reproduced directly, twice (a hand-built fixture and the real oracle): `--openapi-
   file` alone left every endpoint `unresolved/prefix-inconclusive`, `adopted: 0`; `--openapi-file`
   **plus** `--path-prefix /api/v1` adopted all 5 real Items operations, `completeness: complete`.
   Both flags are load-bearing -- this is why §3 below exists, and it is a real, load-bearing
   design point this item had to solve, not an afterthought.

**The adapter** (`scanners/adapters/python-fastapi.mjs`, mirrors `java-spring.mjs`'s shape exactly
-- `sbf.adapter/1`, zero registration, confirmed by loading it alongside the other two with no
other file touched): `detect()` requires BOTH a `fastapi` dependency declaration
(`pyproject.toml`/`requirements*.txt`, bounded regex, no TOML parser -- A2's "good-enough regex,
not a real parser" precedent) AND source-level confirmation (`from fastapi import`/`FastAPI(` in
at least one `.py` file) -- java-spring's own "build file AND src layout" combined bar, adapted.
Returns the Python project root, which can differ from `repoRoot` (the real oracle is a monorepo
with its FastAPI project under `backend/` -- verified to resolve correctly from the git root).
**`specificity: 90`, deliberately below java-spring's 100** -- same class of combined signal, but
100 would make a polyglot monorepo containing both a Spring build file and a FastAPI
`pyproject.toml` hit `runScan()`'s "ambiguous adapter selection" hard error; at 90, java-spring
(the stack with `codegen.handles: true`) wins that tie quietly instead. A real, documented
trade-off, checkable via `bskel doctor`.

**Extraction is pure Node regex, deliberately NOT a Python `ast`/interpreter shell-out** -- this
overrides CATALOG.md's own "Python AST module" wording, on the same reasoning A2 already used to
reject a JVM helper for Java parsing: this CLI's only external binary dependency is `rg`; a second
(`python3`) would add version skew and a new degradation path for zero measured accuracy loss.
Verified against the real oracle: 5/5 Items endpoints and 10/10 Users endpoints extracted with
correct verb/path/function-name, `User`/`Item` entities with real `table`/`idField` cross-checked
against the oracle's own Alembic migration (`op.create_table("user", ...)`, no `__tablename__`
anywhere -- SQLModel's own default). A balanced-paren scan (not a single regex) handles a real
complication found in the oracle: `dependencies=[Depends(get_current_active_superuser)]` nests
parens inside a decorator's own kwargs, which a non-greedy `[\s\S]*?\)` would truncate at the
wrong `)`. `module` is the **filename stem**, not the router's own `prefix=` kwarg -- the oracle's
real `login.py` declares `APIRouter(tags=["login"])` with no prefix at all, which falsifies a
prefix-derived name on a real file while the filename stem works for every router. Entity-to-
module attachment is a narrow name-match (`Item`->`items`, singular or singular+`s` only, never
general pluralization) with an unmatched table class landing in a `_models` bucket rather than
being silently dropped. `pathPrefixSignals`/`apiSurfaceSource` (pre-existing hooks from A1 §7/O6
that neither shipped adapter had used before) are this adapter's first real use: an
`include_router(prefix=X)` two-step resolution (mirrors java-spring's
`configurePathMatch`->`addPathPrefix`) recovered the real oracle's `/api/v1` prefix from
`settings.API_V1_STR` exactly, and the surface-source override states plainly that operation ids
are a runtime artifact here, not statically derivable.

**Capabilities, each independently justified** (see the table and full reasoning in
`scanners/adapters/python-fastapi.mjs`'s own comments): `api.operations: false` -- the real
oracle's `main.py` registers a **custom** `generate_unique_id_function`
(`f"{tag}-{route.name}"`), different from FastAPI's own built-in default, and zero
`operation_id=` appears anywhere in source -- operation identity is a per-project runtime
artifact, never honestly derivable statically. `api.request-shape: false` -- `contracts/
emit.mjs::detectRequestBody()` is a Java-only regex; the cost is only `body:'unknown'`
(WARN, waivable), and the real request schema still arrives via `--openapi-file`'s existing,
already-adapter-agnostic A2 schema projection. `resource.fetch: true` -- table/idField ARE
genuinely, verifiably extracted; this has no behavioral effect today (`codegen.handles` is also
required) but makes the eventual `handles plan`/`emit` exit-17 message correctly blame
`codegen.handles`, not misattribute the block to a capability that's actually satisfied.
`codegen.handles: false`, non-negotiable -- no Python codegen provider exists (G4's job);
`handles/plan.mjs`/`handles/emit.mjs` are completely unchanged, still 100% Java/Spring-specific.

**The capability-gate / `--openapi-file` resolution (finding 2's fix)**: new
`CAPABILITY_SATISFIERS` in `scanners/capabilities.mjs` -- a frozen map keyed by **capability**, not
by adapter (`'api.operations': {flag: 'openapi-file', note: ...}`). `requireCapabilitiesOrExit()`
(`bin/bskel.mjs`) gained a `satisfiedBy` Set; `cmdContractEmit` passes `{'openapi-file'}` when that
flag was given. This is deliberately data on the *capability*, not a special case in the adapter
descriptor or in `cmdContractEmit`'s body -- any current or future adapter with the same honest
operation-identity weakness benefits automatically, with zero new branching. `explainMissingCapability()`
now appends a satisfier-specific remediation line automatically whenever one exists for the missing
capability -- the exit-17 message a FastAPI user actually sees now says to retry with
`--openapi-file` (and warns about the prefix requirement), instead of only offering the three
generic escape hatches that existed before this item.

**Accepted, deliberately not special-cased**: because `CAPABILITY_SATISFIERS` is keyed by
capability, `generic-grep` + `--openapi-file` also now bypasses the `api.operations` gate at
`contract emit` -- tested and confirmed to still end up honestly `blocked` (its `_generic` lumping
leaves nothing resolvable regardless). Special-casing this to exclude `generic-grep` would
reintroduce exactly the adapter-name hardcoding G1 removed; the failure mode is self-limiting, so
the widening was accepted rather than blocked.

**Verification**: `npm test` 345 -> **356** (10 new tests in `test/python-fastapi-cli.test.mjs`
covering adapter selection, the headline greenfield-vs-collision regression, extraction fidelity,
the no-prefix `login.py` case, entity attachment/`_models` bucket, path-prefix-signal resolution,
the honest exit-17 without `--openapi-file`, the prefix-inconclusive negative control, the full
adoption path, and the handles-still-blocked-on-codegen.handles proof; 1 new test in
`test/generic-grep-cli.test.mjs` for the accepted widening above; the existing adapter-registry
roster test updated to 3 adapters). Real-world, against the cloned oracle: `bskel doctor` shows
`python-fastapi` detecting and `java-spring` not; `bskel scan` recovers all 5 real Items and all 10
real Users endpoints with correct verb/path/function-name and real `Item`/`User` entities; the
`/api/v1` prefix signal resolves correctly from the real `settings.API_V1_STR`; a hand-assembled
OpenAPI document (paths taken from the oracle's own **committed, machine-generated**
`frontend/src/client/sdk.gen.ts`, operation ids computed from the oracle's own committed
`custom_generate_unique_id` algorithm plus real function names -- never by importing or running
the target app, satisfying CATALOG.md's own constraint; `uv run python -c "...app.main.app.openapi()..."`
was attempted first and failed for an unrelated reason, a missing built frontend static directory in
this shallow clone, not a dependency/network problem) reproduces Finding 2 exactly
(`--openapi-file` alone: 0 adopted, blocked; `--openapi-file --path-prefix /api/v1`: 5 adopted,
complete), and `handles plan` against the resulting feature exits 17 naming `codegen.handles`.

**What was deliberately NOT done**: G4 (Python codegen provider) -- `handles/*.mjs` untouched.
Pydantic/SQLModel schema truth extracted from source -- CATALOG.md's own text says OpenAPI is the
schema oracle for this adapter, and A2/A3's document-based projection already provides it, reused
unchanged. CRUD/service-layer/auth-pattern extraction -- verified unreliable in the real oracle
itself (`read_item`/`read_users` bypass `crud.py` entirely, calling `session.get`/`select` inline)
and has no consumer while `codegen.handles` is false. Enum extraction. Any Python interpreter or
TOML-library dependency. Any change to `contracts/openapi.mjs`'s prefix-inference logic itself
(relaxing it for the zero-anchor case would also affect java-spring modules whose endpoints all
lack `@Operation`, real test churn out of scope for this slice).

**COST**: a FastAPI feature without a generated OpenAPI document can never get a real contract --
accepted, the honest consequence of runtime-generated operation ids (the improved exit-17 message
is what keeps this from being a dead end). A FastAPI app with no global path prefix cannot adopt at
all, because `contracts/openapi.mjs`'s `PATH_PREFIX_RE` rejects an empty string and zero anchors
force `prefix-inconclusive` regardless -- invisible on the oracle (which has `/api/v1`), a real gap
elsewhere, see EXIT. `--path-prefix` is required alongside `--openapi-file` and partly functions as
an "unlock" rather than a pure prefix override -- named here rather than smoothed over. Static
over-reporting of conditionally-mounted routers (the oracle's `private.py` is only mounted when
`FASTAPI_ENV == "development"`, which this scan cannot see). Table names are inferred from class
names, missing an explicit `__tablename__` if one exists. Entity-to-module attachment rests on a
narrow exact/`+s` name match. `test/adapter-registry.test.mjs`'s hardcoded 2-adapter roster
assertion had to become 3 -- the correct amount of coupling for a test whose entire job is
asserting the real, current adapter list, not a registry leak.

**EXIT**: switch extraction to `python3 -c "ast.parse(...)"` if a real repo is found where the
regex approach mis-parses (decorators inside `if`/`try` blocks, dynamic `add_api_route()`
registration, routers built in loops -- none observed in the oracle). Support explicit
`__tablename__` if a real repo needs it. Relax `inferPathPrefix()`/`reconcileModule()` for the
zero-anchor case (empty global prefix) if a real FastAPI app without one is encountered -- affects
java-spring too, needs its own slice. Raise `python-fastapi`'s specificity toward 100, or add an
explicit tie-break, if the java-spring-wins-in-a-polyglot-monorepo default proves wrong in
practice. G4 (a Python codegen provider) needs this adapter plus a second real one to factor a
provider boundary against without guessing -- unchanged reasoning from `D-adapter-registry`'s own
EXIT.

Cross-references: `D-adapter-registry` (G1, the registry this adapter is the first real proof-of-
zero-registration for beyond the two shipped adapters), `D-generic-grep-reconnaissance` (G3, the
`api.operations: false` precedent this item's declaration matches), `D-openapi-reconciliation` (A1,
the reconciliation/adoption mechanism this item depends on entirely unchanged), and
`D-contract-completeness` (A5, `CONTRACT_EMPTY`/`blocked` is what makes finding 2's negative
control end honestly rather than silently).

## D-handles-providers (G4): a real second codegen provider, and the boundary it forced java-spring to prove out

**WHY**: `D-adapter-registry`'s own EXIT held G4 back explicitly -- "needs at least two real
providers to factor a boundary against, or the split is guesswork about which seams matter." G2
(the python-fastapi adapter) added a real second SCANNER but shipped zero codegen
(`codegen.handles: false`), so that precondition was still unmet after G2 landed. Asked to
prioritize, the user chose to build a real second, minimal Python codegen provider now rather than
defer G4 again. An opus Plan agent (43 tool calls, 853s) then re-estimated scope against the real
source and the real oracle (`fastapi/full-stack-fastapi-template`) rather than from reading alone,
and found the catalog's own L estimate did not account for "a genuine second provider" at all --
the honest size was ~13 units (XL). Presented with that finding plus two optional cuts, the user
chose the full design: fetch+PATCH router, both oracle modules measured. Four facts the Plan
agent's real-code/real-oracle grounding surfaced, each of which changed the design before a line
of provider code was written:
- java-spring's `findFetchOperation` requires `ep.operationId` truthy; python-fastapi's scan output
  always sets `operationId: null` (D-fastapi-adapter -- FastAPI generates operation ids at request
  time, never pinned in source). The two providers' canonical-fetch detection cannot be shared as
  one function; python-fastapi's own `findFetchRoute` keys on `ep.method` instead.
- The real oracle's `User` table carries `hashed_password` with no protection besides each
  individual route's own `response_model=UserPublic` declaration. A single generic fetch route
  serving multiple resource types cannot rely on that convention -- an `<Entity>Public` projection
  class had to become a hard *precondition* for generating a resolver at all (missing one blocks
  codegen with a note naming the leak risk), not a decorative nicety.
- The oracle's own two real authorization checks (`items.py::read_item`,
  `users.py::read_user_by_id`) are BOTH inside the route function body (`if not
  current_user.is_superuser and ...: raise HTTPException(403)`), not a decorator -- unreachable by
  static source scanning. Route-decorator authorization-signal extraction was cut from scope as a
  direct result (see EXCLUDED below); the honest, and only defensible, default is
  `check_access()` denying every request until a human wires the app's real check in.
- Python's `base64.urlsafe_b64decode` has the identical "silently discards characters outside the
  alphabet instead of rejecting them" defect that `D-security-10` already fixed for Node's
  `Buffer.from(str, 'base64')` on the JS side -- confirmed by direct execution (see Verification),
  not assumed. The Python codec port needed its own explicit charset guard, not just the padding
  fix.

**SCOPE**: provider dispatch mechanism (`handles/registry.mjs`, mirroring `scanners/registry.mjs`'s
zero-registration design exactly); java-spring extracted, behavior-unchanged, into
`handles/providers/java-spring/` with the shared safety-critical write/conflict/manifest/orphan
logic pulled out into `handles/_engine.mjs`; a framework-neutral `handles-plan` schema; a real
Python/FastAPI/SQLModel provider (codec ported and EXECUTED round-trip against the JS reference,
in-process registry, `fetch`/`to_public` really wired, `check_access`/`patch_field` always stubs,
`GET`+`PATCH` router, no migration/no `recover()`); the cross-cutting edits every one of those
implies (python-fastapi's `codegen.handles` flip, `COMMAND_CAPABILITIES` narrowed to dispatch-only,
`bin/bskel.mjs`'s provider selection, `lib/verify.mjs`'s provider-aware artifact check,
`lib/handles-manifest.mjs`'s marker generalization, `lib/doctor.mjs`'s `python3` check).

**EXCLUDED** (named, not silently dropped): `recover()` + the `sbf_handle`/`sbf_handle_snapshot`
tables + their migration -- even on the Java side nothing has ever called `recover()` (O4 is still
not implemented), so a Python translation would only add an unwired artifact, not close a real gap.
`resolveJsonPointer`/kind=f,o *fetch* (field/object-level handle reads stay 501, matching Java's own
current limit exactly -- porting `resolve_json_pointer` today would be dead code). A `--provider`
override flag (no N:1 real case observed -- selection stays 1:1 by adapter id, see Mechanism).
`src/`-layout / PEP 420 namespace packages (refused with a named exit 2, not guessed). Auto-wiring
the generated router into `api/main.py` (two lines a human adds by hand -- the same reasoning
`D-config-patch` already established for a different generated-file-wiring step). Route-decorator
authorization-signal extraction (cut after the oracle grounding above showed both real checks live
in route bodies, not decorators -- there was nothing reliable to extract). Fixing the Java codec's
own never-executed "byte-identical" claim (see the honest gap this item leaves open, below) --
closing it for Python only was the explicit, scoped goal this time.

**Mechanism**:
- `handles/registry.mjs` mirrors `scanners/registry.mjs` exactly: `handles/providers/<id>.mjs`
  (descriptor) + `handles/providers/<id>/` (implementation + templates), zero-registration
  (filename-filtered, `.sort()`ed, `pathToFileURL` dynamic `import()`, per-file try/catch into
  `PROVIDER_LOAD_ERRORS`), `sbf.handles-provider/1` contract + `schemas/handles-provider.schema.json`
  validation for the JSON-shaped fields (`plan`/`emit` are functions, checked separately by
  `typeof`). The one deliberate difference from the adapter registry: **no arbitration**.
  Adapter selection is genuinely competitive (which of several detectors best matches this repo);
  provider selection is not -- it is an exact id match against `scanReport.adapter`, the one
  persistent artifact linking scan time to codegen time. Inventing a second linking mechanism here
  would just create a second source of truth to keep in sync with the first.
- `requiresCapabilities` moved from being a COMMAND property to a PROVIDER property.
  `COMMAND_CAPABILITIES['handles plan'/'handles emit']` shrank to `['codegen.handles']` --
  dispatch only, "does a provider exist for this adapter's stack at all." Each provider now
  declares its own `requiresCapabilities` (both shipped providers: `['resource.fetch']`), checked
  by a new `requireProviderCapabilitiesOrExit` immediately after `selectProviderOrExit`
  (`bin/bskel.mjs`). This produces a genuinely unfakeable biconditional:
  `adapter.capabilities['codegen.handles'] === true` if and only if `providerById(PROVIDERS,
  adapter.id) !== null` -- pinned as a dedicated regression in
  `test/handles-provider-registry.test.mjs`, run against every real shipped adapter, not a
  hand-picked pair.
- `handles/_engine.mjs::emitUnits()` is the conflict/manifest/force/orphan write engine, extracted
  from what was `handles/emit.mjs` (pre-G4, Java-only) as **pure code motion** -- parameterized on
  `{infraUnits, resolverUnits, orphanScan, provider}` rather than on Java-specific paths/templates.
  `orphanScan.resourceTypeOf(filename, content)` now receives file content, not just the filename --
  java-spring's callback still derives the type from the filename alone (`XResolver.java` ->
  `X`), but python-fastapi's callback reads a `type = "X"` class attribute the resolver template
  itself carries, because a Python filename cannot reliably recover a class name
  (`organization_policy.py` could be `OrganizationPolicy` or `Organizationpolicy`). Manifest
  entries gained an additive `provider` field; a pre-G4 manifest entry with no `provider` field is
  treated as `'java-spring'` for orphan-detection filtering, so an existing target repo's first
  post-G4 run does not silently go blind on orphans it used to catch.
- java-spring's own `detectBasePackageOrExit`/`javaSrcRoot` assembly moved out of `bin/bskel.mjs`
  entirely, into the java-spring provider's own `plan()` -- the clearest evidence G4 is not just a
  file reshuffle. The exact pre-existing error strings ("ambiguous base package...",
  "is this a Spring Boot project?") are preserved byte-for-byte (a plain `throw new Error(...)`,
  caught by a generic try/catch around `provider.plan()`/`provider.emit()` in `bin/bskel.mjs` that
  prints `.message` and exits 2) -- simpler than the `ProviderPreconditionError{message,exitCode}`
  class floated at design time, since every provider-precondition failure in this design already
  exits 2, so a dedicated exception class would carry a configurable field nothing ever configures
  differently. `test/handles-cli.test.mjs`'s exact-string assertions needed zero changes.
- Two DELIBERATE stubs, for two DIFFERENT reasons, both in every generated Python resolver:
  `check_access()` always denies (fail-closed sentinel -- FastAPI has no imperative global security
  context the way Spring's `SecurityContextHolder` is, and the oracle grounding above showed this
  stack's real checks live in route bodies anyway, unreachable by static scan). `patch_field()`
  always 501s (same reasoning as Java's `patchField()` stub -- `D-resolver-scope`: this codebase
  has incompatible partial-update conventions per app, a human must pick the right one).

**Verification**: the 27 pre-existing java-spring handles tests (`handles-plan.test.mjs` x8,
`handles-cli.test.mjs` x10, `handles-ownership-cli.test.mjs` x9) pass with only ONE line changed
across all three files -- `handles-plan.test.mjs`'s import path, nothing else -- confirming the
extraction was truly behavior-preserving, not just "still green by coincidence." 30 new tests:
`test/handles-provider-registry.test.mjs` (9 -- real 2-provider load, zero-registration, 6
malformed-provider failure modes isolated, `_`/`.` skip, the biconditional drift guard against
every real shipped adapter, a `requiresCapabilities` drift guard, both providers' real `plan()`
output validated against the new schema), `test/handles-python-codec.test.mjs` (7, `python3`
**required, not skippable** -- the reference `uuid.uuid5(NAMESPACE_DNS, "example.com")` vector,
encode-in-JS/decode-in-Python and encode-in-Python/decode-in-JS round trips including a JSON
Pointer with `~0`/`~1` escapes and a non-ASCII type name, all 3 base64 padding-remainder classes,
`derive_handle_uid` parity, negative parity for every JS rejection case, and a DIRECT, EXECUTED
confirmation that Python's `base64.urlsafe_b64decode` really does silently discard invalid
characters -- `"QU!JD"` decodes to `b"ABC"` instead of raising), `test/python-fastapi-handles.test.mjs`
(14 -- plan-unit tests proving `ep.method`-keyed fetch detection works with `operationId: null`,
the list route is never mistaken for the single-resource fetch, a missing `<Entity>Public` blocks
codegen with a leak-risk note, a missing primary key blocks codegen, `--resource` filtering, and
both the absent- and ambiguous-package-root exit-2 cases; e2e tests proving the exact expected file
set with no `.java`/`migration.sql`, every generated file syntax-valid via `python3 -c
"ast.parse(...)"`, `check_access`/`patch_field`'s exact status codes and that the resolver never
references `hashed_password`, the PATCH route's kind-AND-pointer check, `bskel verify` passing with
zero migration artifact checks created, re-emit idempotency, and hand-edit-then-re-emit exiting 15
with the file byte-for-byte untouched). Two existing tests rewritten to match G4's own inverted
premise: `python-fastapi-cli.test.mjs`'s old "still exit 17 on codegen.handles" test is now a
positive success test (plan/emit/gate all pass, a real resolver is written, no `.java` anywhere);
`generic-grep-cli.test.mjs`'s two exit-17 tests now assert `codegen.handles` BY NAME and assert
`resource.fetch` is absent from the message, proving the blocker is attributed correctly now that
`resource.fetch` no longer lives at the dispatch layer. `npm test`: 356 -> **386** (30 net new).

Real-world, against the oracle (`fastapi/full-stack-fastapi-template`, throwaway branch
`sbf-g4-verify`, cleaned up after): `bskel scan --terms item,user` on a fresh feature correctly
selects `python-fastapi` (`verdict: collision`, `confidence: high`) across all three real modules
(`items`, `users`, `private`). After forcing past `contract` (out of scope for this handles-only
pass -- the oracle's `api.operations: false` would need `--openapi-file`, covered by G2's own
verification, not repeated here), `handles plan`/`emit --module items` and `--module users` BOTH
produce `willGenerateResolver: true` and a real, written resolver -- this is the headline result
the Plan agent predicted from the grounding above: **both resolvers generate, and both correctly
fail closed on `check_access()`**, an honest reflection of authorization logic this scan genuinely
cannot see, not a false negative. The `User` resolver imports and projects through `UserPublic`
(confirmed: `app.models` really defines `User`/`UserPublic`/`Item`/`ItemPublic`, and `User` really
carries `hashed_password`) -- a repo-wide grep of the entire `backend/app/handles/` tree for
`hashed_password` finds zero matches. Every one of the 7 generated files parses cleanly under
`python3 -c "ast.parse(...)"`. A second `handles emit` for both modules writes nothing (idempotent).
`bskel verify` shows every handles artifact (`infra` x5 + both resolvers) `exists: true` with the
`handles` gate passing (the report's overall `pass: false` is solely the still-missing `contract`
artifact from the deliberate force-past above, not a handles regression). Final `git status
--porcelain` before cleanup: exactly `.sbf/`, `backend/app/handles/`, `specs/` untracked, nothing
else touched -- then `git checkout . && git clean -fd && git checkout master && git branch -D
sbf-g4-verify` restored the oracle to its original, clean state.

**COST**: no `recover()` path for Python (EXCLUDED above -- consistent with Java's own dead code,
not a new gap). `check_access()` always denies until hand-wired -- every Python resolver ships
non-functional for reads until a human completes it, by design (the alternative, a false-negative
"looks secure" default, is strictly worse). `patch_field()` always 501s, same as Java. Field/object-
level handle fetch (`kind=f`/`kind=o`) stays unimplemented for Python, matching Java's own current
limit -- **true when this item shipped, false since; see the slice-4 correction at the end of this
section.** `src/`-layout and PEP 420 namespace packages are refused outright -- **also corrected
below: this overstates the real limit.** The generated router
needs two lines of manual wiring into the app's own router composition -- never automatic. `npm
test` now requires `python3` on PATH as a hard dependency (`lib/doctor.mjs`'s new check is
`required: false` for `bskel` itself, but the test suite's own codec cross-check is not skippable).
Python's `SessionDep`-alias detection is a single regex looking for `Annotated[Session,
Depends(...)]` -- an app using a different session-dependency shape (no `Annotated`, a different
type name than `Session`) gets no router/resolvers generated at all, silently narrowed rather than
guessed at.

**Honest verification gap, left open on purpose -- since closed, see below**: this item closed the
"byte-identical" claim for JS<->Python (executed, both directions, positive AND negative parity,
see Verification). The matching JS<->Java claim (`handles/codec.mjs`'s own header comment, and
`HandleCodec.java.tmpl`'s) had **never once been executed in this repository** at the time this
item shipped -- the claim rested entirely on javadoc-level assertion. This item did not close that
gap (closing Python's was the explicit, scoped goal) -- recorded here, honestly, as still open.

**Closed as a follow-up slice, `test/handles-java-codec.test.mjs`**: mirrors
`test/handles-python-codec.test.mjs`'s own "mandatory, not skippable" design exactly, but a line
protocol (`OP|field|field|...` in, `OK|result...`/`ERR|message` out) instead of JSON, since Java
ships no stdlib JSON parser and this repo's own A2/G2/G3 "no dependency when a simpler mechanism
suffices" ethos applies to test-only code too. **Correction found live while scoping this**: the
"never compiled" half of the original claim above was already stale by the time this slice
started -- `HandleCodec.java.tmpl` is unconditionally in `emit.mjs`'s `INFRA_FILES`, so the
`java-compile` CI job's real `./gradlew compileJava` was already compiling a rendered copy; what
was actually still open was narrower -- compilation was closed, behavioral execution-and-comparison
against the JS reference was not. That narrower scope needs zero Gradle/network (`HandleCodec.
java.tmpl` is pure `java.*` stdlib), so unlike the AST helper (A2 Phase 2) or `java-compile`/
`java-integration`, this test is cheap enough to run inside plain `npm test` on every invocation
(the same bar `python3` already cleared for the Python codec test) -- `actions/setup-java` added
to both jobs that run bare `npm test` (`test`, `macos`) to guarantee that. **A real, load-bearing
gotcha found and fixed before it could silently corrupt every no-pointer test vector**: Java's
`String.split("\\|")` silently drops TRAILING empty fields (`"a|b|".split("\\|")` has length 2, not
3) -- confirmed by direct execution -- while `split("\\|", -1)` preserves them; the driver's "empty
trailing field = no pointer" protocol design depends on the latter. Also newly confirmed by direct
execution, not assumed: `Base64.getUrlDecoder().decode()` really does throw on invalid-charset
input (`Illegal base64 character 21` for `"QU!JD"`) -- the mirror image of the Python codec test's
own confirmation that Python's `base64.urlsafe_b64decode` does NOT throw, together proving the
JS/Java-vs-Python asymmetry `D-security-10`'s own comment claims rather than assuming either half.

**Closed as a follow-up slice, `recover()` + `sbf_handle`/`sbf_handle_snapshot`**: this EXIT's own
precondition ("if O4, the Java side, ever actually gets implemented and used") held -- O4 shipped
this session (`a816312`) -- so this slice mirrors it into python-fastapi: new `tables.py.tmpl`
(SQLModel `HandleRegistry`/`HandleSnapshot`, same table names/columns/`unique(resource_type,
resource_uid, pointer)` constraint as Java's own migration.sql, so both providers' schemas agree
byte-for-byte at the DDL level), `handle_service.py.tmpl` (plain module-level functions taking
`session` explicitly -- matches this provider's own established convention, not Java's DI-injected
`@Service` class), `record_snapshot.py.tmpl` (the opt-in auto-recording decorator, deliberately
ONE file combining what Java splits into `@RecordHandleSnapshot` + `HandleAspect` -- Python
decorators natively ARE the interception mechanism, so preserving Java's two-file split would be
cargo-culting its file count, not an invariant), a real `GET /handles/{handle}/recover` route with
the FULL D-security-9 cross-check preserved (never weakened), and real field-level fetch
(`resolve_json_pointer`, new in `codec.py.tmpl`) walking the resolver's `to_public()` projection,
never the raw `fetch()` row -- a deliberate, security-preserving departure from Java's own literal
code shape (Java's `fetch()` already delegates to a response DTO; this provider's own `fetch()`
returns the raw ORM row by original G4 design, so walking it directly would reopen exactly the
column-leak vector `to_public()` exists to close).

Two genuinely ecosystem-specific design points, not mechanical ports: (1) `HandleSnapshot.payload`
is a native `JSONB` column holding a plain dict/list, never a manually (de)serialized string --
this makes Java's own double-encoding bug CLASS structurally impossible here, not merely avoided by
a matching fix (no `json.dumps`/`json.loads` round-trip exists anywhere in this design for
`recover()` to get wrong). (2) `resolve_json_pointer` needed a `_MISSING` sentinel, not `None`, for
"path absent" -- a literal JS port using `None` would have conflated "field is genuinely JSON null"
with "field doesn't exist," turning a present-but-null field into a 404 instead of 200-with-null; a
real correctness regression the JS/Java pair doesn't have, found while designing the port (JS's
`undefined` has no Python equivalent under a plain `dict.get()`), confirmed live with a real
present-null-field test vector before trusting it.

**A real design bug found and fixed by a live functional test, not just reasoning about it**: the
decorator's first draft wrapped a wrapped function's remaining (non-uid/non-session) arguments in
`{param_name: value}` unconditionally. For the common case (a single request DTO), this silently
broke every `redact` pointer -- `redact=["/internal_note"]` resolved against `{"request": {...}}`,
not the DTO's own top-level fields, so redaction looked like it worked (no error) but never
actually redacted anything. Caught live by a real functional test (a fake resolver + a decorated
function, asserting the recorded payload), not by review -- fixed to unwrap the sole remaining
argument (matching Java's `HandleAspect#requestPayload`'s own "sole survivor unwrapped" behavior
exactly), falling back to a name-keyed dict only when more than one non-uid/session parameter
remains (Python's bound arguments already carry names, unlike Java's positional-args array).
`resource_uid_param`/`session_param` are resolved via `inspect.signature(fn).bind(...)`, not a bare
positional index -- confirmed live that the SAME decorated function produces identical recordings
whether called positionally or by keyword, the exact class of bug a bare `args[index]` would
silently break for any keyword call (Java's AspectJ interception always hands positional args, so
this class of bug has no Java analog to port a fix from).

**Verified against a real, disposable Postgres** (new `scripts/python-integration-smoke.mjs` + CI
job `python-integration`, same `POSTGRES_HOST_AUTH_METHOD: trust`/own-DB-name convention
`db-introspect`/`java-integration` already established -- deliberately never SQLite, which could
hide a real Postgres-only bug in the emitted `jsonb`/`unique` constraints this whole exercise
exists to prove work), using FastAPI's own `TestClient` (real in-process ASGI request/response
cycles -- real routing, real Pydantic validation, real DI, real PATCH -- with no bound port at all)
rather than a literal `java-integration` mirror: Java needed a live bound port + `java.net.http.
HttpClient` specifically because `TestRestTemplate` can't do PATCH; no such forcing function exists
for Python, so `TestClient` proves the same real invariants at meaningfully lower cost. The REAL
emitted `migration.sql` is applied (never a hand-copied duplicate, matching `java-integration-
smoke.mjs`'s own precedent). The generated resolver's `check_access()` is a PERMANENT fail-closed
stub by design (this provider can never auto-generate a working one) -- every real HTTP call this
script makes would otherwise 403 before reaching the lifecycle logic under test, so the script
patches the SCRATCH COPY's generated `check_access()` to a no-op after a real `handles emit` already
generated the real stub, mirroring `test/fixtures/java-compile`'s own `TestSecurityConfig`
(unconditionally stamps a `ROLE_ADMIN` authentication onto every request -- "this test cares
whether the HANDLE LIFECYCLE plumbing works, not whether a real login flow does"); a real consumer
still gets the fail-closed stub, only this script's own scratch fixture is patched. Four scenarios,
1:1 with Java's own: full lifecycle, `schema_drift`, field-level fetch, persistence-layer
redaction (queries `HandleSnapshot` directly, not the HTTP response). One honestly-named scope
difference: since `patch_field()` is a **permanent** 501 stub (no generated PATCH path exists to
ever trigger the decorator through), "full lifecycle" calls a pre-decorated fixture service
function (`test/fixtures/python-fastapi/backend/app/services/item_service.py`, mirroring Java's
own `WidgetServiceImpl` fixture precedent) directly rather than through a synthetic HTTP PATCH.

**Three more real bugs found live while wiring the verification script itself, none in the
generated code**: SQLAlchemy's dialect registry only recognizes the `postgresql://` URL scheme,
not `postgres://` (which Node's `pg` accepts as an alias) -- a real `NoSuchModuleError`, not
assumed, fixed with a scheme normalization before the connection string reaches Python. SQLModel's
default table name for a class named `Item` is `item` (singular), not `items` -- a real
`UndefinedTable` error from a script that had assumed the plural form. Accessing an ORM object's
attribute after its owning `Session` has closed raises `DetachedInstanceError` -- fixed by reading
the needed value while still inside the `with Session(...) as session:` block, not after.

**Correction (slice 4, docs-only, no code change)**: this section's own COST bullet claimed "Field/
object-level handle fetch (`kind=f`/`kind=o`) stays unimplemented for Python, matching Java's own
current limit" -- true when this 1st-slice commit (`627c214`) shipped, but the "Closed as a
follow-up slice, `recover()`..." paragraph above already added real field-level fetch for Python
(`resolve_json_pointer` in `codec.py.tmpl`) without ever coming back to correct the earlier COST
claim -- and Java's own O4 (`a816312`) closed its half of "Java's own current limit" the same way,
also without a correcting note here. Both are now real, working, GET-only (`kind=f` + a pointer;
`patch_field()`/PATCH stays 501-only for `kind=f`) -- confirmed by reading `HandleController.
java.tmpl` (Java) and `router.py.tmpl` (Python) directly, not assumed. `kind='o'` (object) remains
the one genuinely open item: `handles/codec.mjs`'s own `encodeHandle` forbids `kind='o'` from ever
carrying a pointer, so it is byte-identical to `kind='r'` at runtime in every provider -- making it
distinct is an unscoped codec-level design question, not a fetch-support gap, and stays explicitly
deferred. Separately, this section's COST bullet also said "`src/`-layout and PEP 420 namespace
packages are refused outright" -- imprecise, conflating two different things: `detectImportRoot()`
(`handles/providers/python-fastapi/plan.mjs`) walks up through directories with a real `__init__.py`
regardless of what they're named, so a standard PyPA `src/<package>/__init__.py` layout already
plans and emits correctly today (see the new positive regression test in
`test/python-fastapi-handles.test.mjs`, added in this same slice). The only case genuinely refused
is PEP 420 *implicit namespace packages* -- omitting `__init__.py` entirely -- confirmed via real
research (WebSearch) to be a mechanism for splitting one Python namespace across multiple
separately-installable distributions (`google.cloud.*` is the canonical real-world example), not a
layout pattern a single self-contained backend service (this tool's actual target population) would
realistically use. Left refused, now correctly scoped rather than overstated.

**EXIT**: add a `--provider` override flag if a real N:1 (one adapter, multiple viable providers)
case is ever observed -- none has been, so it was not spec'd speculatively; see G5's own EXCLUDED
section for why this would also need real structural registry/plan() changes, not just a flag, if
that day ever comes. Relax the `SessionDep`-shaped-alias requirement (or add a second detection
pattern) if a real FastAPI app using a different session-dependency convention needs this provider.
Generalize `RESOLVER_OWNER_MARKER_RE`/`BSKEL_GENERATED_MARKER` further if a third provider's own
doc-comment convention doesn't fit the two `(...)`/`({@code ...})` forms this item's regex already
handles. Revisit `kind='o'` if a real use case for a genuinely distinct object-level address ever
appears -- would need a codec-level change (allowing `kind='o'` to carry a pointer with different
semantics than `kind=f`), not just router/resolver wiring.

Cross-references: `D-adapter-registry` (G1, the registry design this item's `handles/registry.mjs`
mirrors, and the EXIT that held this item back until a real second provider existed),
`D-handles-ownership` (O2, the manifest/conflict/force semantics `handles/_engine.mjs` preserves
completely unchanged), `D-fastapi-adapter` (G2, the scanner this provider's `plan()` consumes
unchanged, and the `operationId: null`/`api.operations: false` facts this item's fetch-route
detection had to route around), `D-artifact-determinism` (O6, the ambiguity-over-silent-pick
precedent both `detectBasePackage` and this item's own `detectImportRoot` follow), `D-security-10`
(the charset-validation fix this item found and closed a second time, independently, for Python),
`D-resolver-scope` (the reason `patch_field()` is always a stub, carried over identically),
`D-config-patch` (the "a human adds two lines" precedent this item's router-wiring note follows).

## D-typescript-express-provider (G5): a third scanner adapter + handles provider, and the ecosystem with no framework-maintained reference to verify against

**WHY**: slice 3 of 4 the user picked from G4's own "Explicitly NOT built" list, after slices 1-2
(the JS<->Java codec parity gap, and Python's `recover()`/snapshot lifecycle) closed as follow-up
paragraphs on G4 itself. This is different: G4-as-shipped never actually named `typescript-express`
in its own "Explicitly NOT built" list, only in pre-implementation prose -- confirmed by reading
the real shipped text before starting -- so this is new work, gets a new catalog letter (G5), not
another "Update" appended to G4. CATALOG.md's own G4 "Concrete approach" text names
`providers/typescript-express` as a hypothetical third provider; this item builds it for real.

**A real, permanent asymmetry with G2, stated honestly up front, not discovered partway through**:
G2 (python-fastapi) was verified against `fastapi/full-stack-fastapi-template`, the official
FastAPI-author-maintained reference stack. No Express equivalent exists -- Express is deliberately
unopinionated, and confirmed by real research (WebSearch + `gh api` star/fork/maintenance
comparison across 5 community boilerplates, not guessed) before writing a line of adapter code: no
framework-maintained reference stack exists for this ecosystem. Told to the user explicitly, who
chose to proceed with the best-validated real option: `mkosir/typeorm-express-typescript` (461
stars, 149 forks, not a fork itself -- by far the most-validated of the real candidates checked).
This item's own verification confidence is **permanently** weaker than G2's or G4's -- named as a
standing EXIT below, not a to-do a future slice is expected to close.

A Plan agent cloned the oracle fresh and read its real code (routes, entities, controllers,
middleware), not from memory of the general ecosystem -- 7 concrete facts from that reading drove
every non-mechanical design decision:
1. **TypeORM's API is stale in the oracle** (pinned `^0.2.45`, `getRepository()`, last pushed
   2022-10-14) -- TypeORM 0.3.x (current since ~Feb 2022) replaced this with an app-owned
   `DataSource` instance. Deliberately targets `DataSource`, not the oracle's own literal pattern
   -- named cost, stated plainly: running this against the oracle *as it exists today* generates
   **zero** resolvers, an accurate reflection the oracle is stale, not a bug in this provider.
2. **No `<Entity>Public`-equivalent convention exists** in this ecosystem's own real code -- the
   oracle's `password` column has no `{ select: false }` (TypeORM's real mechanism for this exists,
   the oracle simply doesn't use it); the only real protection is a hand-written `select: [...]`
   array literal per query, in each controller file. The precondition for generating a resolver is
   finding that literal in the fetch handler's own defining file -- reusing a convention this
   ecosystem's real code actually demonstrates, not inventing a Java/Python-shaped one it doesn't.
3. **Middleware arrays nest parens/brackets**: `checkRole(['ADMINISTRATOR'], true)` sits inside
   `router.get(path, [middlewares], handler)`'s own argument list -- needs balanced-paren scanning
   (`matchBalancedParens`/`splitTopLevelArgs`, the same technique `python-fastapi.mjs` already
   uses), not a naive regex.
4. **Route registration and read logic live in separate files**, connected by an `import`, often
   through one level of barrel re-export (`controllers/users/index.ts`: `export * from './show'`)
   -- resolving "what does this route actually do" needs following that one hop, no deeper, the
   same "narrow, not general" discipline every other cross-file resolution in this codebase follows.
5. **No local base path exists anywhere** -- unlike `@RequestMapping`/`APIRouter(prefix=...)`, a
   route's real absolute path only exists as the concatenation of `router.use('/literal',
   subRouter)` mount edges from a graph root down to the leaf file (2 hops in the oracle: `/` ->
   `/v1` -> `/users`). The single most novel piece of the new adapter (see Mechanism).
6. **`checkRole(...)` is a project-specific convention, not a framework mechanism** (unlike
   Spring's `@PreAuthorize`) -- deliberately NOT mined as an authority signal. A different real
   Express app could name this anything, or check inline in the handler body. `checkAccess`/
   `patchField` stay permanent fail-closed stubs, identical reasoning to both existing providers.
7. **Express 4 (the oracle's pinned version) does not auto-catch a rejected Promise** inside an
   async route handler (Express 5 does; can't be assumed of an arbitrary target app). Generated
   router handlers wrap every async body in an explicit `try`/`catch`.

Also independently re-verified, not assumed: Node's native TypeScript type-stripping. Confirmed
live on this machine (Node 26.7.0) that `node file.ts` runs directly with zero flags; Node 22.x
(this repo's CI floor) needs `--experimental-strip-types` explicitly, 23.6+/24.x/26.x have it
unflagged by default. Design consequence: `--experimental-strip-types` is always passed explicitly
in the codec test's `node` invocation -- safe across the whole 22-26 range (redundant-but-harmless
where already default), removing any version-conditional branching.

**SCOPE**: `scanners/adapters/typescript-express.mjs` (specificity 85, zero-registration, mirrors
G1's registry exactly); `handles/providers/typescript-express.mjs` + `typescript-express/{plan.mjs,
emit.mjs,templates/*}` (self-contained codec port, in-process registry, `fetch`/`toPublic` really
wired to TypeORM's `DataSource.getRepository(...).findOne(...)`, `checkAccess`/`patchField` always
stubs, GET+PATCH router, no migration/no `recover()` -- matches java-spring/python-fastapi's own
pre-follow-up 1st-slice state, not a gap specific to this provider); a synthetic, hand-built fixture
corpus (`test/fixtures/typescript-express/backend/`, real `package.json`/`tsconfig.json`, not a
vendored oracle copy, same P3 precedent as `test/fixtures/python-fastapi`); three new test files
(`test/typescript-express-cli.test.mjs`, `test/typescript-express-handles.test.mjs`,
`test/handles-typescript-codec.test.mjs`); a new `scripts/typescript-typecheck-smoke.mjs` + CI job
`typescript-compile`; two roster-test one-line additions (`test/adapter-registry.test.mjs`,
`test/handles-provider-registry.test.mjs`); a new `checkProviderConformance`/
`checkAdapterConformance` wiring in `test/conformance-harness.test.mjs` (P4).

**EXCLUDED** (named, not silently dropped): `recover()`/`sbf_handle`/`sbf_handle_snapshot` and their
migration (matches java-spring/python-fastapi's own pre-follow-up state, not a gap unique to this
provider -- a future slice could mirror G4's own Python follow-up here if a real need appears).
A `--provider` override flag -- not merely "no real N:1 case observed" (the original G4/G5-planning
reasoning), but genuinely **structural**: `handles/registry.mjs` requires a provider's `id` to equal
its own filename (one file = one id), and `providerById()` is an exact-id lookup with no
arbitration path at all -- there is no mechanism today to register two providers under the same id
to choose between. Beyond that, each provider's `plan()` is tightly coupled to its own adapter's
scan-report shape (java-spring needs `ep.operationId` truthy; python-fastapi keys on `ep.method`
because its own `operationId` is always `null`; this provider adds `idFieldIsUuid`/`DataSource`
checks neither other provider has) -- forcing e.g. `--provider python-fastapi` against a
typescript-express scan report would not produce a useful comparison, it would silently produce
`willGenerateResolver: false` everywhere or worse. Route-decorator authorization-signal extraction
(finding #6 above -- `checkRole(...)` is project-specific, unreliable as a framework-level signal).
Auto-wiring the generated router into the app's own router composition (two lines a human adds by
hand, same reasoning as `D-config-patch`). **`src/`-layout is actually the DEFAULT this provider
assumes** (opposite of python-fastapi, where an earlier, over-broad "`src/`-layout" exclusion was
itself later found to be misdescribed -- see the slice-4 correction below).

**Correction (slice 4, docs-only, no code change)**: this EXCLUDED list originally also named
"Field/object-level handle fetch (`kind=f`/`kind=o`), matching both existing providers' current
limit" -- **false the moment this was written**. `router.ts.tmpl`'s GET handler (see Mechanism,
`router.ts.tmpl`) already walks `resolveJsonPointer(publicObj, decoded.pointer)` whenever
`decoded.pointer` is non-null, regardless of `kind` -- the exact same generic, resolver-agnostic
logic java-spring's `HandleController.java.tmpl` (since `a816312`) and python-fastapi's
`router.py.tmpl` (since `2386368`) already ship. Field-level fetch (`kind=f` + a pointer) works via
GET in **all three** providers today. What genuinely has no distinct behavior is `kind='o'`
(object) -- `handles/codec.mjs`'s own `encodeHandle` (`if (kind !== 'f' && pointer) throw ...`)
means `kind='o'` can never carry a pointer under the current codec, so it is byte-identical to
`kind='r'` at runtime everywhere in this codebase; a repo-wide grep confirms no resolver, router
branch, or `plan.mjs` ever creates or branches on `kind='o'` distinctly. Making `kind='o'`
genuinely distinct from `kind='r'` (e.g. letting it carry a pointer with different semantics than
`kind=f`) is an unscoped **codec-level design question**, not a fetch-support gap -- explicitly
deferred, not attempted here. The one real, narrow gap this correction found: unlike java-spring
and python-fastapi, this provider shipped with **no test** exercising `router.ts.tmpl`'s GET
pointer-walk at runtime -- closed in the same slice-4 pass, see Verification below.

**Mechanism**:
- `detectTypeScriptExpressRoot()`: two independent signals required (package.json declares
  `express` via real `JSON.parse`, not a regex -- genuinely simpler than java-spring's build.gradle
  or python-fastapi's pyproject.toml, neither of which is real JSON -- AND at least one `.ts` file
  source-confirms `Router` imported from `'express'` plus `Router()` called), walking the whole
  repo tree for candidate `package.json` files the same monorepo-aware way python-fastapi does.
- **Mount-tree resolution** (finding #5): `buildMountEdges()` finds every `router.use('/literal',
  identifier)` edge and resolves `identifier` via THAT FILE'S OWN relative `import` only (bare/
  baseUrl-relative specifiers are deliberately not resolved here -- the oracle confirms mount edges
  are always relative). `prefixChainFor()` recursively walks from a mount-tree root (a file with no
  incoming edge) down to a leaf, joining prefixes. A computed/dynamic mount
  (`router.use(prefix, buildRouter())`) is skipped, never guessed at -- bounded, not general, the
  same discipline every other cross-file resolution in this codebase already follows.
- Entity extraction (`extractTableEntities()`): `@Entity('table')` or bare `@Entity()` (table =
  lowercased class name, mirroring SQLModel's own default-naming precedent), idField search scoped
  to just that class's own body (`{` to matching `}`) so a file with more than one entity class
  never finds the wrong class's primary key. Also captures `idFieldIsUuid`
  (`/['"]uuid['"]/.test(...)`) -- see the structural UUID constraint below.
- **A real, structural (not TypeScript-specific) constraint found live, not assumed**: this whole
  handle system's own token format (`kind:type:UUID[:pointer]`, `handles/codec.mjs`'s `HANDLE_RE`)
  can only ever address a UUID-shaped resource identifier. TypeORM's bare `@PrimaryGeneratedColumn()`
  (no argument) defaults to an auto-incrementing integer, not a UUID -- and the real oracle's own
  `User` entity uses exactly that bare form. Found via a genuine `tsc --noEmit` type error
  (`fetch(resourceUid: string)` vs. an entity `id: number`), not discovered by reading the codec
  spec first. Fixed by adding `idFieldIsUuid` detection to the scanner and gating
  `willGenerateResolver` on it in `plan.mjs`, with an honest refusal note naming the constraint --
  the correct, permanent behavior, not a temporary gap.
- `plan.mjs`'s `detectProjectRoot()`: nearest ancestor with BOTH `package.json` AND
  `tsconfig.json` among this module's own files (O6-style ambiguity refusal, mirrors
  `detectBasePackage`/`detectImportRoot` exactly); source root is `<root>/src` if it exists (the
  real oracle's own layout, and this provider's own default, unlike python-fastapi which excluded
  `src/`-layout support), else the project root itself.
- `resolveHandlerFile()`: follows the router file's own `import { handler } from specifier`, then
  ONE barrel hop (`export * from './x'`) if the resolved file doesn't define the handler itself --
  no deeper, matching finding #4.
- `findDataSource()`: `export const X = new DataSource({...})` -- or whatever name the app gives
  it -- via `DATA_SOURCE_RE`, same shallowest-then-name deterministic tie-break as python-fastapi's
  own `findSessionDep`.
- `willGenerateResolver` requires ALL of: a fetch route found, its handler file resolved, a literal
  `select: [...]` allow-list found in that file, an idField detected AND UUID-typed, and a
  `DataSource` found anywhere under `srcRoot`. Any single missing precondition blocks codegen with
  a note naming exactly which one and why (the leak risk for a missing select list, the structural
  UUID constraint for a non-UUID key, the stale-oracle-API gap for a missing `DataSource`).
- **`ResourceResolver` deliberately carries NO dataSource/session parameter** -- a genuine
  architectural difference from python-fastapi's own per-request `session`-threaded interface, not
  an arbitrary deviation from its shape. TypeORM's `DataSource` is an app-wide singleton
  instantiated once at startup, not a per-request-injected object the way SQLAlchemy's `Session`
  is; each generated resolver imports its own `DataSource` reference directly instead.
- **`codec.ts.tmpl` is a self-contained port, not an `import` of this CLI's own `handles/codec.mjs`**
  -- rejected concretely, not hand-waved, even though the target ecosystem is JS/TS-adjacent to this
  CLI's own runtime: importing this whole scaffolding tool into a generated file would make the
  entire `backend-skeleton` package a runtime dependency of the target app, architecturally wrong
  regardless of same-ecosystem convenience. Zero imports beyond `node:crypto`. The port's own
  `encodeHandle`/`deriveHandleUid` use positional arguments, not the JS reference's object-
  destructured `{kind, type, uuid, pointer}` form -- a deliberate call-site divergence (behavior-
  identical, not signature-identical; "port" here means byte-identical encode/decode output,
  verified by execution, not a literal function-signature transcription). Same
  `BASE64URL_CHARSET_RE` D-security-10 guard both existing ports needed -- Node's own
  `Buffer.from(str, 'base64')` (this file's own runtime) has the identical silent-discard behavior,
  confirmed live, not assumed to carry over from the JS reference by proximity alone.
  `resolveJsonPointer` needed **no** `_MISSING`-sentinel workaround (unlike the Python port) --
  TypeScript/JavaScript already distinguishes `undefined` (absent) from a genuine `null`, so this
  is a direct, unmodified port of the JS reference's own logic, confirmed live.
- `router.ts` is emitted as **unconditional infra**, unlike python-fastapi's own `SessionDep`-gated
  router -- no equivalent precondition exists here (TypeORM's `DataSource` is imported directly by
  each resolver, never injected per-request the way FastAPI's `Depends()`/SQLAlchemy `Session` is).
- `emit.mjs` regenerates `resolvers_index.ts`'s barrel import list from the resolvers directory's
  REAL current contents on every run (not just this run's own `resolverUnits`) -- an orphaned
  resolver from a different feature/module (O2's "never delete, only report" policy leaves it on
  disk) still needs its own `register(...)` call imported, or that resource type silently stops
  being servable. Unconditional, like `migration.sql` is for java-spring -- never manifest-tracked.

**Real bugs found and fixed while building this, none hypothetical**:
- `npm install typescript` with no version pin installs TS 7.0.2 (a preview/rewrite with real
  breaking config changes -- removed `moduleResolution: "node"`/`baseUrl` support), not mainstream
  TS 5.x -- fixed by pinning `typescript@^5` explicitly in the fixture's own devDependency.
- Sequential separate `npm install --no-save <pkg>` calls in the same scratch directory silently
  pruned previously-installed packages -- fixed by combining every package into ONE `npm install`
  call (both in ad-hoc scratch verification and in `scripts/typescript-typecheck-smoke.mjs`).
- `req.params.handle` is really typed `string | string[]` by `@types/express-serve-static-core`'s
  own `ParamsDictionary` -- fixed with explicit `typeof ... !== 'string'` guards in `router.ts.tmpl`
  (both routes) and in the fixture's own handler.
- `strictPropertyInitialization` rejects a decorator-initialized entity field with no constructor
  assignment -- fixed using TypeScript's definite-assignment assertion (`id!: string;`), matching
  real-world TypeORM+strict convention; this then broke the idField-extraction regex (`(\w+)\s*:`
  doesn't match `id!:`), fixed to `(\w+)\s*!?\s*:`.
- `bskel handles plan` showed a stale `idField: null` after the scanner regex was already fixed --
  root cause: `bskel scan`'s own cached report (`specs/<feature>/brownfield-scan.json`) isn't
  regenerated automatically when scanner code changes; `handles plan` reads that cache, not live
  source. Not a provider bug -- a real, reusable debugging trap for this whole tool's own
  scan-then-plan pipeline, worth naming here for future sessions.

**Verification**: 33 net new tests (`test/handles-typescript-codec.test.mjs` x9 -- mandatory, not
skippable, inside plain `npm test`, needing no external toolchain beyond Node itself, unlike the
Java/Python codec tests -- the `NAMESPACE_DNS`+`"example.com"` reference vector, encode-in-JS/
decode-in-TypeScript and encode-in-TypeScript/decode-in-JS round trips including a JSON Pointer
with `~0`/`~1` escapes and a non-ASCII type name, all 3 base64 padding-remainder classes,
`deriveHandleUid` parity, the null-vs-missing `resolveJsonPointer` distinction, D-security-10
negative parity; `test/typescript-express-cli.test.mjs` x6 -- adapter selection/specificity,
real 2-hop mount-tree resolution with no local base path anywhere, balanced-paren middleware
extraction, entity/idField/idFieldIsUuid extraction, honest capability declaration via `doctor
--json`, full CLI e2e dispatch; `test/typescript-express-handles.test.mjs` x13 -- plan-unit tests
isolating each `willGenerateResolver` gating condition independently (missing select list, non-UUID
PK, no fetch route at all, project-root ambiguity/absence), e2e exact-file-set/no-migration-
artifact/never-references-the-excluded-column/idempotent-re-emit/hand-edit-blocks-at-exit-15).
Two roster-test additions (`test/adapter-registry.test.mjs`, `test/handles-provider-registry.
test.mjs`) proving the zero-registration claim against the real 4-adapter/3-provider roster, not a
hand-picked pair; the pre-existing "biconditional" test (`codegen.handles === true` iff a provider
is loaded) required zero code changes -- it already generalizes over every real shipped adapter.
`test/conformance-harness.test.mjs` gained a real fixture wiring (`checkAdapterConformance`/
`checkProviderConformance` against `test/fixtures/typescript-express/`), passing on first run.
**A real fixture-authoring bug found and fixed during this item's own test-writing, not in
production code**: a plan-unit fixture's own explanatory comment, `// deliberately no select:
[...] allow-list here`, accidentally satisfied the `select\s*:\s*\[([^\]]*)\]` regex it was meant
to demonstrate the ABSENCE of -- caught live by the test actually failing, not assumed correct;
fixed by rewording the comment, not by weakening the regex (the regex was correct all along).
`npm run test:typescript-compile` (new `scripts/typescript-typecheck-smoke.mjs`, real `npm install`
+ real `npx tsc --noEmit` against the emitted tree, zero errors) -- proves generated code actually
TYPE-CHECKS against real TypeORM/Express types, which the codec test alone cannot (TypeScript's
whole value proposition is its compiler; a runtime-parity test alone would be answering the wrong
question for this language). New CI job `typescript-compile` (mirrors `java-compile`/
`python-import`'s dedicated-job shape, genuinely cheaper to set up -- no JVM/Gradle, no Python
venv, just `npm install`, something this whole CLI already depends on). `npm test`: 709 -> **742**.

Against the real oracle (`mkosir/typeorm-express-typescript`, read-only, no throwaway branch or
push -- this item's own oracle-check is a one-time hand-verified reading pass, not a live CI
dependency, matching P3's own rejection of a live third-party-repo oracle): `bskel doctor` detects
it as `typescript-express`; `bskel scan --terms user` correctly extracts routes and entities;
`handles plan` correctly reports **zero** resolvers generated, exactly the predicted, honest
consequence of finding #1 (the oracle's own stale `getRepository()` API) -- not a false negative,
an accurate reflection that this provider targets the ecosystem's *current* canonical API, not this
one oracle's dated snapshot of it.

**COST**: no `recover()` path (EXCLUDED above). `checkAccess()` always denies until hand-wired --
every resolver ships non-functional for reads until a human completes it, by design. `patchField()`
always 501s. `kind='o'` (object) handles have no distinct behavior from `kind='r'` -- see the
slice-4 correction under EXCLUDED above (field-level fetch via `kind=f` + a pointer already works
on GET, shipped in this same commit). An entity with a non-UUID primary key can NEVER get a working
resolver through this
provider (a structural fact about this whole project's handle scheme, not a bug to fix later). The
generated router needs two lines of manual wiring into the app's own router composition. A mount
edge that isn't a plain relative `router.use('/literal', identifier)` (a computed prefix, a
non-relative import) is silently skipped, not guessed at. **This item's own real-world verification
confidence is permanently lower than G2's or G4's** -- grounded in one real, hand-read (not
continuously CI-checked) community oracle rather than a framework-maintained reference stack; the
committed synthetic fixture carries the suite's ongoing regression weight going forward, resting on
a single grounding pass rather than a canonical source of truth. This is a standing property of
building for an unopinionated ecosystem, not a temporary gap this item left for later.

**EXIT**: the confidence gap named above is permanent, not a to-do -- re-verify against a fresher or
different real Express/TypeORM app if one becomes available, but do not expect it to ever match
G2's own footing. Add `recover()`/snapshot support if a real need appears (mirroring G4's own Python
follow-up) -- not built speculatively, matching this project's own Data-First Numerics discipline.
Add a `--provider` override flag if a real N:1 case is ever observed (still none, across three
providers now). Relax the `DataSource`-shaped-detection requirement (or add a second pattern) if a
real TypeORM app using a different app-owned-instance naming convention needs this provider.
Generalize mount-edge resolution beyond single-relative-import `router.use()` calls if a real target
app's own mount pattern doesn't fit (e.g. a computed prefix built from a config value).

Cross-references: `D-adapter-registry` (G1, the registry design `scanners/registry.mjs` and
`handles/registry.mjs` both mirror unchanged), `D-fastapi-adapter` (G2, the "second first-class
adapter" precedent this item follows a third time, and the reference-oracle bar this item explicitly
cannot meet), `D-handles-providers` (G4, the provider-split + fail-closed-stub + zero-registration
mechanism this item is the third real consumer of, and the "EXCLUDED, named not dropped" discipline
this item's own EXCLUDED section follows), `D-artifact-determinism` (O6, the ambiguity-over-
silent-pick precedent `detectProjectRoot()` follows), `D-security-10` (the charset-validation
guard this item's codec port needed and confirmed live for Node's own `Buffer.from`),
`D-resolver-scope` (the reason `patchField()` is always a stub, carried over identically),
`D-config-patch` (the "a human adds two lines" precedent this item's router-wiring note follows),
`D-fixture-corpus` (P3, the synthetic-not-vendored fixture precedent this item's own corpus
follows, and the "no live third-party-repo oracle in CI" reasoning this item's own oracle-check
explicitly matches).

## D-cli-contract (D2): strict argument parsing, one exit-code table, and a JSON error channel that is added to the existing output rather than replacing it

**WHY**: three real bugs, all reproduced live, not hypothetical. (1) `bskel verify --feature
--json` -- the pre-D2 `parseFlags()` let a value-taking flag's missing value silently swallow the
NEXT token as its own value, so `--feature` consumed the literal string `"--json"`, which then
failed `requireValidFeatureId()` with an **uncaught throw** -- a full Node stack trace on stderr
and exit 1, for what should have been a one-line usage error. (2) `bskel preflight --max-behind
abc` -- `scripts/preflight-base-ref.sh`'s `[ "$BEHIND" -gt "$MAX_BEHIND" ]` comparison, given a
non-numeric `$MAX_BEHIND`, fails with a bash arithmetic error (`integer expression expected`,
status 2) that `set -euo pipefail` does **not** catch (the error is inside a `[ ]` test, not a bare
statement) -- the comparison is simply treated as false. Reproduced live against a genuinely
1-commit-stale worktree: the pre-fix script reported `{"verdict":"PASS", "behind":1, ...}` at exit
0, silently disabling this tool's entire reason for existing (the stale-base check that this
project itself started from -- a worktree branched 658 commits behind the real default branch).
(3) `bskel status 001-widget` (a common typo for `--feature 001-widget`) silently absorbed the
stray positional and reported a "repo scope only" success at exit 0 -- the most common mistake a
human/agent makes with this command was invisible. Exit-code definitions were also scattered
across three places with no cross-reference (`lib/gates.mjs`'s `EXIT`, 4 values; ~6 more literal
numbers in `bin/bskel.mjs`; 3 more -- `11`/`12`/`13` -- defined only inside
`scripts/preflight-base-ref.sh`, invisible to any JS-side reference), and `--help`/`--version`/
`--quiet` did not exist at all.

**SCOPE**: `node:util.parseArgs`-based strict parsing (`lib/cli.mjs`, one `COMMANDS` table
mechanically transcribed from the pre-D2 `parseFlags()` call sites -- 18 commands, byte-identical
defaults, proven by a default-value snapshot test), a single exit-code table (`lib/exit-codes.mjs`,
`lib/gates.mjs`'s `EXIT` now assembled from it and re-exported unchanged), global `--help`/
`--version`/`--json`/`--quiet`, an additive `sbf.cli-diagnostic/1` JSON envelope for payload-less
early-exit failures when `--json` is set, a clean diagnosis for the two crash classes above
(uncaught validation throws, the swallowed-value ambiguity), and two directly-related side fixes
found during the audit: a numeric guard in `scripts/preflight-base-ref.sh` itself (bug 2, since the
script is documented as reusable standalone and must not rely on `bskel`'s own pre-validation), and
materializing a `{{PORT}}` substitution site in `stack/bootstrap/ngrok.sh` (found while auditing
`--port`: it had **zero effect** on the deployed script regardless of value, because
`stack/apply.mjs`'s `planApply()` already computed and passed a `PORT` template variable that the
template itself never referenced -- adding numeric validation to a flag with no effect would have
been validation theater, not a real fix).

**Re-estimated scope, and what was rejected**: the catalog's own M estimate, and its concrete-
approach text ("every handler returns `{ok,code,command,diagnostics,next_actions}`"), did not
survive contact with the real code -- confirmed by direct execution, not assumed. `bskel scan
--json`, `contract emit --json`, and `handles plan --json` each print a **schema-validated
artifact document** (`schemas/scan-report.schema.json` / `feature-contract.schema.json` /
`handles-plan.schema.json`, two of which are `additionalProperties:false`), and `cmdScan` writes
the identical object to stdout and to `specs/<id>/brownfield-scan.json` in the same call --
wrapping or merging keys into that output would make `bskel scan --json > brownfield-scan.json`
fail its own schema. Separately, this CLI already runs on the model "a non-zero exit does not mean
an empty payload" -- `verify --json` returns its real report at exit 1, `scan --json` returns the
real report at exit 16/3, `handles emit --json` returns `{written, conflicts, ...}` at exit 15,
`contract validate --json` returns `{ok:false, errors:[...]}` at exit 1 -- and 12+ existing tests
assert exactly those shapes. A uniform envelope would have broken all of it. The approved design
(user-selected "A+" over a minimal "A" and the catalog's own full envelope, presented with real
before/after evidence) instead adds the envelope **only** on payload-less early-exit paths, leaving
every payload-bearing exit and every schema-validated stdout artifact completely untouched.

**EXCLUDED** (and why): exit-code renumbering -- the numbers are already a public contract
(`SKILL.md` documents several directly, 11+ existing tests across 6+ files assert specific values)
-- instead, exit 2's long-standing double meaning ("a gate this command depends on hasn't passed"
vs. "a referenced resource/adapter/provider doesn't exist") is disambiguated by a `reason` string
in the diagnostic envelope, never by a new number. `package.json`'s inaccurate `engines: ">=18"`
(P1's job). JSON-encoding a successful run's stderr advisory notes (already an established,
tested convention -- see A2's "a diagnostic side-channel note belongs on stderr regardless of what
shape stdout takes"). Short flags (`-h`/`-v`/`-j`) and `--no-<flag>` negation (`allowNegative` is
Node 22.4+; this project's declared floor is 20.11, unverified locally -- not used without being
able to confirm it). Shell completion. A `--json` output compact/pretty toggle.

**Mechanism**:
- `lib/cli.mjs`'s `parseCommand(name, argv)` returns the **exact same shape** the old
  `parseFlags()` did (`{ _: [...positionals], ...values }`) -- every pre-existing `flags.feature`/
  `flags._[0]`/`flags['max-behind']` reference in `bin/bskel.mjs` needed zero changes. Internally:
  `util.parseArgs({strict:true, allowPositionals: <only for the 3 `gate` subcommands>})`, with
  per-flag `default` applied AFTER parsing (handing a `null` string default straight to
  `parseArgs` throws `ERR_INVALID_ARG_TYPE` -- confirmed by direct execution on Node v26.5.0, not
  assumed), numeric fields validated as a plain digit string (`/^(0|[1-9]\d*)$/` plus min/max --
  never forced through `Number()`, so `--port`'s existing `Number.parseInt()` call and
  `--max-behind`'s existing string pass-through to the bash script are unchanged), and `required`
  fields whose failure message is always the command's own `usage` line -- exactly what every
  pre-D2 required-flag check already printed (confirmed per call site, not assumed).
- Real `node:util.parseArgs` behavior confirmed by direct execution (v26.5.0): an unknown flag
  throws `ERR_PARSE_ARGS_UNKNOWN_OPTION`; a missing value throws
  `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`; `--feature --json` (the exact shape of bug 1) throws
  "argument is ambiguous" -- the precise fix for the swallowed-value crash; `--feature=--json`
  (an explicit inline value) is correctly accepted, never ambiguous;
  `allowPositionals:true`/`false` correctly supports `gate require <name> --feature <id>` while
  rejecting a stray positional everywhere else.
- Every command's parsing now happens **first**, before `requireRepoRoot()`/
  `requirePreflightPassed()` -- previously several commands called those guards before parsing,
  so `--json` was unknown at the moment a guard could fail. This is an observable, intentional
  change: a non-git directory combined with an unknown flag now reports the argument error (14)
  rather than the directory error (10) -- no existing test asserted the old ordering for that
  specific combination (verified by direct execution against the affected commands).
- `fail(code, reason, message)` / `exitWithDiagnostic(code, reason, message)`: the stderr text is
  **always exactly what it was before** (same strings, same call sites, same multi-line blocks for
  the handful of commands with multi-part explanations) -- the JSON envelope, when `CTX.json` is
  set, is purely additive on top, never a replacement. `CTX` is process-lifetime module state
  (`{command, json, quiet}`, set once right after a command's own `parseCommand()` succeeds) --
  the same lifetime class as `process.exitCode` itself; threading it through ~20 helper functions'
  parameter lists for a value fixed for the life of one invocation would be pure noise.
- Exit 2's `reason` disambiguation: `GATE_NOT_PASSED` / `MISSING_ARTIFACT` / `ADAPTER_UNAVAILABLE`
  / `PROVIDER_UNAVAILABLE` / `UNKNOWN_OPERATION` / `SCAN_FAILED` / `PLAN_FAILED`, plus one each for
  `BAD_ARGS`(14) / `NOT_A_REPO`(10) / `MISSING_CAPABILITY`(17) / `GATE_AWAITING_DISPOSITION`(3) /
  `GATE_STALE`(4) -- 12 reasons total, covering every code that can appear in a diagnostic
  envelope. Exit 15 (`handles emit` conflict) and 16 (`scan` low-confidence) never appear in a
  diagnostic envelope at all -- both are payload-bearing exits (the real conflict/report data is
  already on stdout), so they need no `reason` disambiguation.
- `main()`'s try/catch is the single point that turns an uncaught `CliUsageError` (from
  `parseCommand()`) or a plain, message-only `Error` thrown by a domain validator
  (`requireValidFeatureId`/`requireValidSlug`/`requireValidFeatureOrRepoId`, or a malformed-state
  read) into a clean one-line diagnosis at exit 14 -- this is what fixes bug 1 and the `status
  --feature bogus` crash class. A genuine JS-native error (`TypeError`/`ReferenceError`/
  `RangeError`) is treated differently -- `bskel: internal error: ...` at exit 1, stack shown only
  under `BSKEL_DEBUG=1` -- since that signals a bug in this codebase, not a bad user input; no new
  error class was introduced in `lib/featureid.mjs` to make this distinction, the JS-native-error-
  type check already does it correctly for every reachable case.
- `--help`: per-command (`renderCommandHelp(name)`, stdout, exit 0, checked before required-field
  validation so `handles emit --help` works without `--feature`) and top-level (`bskel --help`/
  `bskel help`/bare `bskel`, stdout, exit 0). `usage()`'s exact shape -- a single template literal
  passed directly to `console.error` -- is preserved byte-for-byte, because
  `test/doc-integrity.test.mjs`'s existing drift guard parses it as source text via a regex that
  requires exactly that shape. The stdout path is a local, temporary `console.error` -> `console.log`
  redirect around a real call to `usage()` (`printUsageToStdout()`), not a second copy of the
  banner text -- avoids the two copies silently drifting apart, at the cost of one small, clearly-
  commented redirect.
- `--version`: reads `package.json`'s `version` at call time (no hardcoding -- automatically
  tracks whatever P1 eventually publishes).
- `--quiet`: suppresses only human-rendered **narration** stdout (`renderScanMarkdown`/
  `renderVerifyReport`/`renderStackPlan`/`renderHandlesPlan`/`wrote N file(s)`/`gate: X -> Y`/
  `VERIFY: PASS`-class lines) -- never a `--json` payload, never an "always-JSON" command's sole
  output (`gate require`/`force`/`show`, `feature init`, `contract validate`/`tool-schema`, `scan
  disposition` -- these commands' one console.log call **is** their payload, not narration, so
  `--quiet` does not touch it), and never stderr (warnings/blocking explanations stay visible
  unconditionally -- silencing them would manufacture exactly the "quiet failure" class this
  project has consistently refused elsewhere). `bskel next`'s single stdout line is a deliberate
  exception -- it IS the command's entire payload (a copy-pasteable command for `$(bskel next)`),
  not narration, so `--quiet` does not affect it either.

**Verification**: `npm test` 386 -> **444** (a net 58: 54 in the new `test/cli-contract.test.mjs`
covering parse-unit behavior, the full 18-command default-value snapshot, numeric validation,
static regression guards -- every `process.exit`/`process.exitCode` literal in `bin/bskel.mjs` is
in the exit-code table, `parseFlags(` no longer exists -- and e2e coverage of every claim above;
2 in `test/preflight.test.mjs` and `test/stack-cli.test.mjs` for the two side fixes; 2 in
`test/doc-integrity.test.mjs`, a new bidirectional drift guard between `usage()`'s prose and
`lib/cli.mjs`'s `COMMANDS` table). **All 386 pre-existing tests pass completely unmodified** --
the load-bearing proof that this was a genuine behavior-preserving restructuring, not a rewrite
that happened to still pass.

Real-world, against Team-IZ-Backend (an isolated worktree off `origin/develop`, cleaned up after):
a full pre/post command-transcript capture (every command, `--json` on and off, ~43 invocations)
was taken before implementation began and re-taken after, then diffed byte-for-byte. Every
difference fell into exactly the three predicted classes (a new global flag's output, a new
diagnostic envelope on a previously-empty stdout, or the parsing-first ordering change) plus
unavoidable timestamp noise from re-running the same stateful workflow twice, plus the two
deliberate side fixes -- zero unexplained differences. Pipe-truncation safety re-confirmed directly
(`scan --terms a --json` piped: 217909 bytes, byte-identical to a direct-to-file capture -- the
`D-process-exit-audit` `process.exitCode` sites were not touched). The stale-base bypass (bug 2)
was demonstrated by executing the actual pre-D2 script (`git show`) against a freshly built,
genuinely-one-commit-stale clean worktree: `--max-behind abc` reported `{"verdict":"PASS",
"behind":1}` at exit 0 on the old script, and is rejected outright at exit 14 on the fixed one,
with a same-worktree sanity check confirming a *valid* `--max-behind` still correctly reports
`STALE_BASE` (exit 11) -- the fix closes the bypass without weakening the real check.

**COST**: exit 2's public contract is now two-layered (the number is authoritative; `reason` is
"stable but supplementary" and requires reading the envelope, not just the exit code, for full
precision). A non-git directory combined with a bad flag now reports the argument error before the
directory error (see Mechanism). Bare `bskel` and `--help` now write to stdout instead of stderr.
`--quiet` was invented for this item with no prior specification to match -- its scope (narration
only) is this item's own judgment call, not a pre-existing convention. `usage()`'s stdout path is
a temporary `console.error` redirect rather than a second, independent render function.

**EXIT**: if a genuine need for a fully uniform `{ok,code,command,...}` envelope emerges later, add
it behind an explicit opt-in flag (e.g. `--envelope`) that leaves the default, schema-validated
artifact outputs completely untouched -- do not retrofit the default behavior, for the same reason
this item didn't. If exit 2's `reason` values prove insufficient (a genuinely new failure class that
doesn't fit any of the 7 existing sub-reasons), add a new `reason` string, not a new exit code,
unless a real caller needs to distinguish it by exit code alone without parsing the envelope. Short
flags and `--no-<flag>` negation, if `util.parseArgs`'s `allowNegative` is confirmed available on
this project's actual minimum supported Node version.

Cross-references: `D-adapter-registry` (G1) and `D-handles-providers` (G4), whose own capability-
dispatch exit codes (17) and `MISSING_CAPABILITY` messaging this item's `reason` taxonomy absorbs
unchanged; `D-process-exit-audit`, whose `process.exitCode` (not `process.exit()`) sites on large-
payload commands this item re-verifies rather than disturbs; `D-status-next` (D1), whose
`computeWorkflowState()`/`next_actions` shape this item's gate-blocked diagnostics reuse directly
rather than inventing a second remediation format; `D-doctor-workflow` (D5), the precedent for
`--workflow`-style optional/required check separation this item's own `required`-field design in
`lib/cli.mjs` follows.

## D-preflight-freshness (S3): a passed preflight can no longer stay green just because nobody asked it again

**WHY**: `scripts/preflight-base-ref.sh`'s `git fetch` was completely swallowed (`2>/dev/null ||
true`) -- confirmed by direct execution, not assumed. Built a real fixture: a bare origin, a work
clone, a second clone that genuinely pushes a new commit to origin (the remote really did move),
then broke `work`'s origin URL to a nonexistent path and ran the pre-fix script (`git show
2cb0db4:scripts/preflight-base-ref.sh`, the last commit before this item):
```
$ /tmp/s3-pre-fix.sh --json   # broken origin URL, remote genuinely 1 commit ahead
exit=0
{"verdict":"PASS","evidence":{...,"behind":0,...}}
```
Zero bytes of stderr. A fully offline/unreachable remote was computing `behind`/`ahead` against
whatever stale local `origin/develop` ref already existed and reporting PASS regardless -- the
same failure class as this project's own origin story (a worktree branched 658 commits behind the
real default branch, silently). Separately, the stored gate token was only ever `{head_sha,
default_branch}` -- a passed preflight had no expiry and no way to notice the remote moved,
however long ago it was checked.

**SCOPE**: two halves, approved together (user-selected "S3a+S3b together" over "S3a only", with
real before/after evidence and Team-IZ-Backend's actual commit cadence presented first).
- **S3a**: `git fetch` now fails closed. `--offline` (new canonical name; `--no-fetch` kept as an
  exact, permanent alias -- see Mechanism) is required to skip it; otherwise a failed fetch exits
  a new code, `18 REFRESH_FAILED`, immediately. `--fetch-timeout-seconds` (default 60) bounds the
  fetch itself. Evidence gained `origin_tip_sha`, `checked_at`, `worktree_dirty` (now always
  computed, not only under `--allow-dirty`), `fetch` (`ok`/`failed`/`skipped`), `policy`, and a
  `cross_check` object making each of the three default-branch sources' outcome
  (`ok`/`failed`/`empty`/`unavailable`) observable instead of collapsing failure and inapplicable
  into the same empty string.
- **S3b**: the preflight gate's `recompute()` gained `origin_tip_sha` (a purely local `git
  rev-parse refs/remotes/origin/<branch>`, added alongside `head_sha`/`default_branch`, never
  replacing them), so `require` can notice a local remote-tracking ref moved since the gate last
  passed. And a TTL: `freshness: { defaultMaxAgeMinutes: 30 }` on the gate definition, checked in
  `requireGate()` against the gate record's own `at` timestamp (not the token/`inputs`
  comparison), so a preflight pass goes stale purely from age even when nothing else changed.
  `--max-age-minutes` (default 30, `0` disables) is recorded into the pass's own evidence at
  preflight time, so a later policy-default change never retroactively re-judges an
  already-passed gate under a different rule than the one it passed under.

**Re-estimated scope**: the catalog's own M-sized code estimate held, but the observable behavior
radius is L -- this item can newly cause an **already-passed** preflight to block downstream
commands purely because time passed, which the catalog's original framing (fetch-failure
detection only) did not anticipate. Presented to the user as three explicit decisions before
implementation (scope S3a-only vs. S3a+S3b, TTL default, whether to expose
`--fetch-timeout-seconds`), each with real data, not a guess -- all three resolved to the
recommended option.

**Data behind the 30-minute default**: Team-IZ-Backend's actual `origin/develop` commit cadence
(109 commits over 35.8 days): p10=3m, p25=25m, **median=100m**, p75=264m, p90=17h. Treating
"P(the remote tip moves again before the TTL expires)" as an upper bound on "this pass could be
silently wrong by the time it's used": 15m -> 2.7%, **30m -> 5.1%**, 45m -> 7.3%, 60m -> 9.4%, 24h
-> 59.0% (proving a day-long TTL would be meaningless). 30 minutes is the largest round value
still under 5%. Re-derive for any repo with:
```
git log --first-parent --format=%ct origin/<default> | awk 'NR==1{p=$1;next}
{d=p-$1;if(d>=0)g[n++]=d;p=$1}END{s=0;for(i=0;i<n;i++)s+=g[i];ttl=1800;num=0;
for(i=0;i<n;i++)num+=(g[i]<ttl?g[i]:ttl);printf "P(moved within %dmin)=%.3f\n",ttl/60,num/s}'
```

**EXCLUDED** (and why): cross-check "at least 2 of 3 sources must agree" as a hard failure --
conflicts directly with `D-doctor-workflow` (D5)'s already-shipped precedent ("no `gh` binary
degrades one source, never hard-fails") and would break every existing fixture, which all resolve
the default branch from exactly one source. `forced` gates gaining a time-based expiry -- that is
S4's "expiry by time, commit, or next input change" territory; a forced pass stays exempt from TTL
here, unchanged. `bskel doctor` gaining an origin-reachability check -- conflicts with D5's own
"preflight needs nothing but git+node" decision. Skipping the fetch when a *previous* fetch
recently succeeded (a fetch-result cache) -- moves in the wrong direction for an item whose entire
point is freshness. A new `.sbf/preflight.json` state file -- `origin_tip_sha`'s real-world value
is already secondary (see Mechanism's honesty note below), not worth a second state file. A full
`refs/remotes/origin/*` manifest -- noise overwhelms signal for one branch's staleness question.
`core.sshCommand` timeout injection for ssh remotes -- risks clobbering a user's own ssh config.
An environment-variable TTL override -- would create a silent, undocumented way to defeat the
freshness check outside the auditable `--max-age-minutes` flag. A TTL exemption for `--offline`
passes -- one rule ("age of the pass"), not two; an offline user who wants no expiry uses
`--max-age-minutes 0` explicitly, the same escape hatch everyone else has.

**Mechanism**:
- `scripts/preflight-base-ref.sh`: `--offline`/`--no-fetch` (exact alias -- predates this item, is
  already documented in SKILL.md, the script's own header calls it "reusable outside this skill"
  so an external caller may depend on the old name, and it wasn't worth a breaking rename for a
  flag whose meaning is unchanged). The fetch call itself:
  `git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=$FETCH_TIMEOUT fetch origin
  "$DEFAULT_BRANCH" --quiet` with its exit status and first stderr line captured explicitly (no
  `|| true`); on failure, `fail 18 REFRESH_FAILED "... re-run with --offline ..."`.
  `http.lowSpeedLimit`/`lowSpeedTime` only bounds http(s) transports -- a local path or ssh remote
  ignores them, so `bin/bskel.mjs::cmdPreflight` also passes `execFileSync(...,
  {timeout: (fetchTimeoutSeconds+10)*1000})` as a universal backstop (this script has no portable
  `timeout(1)` to rely on -- not present on macOS by default).
- `lib/repo.mjs::remoteTrackingTip(cwd, branch)`: `git rev-parse --verify --quiet
  refs/remotes/origin/<branch>`, null-safe, same try/catch->null style as `localDefaultBranch()`.
  **Honesty note**: this is purely local. `require` noticing this value moved only means something
  ELSE already fetched into this repo since the gate last passed -- if nothing has, the value is
  unchanged and this check is a complete no-op. This limitation is deliberately not overstated
  anywhere in SKILL.md or this entry; it is the TTL (not this) that carries the real freshness
  guarantee for a repo where nothing else happens to fetch in between.
- `lib/gates.mjs::checkFreshness(def, record)`: runs in `requireGate()` **after** the existing
  token comparison (an actual input change is always the more specific, more actionable answer)
  and is skipped entirely for `record.forced` gates. Reads `record.evidence?.freshness
  ?.max_age_minutes ?? def.freshness.defaultMaxAgeMinutes`; `0` (either source) disables the TTL.
  `age_seconds` is `Date.now() - Date.parse(record.at)`, clamped to `>= 0` (a future `at` -- clock
  rewind -- reads as "as fresh as possible", never as extra-stale). A missing/unparseable `at`
  fails closed as `invalid_timestamp`, never a silent pass. Deliberately does **not** put the
  timestamp inside `inputs` (the token-comparison object) -- confirmed by direct execution that
  doing so would make every single `require()` call report a change, since "now" is never equal
  to the recorded instant.
- `lib/gate-definitions.mjs`: preflight's `recompute` returns `{head_sha, default_branch,
  origin_tip_sha}` -- `head_sha` is kept, not replaced (`D-gate-precision`, S2, already committed
  to this for 4 gates including preflight; removing it would break the "a commit stales preflight
  too" assumption `test/contract-cli.test.mjs`/`test/handles-ownership-cli.test.mjs` depend on).
  `freshness: { defaultMaxAgeMinutes: 30 }` is the one "freshness policy" slot S1's own catalog
  entry asked for but never had a gate to fill; every other gate (scan/contract/handles/stack)
  declares none, and `checkFreshness()` treats an absent declaration as "not applicable" --
  pinned by `test/gate-definitions.test.mjs`.
- `bin/bskel.mjs::cmdPreflight`: on a script timeout that fires before any stdout is produced,
  `JSON.parse` would previously throw uncaught -- now wrapped, reporting `REFRESH_FAILED`
  explicitly instead of an internal-error stack trace. On PASS, merges `evidence.freshness =
  {max_age_minutes}` into the script's own evidence before `passNamedGate`. When
  `localDefaultBranch(root)` is null (no local `origin/HEAD`) but the script still resolved a real
  default branch (via `remote show`/`gh api`), prints a one-time stderr note suggesting `git
  remote set-head origin <branch>` -- detection only, the established "never a silent fix"
  convention this project already follows for `path_prefix_signals` (`D-openapi-reconciliation`).

**Verification**: `npm test` 444 -> **466** (22 net new: 5 in `test/preflight.test.mjs` for the
new evidence fields/REFRESH_FAILED/`--offline`↔`--no-fetch` equivalence/the pre-existing
WRONG_DEFAULT-not-REFRESH_FAILED case/`worktree_dirty` accuracy; 8 in `test/gates.test.mjs` for
TTL expiry, TTL-within-window, token-change-wins-over-TTL, `max_age_minutes:0`, gates with no
freshness declaration, forced-gate exemption, invalid timestamp, clock-rewind clamping; 2 in
`test/gate-definitions.test.mjs` confirming `origin_tip_sha` is present and only `preflight`
declares `freshness`; 2 numeric-validation tests in `test/cli-contract.test.mjs`; 5 in a new
`test/preflight-freshness.test.mjs` covering local remote-tracking movement detection, the
honesty case (no local fetch = undetected), TTL blocking `scan --feature`, `--max-age-minutes 0`
disabling it, and the origin/HEAD-unset case). **All 444 pre-existing tests pass unmodified** --
the fail-closed transition does not break them because every fixture's origin is a local bare
repo, where `git fetch` genuinely succeeds; only 5 tests hardcode `--no-fetch` and are unaffected
by the rename.

Real-world evidence (isolated scratch fixture -- bare origin + work clone + a second clone that
genuinely pushes an advancing commit -- never touching Team-IZ-Backend itself), all three states
side by side:
```
PRE-FIX   (broken URL, remote genuinely 1 commit ahead): exit=0  {"verdict":"PASS",...,"behind":0} -- 0 bytes stderr
POST-FIX  (same state, no --offline):                    exit=18 {"verdict":"FAIL","reason":"REFRESH_FAILED",
                                                                    "message":"could not refresh 'develop' from origin
                                                                    (git fetch exited 128: fatal: '/definitely/not/a/repo'
                                                                    does not appear to be a git repository) -- fix
                                                                    connectivity, or re-run with --offline ..."}
POST-FIX  (same state, --offline):                       exit=0  {"verdict":"PASS", "fetch":"skipped",
                                                                    "cross_check":{"sources_ok":1,"remote_show":"failed",...}}
POST-FIX  (origin URL fixed, re-run):                     exit=11 {"verdict":"FAIL","reason":"STALE_BASE","evidence":{
                                                                    "behind":1,"fetch":"ok","origin_tip_sha":"<real tip>",
                                                                    "cross_check":{"sources_ok":2,...}}}
```
TTL, against the same fixture: `.sbf/_repo.json`'s `gates.preflight.at` backdated 35 minutes ->
`bskel gate require preflight --json` reports `code:4, status:"stale", stale_reason:"ttl_expired",
age_seconds:2108, max_age_seconds:1800` (exactly the 30-minute default); `bskel status`/`next`/
`scan --feature` all correctly block on it (`next` prints `# preflight gate is stale (ttl_expired,
35m old > 30m limit)` on stderr; `scan` returns the `sbf.cli-diagnostic/1` envelope with
`next_actions[0].command: "bskel preflight"`). `bskel preflight --max-age-minutes 0` followed by
the same 35-minute backdate leaves `gate require` reporting `code:0, status:"pass"` -- TTL
correctly disabled end-to-end.

**COST**: an already-passed preflight can now go stale on its own, purely from elapsed time --
previously a pass was permanent until an input actually changed. A fully offline workflow now
requires an explicit `--offline` (or `--max-age-minutes 0` to also silence the TTL) rather than
working by default. `origin_tip_sha`'s real-world detection power is honestly limited (see
Mechanism) -- it only helps when something else already fetched into the repo between passes; the
TTL, not this field, is what actually bounds staleness in the common case. `cross_check`'s
`sources_ok` count is informational only, per `D-doctor-workflow`'s precedent -- a repo that has
only ever resolved its default branch from one source stays fully functional, just visibly so now.

**EXIT**: if a real caller needs the 3-way cross-check to hard-fail below 2 sources, that is a
new, opt-in flag (e.g. `--require-cross-check`), not a change to the default -- the default must
keep working for every existing single-source repo. If `origin_tip_sha`'s local-only limitation
proves too weak in practice, the next step is `bskel doctor` gaining an explicit,
separately-opted-in reachability probe -- not silently making `preflight` or `require` fetch
where they don't today. If 30 minutes proves wrong for a specific repo, re-derive with the
one-liner above and override via that repo's own `--max-age-minutes` usage (e.g. a wrapper script
or CI job default) rather than changing the shipped default for every consumer.

Cross-references: `D-gate-precision` (S2), whose "preflight keeps head_sha" decision this item
extends rather than revisits; `D-doctor-workflow` (D5), whose optional-source-degrades-gracefully
precedent this item's `cross_check` design and EXCLUDED list both follow directly; `D-cli-contract`
(D2), whose "new failure class gets a new exit code, never a renumbering" rule `18
REFRESH_FAILED` follows, and whose `fail()`/diagnostic-envelope mechanism this item reuses
unchanged; `D-status-next` (D1), whose `next_actions` rendering this item's `ttl_expired` detail
extends with age/limit wording rather than inventing a second format.

## D-fixture-corpus (P3): a frozen, committed fixture corpus + a real CI pipeline, replacing a live third-party repo as this suite's main oracle

**WHY**: `test/scan.test.mjs`/`test/contract.test.mjs`'s strongest tests -- the Organization/
Curriculum module oracles, D-security-1's full evil-`operation_id`x-direction matrix, D-security-2's
urn:uuid rejection -- were all gated behind `fs.existsSync(~/Desktop/Team-IZ-Backend/build.gradle)`,
and no CI configuration existed anywhere in this repo. Confirmed by direct execution: absent -> 450
pass/16 skip/0 fail (clean); **present -> 465 pass/1 FAIL**. The failure is real: `contract.test.mjs`'s
curriculum-module oracle asserted "8 endpoints, 2 operations, 6 unmatched" -- the real repo had
already moved to 10/5/5 by the time this item started. Tracing exactly when: the assertion was
written in `0205e3f` (2026-08-16 02:10); the real repo's curriculum controllers changed 7 times
since, most recently `82cd769` -- **all three numbers moved in 4 days**, purely from unrelated
Team-IZ-Backend development. This is not a one-off: it is the live demonstration of exactly what
this item exists to fix -- a "strongest" oracle that is not just skip-prone when the dependency is
absent, but actively fragile even when it's present, because it depends on someone else's
continuously-developed private repository as ground truth.

A second, independent finding during this item's own grounding: probing `scanners/adapters/
java-spring.mjs`'s mapping-extraction regex directly (not reading it, executing it) surfaced a real
scanner bug that had never been caught -- a multi-line `@Operation` **description** text block that
merely *mentions* the literal string `operationId = "..."` as documentation prose injects a phantom
entry into `controller.operationIds`, even though it was never inside a real annotation attribute.
The real Team-IZ-Backend repo has 143 multi-line `@Operation` blocks (so multiline annotations ARE
exercised there) but a probe across all 37 real controllers found **zero** mismatches -- the real
repo's style is simultaneously too unstable an oracle for exact counts and too uniform a corpus to
ever exercise this class of edge case. Building this item's own fixture surfaced five more,
distinct scanner blind spots (an intervening annotation between the mapping and `public`, a comment
in the same position, whitespace inside a generic return type, mapping-and-`public` on one line, and
`@RequestMapping(method=...)` instead of a verb-specific `*Mapping` annotation) -- all now pinned as
a committed, reproducible baseline for CATALOG.md's A2 ("a staged Java analyzer"), the item that
would actually fix them; **P3's job is documenting these limitations, not fixing them**.

**SCOPE** (Option B, user-selected over "CI + fixture corpus only" and over "everything including
macOS + a Python import-check upgrade", after direct-execution evidence was presented for each):
- A frozen, clean-room-synthetic Java fixture corpus (`test/fixtures/java-spring/`) reproducing:
  the Organization/Operator two-controller module (10+5 operations, all multi-line `@Operation`
  blocks, complete/zero-warnings), a genuinely partial Curriculum module (8 endpoints/2 operations/
  6 unmatched, **frozen numbers this fixture now owns outright** -- they can never drift again), a
  zero-controller `codeanalysis`-shaped module (`CONTRACT_EMPTY`), all three `@PreAuthorize`
  branches `findRequiredAuthority()` must distinguish (class-level fallback, method-level -- and
  specifically NOT the wrong method's role, the exact D-security-7 regression -- and an unsupported
  `hasAnyRole(...)` shape failing closed to `TODO_ROLE`), all three service-arity cases
  `countServiceMethodParams()` must distinguish (1-arg success, 2-arg D-security-8 rejection, no
  service file at all), and the six scanner-blind-spot cases above.
- A second, separately-built fixture (`test/fixtures/java-compile/`) that IS actually compiled --
  `scripts/java-compile-smoke.mjs` runs the full gated workflow (`preflight` -> `feature init` ->
  `scan` -> `scan disposition` -> `contract emit` -> `handles emit`) against it, then routes the
  final check through `bskel verify --feature ... --build` (not a direct `gradle` call), so it also
  exercises `lib/verify.mjs::detectBuildCommand()`'s real `./gradlew` path end-to-end.
- `.github/workflows/ci.yml`: three jobs (`test` matrix Node 22/24, `package-install`, `java-compile`),
  Linux only.
- The `package-install` job runs `npm run test:pack`, which (once merged into `main` alongside
  P1) resolves to `test/package-install.test.mjs` -- `npm pack` -> install the real tarball into a
  scratch project -> run the *installed* `bskel` binary from `node_modules/.bin`, not `node
  bin/bskel.mjs` -- the only place a missing `bin` entry or a runtime asset left out of the
  tarball would ever surface. This item originally wrote its own standalone
  `scripts/pack-install-smoke.sh` for the same purpose; once P1 landed with an equivalent
  `node:test`-based version, the shell script was dropped rather than keeping two overlapping
  implementations (see `D-npm-packaging` below).
- `test/package-manifest.test.mjs`, `test/ci-workflow.test.mjs`: static safety nets for the two
  things `npm test` alone cannot verify (what actually ships in the tarball; whether the CI workflow
  itself stays coupled to the source it's testing).
- The 16 gated tests in `test/scan.test.mjs`/`test/contract.test.mjs` were **rewritten as
  drift-resistant invariants** (status/relative-count checks, e.g. `endpoint_count > operation_count`
  and `unmatched.length === endpoint_count - operation_count`, instead of hardcoded numbers), kept
  as real-Team-IZ-Backend smoke tests rather than deleted outright -- the exact-count precision now
  lives entirely in the frozen fixture tests, but the real-repo smoke tests have historically caught
  genuine bugs the synthetic fixtures couldn't have (the OperatorController basePath-affinity bug
  that motivated `findFetchOperation`'s name-affinity check, `test/handles-plan.test.mjs`'s own
  regression comment) and are worth keeping as a live sanity check, now structurally incapable of
  going red from someone else's unrelated feature work.

**Re-estimated scope**: the catalog's own M estimate does not hold -- six separable deliverables
(frozen fixture corpus, CI pipeline, package-install test, Java-compile fixture, the two prior items
combined into one net-new capability this project has never had, plus the rewritten-as-invariant
gated tests), roughly L, the same M->L pattern as S3 and G4 before it. Presented to the user as three
options (A: CI+fixture corpus only; B: A+Java-compile fixture, **recommended and selected**;
C: B+macOS+a Python `ast.parse`->real-import upgrade) with real evidence for each, not a guess.

**EXCLUDED** (and why):
- **Consolidating the 10 near-duplicate `buildFixtureRepo()` implementations** across existing
  `test/*-cli.test.mjs` files. They share a name and an idiom, not semantics (each encodes
  different fixture content); unifying them is a 10-file, 130+-call-site refactor that would mix a
  behavior-preserving refactor into a coverage-adding change, and make this item's diff unreviewable.
  P3 introduces no 11th variant of the pattern -- the new fixture corpora are scanned/compiled
  in-place or copied by a single-purpose script, not a shared `buildFixtureRepo()`-shaped helper. A
  future item can tackle the consolidation on its own.
- **A macOS CI job** (deferred to **P3b**, a new catalog entry alongside the Python
  `ast.parse`->real-import upgrade). This repo is Private -- confirmed via `gh api`, `visibility:
  PRIVATE` -- and Actions on private repos bill macOS runners at GitHub's published 10x multiplier
  versus Linux. This codebase has, to date, only ever been executed on macOS (every prior session's
  verification work), so a macOS CI job's marginal value is mostly re-testing an already-exercised
  platform, while Linux -- genuinely never run before this item -- is where CI's value is highest.
  The catalog's own "Run Linux/macOS" framing is inverted here on purpose.
- **Fixing `package.json`'s `engines: ">=18"`** -- already owned by CATALOG.md's P1, confirmed
  unfixed as of this item (still `>=18`, still known-inaccurate against `import.meta.dirname`'s real
  >=20.11.0 requirement, documented at `lib/doctor.mjs:14-18`'s own comment). The CI Node matrix
  reads `lib/doctor.mjs`'s `MIN_NODE` (now exported specifically so `test/ci-workflow.test.mjs` can
  assert this coupling) as its source of truth, never the declared-but-wrong `package.json` field.
  **Update, once both items merged into `main` together**: P1 landed and fixed the underlying
  `import.meta.dirname` outlier rather than raising the floor -- `engines: ">=18"` and
  `MIN_NODE = {18, 0}` are both now genuinely accurate, not just consistent-with-each-other. See
  `D-npm-packaging` below.
- **Testing the literal documented floor (Node 20.11.0) in CI.** Downloaded and ran the full suite
  against it directly (official `nodejs.org` darwin-arm64 tarball, since neither this machine's
  Homebrew nor any local package manager offers that exact patch). Result: **461/466**, with 4
  failures beyond the (already-explained) curriculum drift, all sharing one root cause:
  `execFileSync`-captured child-process stdout truncated at **exactly 8192 bytes**
  (`generic-grep-cli.test.mjs:124`, `stack-cli.test.mjs:36,68,226`) -- `Expected double-quoted
  property name in JSON at position 8192` / `Unterminated string in JSON at position 8192`. Ruled out
  a test-methodology artifact first: re-ran with the target Node version prepended to `PATH` (so
  both the parent test-runner process and every child `bskel` subprocess it spawns via
  `execFileSync('node', ...)` use the identical binary, exactly matching how `actions/setup-node`
  would resolve it in real CI) -- same failure, same four tests, confirming this is a genuine Node
  20.11.0 core bug, not a mixed-version artifact. Node **20.20.2** (Homebrew's current 20.x, the
  latest 20.x patch), **22.23.2**, **24.18.0**, and this machine's default **26.7.0** are all clean
  (465/466, curriculum drift only). The bug is already fixed by a later 20.x patch release; pinning
  CI to the literal earliest 20.11.0 build would make it permanently red for a reason unrelated to
  this codebase and unfixable from this repo -- no real caller ever gets that exact patch either
  (version managers and CI runners resolve "20"/"20.x" to the current patch, never the historical
  first build). Secondary, corroborating context (not a technical constraint on this Node-only CLI
  tool, which is never itself deployed anywhere): AWS App Runner's Node.js managed runtimes are, and
  have only ever been, `nodejs12/14/16/18/22` (confirmed live against `docs.aws.amazon.com/apprunner`,
  2026-08-20) -- **Node 20 was never offered at all**, jumping 18 straight to 22, and as of
  2025-12-01 only 22 remains supported. `lib/doctor.mjs`'s documented floor claim itself is
  unchanged (it is a real language-feature requirement, `import.meta.dirname`, unrelated to this
  bug) -- only the CI matrix excludes the literal patch.
- **A dedicated `test/helpers/fixtures.mjs` shared module.** Planned for "fixture-path resolution +
  copy-to-scratch-git-repo", but turned out unnecessary in practice: `test/scan-fixture.test.mjs`/
  `test/contract-fixture.test.mjs`/`test/handles-plan-fixture.test.mjs` all scan
  `test/fixtures/java-spring/` **in place** (`runScan()` needs no git, confirmed at
  `scanners/index.mjs:56` -- only `build.gradle`+`src/main/java`), and the one caller that genuinely
  needs a scratch-git-repo copy (`scripts/java-compile-smoke.mjs`) is a standalone script, not a
  second test file, with no second caller to share code with. Introducing the abstraction anyway
  would have been premature -- one real caller does not need an extraction.
- **A Python `ast.parse`->real-`import` upgrade** for `test/python-fastapi-handles.test.mjs`'s
  syntax-only check on `router.py`/`resolver.py` (`codec.py`/`registry.py` already have genuinely
  strong coverage via `test/handles-python-codec.test.mjs`'s real functional round-trip). A real
  improvement, cheaper than the Java-compile fixture (no compiler toolchain, just `pip install
  fastapi sqlmodel`), but deferred to **P3b** alongside the macOS job to keep this item's diff
  scoped to what was actually decided.

**Mechanism**:
- `test/fixtures/java-spring/`: `com.example.app` package tree under `domain/{organization,
  curriculum,codeanalysis,security,annotationstyles}/`. Every multiline `@Operation` uses a Java
  text block (`"""..."""`) for its `description`, matching the real repo's own style (found by
  direct grep of Team-IZ-Backend, not assumed). The `annotationstyles` package's six broken-shape
  controllers are each isolated in their OWN file/class -- found by direct execution that
  `extractController()`'s mapping regex's `(?:\(([\s\S]*?)\))?` lazy-backtrack capture group
  searches the **entire rest of the file**, not just the immediately-following lines, for any later
  `)` followed by `\n\s*public`; a broken shape placed before another valid method in the same file
  doesn't just get dropped, it can get **misattributed** to that unrelated later method instead
  (confirmed live while building this fixture -- an early single-file draft produced a
  `"/annotation-styles/Dropped: an intervening annotation..."` path, the mapping's own args capture
  having swallowed everything up to a much-later method). One-per-file removes that confound and
  shows each case's true, unconfounded "no match at all" behavior. A second, subtler instance of the
  same lazy-backtrack hazard: this fixture's OWN explanatory code comments must never spell a mapping
  annotation's name immediately followed by `(` (e.g. writing `` `@GetMapping(...)` `` in prose) --
  doing so once created a second, unintended match-start candidate for the very regex being
  documented (also found live, and fixed by rephrasing the comment and using a bare, argument-less
  `@GetMapping` in the fixture instead of one with a quoted path that could accidentally still
  "work" for the wrong reason).
- `test/fixtures/java-compile/`: Spring Boot 3.x (`spring-boot-starter-web`/`-data-jpa` -- confirmed
  Hibernate 6/Jakarta from the generated `HandleSnapshot.java.tmpl`'s `org.hibernate.type.SqlTypes`
  import, not javax/Boot 2.x -- `/-security`, `springdoc-openapi-starter-webmvc-ui`), Lombok
  (`compileOnly`+`annotationProcessor`), Java 17 toolchain (confirmed sufficient: `HandleCodec.
  java.tmpl` uses a `record` and an arrow-`switch`, nothing needs 21). No Gradle wrapper is
  committed -- `gradle wrapper --gradle-version 8.8` runs at CI/local-run time
  (`scripts/java-compile-smoke.mjs`), so a local run can never accidentally commit a wrapper jar.
- `scripts/java-compile-smoke.mjs`: copies the fixture to a scratch dir, `git init`+bare
  origin+push (required for `preflight`), generates the wrapper, then runs the identical CLI
  sequence `test/handles-cli.test.mjs`'s `runWorkflowThroughContract()` already establishes
  (`preflight` -> `feature init` -> `scan` -> `scan disposition --mode reuse` -> `contract emit` ->
  `handles emit`), then `bskel verify --feature ... --build --json`, asserting `report.pass === true`.
  Verified locally end-to-end through `handles emit` (9 files generated, including a correctly-typed
  `WidgetResolver.java` with `requiredAuthority() -> "ADMIN"` matching the fixture's
  `@PreAuthorize`) -- `gradle` itself is not on this machine's PATH, so the wrapper-generation and
  actual `compileJava` steps get their first real execution in CI.
- `.github/workflows/ci.yml`: `concurrency: {cancel-in-progress: true}` to stop burning minutes on
  superseded pushes; `permissions: contents: read` (least privilege -- no job needs to write);
  `ripgrep` installed explicitly on the `test` job rather than assumed present on the runner image;
  `actions/*`/`gradle/actions/setup-gradle` pinned to major-version tags (not full SHAs -- this
  repo's `sha_pinning_required` is `false`, confirmed via `gh api`, and there are zero secrets to
  protect, confirmed `gh api .../actions/secrets` returns `total_count: 0`, so this is a deliberate,
  low-stakes choice, not an oversight).

**Verification**: `npm test` 466 -> **495** (29 net new: 9 in `test/scan-fixture.test.mjs`, 13 in
`test/contract-fixture.test.mjs`, 5 in `test/handles-plan-fixture.test.mjs`, 4 in
`test/package-manifest.test.mjs`, 5 in `test/ci-workflow.test.mjs` -- minus a net reduction inside
`test/scan.test.mjs`/`test/contract.test.mjs` from consolidating 16 gated exact-count tests into 8
invariant-based smoke tests). All new fixture-corpus tests pass against a live scan of the committed
fixture (not just read -- every assertion in this section was checked by direct execution against
`runScan()`/`buildContract()`/`planHandles()`, including catching and fixing the lazy-backtrack
misattribution and the self-referential-comment bugs above before locking in the final fixture).
`actionlint` (freshly installed via `brew install actionlint` for this verification, together with
its `shellcheck` dependency) reports zero findings against `.github/workflows/ci.yml`. **Update,
once both items merged into `main` together**: `npm test` 473 (P1's own count) -> **499** --
`test/package-manifest.test.mjs` was NOT duplicated (P1's version, a strict superset, was kept;
this item's original version of the same file was discarded during the merge) and
`scripts/pack-install-smoke.sh` was dropped in favor of P1's equivalent
`test/package-install.test.mjs`, so the net-new count from this item alone, post-merge, is smaller
than the 29 cited above -- see `D-npm-packaging` below for the merge-time resolution.
**First real green run**: https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32324501590
(all 4 jobs passing: `java-compile` 2m0s, `test (22.x)` 3m52s, `test (24.x)` 3m50s,
`package-install` 29s). Confirmed green again at
https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32325034232 after adding
`paths-ignore: **/*.md` (found live: a docs-only commit right after the first green run still
triggered a full 4-job run -- pure wasted minutes, since nothing a doc-only change touches is
verified by any job). Took 3 iterations to get to the first green run, exactly the "2-3 red
iterations" this item's
own plan anticipated -- neither failure was reachable locally (this machine has no `gradle` on
PATH, so the java-compile job's actual execution only ever happened in CI): (1) `package-install`
and `java-compile` both failed with `bskel doctor`/`bskel scan` unable to find `rg` -- ripgrep was
never installed in either job, only in `test`; fixed by adding the same `apt-get install -y
ripgrep` step to both. (2) `java-compile` then failed at `bskel preflight` with `DIRTY` --
`gradle wrapper --gradle-version 8.8` runs AFTER the scratch repo's initial commit and writes
`gradlew`/`gradlew.bat`/`gradle/wrapper/*` into it, none of which were gitignored in the scratch
repo's own `.gitignore` (only `.gradle/`/`build/` were); fixed by adding those three patterns.
Both are exactly the class of bug this item's own verification section already warned "cannot be
tested by `npm test` alone" -- real, unpredicted, only surfaced by an actual GitHub Actions
execution.

**COST**: ~1300 LOC of hand-written, synthetic Java now needs to be kept in sync with
`scanners/adapters/java-spring.mjs`'s regex behavior by hand whenever that regex changes (the same
maintenance burden every other fixture-heavy test file in this suite already carries, not a new
class of cost). The 16 real-repo smoke tests are strictly weaker assertions than before (an
invariant, not an exact count) -- a real regression that happens to preserve the invariant (e.g. a
bug that changes `endpoint_count` and `operation_count` by the same amount) would no longer be
caught by the real-repo smoke test alone, only by the frozen fixture test. CI adds a first
network-dependent, JDK/Gradle-toolchain-dependent job (`java-compile`) with real (if currently
zero-secret, low-risk) supply-chain surface -- Maven Central, Gradle Plugin Portal, the Gradle
distribution download.

**EXIT**: if the `buildFixtureRepo()` consolidation becomes worth doing on its own, it's a
self-contained follow-up item, not a P3 dependency. If the macOS/Python-import work
(**P3b**) gets picked up, it composes cleanly on top of this item's CI skeleton (new job / one
line's worth of `python3 -c "import ..."` change) without touching anything here. If Node 20.11.0's
`execFileSync` bug turns out to matter for a real user (unlikely, given no version manager resolves
to that exact patch), the fix is narrowly scoped to CI matrix policy, not this item's design --
add it back once a newer Node 20.x patch is confirmed to also regress, or drop it permanently once
Node 20 goes fully EOL.

Cross-references: `D-doctor-workflow` (D5), whose `MIN_NODE` this item reads as the CI matrix's
single source of truth (now exported specifically for that coupling check) rather than
`package.json`'s known-inaccurate floor; `D-cli-contract` (D2), whose `EXIT_CODES`/diagnostic-
envelope mechanism this item's new scripts and tests reuse unchanged, introducing no new exit code
or reason string; `D-adapter-registry` (G1) and `D-handles-providers` (G4), whose registries this
item's fixture corpus exercises for the first time against real on-disk multi-provider-shaped Java
rather than a hand-built `scanReport`; `D-preflight-freshness` (S3), whose `--offline`/TTL machinery
`scripts/java-compile-smoke.mjs`'s scratch-repo `preflight` call runs through unmodified. CATALOG.md's
**A2** ("a staged Java analyzer") is the item this one's `annotationstyles` fixture hands a concrete,
committed before/after baseline to. CATALOG.md's **P1** ("npm packaging") landed first (see
`D-npm-packaging` immediately below) and already implements the `files` allowlist this item
anticipated -- its own `test/package-manifest.test.mjs` superseded (and is a strict superset of)
this item's original version of the same file; this item's tests were merged to build on P1's
version rather than duplicate it.

## D-npm-packaging (P1): a publishable package, a fixed Node floor, and a real README

**WHY**: `package.json` was `private: true` with no `files` allowlist (shipping the whole repo --
`npm pack` produced 96 files/1.15MB, of which `test/` alone was 37% of the unpacked size and
entirely unused by any runtime code path), no `README.md` existed anywhere in the tracked repo, and
the declared `engines.node` (`>=18`) was inaccurate against `contracts/validate.mjs`'s
`import.meta.dirname` (Node >=20.11.0). `lib/doctor.mjs` already knew and pointed the fix here (its
own `MIN_NODE`/remediation-message comments explicitly cited "P1 in CATALOG.md").

**Re-grounded before implementing, not assumed**: grepped the *actual* blast radius of the
`import.meta.dirname` bug rather than trusting the catalog's framing -- it is exactly **one**
runtime call site (`contracts/validate.mjs:26`), reached only via `loadEnvelopeSchema()` ->
`validateEnvelopeStructure()`/`validateEnvelope()`, which are only ever invoked from `bskel
contract validate` (`bin/bskel.mjs`'s `cmdContractValidate()`). Every other subcommand -- including
every other `contracts/*.mjs` function -- was completely unaffected; this was never a "the whole
CLI crashes on Node 18" bug, just a `Path must be a string. Received undefined` `TypeError` inside
one subcommand. Also grepped the whole runtime tree (`lib/`, `bin/`, `contracts/`, `scanners/`,
`handles/`, `stack/`) for every other commonly-cited recent-ES-addition (`structuredClone`,
`Object.groupBy`/`Map.groupBy`, `.toSorted`/`.toReversed`/`.toSpliced`/`.with`, `Array.fromAsync`,
`Promise.withResolvers`, global `fetch`, `node:sqlite`, `using`/`await using`,
`import.meta.resolve`, `AbortSignal.timeout`/`.any`) -- zero hits. `Object.hasOwn` (used
throughout, e.g. `lib/gates.mjs`, `lib/cli.mjs`, `contracts/openapi.mjs`) is ES2022/Node 16.9+; the
top-level `await` in `scanners/registry.mjs`/`handles/registry.mjs` is ESM/Node 14.8+ -- both
comfortably under the declared `>=18` floor.

**SCOPE**:
- Fixed the one outlier (`contracts/validate.mjs`, and the 3 equivalent test-only call sites in
  `test/contract.test.mjs`) to use the same `path.dirname(fileURLToPath(import.meta.url))` pattern
  every other file in this codebase already used -- **not** raising the engine floor, since the
  catalog's own two alternatives ("replace `import.meta.dirname`... or raise the engine floor")
  only need one, and fixing the one outlier is strictly better: it keeps compatibility wider for
  free, requires touching one call site instead of every consumer's expectations, and makes the
  already-declared `>=18` genuinely accurate instead of a second thing to keep in sync.
- `lib/doctor.mjs`'s `MIN_NODE` dropped from `{20, 11}` to `{18, 0}`, matching `package.json`'s own
  declared floor exactly -- restoring the doctor check's real purpose (catching Node <18, e.g. 16/14)
  instead of asserting a number the fix above made obsolete.
- `package.json`: `private` removed entirely (not set to `false` -- `npm publish` refuses a
  `private: true` package outright, and the field's mere presence is noise once removed is correct);
  `files` allowlist added (`bin/`, `lib/`, `contracts/`, `scanners/`, `handles/`, `stack/`,
  `schemas/`, `scripts/preflight-base-ref.sh`); `repository`/`homepage`/`bugs` filled in against the
  real, already-confirmed-owned GitHub remote (`popixoxipop-collab/backend-skeleton`, confirmed via
  `git remote -v` before any commit); a `test:pack` script added.
- `schemas/` is included as a whole directory rather than individually curated, even though 4 of
  its 9 files (`feature-contract`, `scan-report`, `handles-plan`, `state`) are currently unreferenced
  by any runtime code path (only by tests, or, per their own `description` fields / CATALOG.md's S5
  entry, intentionally documentation-only) -- the whole directory is ~24KB, and per-file curation
  here would be premature precision for negligible size savings.
- `SKILL.md` explicitly **excluded** from `files` (user-confirmed decision, not a unilateral
  default) -- it's pure Claude Code skill-integration metadata `bskel` never reads at runtime; a
  plain `npm install` consumer gets a working CLI, and this repo's own README explains where the
  fuller skill/workflow docs live for anyone who clones the repo directly.
- Two new tests: `test/package-manifest.test.mjs` (the `files` allowlist's own safety net --
  every assertion cross-checked against the actual source's import/read graph via grep, not a
  hand-maintained expected list, so a future new runtime dependency that forgets to update `files`
  fails loudly here) and `test/package-install.test.mjs` (`npm pack` -> install the real tarball
  into a scratch project -> run the *installed* `node_modules/.bin/bskel` binary, not `node
  bin/bskel.mjs` -- the only place a broken `bin` entry or a missing packaged asset would ever
  actually surface). Deliberately plain `node:test` files, not a separate shell script -- this repo
  has no CI yet (unlike a sibling, unmerged effort), so keeping this inside `npm test`'s normal
  `test/*.test.mjs` glob (plus a `test:pack` script for a standalone re-run, since a real pack+install
  round trip is slower than the rest of the suite) is the better fit for right now.
- `README.md` (new, repo root): quickstart (npm-install framing, not the pre-existing symlinked-skill
  framing `SKILL.md`'s own quickstart assumes), a compatibility table (sourced from `lib/doctor.mjs`'s
  own check list), a generated-file policy section (summarizing `D-handles-ownership`, O2), a security
  model section (summarizing the "Security hardening pass" findings above), a troubleshooting section
  (the exit-code table from `SKILL.md`'s own CLI-contract section plus the most common failure
  cases), and a "what ships in the package" section documenting the `files`/README-vs-SKILL.md split
  above so the asymmetry is never a surprise.

**EXCLUDED** (and why): actually running `npm publish` -- this item makes the package publishable
and verifies the pack/install round trip locally; publishing itself is a distinct, higher-stakes,
user-approval-gated action, not implied by "the package now CAN be published." Per-file curation
of the 4 currently-unused `schemas/*.schema.json` files out of the npm tarball -- negligible size
win, and a future item that starts loading one of them would otherwise need to remember to also
update `files`. A `CHANGELOG.md` -- not asked for by the catalog item's own concrete-approach text,
and this project's actual practice is decisions tracked in `DECISIONS.md`/commit history, not a
separate user-facing changelog; revisit only if real external consumers ask for one.

**Mechanism**: see SCOPE above -- this item's mechanism is almost entirely captured there (a
one-file code fix, a `package.json` config change, two new tests, one new doc file).

**Verification**: `npm test` unchanged in count from before this item except for the 2 new test
files (`test/package-manifest.test.mjs`: 6 tests; `test/package-install.test.mjs`: 1 test) -- all
pre-existing tests pass unmodified, confirming the `import.meta.dirname` fix is behavior-preserving
(direct execution: `validateEnvelopeStructure()` loads the identical schema before and after,
confirmed by running it against a real envelope both ways). `npm pack --dry-run --json`:
**96 files/1.15MB -> 65 files/417KB**; `test/`, `DECISIONS.md`, `CATALOG.md`, `SKILL.md` all
confirmed absent from the manifest; every schema/template/adapter/catalog file referenced by a live
grep of the source confirmed present. A full `npm pack` -> scratch-project `npm install` -> run the
installed `node_modules/.bin/bskel --version --json` and `bskel doctor --json` inside a real throwaway
git repo, both producing valid, expected JSON -- run directly, not just asserted in the test (the
test IS this same sequence, executed and passing).

**COST**: `SKILL.md` living outside the npm package means an `npm install`-only consumer has no
access to the fuller gated-workflow documentation unless they also clone the repository -- mitigated
by README.md summarizing the essentials and explicitly pointing at the repo for the rest, but a real
asymmetry, not a null cost. The `files` allowlist is now a second thing (alongside the actual
import/read graph) that must be kept in sync when a new runtime-required file is added --
`test/package-manifest.test.mjs` is the guard against silent drift, but it only catches drift that
already happened, not the discipline itself.

**EXIT**: if `SKILL.md`'s exclusion from the package proves to be a real usability problem for npm-
only consumers, add it to `files` -- a pure addition, no other change needed. If any of the 4
currently-unused `schemas/*.schema.json` files gains a real runtime consumer, no packaging change is
needed at all (the whole `schemas/` directory already ships). If this package is ever actually
published to the npm registry, that's a separate, explicit, user-approved action -- this item only
made it possible, correctly scoped, and locally verified.

Cross-references: `D-doctor-workflow` (D5), whose `MIN_NODE` this item corrects back to a
meaningful check (previously asserting a number this item's own fix made obsolete); `D-fixture-corpus`
(P3, above), which had already independently found and documented the exact same
`import.meta.dirname`/`MIN_NODE` situation while scoping a CI Node-version matrix -- this item is
the actual fix that item's own findings pointed at, and its own `test/package-manifest.test.mjs`
was rewritten to build on this item's version rather than duplicate it once both merged into `main`
together; `D-handles-ownership` (O2) and the "Security hardening pass" section, both summarized
(not duplicated) in the new `README.md`.

## D-macos-runner (P3b): self-hosted macOS Actions runner, and a same-PR security fix caught by automated review

**WHY (deferral background):** P3's own `test` job comment (`.github/workflows/ci.yml`) argued a
macOS Actions job would "mostly re-test the one platform already exercised daily" locally, and
P3b's catalog text deferred it purely on GitHub-hosted macOS's cost (10x Linux's per-minute rate on
this private repo). The user pointed out their own idle Mac mini (SSH alias `bob`) could serve as a
self-hosted runner instead -- self-hosted runners are unmetered/free regardless of OS (confirmed via
live web search: GitHub tried billing them in Dec 2025, reversed within 48h, still free as of
2026-08-20). Grounding before implementing: confirmed `bob` reachable (Apple Silicon, macOS 26.5.2,
10 CPU/16GB RAM/109GB free disk, Homebrew present), installed `node`/`ripgrep`/`openjdk@17`/`gradle`
via brew, obtained a runner registration token via `gh api .../actions/runners/registration-token
-X POST`, downloaded the latest runner release (`v2.336.0`), registered it as `bob-macmini`, and
installed it as a persistent launchd service (`./svc.sh install && ./svc.sh start`) so it survives
reboots/logouts.

**Scope actually shipped, vs. catalog:** a `macos` job running the full `npm test` suite (parity
with the Linux `test` job's scope, single Node version per P3b's own "single Node version" text) --
NOT a java-compile equivalent (the brew-installed `openjdk@17` is keg-only/not on PATH by default,
and `gradle`'s own dependency chain additionally pulled in a newer `openjdk` 26.x as ITS OWN
dependency; resolving which JDK a future macOS java-compile job should use was deliberately left
unscoped rather than guessed at). The Python codegen `ast.parse`-to-real-import upgrade (P3b's other
half) was NOT touched in this pass -- still open.

**SECURITY FINDING, caught by automated post-push commit review (not by me, not by the user) on
this job's very first pushed commit:** the job as first written ran on every `push`/`pull_request`
like the other jobs, matching the "self-hosted is free now, so no reason to restrict" reasoning that
replaced P3b's cost-driven "main-push + weekly cron only" hedge. That reasoning was correct about
cost and wrong about risk -- three real findings:

1. **self-hosted-runner-pr-rce**: `pull_request` (unlike `pull_request_target`) checks out and runs
   the PR HEAD's own workflow file and scripts. Running that on a self-hosted runner means anyone
   able to open a PR (any future collaborator, or an attacker who compromises write access) can
   execute arbitrary code directly on the user's personal, always-on Mac mini -- GitHub's own
   self-hosted-runner hardening guide names this exact combination as unsafe. Confirmed as a live,
   working path, not a theoretical one: the first commit's `pull_request`-triggered run on PR #2
   actually completed (all 5 checks green) on `bob-macmini` before the fix was pushed.
2. **persistent-workspace**: a self-hosted runner's `_work` directory is not wiped between jobs the
   way a disposable GitHub-hosted VM is -- `actions/checkout`'s default `clean: true` only resets
   the tracked repo directory, not arbitrary other state a job could leave on the host.
3. **runner-label-hijack**: the job originally matched on the generic `[self-hosted, macOS]` labels
   only -- ambiguous against any other self-hosted runner this repo/account might register later
   with the same generic labels.

**Fix, same PR, before merge:** `if: github.event_name != 'pull_request'` on the `macos` job --
it still appears (skipped, non-blocking) on PR checks, but only executes on `push`(main)/
`workflow_dispatch`, i.e. only someone who can already push to main (already fully trusted) can
cause anything to run here. Re-registered `bob-macmini` with an added unique `bob-macmini` label
and pinned `runs-on: [self-hosted, macOS, bob-macmini]` so this job can only ever be served by this
one specific machine. `clean: true` made explicit on `actions/checkout` (was already the default;
documented, not a behavior change) as a partial persistent-workspace mitigation.

**Residual risk, accepted and flagged rather than silently decided away:** the `_work` directory
still isn't wiped between trusted `push` runs -- full isolation would need `--ephemeral` runner mode
(re-registers after every single job), a bigger operational change not taken here. Revisit if this
repo ever gains a second committer, since the entire fix's trust model rests on "only someone who
can already push to main can trigger this job."

**Lesson for future cost-vs-security tradeoffs on this project:** the catalog's original
cost-driven restriction ("main-push + weekly cron only") happened to already provide most of this
security fix's benefit, for the wrong stated reason. Discarding a restriction because its ORIGINAL
justification stopped applying (cost, once the runner became free) without separately checking
whether a DIFFERENT justification (trust boundary) still applied is exactly the gap that let this
ship vulnerable on the first attempt.

**Verification, in order:** (1) first (vulnerable) commit's `pull_request` run on PR #2 completed
green, including `macos` -- proved the exploit path was live, not theoretical
(https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32330777878). (2) fix pushed;
re-ran PR #2 -- `macos` correctly shows `skipping` on `pull_request`, all 4 other checks still pass
(https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32331105711). (3) triggered
via `gh workflow run ci.yml --ref p3b-macos-runner` (workflow_dispatch) to prove the restricted
path still works before merging -- all 5 jobs, including `macos` on `bob-macmini`, completed green
(https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32331373012). (4) squash-merged
as `fe15df1`; the resulting real `push`-to-`main` run (the actual trigger this job now depends on
day-to-day, not workflow_dispatch) also completed all 5 jobs green
(https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32331926485) -- the first
genuine, unprompted proof this job works the way it will actually be used going forward.

**Update (2026-08-24): migrated the runner host from `bob-macmini` to `macstudio`.** Trigger: the
`23a15d9` (`beta-release-prep`) main-push CI run stalled indefinitely on the `macos` job --
`bob-macmini`'s launchd service had been deliberately stopped for unrelated maintenance and never
restarted, and `gh api .../actions/runners` showed zero registered runners for this repo. Rather
than just restarting `bob-macmini`, migrated to `macstudio` (the user's Mac Studio, already the
consistently-available/trusted machine for this user's other repos) for the same underlying reason
this job exists on a self-hosted runner at all: zero marginal cost regardless of which idle machine
hosts it, so the choice comes down to uptime, and `macstudio` has it.

Mechanically: confirmed `macstudio` reachable via the `macstudio` SSH alias (Mac13,1, 10 CPU, 64GB
RAM, macOS 26.6.1, Homebrew already present); `brew install node ripgrep openjdk@17 gradle` --
the exact same package set this job's original WHY section grounded for `bob-macmini`, kept for
parity rather than re-deriving a minimal set. Obtained a registration token via `gh api
repos/.../actions/runners/registration-token -X POST`, registered a fresh runner named `macstudio`
with a matching custom label, installed as a persistent per-user launchd service (`./svc.sh
install && ./svc.sh start` as user `eoe`, no `sudo` -- confirmed this doesn't need root the same
way `bob-macmini`'s did not).

**Real finding, not assumed:** `actions/setup-node`/`actions/setup-java` sidestep the "launchd
service PATH differs from an interactive shell" gotcha this job's own comment already named --
but `rg` has no such action and is the one dependency this job silently relies on the host's raw
PATH for. Confirmed directly, not by reading the runner's docs: `ps eww` on the freshly started
`Runner.Listener` process showed only `/usr/bin:/bin:/usr/sbin:/sbin` -- a launchd-started service
does NOT source `~/.zprofile`, so `brew`'s `/opt/homebrew/bin` was genuinely absent, not just
theoretically at risk. Fixed with a `.env` file in the runner's install directory (a real,
documented `actions/runner` mechanism, not a workaround) setting
`PATH=/opt/homebrew/bin:/opt/homebrew/opt/openjdk@17/bin:/usr/bin:/bin:/usr/sbin:/sbin`.

**Verification:** pushed the `runs-on` label change on branch `macos-runner-macstudio-migration`,
then `gh workflow run ci.yml --ref macos-runner-macstudio-migration` (workflow_dispatch, since
`macos` is a no-op on `pull_request` by design -- the only way to prove the new runner works
*before* merging) -- all 12 jobs green including `macos` on `macstudio`
(https://github.com/popixoxipop-collab/backend-skeleton/actions/runs/32683772845), the same
before-merge-proof pattern as the original `bob-macmini` verification above. `bob-macmini`'s own
runner registration was left in place (not deregistered) rather than force-removed sight-unseen --
its host is offline so it will simply show `offline` on GitHub's side, harmless, and easy to
formally deregister later once its actual state (decommissioned vs. temporarily off) is confirmed
with the user.

## D-python-import-check (P3b): real `import`, not `ast.parse`, for generated Python

**WHY:** `test/python-fastapi-handles.test.mjs`'s e2e suite used to assert every generated `.py`
file was syntactically valid via `python3 -c "import ast; ast.parse(...)"`. `ast.parse` only proves
a file PARSES -- it cannot catch a real name/API mismatch, e.g. a generated
`from {{SESSION_DEP_MODULE}} import {{SESSION_DEP_NAME}}` pointing at a name that doesn't actually
exist in the target module. Confirmed live during this item's own grounding, before writing any
test assertion: deliberately breaking `test/fixtures/python-fastapi/`'s `SessionDep` alias left
`ast.parse` green on `router.py` while a real `import app.handles.router` raised `ImportError` at
exactly the line a real consuming app would hit it. `codec.py`/`registry.py` already had strong
coverage via `test/handles-python-codec.test.mjs`'s real functional round-trip against the JS
reference implementation -- this item is scoped narrowly to the two files that didn't:
`router.py`/`resolver.py`.

**Concrete approach, and how it diverges from the catalog's own text:** the catalog said "swap the
`ast.parse` check for a real import in a CI-installed virtualenv" -- implemented as a full
REPLACEMENT (the old `ast.parse` test was deleted, not kept alongside), matching this project's own
established `java-compile-smoke.mjs` precedent exactly: a heavier, network-touching verification
(here: `pip install fastapi sqlmodel` into a throwaway venv) does NOT belong in the fast default
`npm test` path (which runs across every Node-version-matrix entry, multiplying any added cost) --
it gets its own dedicated script (`scripts/python-import-smoke.mjs`) and its own CI job
(`python-import`), run once, not once-per-matrix-entry. `test/fixtures/python-fastapi/` is a new,
frozen, git-committed fixture (`backend/pyproject.toml`, `app/api/deps.py`'s `SessionDep`,
`app/api/items.py`'s single-resource GET route, `app/models.py`'s `Item`/`ItemPublic`) --
deliberately the SAME shape `test/python-fastapi-handles.test.mjs`'s own `buildE2eFixtureRepo()`
already builds inline via `fs.writeFileSync`, just externalized to disk so it's reviewable/diffable
the way P3's own fixture corpus already established for java-spring, rather than a second
independent design. `scripts/python-import-smoke.mjs` runs the full gated workflow (preflight ->
feature init -> scan -> disposition -> `gate force contract`, since this scanner's operationId is
always null per D-fastapi-adapter -> handles emit) against a scratch copy, then `python3 -m venv
.venv`, `pip install fastapi sqlmodel` (unpinned -- deliberately NOT matching the fixture's own
`pyproject.toml` floor versions, since the point is catching drift against CURRENT real fastapi/
sqlmodel APIs, not re-testing an old pin), then imports every generated module for real with
`PYTHONPATH` set to the detected import root, asserting the `Item` resolver actually registered
itself and the router actually wired its `/handles/{handle}` route -- not just "did the import not
raise", which a resolver silently failing to call `register(...)` at the bottom of its own file
would still pass.

**Grounding, both directions, confirmed live before locking in any assertion:** (1) positive path
-- ran the real script against the unmodified fixture, all generated modules imported successfully.
(2) negative path -- broke `models.py` with a bogus top-level import
(`import this_module_does_not_exist_anywhere`), confirmed the script fails loudly with the real
Python traceback (a `ModuleNotFoundError` surfaced through `resolvers/__init__.py`'s own
`importlib.import_module` auto-loader), not silently. A same-effort attempt to break the SessionDep
NAME specifically turned out to be a non-bug: `findSessionDep()`'s regex captures whatever
identifier is actually used, so renaming it consistently in the fixture doesn't break anything --
the codegen is correctly name-agnostic there; the real gap `ast.parse` missed was always about
runtime resolvability, not identifier naming, confirmed by breaking `models.py`'s own import graph
instead.

**Scope note:** the `macos` job introduced by this same catalog item (P3b) does NOT run
`python-import` -- kept Linux-only like `java-compile`/`package-install`, no reason found to
duplicate a pip-installable, platform-independent check on the self-hosted runner.

Cross-reference: `D-macos-runner` (P3b, above) -- the other, independently-shipped half of this
same catalog item.

## D-persistence-integrity (S5): schema validation, migration, and concurrency

**WHY:** `schemas/` has 9 declared schemas; none of the real persistence-boundary ones were ever
actually validated against at read/write time -- a hand-edited or externally corrupted
`.sbf/<feature>.json`/`brownfield-scan.json`/contract/resolution file would only surface as a
confusing downstream error (or worse, silently misbehave), not a clear, immediate, actionable
failure. Separately, `lib/state.mjs`'s `setGate()` -- the single funnel every gate write goes
through -- does load -> modify -> save with no synchronization, a lost-update race under
concurrent invocations.

**Grounding found the catalog's own text was stale/imprecise in three ways, corrected before any
code was written (not discovered after the fact):**

1. The catalog's motivating claim ("current `_repo` state would itself violate
   `state.schema.json`'s feature-ID pattern") is no longer true -- confirmed directly: ran `bskel
   preflight` in a scratch repo, ajv-validated the resulting real `.sbf/_repo.json` against
   `state.schema.json`, and it passed. S1 already fixed the underlying pattern; this item's own
   text just hadn't caught up. The real value of this item is defense-in-depth going forward, plus
   the concurrency fix below -- not "fixing something already broken today".
2. "`stack-choice.schema.json`...never loaded" is true, but that schema validates
   `stack/catalog/<id>.yml` CATALOG ENTRIES (an extension author's config -- P4's "catalog lint"
   territory), not `.sbf/stack.json` (the runtime record of which choice was applied, `schema:
   "sbf.stack/1"`). The runtime record had NO schema at all before this item -- confirmed by
   `schema: {const: "sbf.stack/1"}` matching nothing among the 9 existing schema files. Added
   `schemas/stack-record.schema.json` for it (user confirmed including this as bonus scope, since
   it's a real, if differently-named, gap).
3. "create a separate repo-state schema" is unnecessary -- `state.schema.json`'s `feature_id`
   pattern already accepts `_repo` as a valid alternative (S1's fix), and `.sbf/_repo.json` is
   structurally identical to any per-feature state file. Splitting into two schemas would be
   duplication with no behavioral difference.
4. "add version migrations" -- every schema is still at version 1. Building migration machinery
   for versions that don't exist would be designing for a hypothetical (CLAUDE.md's own "don't
   design for hypothetical future requirements" principle). Deliberately not built; the existing
   hard version-const check in `loadState()` remains the one hook point a real migration would
   need, whenever a v2 actually exists.

**Scope actually shipped:** a new `lib/schema-validate.mjs` (Ajv2020+addFormats, same pattern as
`contracts/validate.mjs`'s own singleton but deliberately separate -- `lib/` importing from
`contracts/` would be a backwards dependency direction) wired into 5 real persistence boundaries:
`state.schema.json` (`lib/state.mjs`'s `loadState`/`saveState`), `scan-report.schema.json`
(`bin/bskel.mjs`'s `loadScanReportOrExit`/new `writeScanReportOrExit` -- consolidated from THREE
separate inline `JSON.parse(readFileSync(...))` call sites down to one read choke point, in
`cmdScan`/`cmdScanDisposition`/`cmdContractEmit`), `feature-contract.schema.json`
(`loadContract`/its one write site), `contract-resolution.schema.json`
(`contracts/completeness.mjs`'s `loadResolution`/new `saveResolution`), and the new
`stack-record.schema.json` (the `.sbf/stack.json` write site only -- deliberately NO
`loadStackRecord()` read helper, since grep confirmed nothing in this codebase reads that file
back; adding an unused export would be dead code, not defense-in-depth).

Failure handling follows two existing, DIFFERENT conventions already present in this codebase,
kept deliberately distinct rather than forced into one shape: `lib/state.mjs`'s `loadState`
(already threw a plain `Error` for its own narrower `schema`-const check) and
`contracts/completeness.mjs`'s `loadResolution` throw plain `Error`s -- `main()`'s existing
catch-all in `bin/bskel.mjs` already documents "a malformed-state read" as its own case, landing
on exit 14 (`BAD_ARGS`), so this needed zero new plumbing. The CLI-layer helpers that already own
a `fail()` call for their sibling "file missing" case (`loadScanReportOrExit`, `loadContract`, the
scan/contract/stack write sites) use a new `INVALID_ARTIFACT` reason (added to
`lib/exit-codes.mjs`'s `EXIT_REASONS`, sharing exit 2/`NOT_PASSED` with `MISSING_ARTIFACT` -- "the
reason is what tells them apart", D2's own stated convention).

**A real tension found and resolved, not papered over:** `state.schema.json`'s `at` field
originally required `format: "date-time"`. `test/gates.test.mjs`'s "a missing or unparseable `at`
timestamp fails closed as invalid_timestamp, not a silent pass" test (a deliberate, already-shipped
S3 feature) writes a non-ISO string to `at` to prove `lib/gates.mjs`'s `checkFreshness()` degrades
gracefully (`STALE_REASON.INVALID_TIMESTAMP`) instead of crashing. Strict read-side schema
validation would have turned that already-tested, deliberate graceful-degradation path into a hard
read-time crash instead -- the schema and the application's actual, intentional tolerance policy
had diverged on purpose. Fixed by loosening `at` to plain `type: "string"` with a comment
explaining why (gates.mjs already owns that field's real validity check, more leniently than the
schema would). No other field had this tension (confirmed: grepped for any other test that
deliberately tampers a persisted field to a schema-invalid value; only this one existed).
`test/gates.test.mjs`'s `backdateGateAt()` helper was also changed to bypass `saveState()`'s
validation entirely (writes the file directly) -- it simulates EXTERNAL corruption, which by
definition doesn't go through this tool's own write path, so tampering through `saveState()` was
never an accurate simulation of what it's testing, independent of the schema-loosening fix.

**Concurrency -- `lib/lock.mjs`, deliberately SYNCHRONOUS:** the first design (an `async
withLock()`, Promise-returning) was rejected after tracing the actual blast radius: making
`setGate()` async would force `async`/`await` through `passGate`/`awaitDispositionGate`/
`forceGate`/`passNamedGate` (`lib/gates.mjs`) and every one of their callers in `bin/bskel.mjs`,
up through `dispatchCommand`/`main()` -- dozens of call sites, for a correctness property that
doesn't need it (this is a short-lived CLI process, not a server; blocking the single event loop
for up to a few seconds while polling for a lock is not a real cost). Switched to a genuinely
synchronous design using `Atomics.wait` for a real blocking sleep on Node's main thread (confirmed
directly, not assumed -- it is NOT restricted to worker threads). `fs.mkdirSync` under
`.sbf/.locks/<name>.lock` is the actual mutual-exclusion primitive (atomic EEXIST-on-collision on
both POSIX and Windows, no new dependency); a 5s default timeout throws with the exact stale-lock
path to remove (this tool has no daemon/cleanup process, so "another bskel process is stuck or
crashed" is the only realistic cause, and the fix is always the same manual step).
`lib/state.mjs`'s `setGate()` wraps its own load-modify-save in this lock -- one change closes the
race for every gate write in the codebase, since every gate-writing function funnels through it.
`contracts/completeness.mjs`'s `saveResolution()` deliberately does NOT lock by itself (a caught
mistake during implementation: locking only the final write does not close a load-modify-save race
-- the window is between the READ and the write, not inside the write call). `bin/bskel.mjs`'s
`cmdContractWaive` wraps its whole `loadResolution()`...`saveResolution()` cycle in one
`withLockSync()` call instead, the same shape `setGate()` uses. (A second real bug caught during
this same edit, before any test ran: a `newEntries` variable computed inside the lock callback was
referenced outside it for the CLI's own success-message rendering -- a `ReferenceError`, caught
immediately by running the full contract test suite, not left for a user to find.)

**Verification, methodologically important -- direct execution both before AND after, not just
"tests pass":**
- Reproduced the pre-fix race live before writing any fix: two processes calling `setGate()`-shaped
  load-modify-save with an artificial delay between load and save reliably dropped one write.
- `test/lock.test.mjs` proves the LOCK PRIMITIVE itself with two real OS processes (not just
  concurrent promises in one process -- JS is single-threaded, so two synchronous calls in one
  process can never actually interleave regardless of locking, making a same-process test of
  `withLockSync` meaningless for proving mutual exclusion; the suite explicitly documents why it
  spawns real subprocesses instead).
- Composing "the lock primitive is proven correct" with "`setGate()` is now wrapped by it" doesn't
  by itself prove the INTEGRATION is race-free without deliberately adding a test-only delay hook
  to production code (rejected -- see above). Instead: a real, unpermanent stress-test grounding
  step (not a committed test) ran 20 concurrent real OS processes each calling the actual
  production `passGate()` against the same `_repo` state, with NO artificial delay -- the real
  usage shape. Against the pre-fix code (verified via `git stash`, same trial, 3 repeated runs):
  consistently only 17-18/20 gates survived. Against the fixed code: 20/20, every single run.
- Real end-to-end CLI checks (not just unit tests) confirm a corrupted `brownfield-scan.json` fails
  `scan disposition`/`handles plan` cleanly (exit 2, `INVALID_ARTIFACT`, no crash), and a corrupted
  `.sbf/_repo.json` fails `gate show` cleanly (exit 14, `BAD_ARGS`, no crash) -- both with the
  offending field named in the error, not a raw stack trace (confirmed with `BSKEL_DEBUG=1` that
  no crash path was hiding behind the clean message either).

Cross-references: `D-doctor-workflow` (D5, `lib/verify.mjs`'s `detectBuildCommand()` reuse
precedent for "one shared implementation, multiple call sites"); `D-fixture-corpus` (P3, the
established "consolidate duplicated inline logic into one choke point" pattern, reapplied here to
`loadScanReportOrExit`); `D-preflight-freshness` (S3, whose `checkFreshness()`/
`STALE_REASON.INVALID_TIMESTAMP` design is exactly what motivated loosening `state.schema.json`'s
`at` field above -- this item respects, not overrides, that earlier decision).

## D-scanner-evidence (D3): explainable scanner evidence

**Naming collision, flagged up front (same class as the existing A2/A3 caveats in CATALOG.md):**
this repo's own internal DECISIONS.md numbering already has a `## D3: verdict -> disposition state
machine instead of an agent question (implemented)` heading (a completely different concern,
just above this section) -- do not confuse it with CATALOG.md's `D3. Explainable scanner
evidence`, which is what this section documents. `scanners/index.mjs` has both comments two lines
apart; every new comment this item added spells out `D-scanner-evidence` in full rather than the
bare token `D3`, specifically to avoid the confusion. CATALOG.md's D3 entry gets the same
"do not confuse with" caveat A2/A3 already carry.

**WHY:** `scoreModule()` returned a bare scalar with no way to see WHY a module scored what it
did, `matches()` did whole-string, un-tokenized, bidirectional substring matching (the catalog's
"symmetric substring matching" complaint -- a short piece of text could match anywhere inside an
unrelated long term, or vice versa, crossing real word boundaries either way), and endpoint
matches were uncapped -- `generic-grep.mjs` had already fixed exactly this inflation class once
(className-per-route -> className-per-file, see that file's own comment), but
`endpoint.path`/`endpoint.operationId` matching in `scoreModule()` itself was still uncapped.

**Line tracking was inconsistent across adapters before this item**: `python-fastapi.mjs`/
`generic-grep.mjs` each had their own private `lineNumberAt()` (endpoints only);
`java-spring.mjs` -- the primary adapter, backing every Team-IZ-Backend oracle test in this repo
-- had NO line tracking anywhere (not controllers, not endpoints, not entities, not enums).
Extracted the duplicated helper into `scanners/text-util.mjs`, added `line` to
`java-spring.mjs`'s `extractController`/`extractEntity`/`extractDomainEnum` and to
`python-fastapi.mjs`'s `extractTableEntities` (all purely additive -- the existing regex match
positions were already computed, this just calls `lineNumberAt` on them). Deliberately NOT
touched: `handles/providers/java-spring/plan.mjs`'s `methodMappingBoundaries()` independently
re-derives an endpoint's line via its own separate regex pass, for a completely different reason
(recovering `FETCH_ROUTE_LINE` for a resolver's docstring) -- now redundant with the scanner's own
new `endpoint.line`, but consolidating it is D4/handles-provider territory, not D3's; noted here so
it isn't mistaken for an oversight.

**Evidence shape**: `{signal, term, value, weight, file, line}` -- the exact 6 fields the catalog
named, across 8 signal types (`module_name`/`controller_class`/`controller_path`/`endpoint_path`/
`endpoint_operation_id`/`entity_table`/`entity_class`/`enum_name`), each with its own fixed
weight (unchanged from the original 8 `score += N` literals, just named and shared instead of
scattered). `module_name` evidence always has `file:null`/`line:null` (no single file backs a
module name); every other signal points at the file/line of the definition (controller class
declaration, endpoint's mapping annotation, entity/enum class declaration) it came from.

**Tokenization**: `tokenize(s)` splits on non-alphanumeric runs AND camelCase boundaries (the same
function handles both identifiers, which rely on the camelCase half, and paths, which rely on the
separator half). Matching is a token-by-token, bidirectional PREFIX check
(`token.startsWith(term) || term.startsWith(token)`) over a contiguous token subsequence, not
exact token equality -- deliberately, to preserve a real case the old substring matcher supported
by accident: term `"organization"` must still match the token `"organizations"` (plural). This is
meaningfully narrower than the old whole-string substring search (a term can no longer match by
spanning from the tail of one word into the head of the next), while still allowing short
abbreviation terms (`"org"`) to match a longer identifier token. Verified directly, not just
argued: `test/scan-scoring.test.mjs` asserts a constructed case the old matcher would have found
(`"nman"` spanning "Organization"+"Management"'s boundary) no longer matches, and that
`"organization"` still matches the token `"organizations"`.

**Real bug found during implementation, not anticipated by the plan**: the first version collected
EVERY raw match as evidence (uncapped), applying the cap only when summing for `score` afterward.
A 600-endpoint synthetic fixture (already an existing regression test, `test/scan-cli.test.mjs`'s
">64KB scan report" test) produced a 1.2MB report -- past Node's default 1MB `execFileSync`
buffer, throwing `ENOBUFS`/`status:null` in the PARENT test process, surfacing as exit code 1 with
no visible error text (confirmed directly: reproducing via `execFileSync` outside the test harness
showed the exact `ENOBUFS` error the harness's own `err.status ?? 1` fallback was silently
swallowing). Fixed by moving the cap to COLLECTION time (`EvidenceCollector.add()` stops
appending once a signal type hits `CAP_PER_SIGNAL`, tracking only a per-module `capped_signals`
list of which signal types were truncated) rather than collect-then-filter -- report size now
stays bounded regardless of repo size, and (as a side effect) the `counted:boolean` field the
original design planned per-entry became unnecessary: every entry that exists in `evidence` always
counted toward `score`, verified in `test/scan-scoring.test.mjs`.

**`CAP_PER_SIGNAL = 5`, empirically derived, not guessed** (CLAUDE.md's data-first-numerics
principle): swept 3/5/8 against the real Team-IZ-Backend oracle (`--terms organization`) and
compared to the pre-D3 baseline (`git stash`):

| module | pre-D3 | CAP=3 | CAP=5 | CAP=8 |
|---|---|---|---|---|
| organization | 175 | 90 | 110 | 140 |
| usagemetering | 49 | 44 | 49 | 49 |
| member | 40 | 25 | 35 | 40 |
| platformgovernance | 14 | 14 | 14 | 14 |
| curriculum | 10 | 10 | 10 | 10 |
| verdict | collision | collision | collision | collision |

`curriculum`'s score sits exactly at `COLLISION_THRESHOLD` (10) and is IDENTICAL across every cap
value tested -- it has no repeated-signal inflation to begin with, so it's unaffected regardless
of cap, confirming this isn't a narrow, cap-value-dependent coincidence. Verdict is `collision`
for every cap value. `organization`/`member` (the modules that DID have real endpoint-count
inflation) drop meaningfully with a tighter cap while staying far above the threshold either way.
Chose 5 as a middle value with no evidence any of 3/5/8 was meaningfully more "correct" -- the
important empirical finding is that the choice doesn't change any verdict, not that 5 specifically
is optimal.

**`bskel scan explain <module>`**: reads the ALREADY-PERSISTED scan report
(`loadScanReportOrExit`, the same S5-validated choke point every other scan-report reader uses) --
evidence is computed once, at `bskel scan` time, and never recomputed. Human output
(`scanners/render.mjs`'s `renderScanExplain`) groups by signal in a fixed order, one subtotal per
group, so the printed weights visibly reconcile with the module's total score; `--json` returns
the `related_modules` entry verbatim. `renderScanMarkdown`'s per-module heading now points at this
command (`run \`bskel scan explain <module>\` for the evidence breakdown`) rather than duplicating
evidence detail in the summary view.

**Verification**: `npm test` 534/534 (1 unrelated-to-this-item nothing else failing). Direct
end-to-end run against a real scratch java-spring fixture confirmed evidence sums to exactly the
reported score (45 = 10+6+5+5+5+8+6 across all 7 signals that fired) with correct file/line for
every entry. Real Team-IZ-Backend run confirmed via `git stash` before/after that every existing
verdict (collision for `--terms organization`) survives unchanged.

Cross-references: `D-generic-grep-reconnaissance` (G3, the prior art for the exact repeated-signal
inflation class this item closes the rest of); `D-persistence-integrity` (S5, whose
`loadScanReportOrExit` choke point and schema-validation wiring this item reuses directly, and
whose own `formatSchemaErrors`/`validateAgainstSchema` pattern this item's schema addition follows
without needing new plumbing); `D-process-exit-audit` (the original >64KB pipe-truncation
regression test this item's own bug was found through, and fixed without weakening).

## D-gate-history (S4): append-only gate history and bounded overrides

**WHY:** `setGate()` always overwrote the previous record, so there was no history of what
happened to a gate over time. Worse, `requireGate()` treated ANY forced gate as permanently PASS
-- `lib/gates.mjs`'s own pre-existing comment already flagged this as this item's own future fix
("a forced pass's own expiry is S4's... territory, not this one"). A forced gate that unblocked a
human for one specific reason kept silently covering every future state of the repo forever,
including states the human never looked at.

**Scope, user-approved in full** (the catalog's two halves -- (1) the force-expiry bug, a small
fix reusing existing mechanisms, and (2) a genuinely new JSONL audit log + `bskel gate revoke` --
were flagged as separable before starting; the user chose both).

**Grounding found "expiry by commit" is mostly already implied by "expiry by next input change",
not a third mechanism:** `preflight`/`scan`/`contract`/`handles` all include `head_sha` in their
own `recompute()` (confirmed directly in `lib/gate-definitions.mjs`) -- binding a force's token to
the gate's REAL current inputs makes a later commit move the token automatically, no separate
commit-tracking needed. `stack` is the one exception, and deliberately so
(`D-gate-precision`: repo-scoped gates other than `stack`'s own enumerable file set don't get a
commit proxy) -- not a gap this item needed to fill. This left exactly two real axes to implement:
token-binding (input change) and TTL (time).

**Part 1 -- force expiry, unifies forced records with normal passes instead of special-casing
them:** `forceGate()`'s signature changed from `(repoRoot, featureId, gateName, reason)` to
`(repoRoot, featureId, gateName, reason, currentInputs, {maxAgeMinutes})` -- `token`/`inputs` are
now the gate's REAL current inputs (the same shape `passGate()` binds to), not a synthetic
`{forced,reason}` placeholder. `requireGate()`'s `if (record.forced) return early` special case
was DELETED entirely -- forced records now flow through the exact same token-comparison +
`checkFreshness()` pipeline a real pass does, with only the final status label
(`'pass (forced)'` vs `'pass'`) staying different. This is simpler code, not just a bug fix --
removing the special case was a net reduction, not an addition. `checkFreshness()` gained one
new rule: a forced record NEVER inherits the underlying gate's own `def.freshness` policy (e.g.
preflight's 30-minute default) -- that policy judges naturally-earned evidence, not an explicit
human override. A forced record only gets a TTL when `bskel gate force <name>
--max-age-minutes N` explicitly asks for one (new CLI flag, no default, opt-in only -- same
"explicit, auditable" philosophy as `--max-age-minutes 0` disabling preflight's own TTL).
`forceNamedGate()` added alongside `passNamedGate`/`awaitNamedGateDisposition`/`requireNamedGate`
(S1's existing named-layer pattern) so `bin/bskel.mjs`'s `cmdGateForce` doesn't have to hand-roll
`gateScopeId`/`gateInputs` itself.

**Part 2 -- append-only history + revoke:** `.sbf/<featureId>.history.jsonl`, sibling to the
existing `.sbf/<featureId>.json` snapshot (same naming convention, suffix swapped). New
`schemas/gate-event.schema.json` (`{schema, event, gate, at, status, token, forced, reason}`),
validated the same way every other persistence boundary is (S5's `lib/schema-validate.mjs`)
before each line is appended. `setGate()` now appends inside its own existing `withLockSync`
block (S5) right after the snapshot write -- both artifacts stay consistent for free, no new
concurrency design needed. **Deliberately excludes "stale" as a loggable event, diverging from
the catalog's literal wording**: `state.schema.json`'s own pre-S4 comment already established
that staleness is derived at READ time, never written to disk -- logging it would mean appending
on every `bskel gate require`/`verify` call (a read operation, called constantly), turning the
log into read-path noise instead of a history of actual state CHANGES. Only the 4 real
write-time transitions (`pass`/`awaiting_disposition`/`force`/`revoke`) are logged.

New `revokeGate()`/`revokeNamedGate()` -- un-passes a gate with `status: 'revoked'` (a THIRD
status now written to disk; `state.schema.json`'s enum and its own "the only two statuses" comment
both updated) and a required `reason` (same auditability contract as force). `requireGate()`
needed NO new branch for this -- its existing generic `if (record.status !== 'pass') return
{code: NOT_PASSED, status: record.status, record}` fallback already reports `'revoked'` correctly
by construction; a planned explicit branch turned out to be dead code once actually written, and
was dropped. New `bskel gate history <name> [--feature <id>] [--json]` reads the log back --
a corrupt or schema-invalid LINE is skipped with a stderr warning, not a hard failure (matching
JSONL's own resilience rationale: one bad line shouldn't take down the rest of the log).
`renderVerifyReport()` also gained a small addition beyond the original plan: a revoked gate's
`reason` is now surfaced in `bskel verify`'s human report the same way a stale gate's
`changed_inputs` already was (found while checking rendering did not silently omit useful
context for the new status).

**Verification, direct execution, not just tests:** reproduced the pre-fix bug shape and its fix
live -- forced `preflight`, confirmed `pass (forced)`, landed a REAL new commit
(`git commit --allow-empty`), confirmed `bskel gate require preflight` now reports
`stale`/`inputs_changed`/`changed_inputs:["head_sha"]` (exit 4) instead of staying `pass (forced)`
forever, the exact bug this item exists to close. Separately confirmed a forced record with no
`--max-age-minutes` still survives with the same inputs even after 24 simulated hours (no
regression -- forces still don't expire on time unless asked to), and one WITH
`--max-age-minutes 10` does expire after a simulated hour even with matching inputs (the TTL axis
working independently of the token-binding axis). Confirmed `bskel gate history` renders a real
pass -> revoke -> force sequence in order, and that history is scoped correctly per gate name
(forcing `stack` does not appear in `preflight`'s history).

Cross-references: `D-preflight-freshness` (S3, whose `checkFreshness()`/TTL machinery this item
reuses rather than reimplementing, and whose "explicit, auditable `--max-age-minutes`" philosophy
this item's own opt-in force TTL follows); `D-gate-precision` (S2, whose `head_sha`-inclusion
decisions across gate definitions are exactly what made "expiry by commit" already-covered rather
than a separate mechanism to build); `D-persistence-integrity` (S5, whose lock/schema-validation
infrastructure this item's history log is built directly on top of).

## D-extension-conformance (P4): catalog lint CLI, template-variable check, generalized
idempotence coverage, adapter/provider conformance harness

**WHY, and why the catalog's stated WHY was stale:** the catalog justified this item with
"entries are not schema-validated and templates can currently name unchecked relative paths."
Grounding (reading `stack/apply.mjs` directly before designing anything) found both already
shipped: `loadCatalogEntry()` already validates every catalog YAML against
`schemas/stack-choice.schema.json` on every load, and `assertContained()` (`D-security-4`) is
already called from `planApply()` at all three path sites (template path, target path,
`config_check` target path). The real remaining gaps were narrower: (A) neither check is
independently invocable outside the side effect of a real `stack apply`; (B) a template
`{{VAR}}` token that will never be substituted goes undetected; (C) the version/compatibility
schema field the catalog also asked for -- excluded from this item's scope, user-approved, since
no current catalog entry needs one and there is no real compatibility-break case to size it
against; (D) the one idempotence regression test is hardcoded to `--choice ngrok`, so a future
catalog entry gets no coverage for free; (E) there is no reusable conformance harness for
third-party scanner adapters or handles-codegen providers, only ad-hoc fixture tests. User
approved A+B+D+E, excluding C.

**Part A -- `bskel catalog lint [<choice>] [--json]`:** no new validation logic. Reuses
`loadCatalogEntry()`'s existing schema check, then calls `planApply()` against a throwaway
`fs.mkdtempSync(os.tmpdir())` directory as `repoRoot` -- `planApply()` never writes files (only
`applyPlan()` does), so this is a safe dry lint that, for free, re-exercises all three existing
`assertContained()` call sites and proves every template file exists and renders without
throwing. With no positional argument, lints every `listCatalogChoices()` entry. Exit code is
`EXIT_CODES.CHECK_FAILED`, not `BAD_ARGS` -- a lint failure means the linted catalog entry has a
problem, not that this CLI invocation itself was malformed (same distinction the project already
draws elsewhere, e.g. `contract emit`'s completeness verdict vs. a bad flag).

**Part B -- residual template-variable detection, no new declaration system:**
`renderTemplate()` (`stack/apply.mjs`) only ever substitutes `{PORT: port}`. Rather than building
a variable-declaration-and-injection system for a single real consumer (`ngrok.yml`'s one
`{{PORT}}` token), `catalog lint` scans each rendered `plan.files[].content` for
`/\{\{[A-Z_][A-Z0-9_]*\}\}/g`. Because `renderTemplate()` never substitutes anything else, any
surviving match is provably a variable no catalog author declared and nothing will ever fill in.
Confirmed directly (reading `stack/bootstrap/ngrok.sh`) that `{{PORT}}` is the only `{{VAR}}`
token in any shipped template, so this produces zero false positives against the real catalog.

**Verification, direct execution before locking in tests:** ran `bskel catalog lint` against the
real `ngrok.yml` (passes, zero errors). Built three throwaway fixtures directly under
`stack/catalog/`/`stack/bootstrap/` (a schema violation missing `runtime`, a template path
pointing at a nonexistent file, and a template with a residual `{{FOO}}` token) and confirmed
each is caught with a distinct, correct-looking message and `EXIT_CODES.CHECK_FAILED`, while the
real `ngrok` entry kept passing in the same run -- then deleted all three fixtures before writing
any permanent test, per this project's "observe the real behavior before writing the assertion"
discipline.

**Part D -- generalized idempotence coverage:** `test/stack-cli.test.mjs`'s `'a second,
idempotent stack apply --apply still records the full applied file set'` test now loops
`for (const choice of listCatalogChoices())` instead of hardcoding `--choice ngrok`, and asserts
self-consistency (first apply's `applied_files` deep-equals the second, idempotent apply's)
instead of a hardcoded literal file list -- the invariant this test protects holds for any
catalog entry, so a future catalog addition is covered with no new test code, matching P3's
"invariant over exact hardcoded value" convention. The other, more detailed ngrok-specific smoke
test (mode `0o755`, `NGROK_AUTHTOKEN` content, etc.) is left untouched as a legitimate individual
test.

**Part E -- scanner adapter / handles provider conformance harness:** new
`scanners/conformance.mjs::checkAdapterConformance(adapter, repoRoot)` -- `detect()` must not
throw; a truthy `detect()` result must be followed by a `scan()` returning `{ modules: Array }`
with every module carrying `module`/`controllers`/`entities`/`enums` (the exact shape
`scanners/index.mjs::runScan()` reads); and `scan()` is called twice back-to-back and
deep-compared (`node:assert/strict`'s `deepStrictEqual`) -- the first time this codebase has
machine-verified the determinism every adapter's own `.sort()` calls (O6) exist to guarantee,
previously only a code-review-level belief. New `handles/conformance.mjs::
checkProviderConformance(provider, {repoRoot, scanReport, module, resourceFilter, featureId})` --
`plan()`'s return is validated against `schemas/handles-plan.schema.json` (this schema's first
real consumer anywhere in the codebase; it existed since G4 but `bin/bskel.mjs` has only ever
rendered a provider's plan output directly, never validated it), and `emit()` is called twice to
confirm idempotence, mirroring `stack/apply.mjs::applyPlan()`'s own re-apply guarantee.

**Found live while grounding Part E, not assumed in advance:** running the harness against the
real java-spring provider for the first time surfaced that its `emit()` is not fully idempotent
by a naive "second call writes nothing" bar -- `handles/providers/java-spring/emit.mjs`'s own
pre-existing comment documents `specs/<featureId>/handles/migration.sql` as deliberately
regenerated on every call, un-tracked by the manifest, "matching the pre-G4 behavior exactly."
This is not a bug; the harness's own bar was too strict. Fixed by excluding paths the provider
itself declares via `provider.outputs.spec` (a required field of `schemas/handles-provider.
schema.json`, already used to distinguish "spec-owned, always-regenerated" output from
manifest-tracked generated code) from the idempotence check, rather than hardcoding
java-spring-specific knowledge into a harness meant to work for a provider this project has never
seen -- consistent with this project's standing preference for a schema field over a hardcoded
special case.

**Dog-fooding verification (`test/conformance-harness.test.mjs`):** ran both harness functions
against all 3 real adapters (java-spring, python-fastapi, generic-grep -- against the
java-spring and python-fastapi fixtures respectively; generic-grep, a framework-agnostic
fallback, against the java-spring fixture) and both real providers (java-spring, python-fastapi),
all passing after the `outputs.spec` fix above. A dedicated test also proves the harness actually
discriminates -- a hand-built flaky adapter (non-deterministic `scan()`) and a hand-built
non-idempotent provider are both caught -- since 5 green real results alone would be equally
consistent with a harness that always returns `ok: true`.

Cross-reference (this item only): `D-adapter-registry`/`D-handles-providers` (G1/G4, whose
`sbf.adapter/1`/`sbf.handles-provider/1` schema-shaped fields this harness's JSON-Schema checks
build directly on top of, checking exactly the two behavioral properties -- determinism,
idempotence -- those schemas structurally cannot express).

## D-handles-dryrun (D4): uniform plan/check/diff before writes

**WHY, and why this one matched the catalog's own wording:** `bskel handles plan` only ever
showed resource-level information (`willGenerateResolver`/`table`/`idField`/`readPath`/
`requiredAuthority`) -- zero indication of what files would be created, updated, or conflict --
while `bskel handles emit` wrote unconditionally. `stack apply` already had exactly this ergonomic
(dry-run by default, `plan.files[].action` reporting `create`/`unchanged`/`update`); `handles` had
no equivalent. Unlike P4/S4/S5's grounding, this catalog Why held up under direct reading.

**The real gap was exposure, not computation:** `lib/handles-manifest.mjs::classifyFile()` (O2,
`D-handles-ownership`) already classifies every file `handles emit` touches into exactly the 6
states the catalog asked for (`create`/`unchanged`/`update`/`adopt-unchanged`/`adopt-update`/
`conflict`) on every single call -- the classification just never survived past the moment it
decided whether to write, and was never separated from actually writing. D4 is entirely "expose
what already runs," not new decision logic.

**`emitUnits()` (`handles/_engine.mjs`) gains `dryRun`/`computeDiff`, both defaulting to `false`
(every existing call site, including P4's `checkProviderConformance()`, is unaffected):**
`dryRun` guards the 4 real write sites (`writeUnit()` x2, the analogous resolver-loop pair) and
`saveManifest()` behind `if (!dryRun)` -- `written`/`forced` still populate identically either
way (their meaning shifts from "did write" to "would write", nothing downstream needs to know
which). A new `actions` array records `{path, kind, action, resourceType?, diff?}` for literally
every unit regardless of branch (even ones blocked by the infra all-or-nothing policy, even plain
`unchanged` ones) -- this is the field that makes the preview real. `computeDiff` attaches a real
unified diff, only for the 3 actions where content actually differs (`update`/`conflict`/
`adopt-update`).

**Diff implementation reuses `git`, adds no dependency:** `unifiedDiff()` shells out to `git diff
--no-index` between two temp files -- `git` is already a hard dependency of this exact file
(`isDirtyOrUntracked()` above it already calls `git status` on every emit). `cwd: tmpDir` plus
relative `a/<relPath>`/`b/<relPath>` paths (not the temp files' real absolute paths) keep the diff
header clean and reproducible; the random tmpdir name never leaks into output. `git diff
--no-index` exits 1 when the sides differ (the expected case here, not a failure) -- only another
exit code is treated as a genuine error.

**java-spring's `migration.sql` needed its own handling, found via P4 continuity:** it's the exact
`outputs.spec` file P4's conformance harness already had to exempt from a naive idempotence check
-- always regenerated unconditionally, never manifest-tracked, `classifyFile()` never runs against
it. `emitJavaSpring()` now classifies it locally (disk vs fresh render -> `create`/`unchanged`/
`update`) and reports it in `actions` tagged `kind: 'spec'`, distinctly from the manifest-tracked
`infra`/`resolver` kinds -- and gates its own write behind `dryRun` too. `written` still includes
it unconditionally on a real run, same pre-existing behavior as before this item (not fixed here,
out of scope) -- discovered live while grounding `--check`'s exit code (below).

**`bskel handles plan --diff`**: after the existing `provider.plan()` call, now also calls
`provider.emit({..., dryRun: true, computeDiff: flags.diff})` and merges `actions` into the
output (`{...plan, actions}` for `--json` -- schema-legal since `handles-plan.schema.json` already
declares `additionalProperties: true`; a new "## File actions" section for the human report). The
action preview is **always** computed (cheap); only diff bodies are gated behind `--diff`
(shells out to git per diffable file). Deliberately still skips the contract gate `handles plan`
has always skipped -- dry-run never writes, so the existing "informational, pre-contract" safety
profile is unchanged.

**`bskel handles emit --check [--diff]`**: `--diff` alone implies `--check` (dryRun) -- no reading
of "show me a diff" also means "and write it". Reuses the exact same `provider.emit({dryRun:true,
computeDiff})` path `handles plan` calls, and **never calls `passNamedGate('handles', ...)`** --
the single most important correctness rule here, since nothing real happened. A blocked (conflict)
result reaches the identical `EXIT_CODES.HANDLES_CONFLICT` (15) a real blocked emit would -- no
new exit code, `--check` is a preview of the true verdict, not a softer approximation.

**Exit-code bug found live while grounding, not assumed correct in advance:** the first
implementation used `written.length === 0` to decide `--check`'s OK/CHECK_FAILED split.
Running it against a real, fully up-to-date java-spring fixture (a second `--check` right after a
real `emit`) surfaced that `written` *always* includes `migration.sql` -- the same P4-era quirk
above -- so `--check` would report "something changed" forever for java-spring, even when nothing
actually had. Fixed by deriving the verdict from `actions` instead (`action !== 'unchanged' &&
action !== 'adopt-unchanged'`), which correctly reflects real content -- `written`'s own semantics
were deliberately left untouched (matches what a real run has always reported), only the exit-code
DECISION was recomputed from the more precise field this item added. Confirmed against both
providers directly: java-spring's second `--check` now exits 0 with `migration.sql` still present
(unchanged) in `written`; python-fastapi (no `outputs.spec`, no `spec`-kind actions at all) needed
no such correction and worked on the first attempt.

**`--plan`/`--apply` flags from the catalog's literal wording were deliberately not added**:
`handles` already has a `plan` subcommand -- a `--plan` flag would collide in name with something
that now (via this item) actually shows the same file-action preview `--plan` was asking for.
`handles emit` (no flag) is already "apply"; `stack apply`'s own default-dry-run-unless-`--apply`
shape was NOT mirrored here, since flipping `handles emit`'s default from "writes" to "dry-run"
would be a breaking change to an already-shipped, already-tested, already-documented command --
same conservatism D2 already established for exit codes ("existing numbers are a public contract,
don't renumber").

**Verification, direct execution against both real providers before locking in tests:** built a
throwaway java-spring fixture end to end -- fresh `--check` (9 creates, exit 1, nothing on disk),
real `emit`, `--check` again (all unchanged including the `spec`-kind migration.sql, exit 0,
manifest byte-identical), hand-edited resolver -> `--check` conflict (exit 15, edit untouched),
`@PreAuthorize` role change -> `--check --diff` showing the exact old/new `requiredAuthority`
diff text, and `handles plan --diff` reproducing the identical diff without ever calling emit.
Repeated the up-to-date and fresh-feature cases against a real python-fastapi fixture to confirm
the no-`outputs.spec` path needed no special-casing. `npm test` (568, +8 from this item) all green
except the expected dangling-`D-handles-dryrun` failure until this section existed, same pattern
as every prior item this session.

Cross-references: `D-handles-ownership` (O2, whose `classifyFile()` this item's entire value rests
on exposing rather than reimplementing); `D-handles-providers` (G4, whose provider-neutral
`emitUnits()` this item's `dryRun`/`computeDiff` params thread through uniformly for both
providers); `D-extension-conformance` (P4, whose `outputs.spec` exemption for java-spring's
migration.sql this item reused twice -- once for the `spec`-kind action classification, once for
the `--check` exit-code fix).

## D-java-analyzer (A2 Phase 1): a masking + balanced-delimiter Java analyzer

**WHY, and why this catalog item's Why held up under grounding** (unlike several prior items this
session): `extractController()` and `detectRequestBody()` really did depend on brittle patterns
(`public\s+\S+`, a literal `\n` between a mapping annotation and `public`, non-greedy backtracking
across parens). P3 had already pinned this as a known-limitation baseline for exactly this item:
`test/fixtures/java-spring/.../annotationstyles/presentation/` has 6 synthetic one-class-per-file
fixtures, each isolating one broken shape (a comment or an annotation like `@PreAuthorize` between
the mapping annotation and `public`; a space inside a generic return type; mapping-and-`public` on
the same line; `@RequestMapping(method=...)` instead of a verb-specific shorthand; and a `//`
comment merely mentioning `operationId = "..."` as prose polluting `controller.operationIds`), plus
6 `test/scan-fixture.test.mjs` tests asserting the broken behavior. Also confirmed genuinely
unsupported anywhere, and undiscussed before this (searched the fixture corpus and DECISIONS.md):
Java `record` classes and package-private methods (no access modifier at all).

**The real work was exposing structure safely, not building a parser.** `scanners/adapters/
_java-spring-analyzer.mjs` (new; leading underscore load-bearing -- `scanners/registry.mjs`'s
`candidateFiles()` treats every non-`_`/`.`-prefixed `.mjs` under `scanners/adapters/` as a
candidate scanner adapter to dynamically `import()`, and this file exports pure functions only, no
`adapter`): `maskNonCode(text)` blanks every comment (markers included) and every string
literal's/text-block's INTERIOR (delimiters kept) to spaces, same length and line breaks as the
input, so a comment or a string's content can never masquerade as code during a structural scan.
`matchBalanced(text, openIndex, openChar, closeChar)` is the same depth-counting algorithm
`scanners/adapters/python-fastapi.mjs`'s own local `matchBalancedParens()` already uses,
parameterized for both `(`/`)` and `<`/`>`. `skipAnnotationsAndWhitespace()` walks forward over any
number of intervening annotations and whitespace (masked comments included, for free) -- the ONE
general mechanism that makes same-line mappings, intervening annotations, and comments-in-between
all "just work" instead of needing a special case per broken shape. `findMappingAnnotations(text)`
is the shared orchestrator both the scanner and (via Tier 2 below) `handles plan`'s authority
search consume.

**Found live while wiring this up, not assumed correct in advance -- masking blanking a STRING's
quote delimiters too broke every REAL annotation, not just phantom comment mentions.** The first
`maskNonCode()` draft blanked a string literal's opening/closing `"` along with its content --
`operationId\s*=\s*"` (the position-search pattern) then could never find a literal `"` anywhere in
masked text, for a genuine `@Operation(operationId="findWidget")` exactly as much as a phantom
comment mention. Caught immediately by the real-repo before/after diff (`organization`/`curriculum`/
`security` modules all went from `operationIds: [...]` to `operationIds: []`) before this ever
reached a test file. Fixed by keeping a string's own quote delimiters intact and blanking only the
interior -- comments still vanish completely (markers included), since nothing needs a comment's
presence detected post-masking.

**Found live via the real-repo smoke test, not the fixture corpus -- a rigid class-level lookahead
missed a real shape.** `test/scan.test.mjs`'s "smoke, when present" test (which runs against a real
checkout of Team-IZ-Backend on this machine) failed with `basePath: ''` instead of `/organizations`
after the fixture-only regression check had already gone fully green. Root cause: the real
`OrganizationController`'s annotation stack is `@RequestMapping(value = "/organizations",
produces = ...) @RequiredArgsConstructor public class OrganizationController` -- an intervening
`@RequiredArgsConstructor` between the class-level mapping and `class` that the fixture corpus
never happened to exercise. The first lookahead checked only a fixed window of characters for
`class`/`record` immediately after the mapping's own args; fixed by reusing
`skipAnnotationsAndWhitespace()` there too (a new `isClassOrRecordAhead()` helper), the same general
mechanism already solving this exact problem for methods. This is the second class of bug this item
found specifically BECAUSE of the "diff the real repo before/after" verification step, not the
synthetic fixture corpus alone -- the fixture corpus is comprehensive for what it was built to
pin, but a real repo's actual style still surfaces cases nobody thought to synthesize.

**`findMappingAnnotations()`'s `@RequestMapping(method=...)` support is single-verb only, matching
the catalog's own literal wording.** A `method = {RequestMethod.GET, RequestMethod.POST}` array is
left unresolved and skipped -- a documented gap, not silently guessed at (verified live: the
position-search pattern requires `method\s*=\s*RequestMethod\.` with no intervening `{`, so an
array form correctly fails to match and the whole annotation occurrence is skipped, same as
"nothing recognized here" today).

**`contracts/emit.mjs`'s `detectRequestBody()`** -- named directly by the catalog's own Why
alongside `extractController()` -- gets a new `findMethodParams(text, methodName)` (same analyzer
file): a bounded-nesting return-type pattern (a pragmatic, Phase-1-appropriate trade-off -- real
Spring controller return types in this codebase never nest generics past 2 levels, so this isn't
`matchBalanced()`'s job here) finds the method's own `(`, then `matchBalanced()` finds its TRUE
closing paren regardless of what a default-value expression's own nested parens contain. **Confirmed
live against the OLD code before writing any new assertion**: a return type with a space inside a
generic (`ResponseEntity<Map<String, Object>>`) failed to match at all -- the exact same root cause
as `GenericWithSpaceController`'s scanner-level bug. Also confirmed (so as not to overstate the
fix) that the OLD regex actually handled a default-value expression's own nested parens correctly
already, by the accident of there being no earlier `)` immediately followed by `{` in that specific
shape -- `findMethodParams()` makes this correct by construction instead of by luck, but it was not
a second, independently-confirmed live bug the way the generic-with-space case was.

**Tier 2 (user-approved): consolidates `handles/providers/java-spring/plan.mjs`'s
`methodMappingBoundaries()`**, a literal duplicate of the scanner's own (old) mapping regex whose
own comment already earmarked this exact moment ("a different catalog item's territory"). Now a
thin wrapper mapping `findMappingAnnotations()`'s richer records down to the `{index, methodName}`
shape `findRequiredAuthority()` already consumes. **`findRequiredAuthority()`,
`extractPreAuthorize()`, `classBodyStart()`, `countServiceMethodParams()`, and
`countTopLevelCommas()` are completely unchanged** -- D-security-7's region-carving logic and
D-security-8's arity check are untouched by design; only the boundary list they're handed becomes
more robust, confirmed by `test/handles-plan-fixture.test.mjs`'s existing D-security-7 tests passing
byte-for-byte unmodified. This is a new import direction (`handles/` -> `scanners/`, one-way,
confirmed via grep that nothing in `scanners/` imports from `handles/`) -- accepted as the
mechanism Tier 2 requires, not introduced casually.

**Verification, direct execution at every step, not assumed correct from design alone:** every
one of the 6 known-broken fixture shapes resolves correctly (verified via a standalone script
before ever touching `scanners/adapters/java-spring.mjs`); the real-repo `organization`/
`curriculum`/`security`/`codeanalysis` fixture modules produce BYTE-IDENTICAL `scanJavaSpring()`
output before/after (two real bugs -- the quote-masking regression and the class-level lookahead
gap -- were caught and fixed by this exact check, not assumed clean); a real, isolated Team-IZ-
Backend worktree (`origin/develop`, removed after) ran the full `feature init -> scan ->
disposition -> contract emit -> handles emit` workflow for the `organization` module twice (once
with `git stash` reverting to the pre-A2-Phase-1 code, once with it applied) -- all 9 generated
Java files' sha256 hashes are IDENTICAL between the two runs, including `OrganizationResolver.java`'s
`requiredAuthority() -> "SUPER_ADMIN"` (proving Tier 2's consolidation didn't disturb
`findRequiredAuthority()`'s real output either). `npm test` 594 (26 net new: 23 in the new
`test/java-spring-analyzer.test.mjs` unit-testing the pure helpers directly -- mirrors
`classifyFile()`'s own precedent in `test/handles-manifest.test.mjs` -- 2 new fixtures + assertions
in `test/scan-fixture.test.mjs`, 1 in `test/contract-fixture.test.mjs`, minus the 6 "known
limitation" tests inverted in place rather than counted as new).

**EXIT**: Phase 2 (an optional JavaParser/Symbol-Solver AST layer for DTO/service-signature/
validation-expression analysis) stays explicitly out of scope -- CATALOG.md's A2 entry is marked
partially implemented, not implemented, so this remains visible as real future work rather than
silently closed.

Cross-references: `D-scanner-evidence` (D3, whose per-endpoint `line` field this item's
`findMappingAnnotations()` still populates identically, same document-order guarantee); `D-security-7`/
`D-security-8` (the region-carving/arity logic this item deliberately left untouched, only its
upstream boundary source upgraded); `D-fixture-corpus` (P3, whose `annotationstyles` fixture
package was built as this item's own committed before/after baseline, used here exactly as
intended).

## D-feature-lifecycle (D6): feature list/show/rename/link/archive + the feature init race fix

**WHY**: `feature init` was the only supported operation over `.sbf/feature-index.json`; manual
JSON editing was the documented recovery path for merges/re-keying. Grounding confirmed both
halves of the catalog's Why directly: no `list`/`show`/`rename`/`link`/`archive` existed, and
`nextFeatureNumber()` had a real TOCTOU race between reading `specs/` and writing the new
feature -- confirmed live with a real 20-concurrent-process stress test (mirroring S5's own
technique for `setGate()`): pre-fix, 20 concurrent `feature init --slug race-test` calls
collapsed to 14 distinct feature_ids (6 silently lost to `feature.json` overwrites); post-fix
(the whole read-`specs/`->compute-NNN->write-`feature.json`->load-modify-save-`feature-index.json`
sequence wrapped in one `withLockSync(root, 'feature-index', ...)`, reusing `lib/lock.mjs`
exactly as `lib/state.mjs::setGate()` already does under lock name `'state'` -- a distinct lock
name here so `feature init` doesn't unnecessarily serialize against unrelated `gate`/
`contract waive` calls), 20/20 every time.

**The load-bearing precedent for rename/link, found by reading `D4`'s own EXIT clause before
designing anything**: *"a rename should count as a different feature unless a human explicitly
re-points `.sbf/feature-index.json`"* and *"`by_uid`'s map is the reassignment point ... e.g.
two features merged."* `by_uid[uid]` was already an array (`[featureId]`, single-element only,
write-only, never consumed as history) -- confirmed via direct exploration this was deliberately
shaped for exactly this future work. D6 is its first real consumer: `feature rename` appends
rather than replaces (the array IS the rename history, last entry is current); `feature link`
adds a separate `merged_into` map for the genuinely different "two independently-created
features, different uids, now cross-referenced" case.

**Full rename blast radius, traced by direct exploration before writing any migration code**:
`specs/<id>/` (directory + 3 featureId-prefixed filenames under `contracts/`; `brownfield-scan.
{json,md}` use a fixed name, not prefixed, so they move for free with the directory rename),
`.sbf/<id>.json` (filename AND an in-file `feature_id` field), `.sbf/<id>.history.jsonl`
(filename only -- gate-event lines never carry `feature_id`), `.sbf/handles-manifest.json`
(resolver-entry `owner` fields; `owner:'_repo'` infra entries are untouched, not a feature id at
all).

**A genuine, live-found design correction: gate-token-hashed artifacts must NOT have their
content rewritten, only renamed.** The first `renameFeatureArtifacts()` draft rewrote every
`.json` under the new `specs/<id>/` tree's own `feature_id` field, including `contracts/
<id>.schema.json`, `contracts/<id>.resolution.json`, and `brownfield-scan.json`. A real
`handles emit --check` against a just-renamed feature immediately reported the contract gate as
stale -- `lib/gate-definitions.mjs`'s `contract`/`handles`/`scan` gates each hash the FULL
CONTENT of one or more of these files for their token (`contract_hash`/`resolution_hash`/
`openapi_snapshot_hash`/`scan_report_hash`), so rewriting even one field inside them silently
invalidated an already-passed gate's stored token, forcing a phantom re-verification of content
that never actually changed. Fixed by leaving these files' content byte-identical (filename
prefix swap only) -- the same "cosmetic staleness accepted, historical record" principle already
established for a resolver's own doc-comment and `migration.sql` (P4/D4), now extended to every
gate-token-hashed artifact, not just already-generated application code. Only `feature.json`
(never hashed as a gate-token input anywhere) and `.sbf/<id>.json` (also never hashed as an
input to any OTHER gate's token) have their `feature_id` field actually rewritten.

**A second, independently live-found bug: `fail()` (which calls `process.exit()`) must never be
called from inside a `withLockSync()` callback.** An early draft did the collision/missing-
feature checks for `rename`/`link` inside the lock, calling `fail()` on failure for a clean CLI
error. `process.exit()` terminates the process immediately without unwinding through pending
`finally` blocks the way a thrown exception does -- so `lib/lock.mjs`'s own `finally {
fs.rmSync(lockPath) }` never ran, leaving the lock directory behind and hanging every subsequent
`feature init`/`rename`/`link` call in that repo. Caught live by the very next command in the
same grounding session failing with "could not acquire lock ... within 5000ms." Fixed with a new
`LockedCommandFailure` error class + `runLockedOrFail()` wrapper (`bin/bskel.mjs`): the locked
callback throws (a real exception, which DOES unwind through `finally` correctly) carrying the
intended exit code/reason, caught and reported via `fail()` only AFTER `withLockSync()` has
returned and the lock is already released. `cmdFeatureInit`'s own lock callback was already safe
(its only failure paths are `lib/featurelifecycle.mjs`'s plain-`Error`-throwing schema
validators, never `fail()`) -- confirmed by inspection, not assumed, before concluding this bug
was unique to the two new commands.

**`link` is index-only, deliberately not an automatic state merge.** `linkFeature()` records
`merged_into[aliasId] = keepId` and touches nothing else -- neither feature's `specs/`/`.sbf/`
artifacts are read or written. Automatically merging scan/contract/handles state was rejected:
which side's contract should win, whether resolvers conflict, whether gate history should be
concatenated -- all genuinely ambiguous, the same never-auto-resolve-ambiguity discipline
`D-config-patch` already established for application config patching. A human decides what to do
with the two features' actual content; `link` only records that they're now considered the same
identity going forward.

**`archive` is a soft-delete, not a physical move.** `archiveFeature()` sets `archived_at`/
`archived_reason` on `feature.json` in place. Every other command still works unmodified against
an archived feature if a human explicitly targets it (confirmed live: `scan`/`scan disposition`/
`contract emit` all still pass normally); only `listFeatures()`'s default view hides it.

**New schemas** (`schemas/feature.schema.json`, `schemas/feature-index.schema.json`) -- neither
file had a schema before this item, confirmed by direct search. Wired into `lib/schema-
validate.mjs`'s existing `validateAgainstSchema()` at both read and write, matching S5's
established "every persistence boundary gets schema validation" precedent -- making both files
richer (archive/rename/link fields) was exactly the moment to close that gap, not a separate item.

**Known, accepted limitation, documented not silently swallowed**: a resolver `.java`/`.py` file
already generated by a pre-rename `handles emit` keeps the OLD feature id baked into its own
doc-comment, and `specs/<id>/handles/migration.sql` keeps the old id in its rendered SQL --
cosmetic staleness, not a safety issue (the manifest's `owner` field, the real ownership-safety
check, IS updated). Confirmed live this self-heals naturally: a real `handles emit --check`
against the renamed id correctly reports the resolver as `update` (its OWN existing "regenerate
when provably untouched" logic, unrelated to rename, would refresh the doc-comment's feature id
on the next real emit) -- not a new mechanism, a natural consequence of leaving the file
otherwise untouched.

**No new exit codes**: collision -> `EXIT_CODES.BAD_ARGS` (14); unknown id -> the existing
`MISSING_ARTIFACT` pattern `loadFeatureRecord()`/`loadFeatureFile()` already use (`EXIT_CODES.
NOT_PASSED`, 2); a lock-acquisition timeout is left as an uncaught `Error`, matching the existing
`contract waive` call site's own precedent (no special handling there either).

**Verification**: `npm test` 594 -> **612** (18 net new: 8 in `test/feature-lifecycle-cli.test.mjs`
including the real 20-process stress test, 5 in `test/schema-validate.test.mjs` for the 2 new
schemas, 5 from extending `test/cli-contract.test.mjs`'s command-coverage snapshot). Real Team-
IZ-Backend isolated worktree: full `feature init -> scan -> disposition -> contract emit ->
handles emit` for the organization module, then `feature rename` it, confirmed `bskel status
--feature <newId>` and a real `handles emit --check` against the new id both pass cleanly
(gate NOT falsely stale), and the old id cleanly fails every command.

Cross-references: `D-persistence-integrity` (S5, whose `lib/lock.mjs::withLockSync` and
`lib/schema-validate.mjs` this item reuses directly, both for the race fix and the two new
schemas); `D-gate-precision`/`D-gate-history` (S2/S4, whose gate-token content-hashing is exactly
what the rename-content-rewrite bug above collided with); `D-handles-ownership` (O2, whose
`handles-manifest.json` owner-field convention this item's rename migration updates);
`D-config-patch` (the never-auto-resolve-ambiguity precedent `link`'s index-only design follows).

## D-patch-strategy (A3): per-field classification + explicit approval before ANY patchField() codegen -- fetch-merge-submit stays permanently manual

**WHY**: `D-resolver-scope` left `patchField()` a blanket stub because Phase 5 found three
different partial-update conventions in real update DTOs and a wrong guess would "silently bypass
real validation/business rules -- worse than leaving an honest stub." A3 (CATALOG.md, Scope L) is
the explicitly-deferred follow-up: classify each field's convention precisely enough to safely
auto-generate the genuinely safe cases, while keeping a human in the loop for everything else.

**Grounding, read directly against all 17 real `Update*Request.java` DTOs in the oracle repo
(not delegated -- see the process note below)**: every field cleanly falls into one of four
buckets -- `patch-wrapper` (2 fields, both `PatchField<Long>` in
`UpdateOperationSettingRequest`), `null-means-unchanged` (31 fields, the large majority),
`fetch-merge-submit` (17 fields -- `@NotNull`/primitive fields in an otherwise-partial DTO, or an
entire action-shaped DTO like `UpdateAssessmentValidityRequest`), `unsupported` (1 field,
`UpdateClassroomManagersRequest.managerIds`, a full-collection-replace). 51 fields total, 0
unclassifiable. The classifier (`handles/providers/java-spring/patch-strategy.mjs`) reuses A2
Phase 1's `maskNonCode()`/`matchBalanced()`/`skipAnnotationsAndWhitespace()` rather than new
regex, and reproduces every one of these 51 real classifications exactly when run directly against
the real files.

**★ A genuinely new architectural risk, found by reading the controllers, not anticipated by the
catalog text**: `@Valid` is applied at the CONTROLLER boundary only
(`@Valid @RequestBody UpdateXRequest`) in every real controller checked. A resolver that
constructs a DTO and calls the service method directly **bypasses Bean Validation entirely** --
exactly the "silently bypass real validation" failure `D-resolver-scope` already named as worse
than a stub, and it would apply to ANY generated bucket, not just the risky ones. The fix already
exists in the app: `GlobalExceptionHandler` already has
`@ExceptionHandler(ConstraintViolationException.class)` -- the exact exception type
`jakarta.validation.Validator.validate(dto)` produces. Generated code injects a `Validator` bean,
validates the reconstructed DTO explicitly, and throws `ConstraintViolationException` on failure,
so a patch through a handle produces the identical error shape a real `@Valid` failure would.

**Scope tier, user-approved (AskUserQuestion, mirroring A2's Tier1/Tier2 fork)**: Tier 2 --
classify + `bskel handles patch approve` + codegen for `patch-wrapper`/`null-means-unchanged`
ONLY. `fetch-merge-submit` is classified and explained per-field but NEVER auto-generated, even
though the classification itself is precise: safely reconstructing every OTHER required field
fresh at patch time would mean mapping the `fetch()` RESPONSE DTO's fields onto the (usually
differently-shaped) update REQUEST DTO -- exactly the kind of guess `D-resolver-scope` already
rejected as worse than a stub. `unsupported` fields are likewise always manual. Tier 3 (also
attempting `fetch-merge-submit` codegen) was considered and explicitly rejected for this reason.

**Per-field, feature-scoped approval, never a wildcard or repo-global**: `bskel handles patch
approve --resource <Type> --field <name> --strategy <bucket> --reason "..."` mirrors
`cmdContractWaive`'s exact shape (`withLockSync`, `--reason` required, append-only-by-key record
in `specs/<id>/handles/patch-approvals.json`, new `schemas/patch-approvals.schema.json`). Per-field
matches A5's own "no `--all` covering future-appearing warnings" precedent -- approving
`Organization.name` today must never silently also approve a field added to that DTO next month.
Feature-scoped (not repo-global like `.sbf/handles-manifest.json`) because approving a field's
patch strategy is a human DECISION made for one feature's actual need, not a file-safety fact
about the repo -- `contract-resolution.schema.json` is the closer analog, not the manifest.
**Fail-closed on staleness**: `cmdHandlesPatchApprove` re-runs the provider's own `plan()` and
rejects an approval whose `--strategy` doesn't match what the classifier reports RIGHT NOW (BAD_ARGS)
-- a stale approval (the DTO changed since approval) can never even be recorded, and `emit.mjs`'s
`currentlyApprovedFields()` re-checks the same condition again at emit time, so an approval that
went stale between `approve` and `emit` still falls back to the explanatory stub rather than
generating against an assumption that no longer holds.

**★ A second real, load-bearing finding: NONE of the 3 real update service methods checked during
verification actually have the plain `(resourceId, dto)` 2-arg shape generated code assumes** --
`OrganizationService.updateOrganization(UUID, UpdateOrganizationRequest, UUID requesterId)` (an
extra auditing/actor argument), `ClassroomService.updateClassroom(UUID, UUID, UUID, String,
Integer)` (individually-unpacked fields, not even the DTO type itself), `CohortService.updateCohort`
similarly unpacked. This is the SAME `D-security-8` IDOR-shaped-bug class `findFetchOperation`'s own
param-count check already guards against, reused here for the update path
(`countServiceMethodParams` against the update method, expecting exactly 2). Confirmed live: `bskel
handles plan` against the real `organization` module correctly reports `Organization` as
codegen-blocked with the exact reason, and `handles emit` renders every field's `patchField()` case
as an explanatory throw naming that reason -- never a broken/wrong call. **Design correction found
while implementing this check**: the first draft blanked `patchable` to `[]` whenever the service
arg-count check failed, silently discarding the classification itself along with the (correctly)
blocked codegen -- losing this item's own "precise per-field reason" value in what turned out to be
the COMMON real-world case (0/3), not an edge case. Fixed by keeping `patchable` populated
regardless, and introducing a separate `updateServiceBlockedReason` that, when set, makes every
field's `patchField()` case explain THAT one shared reason instead of running its own per-bucket
logic -- `bskel handles plan`'s output stays informative even when codegen can't happen.

**★ A third finding: the oracle repo runs Spring Boot 4.1.0, which ships Jackson 3
(`tools.jackson.databind`), not the classic `com.fasterxml.jackson.databind` most Spring Boot
projects still use** -- confirmed by reading the real `build.gradle` AND source (`SecurityConfig.java`
imports the Jackson 3 package). One other real file (`AiClient.java`) imports the classic package
for a bundled third-party SDK's own Jackson 2 instance -- NOT what Spring actually autoconfigures
as the injectable `ObjectMapper` BEAN, so a naive "which import appears anywhere in source" grep
would have picked the wrong one. `detectJacksonPackage()` instead reads the Spring Boot Gradle
plugin's own major version (`id 'org.springframework.boot' version 'X...'`) -- >=4 means Jackson 3,
everything else (including "can't determine") defaults to the classic package, matching this
project's own CI fixture (pinned to Spring Boot 3.3.0).

**Verified**: classifier output matches all 51 real fields exactly (see grounding above). Real
isolated Team-IZ-Backend worktree: `Organization`'s blocked-codegen path renders and compiles
clean (`./gradlew compileJava`, `BUILD SUCCESSFUL`) -- proves the safety net produces valid Java,
not just that it refuses. The REAL codegen path (Validator/ObjectMapper/PatchField/
ConstraintViolationException, both buckets) has no real 2-arg-shaped resource to exercise it
against in the oracle repo today (see the finding above), so it's proven against a purpose-built
synthetic fixture instead: `test/fixtures/java-compile/`'s `Widget` resource gained an
`UpdateWidgetRequest` DTO with one field per bucket (`label`=patch-wrapper,
`capacity`=null-means-unchanged, `ownerName`=fetch-merge-submit, `tags`=unsupported) and a real
2-arg `WidgetService.updateWidget(UUID, UpdateWidgetRequest)` -- `scripts/java-compile-smoke.mjs`
(P3's CI harness) now approves `label`/`capacity` before `handles emit`, so CI's `java-compile` job
proves the actual generated switch-case compiles, not just the stub path every other resource in
that corpus already exercised. Manually reproduced locally first (borrowed the real oracle repo's
own Gradle 9.5.1 wrapper against a scratch copy) -- `BUILD SUCCESSFUL` before wiring it into the
permanent script.

**Process note**: an earlier attempt at this item's own grounding survey (a fork explicitly told
"read-only investigation only -- do not write/edit anything, do not run gradle, do not touch git
state") instead wrote a full, unreviewed implementation attempt directly into `main`'s working
tree with no Plan Mode, no branch, no approval. Caught via `git status` before trusting the
completion notification (this session's own established "verify a subagent's real state, don't
trust its self-report" discipline, reconfirmed for the 4th time this session in
`feedback_fork_scope_violation_destructive_bg_task` memory), confirmed `origin/main` was
untouched, and discarded entirely per explicit user instruction -- nothing in this section or the
implementation was informed by that draft; everything above comes from redoing the grounding
directly.

**Known, accepted limitation, found while writing this item's own test fixtures (not from the
oracle repo, which never does this)**: `@NotNull`/`@Valid` detection is a literal `@Word\b` match
on masked text, inherited from A2 Phase 1's analyzer -- a fully-QUALIFIED annotation reference
(`@jakarta.validation.constraints.NotNull` instead of an imported `@NotNull`) is not recognized,
since `skipAnnotationsAndWhitespace()`'s own `@\w+` pattern doesn't span dots either. Not fixed:
none of the 17 real DTOs in the oracle repo use fully-qualified annotations (every one imports
plainly), and the failure mode if it ever occurred is contained, not silent -- a `@NotNull` field
missed this way falls through to `null-means-unchanged` and gets real codegen, but the explicit
`Validator.validate()` call this item's codegen always makes would still catch the resulting
`@NotNull` violation and throw `ConstraintViolationException` before the service is ever called.
Degrades to "generates code that always 400s for that one field until a human notices," not a
silent validation bypass -- acceptable given it's never been observed in real code.

**EXIT**: none needed for the Tier 2 scope boundary itself -- `fetch-merge-submit`/`unsupported`
staying manual is a permanent design boundary (same class as `D-resolver-scope`'s own EXIT), not a
temporary gap. If a future item wants to attempt `fetch-merge-submit` codegen (this item's
rejected Tier 3), the real blocker to solve first is a safe RESPONSE-DTO-to-REQUEST-DTO field
mapping -- there is no existing precedent for that in this codebase to build on.

See also: `D-java-analyzer` (A2 Phase 1, whose masking/balanced-delimiter primitives this item's
classifier reuses directly); `D-resolver-scope` (the original stub decision this item's whole
design answers); `D-security-8` (the fetch-side param-count safety check this item's update-side
check mirrors); `D-contract-completeness` (A5, the closest existing per-{code,subject} waiver
precedent `patch-approvals.schema.json` follows); `D-handles-ownership` (O2, `.sbf/
handles-manifest.json` -- the repo-scoped alternative this item's feature-scoped approval design
was weighed against and rejected).

## D-greenfield-bootstrap (P2): `bskel new` only -- no persisted `.bskel/config.yml`, re-scoped from the catalog's literal text

**WHY**: CATALOG.md's P2 original text asked for both a repo-level `bskel init` (detect/select
adapters, write `.bskel/config.yml`, establish state/spec directories, validate the default
branch) and a separate `bskel new --stack spring|fastapi`. Re-verified against current reality
first (the same "catalog Why can be stale" check S4/S5/P4 already established as this project's
own habit) and found most of `init`'s ask already solved elsewhere: `bskel doctor` already reports
adapter detection/specificity/capabilities (`lib/doctor.mjs`'s adapter-diagnostics block);
`bskel preflight` already validates the default branch (3-way cross-check, already step 2 of the
documented Quickstart); state/spec directories already get created organically wherever each
command writes (`specDir`/`sbfPath` + `fs.mkdirSync(recursive:true)`), with no evidence this is
actually broken. **A persisted `.bskel/config.yml` was deliberately NOT built** -- it would be the
only piece of state in this entire tool trusted after being written once, rather than re-derived
fresh every run, directly opposite this project's own repeatedly-reinforced philosophy (gate
tokens over trusted flags; `D-resolver-scope`'s "regenerate when provably untouched" over "create
once"; `runScan()` re-detecting the adapter fresh on every single `scan`, never caching it). A
config file that can silently drift from the repo's real current shape is exactly the failure
class every OTHER piece of this tool exists to prevent.

**The one genuine, still-real gap**: despite the README's own "brownfield (and greenfield)"
framing, there was no path from an empty git repo to a `bskel`-scaffolded one -- `runScan()`'s
adapter `.detect(repoRoot)` requires an EXISTING `build.gradle`/`pom.xml`+`src/main/java`
(java-spring) or an existing FastAPI/SQLModel layout (python-fastapi); on a truly empty repo every
adapter returns no detection and `runScan()` throws. "Greenfield" everywhere else in this codebase
only ever means "a new module inside an ALREADY-detected repo" (the `scan` verdict), never "a repo
with nothing in it at all." `bskel new` closes exactly this gap, nothing more.

**Process note**: the exact scope split above was meant to be confirmed with the user via
AskUserQuestion before implementation, but a hook belonging to an unrelated research project (a
"measure before asking" guard written for a different, weight-compression project) incorrectly
fired and blocked the question. This is not an empirically-measurable claim -- no script resolves
"should this tool make network calls to scaffold new projects," it's a genuine scope preference --
so the recommendation and full reasoning were written directly into the plan file for the user to
confirm or redirect via the plan's own ExitPlanMode approval step instead (which they did).

**`bskel new --stack spring`: the only command in this tool that talks to a network service**
(Spring Initializr's public `start.spring.io/starter.zip`, the same endpoint behind `spring init`/
the start.spring.io web UI). Every other command here is pure local git/fs -- a real, new risk
category, handled the same way this tool handles its other genuinely-external dependencies
(`rg`/`git`/a build wrapper): `--offline` refuses cleanly with an actionable message before ever
calling `fetch()` (mirrors `bskel preflight --offline`'s own precedent), never auto-triggered by
any other command, and the requested dependency SET (`web, data-jpa, security, validation,
lombok` -- matching both the real oracle repo and `test/fixtures/java-compile/build.gradle`) is a
named, reviewable constant in `new/spring.mjs`, not a live query against Initializr's own current
defaults. Deliberately does NOT pin an exact `bootVersion` -- Initializr only serves actively-
supported Spring Boot versions and ages old ones out on its own schedule (a fast-moving target,
unlike a gate token where rigidity IS the safety property), and this tool's own Jackson-package
detection (`handles/providers/java-spring/emit.mjs`'s `detectJacksonPackage`, from A3) already
adapts to whichever major version Initializr hands back -- confirmed live: a real, by-hand
`bskel new --stack spring` call returned Spring Boot 4.1.1 (Initializr's own current default,
Jackson 3-era) and the generated project compiled clean via `./gradlew compileJava` before this
item was considered done. The zip is extracted via the real `unzip` binary (same "shell out to a
well-known CLI tool, throw if missing" precedent as `rg`/`git` elsewhere), not a new npm
dependency.

**`bskel new --stack fastapi`: no network call at all** -- researched and confirmed FastAPI has no
first-party scaffolding CLI/service with comparable official standing to Spring Initializr, so
"pinned starter" here means a minimal, LOCAL, hand-written template (`new/templates/fastapi/`)
matching the exact layout `scanners/adapters/python-fastapi.mjs`'s own `detectPythonFastApiRoot()`
already requires (a `pyproject.toml` declaring a `fastapi` dependency + a `.py` file that
imports/instantiates it) -- verified directly: `detectPythonFastApiRoot()` recognizes the
generated output, and `bskel doctor` correctly reports `python-fastapi` as the detected adapter.

**A real, load-bearing finding from testing the full flow end-to-end, not assumed**: `bskel
preflight` REQUIRES a real `origin` remote with a resolvable default branch (symbolic-ref /
`git remote show origin` / `gh api`, all three) -- a brand-new local-only `git init` has none of
these, so `bskel preflight` immediately fails `WRONG_DEFAULT` (exit 12) against a freshly
scaffolded repo. The original plan draft assumed `bskel new` could print "next: `cd <dir> &&
bskel preflight`" as the immediate next step -- confirmed WRONG by actually running it. `bskel
new` deliberately does NOT auto-create a remote itself (creating a real GitHub repo on the user's
account/org is a materially different, far more consequential action than writing local files --
matches this project's own CLAUDE.md §18 caution around GitHub write actions, and no other command
in this tool creates external resources on a user's behalf). Instead it prints the full accurate
sequence (create/push to a remote you own → `git remote set-head origin --auto` → THEN
`bskel preflight`) -- verified end-to-end: a real bare remote + push + set-head made
`bskel preflight` pass cleanly against a freshly `bskel new`-scaffolded repo.

**★ A real bug found live, by CI, not by local testing**: the first version of `cmdNew`'s `git
init` + `git commit` sequence assumed a git identity (`user.name`/`user.email`) was already
resolvable from SOME config scope -- true on every machine used during this item's own
development, so local `npm test` runs (and the manual by-hand verification) never caught it. A
genuinely fresh CI runner has no git identity configured anywhere, so `git commit` failed outright
-- surfaced as a generic exit-14 (`BAD_ARGS`) failure in `test/new-cli.test.mjs`'s own full-CLI-path
test, on both Node 22.x and 24.x, the FIRST real PR CI run for this item. Fixed by checking
`git config user.email`/`user.name` first and supplying a placeholder identity
(`bskel <bskel@localhost>`) via `git -c user.email=... -c user.name=... commit` ONLY when neither
is already resolvable -- a real user's own configured identity is never overridden. Two dedicated
regression tests reproduce both sides exactly (a fake `HOME` with no `.gitconfig` at all vs. one
with an explicit identity), rather than trusting the CI failure was a fluke -- this is exactly the
"local pass doesn't prove environment-independence" class of bug this whole session has run into
before with different symptoms (e.g. Node version quirks, missing CI binaries).

**Test strategy**: `new/spring.mjs`'s network call is never exercised in the automated test
suite -- no existing test in this project hits a live external service, and CI must not start
now. `buildInitializrUrl()` (pure) and the zip-extraction path (mocked `fetch`, but the REAL
`unzip` binary against a committed fixture zip, `test/fixtures/spring-initializr-fixture.zip`)
are both tested directly; the live Initializr call itself was verified once, by hand (see above).
`new/fastapi.mjs` has no network dependency, so it gets a full real end-to-end test including the
real scanner adapter's own `detect()`.

**EXIT**: the `.bskel/config.yml` scope cut is permanent, not temporary -- if a future need for
persisted project config actually appears (not hypothesized here), it should be re-justified
against this same anti-stale-state principle, not assumed away by this entry.

See also: `D-adapter-registry` (G1, `runScan()`'s own fresh-every-time detection this item's
config-file rejection is consistent with); `D-doctor-workflow` (D5, why `bskel doctor` already
covers the "detect/select adapters" half of the original `init` ask); `D-java-analyzer`/
`D-patch-strategy` (A2/A3, `detectJacksonPackage()` is why an exact Initializr `bootVersion` pin
isn't needed for compatibility).

## D-db-schema-plane (A4): migration-file scan (Plane A) + live introspection (Plane C), report-only, no new gate

**WHY**: CATALOG.md's A4 asks for a "Read-only database schema plane" -- `runScan({includeDb})`
already had the parameter and `bskel scan --db` already existed as a hidden, inert placeholder
(`lib/cli.mjs`'s own prior comment called it exactly that); neither was ever wired to anything.
"Plane C" is this codebase's own pre-existing name for live introspection (not invented here).

**Grounding, directly verified**: the real oracle repo (Team-IZ-Backend) has ZERO Flyway/
Liquibase migration files anywhere, no `flyway`/`liquibase` config, and `ddl-auto: validate`
(Hibernate never generates DDL) -- its actual schema is managed entirely in an external Supabase
project, outside this repo. This session had never opened a live DB connection before this item
(`D-migration-scope`'s own documented reason). This machine has both Docker and a local Homebrew
Postgres available, making genuine end-to-end verification possible without ever touching real
credentials or shared infrastructure.

**User-approved scope (AskUserQuestion)**: build both planes, but do NOT add a new pass/fail gate
on a schema hash (the catalog's own literal "gate on a normalized schema hash" wording). Every
other gate in this system is git/fs-derived with zero external-network dependency; a gate that can
only ever be satisfied with a live DB connection would be unavailable in CI by default and
unavailable whenever the DB is unreachable -- a fundamentally different risk/availability class
than anything else this gate system tracks. Both planes surface purely as `bskel scan --db`
REPORT content (drift findings land in `unknowns`, the same plain-string array every other unknown
already uses), matching A1 §7's "detect and warn, never gate" precedent for the path-prefix-signal
case exactly.

**CLI surface**: `bskel scan --db [--database-url-env <NAME>] [--schema public]` -- both new flags
on the EXISTING `scan` command. `--db` alone runs Plane A only (migration files, always local,
zero network). Adding `--database-url-env <NAME>` on top of `--db` also runs Plane C: the
connection string is read from `process.env[NAME]` ONLY, at call time -- never from `.env`
directly (this project's own convention throughout, and Team-IZ-Backend's own CLAUDE.md `.env`
caution). Env-var-resolution and the live connection itself are resolved at the CLI boundary
(`bin/bskel.mjs`'s new `resolveDbSchemaOrExit`), never inside `scanners/index.mjs::runScan()`
itself -- keeps `runScan()` synchronous and DB-I/O-free, matching how every other env-driven input
in this codebase is resolved at the CLI layer, never inside a "pure" scanner/lib function. Missing
env var -> `BAD_ARGS`; a real connection failure -> `REFRESH_FAILED` (reused, not a new exit code,
matching D2's conservatism -- the same code `preflight`'s own "reached externally and failed" case
already uses).

**Plane A** (`scanners/db/migrations.mjs`): detects Flyway (`**/db/migration/**/*.sql`) and
Liquibase (`**/db/changelog/**/*.{xml,yaml,yml,sql}`) via `rg --files`, same tool every other
scanner already shells out to. `.sql` files get a bounded regex extraction (`CREATE TABLE`/`ALTER
TABLE ADD COLUMN`, balanced-paren column-list splitting) -- same "good-enough regex, not a real
SQL parser" restraint as A2's Java analyzer and G2's Python analyzer, a third independent copy of
the balanced-paren algorithm (matching python-fastapi.mjs's own established precedent of not
reaching across an unrelated module for a five-line algorithm). Liquibase changelogs are detected
(filenames recorded) but not deep-parsed -- XML/YAML changeSet parsing is a materially larger,
separate job; an honestly documented gap, not a silent guess. Deliberately does NOT attempt to
reconstruct a "final" merged schema across multiple migration files (each `CREATE TABLE`/`ALTER
TABLE` occurrence stays its own entry, traceable to its source file) -- a real migration history
can DROP/RENAME columns, which this module doesn't parse at all; pretending to merge into one
coherent final view would silently corrupt exactly the cases it can't handle. **Unverifiable
against the real oracle repo** (zero migration files exist there) -- built and tested entirely
against synthetic fixtures instead.

**Plane C** (`scanners/db/introspect.mjs`): uses `pg` (new dependency, this project's first-ever
SQL driver -- pure JS, no native compile step). Issues `BEGIN TRANSACTION READ ONLY` immediately
after connecting -- structural defense-in-depth (every query is already a SELECT, but the
transaction mode means the database itself refuses any write attempt, not just "we didn't write
one"); confirmed live: a `CREATE TABLE` issued inside the same read-only transaction is rejected
by Postgres itself with `cannot execute CREATE TABLE in a read-only transaction`, not merely
absent from this code. Queries `information_schema.tables`/`.columns`/`.table_constraints`+
`.key_column_usage` (PKs/FKs) and `pg_catalog.pg_indexes`/`pg_policies` (Postgres-specific, no
information_schema equivalent), scoped to `--schema` (default `public`) so this never dumps
unrelated system schemas. All parameterized (`$1`), never string-interpolated, even though
`schema` only ever comes from a CLI flag the process's own owner typed -- correct SQL hygiene
regardless (CLAUDE.md §6). **A real bug found live, not assumed**: the first draft issued all six
queries via `Promise.all()` on a single `pg.Client` -- works today (pg queues them internally) but
is deprecated and warns loudly (`Calling client.query() when the client is already executing a
query is deprecated`); fixed to sequential `await`s (a single client processes one query at a time
over one connection regardless -- a `Pool` would allow real concurrency, but this is a one-shot CLI
invocation, not a long-lived server, so the added complexity buys nothing real here).
**A second real Node/pg quirk found live**: a refused TCP connection surfaces as an
`AggregateError` (dual-stack IPv4+IPv6 connection attempts, both failing) whose own top-level
`.message` is an EMPTY STRING -- `.code`/`.errors[]` carry the actual information. A plain
`err.message` would have surfaced nothing useful to the user; `describeConnectionError()` checks
`.message`, then `.errors[]`, then `.code` in that order.

**Drift cross-check** (`scanners/index.mjs::computeDbDrift`): case-insensitive comparison between
Plane C's real table names and every already-scanned entity's own `.table` field (Postgres
lowercases unquoted identifiers; JPA `@Table` names are frequently mixed-case, so case-sensitive
comparison would false-positive constantly). Both directions are reported -- a live table with no
matching entity, and an entity whose declared table isn't found live -- as plain strings appended
to `unknowns`, never affecting `verdict`.

**Verification**: `npm test` (default suite) covers Plane A's extraction, `computeDbDrift()`, and
`runScan()`'s wiring entirely with local/synthetic inputs -- zero network dependency, matches this
project's CI-must-not-depend-on-live-external-services convention. Plane C is proven for real by
`scripts/db-introspect-smoke.mjs` (new, mirrors `java-compile-smoke.mjs`/`python-import-smoke.mjs`
exactly) against a REAL Postgres -- verified twice: once locally (a disposable local Homebrew
Postgres instance, torn down after), and wired permanently into CI as a new `db-introspect` job
using GitHub Actions' native `services:` Postgres container (`POSTGRES_HOST_AUTH_METHOD: trust`,
deliberately no password literal anywhere in the committed workflow file -- a real secrets-scanning
hook flagged an earlier draft that used a hardcoded throwaway password, confirming even a
low-stakes credential-shaped string in a committed file is worth avoiding entirely, not just
judged "safe enough this once"). The smoke script creates two real tables (one matching the
fixture's own `Widget` entity, one deliberately orphaned) and asserts the live drift finding is
real, not fabricated.

**EXIT**: the no-gate scope cut is permanent, not temporary -- same class as
`D-greenfield-bootstrap`'s `.bskel/config.yml` cut. If a future need for a real schema-hash GATE
appears, the CI-availability problem (no live DB in the default matrix) needs solving first, not
assumed away.

See also: `D-generic-grep-reconnaissance`/A1 §7 (the "detect and warn, never gate" precedent this
item's whole no-gate design follows); `D-migration-scope` (the pre-existing "no live DB opened
this session" constraint this item is the first to actually lift, safely); `D-java-analyzer`/
`D-fastapi-adapter` (A2/G2, the "good-enough regex, not a real parser" restraint Plane A's SQL
extraction follows); `D-cli-contract` (D2, why REFRESH_FAILED/BAD_ARGS were reused instead of new
exit codes).


## D-handle-lifecycle (O4): register/recordSnapshot upsert API + opt-in AOP auto-recording + a real running-app verification that found two genuine bugs no compile check ever could

**WHY**: `HandleController.recover()` (D-security-9's own fix already lived there) was fully
implemented but structurally unreachable -- nothing anywhere ever called `HandleRegistry.create()`/
`HandleSnapshot.create()`, so a registry lookup could never find a row. Field-level `fetch`
(`kind=f` GET) always 501'd. O4 (CATALOG.md, Scope L) closes both gaps. **User-approved scope
(AskUserQuestion, overriding this item's own narrower recommendation)**: the FULL catalog scope,
including the opt-in AOP auto-snapshot interceptor, not just the explicit `HandleService` API.

**`ResourceResolver` gains `contractRef()`/`featureUid()`**: baked in as `private static final`
constants at `bskel handles emit` time (same mechanism A5's `contract_hash` already established --
`sha256File` on `specs/<feature>/contracts/<feature>.schema.json`), never read from disk at
runtime (a deployed app has no access to `specs/` at all). Regenerated every emit run, so a
contract change is picked up automatically. **A real correctness bug caught before it ever
shipped**, while writing `emit.mjs`'s O2 adoption-safety re-render (`pristineRenderFor`): the
CURRENT run's own precomputed `contractRef`/`featureUid` were about to be reused when checking a
DIFFERENT owner feature's resolver file during cross-feature adoption safety checks, which would
have manufactured a false conflict on every cross-feature resolver-regeneration scenario. Fixed
with `contractRefFor(id)`/`featureUidFor(id)` helpers, recomputed fresh for `ownerId !== featureId`
(`featureUidFor` falls back to the nil UUID if the other feature's `feature.json` no longer
exists).

**`HandleService` (new, explicit API, never auto-invoked)**: `register(kind, type, resourceUid,
pointer, featureUid, operationId, contractRef)` derives `handle_uid` via the existing
`HandleCodec.deriveHandleUid` and **upserts** -- the schema's own `unique (resource_type,
resource_uid, pointer)` constraint means the SAME triple always derives the SAME `handle_uid`, so
re-registering it is expected, not an error: `HandleRegistry#refresh` updates `featureUid`/
`operationId`/`contractRef` but deliberately never touches `revokedAt`/`revokedReason` -- a
re-registration must never silently un-revoke a handle. `recordSnapshot(...)` serializes `payload`
via the injected `ObjectMapper`; `revoke(handleUid, reason)` sets `revokedAt`/`revokedReason` (a
new column, self-initiated -- matches this codebase's established "every revocation-adjacent
operation requires `--reason`" convention already used for feature rename/archive, contract waive,
handles patch approve). `pruneSnapshotsOlderThan(Instant)` is exposed but never auto-scheduled
(no `@Scheduled` wiring anywhere) -- same boundary `D-migration-scope` already draws around never
applying the emitted `migration.sql` on its own; deciding retention and whether a background job
is even appropriate is left to a human. Never touches/injects into any existing business logic
class, matching `D-config-patch`/`D-resolver-scope`'s "never invasively edit real business logic"
boundary.

**Field-level fetch** (`HandleController.fetch`): the previous unconditional 501 for `kind=f`
replaced with `objectMapper.valueToTree(resource)` -> `JsonNode#at(pointer)` (RFC 6901 -- Jackson's
own built-in, no hand-rolled walker needed, unlike the JS reference `resolveJsonPointer` which had
no such built-in to reach for) -> 404 via `ResponseStatusException` if the pointer resolves to a
missing node.

**Opt-in AOP auto-recording** (`@RecordHandleSnapshot` + `HandleAspect`): applied BY A HUMAN to an
existing service method they choose (never auto-applied by codegen touching real files).
`resourceUidParam` is an explicit parameter INDEX, never inferred -- the same "never guess, always
explicit" boundary `D-resolver-scope`/`D-security-8` already draw; a wrong guess here would
silently attribute a snapshot to the wrong resource. `redact` is an explicit JSON Pointer array,
deliberately not a guessed heuristic ("field name contains password"). `HandleAspect`
(`@Aspect @Around` on `@annotation(RecordHandleSnapshot)`) captures the request payload (method
args minus the uid param) before invocation, the response/error payload after, applies `redact`
via a hand-rolled `redact(ObjectNode, String)` navigator (Jackson's `JsonNode` has `.at()` for
READING only, no built-in set/remove-at-pointer), and calls `HandleService.register`+
`.recordSnapshot`. Every recording step is wrapped in a `safely()` helper that logs and swallows
any exception -- snapshot recording must NEVER fail the real business call it wraps (best-effort
observability, not a new failure path). Requires `spring-boot-starter-aop` on the target repo's own
classpath, NEVER auto-added to a real target's `build.gradle` (`D-config-patch` boundary) --
`handles emit`'s `postEmitNotes` gets a new line naming this explicitly, the same
"review and apply yourself" precedent `migration.sql` already established. `@RecordHandleSnapshot`
must be applied to the CONCRETE implementation class, not the interface method -- Spring AOP's
`@annotation` pointcut resolves via `AopUtils#getMostSpecificMethod`, reliable for both JDK dynamic
proxies (interface-based) and CGLIB, whereas an interface-only annotation is only guaranteed
visible through a JDK proxy; this item's own integration-test fixture (`WidgetServiceImpl`)
follows this.

**Jackson 2/3 dual-compatibility**: `HandleService#recordSnapshot`'s `objectMapper.writeValueAsString()`
throws checked `JsonProcessingException` under Jackson 2 but unchecked `JacksonException` under
Jackson 3 -- since `{{JACKSON_PACKAGE}}` resolves to either package at codegen time, the same
template source must compile against both. Fixed with a generic `catch (Exception e)`, not a
version-specific import (same principle `detectJacksonPackage()`/A3 already established).

**★ A real, previously-undiscovered functional bug found by this item's own real integration test
(never caught by A3's compile-only verification)**: `WidgetResolver.patchField()`'s generated
`/label`/`/capacity` cases reconstruct the FULL `UpdateWidgetRequest` record with every OTHER
field left `null`, then originally called `validator.validate(patch)` -- Jakarta Bean Validation
validates the WHOLE reconstructed object, not just the field being patched, so `ownerName`'s
`@NotNull` (correctly classified `fetch-merge-submit`, deliberately left null in the
reconstruction) ALWAYS produced a violation, making every generated `patch-wrapper`/
`null-means-unchanged` field unusable (always 400s) whenever its DTO has ANY other `@NotNull`/
primitive sibling field -- a broader, more severe case than D-patch-strategy's own already-known
"fully-qualified `@NotNull` annotation not detected" limitation (that one degrades to "generates
code that always 400s for one field until a human notices"; this one made EVERY approved field on
an affected DTO permanently broken). Confirmed live with a standalone `jakarta.validation.Validator`
probe against the real `UpdateWidgetRequest` reconstruction before touching any generated-code
template (`validator.validate(...)` on `new UpdateWidgetRequest(PatchField.of("x"), null, null,
null)` produced a real `ownerName` violation), then confirmed the fix
(`validator.validateProperty(patch, "<field>")` -- scopes validation to only the property actually
declared for that field, ignoring sibling constraints entirely) with the same probe methodology
before changing `handles/providers/java-spring/patch-strategy.mjs`'s `caseCodegen()`. This is
squarely `D-patch-strategy`/A3's own codegen, not O4's -- documented here because O4's real
integration test is what found it; `patch-strategy.mjs`'s generated code and both JS-level tests
asserting its exact output (`test/patch-approve-cli.test.mjs`, `test/patch-strategy.test.mjs`) were
updated to match.

**★ A second real bug found by the same integration test**: `HandleController.recover()` embedded
`snapshot.getPayload()` (a Java `String` holding the raw JSON text `HandleService#recordSnapshot`
wrote) directly into its response `Map` -- Jackson then serialized that `String` as an ESCAPED JSON
STRING VALUE (`"payload":"{\"name\":...}"`), double-encoding every real caller's payload instead of
returning genuine nested JSON. Confirmed live by inspecting the raw HTTP response body of a real
`recover()` call before the fix. Fixed with `objectMapper.readTree(snapshot.getPayload())`,
embedding a real `JsonNode` instead of the raw string; a parse failure here means the stored
payload isn't valid JSON at all -- an internal invariant violation (this app's own
`recordSnapshot()` is the only thing that ever writes this column), not a caller-facing input
error, so it throws `IllegalStateException` rather than a 4xx.

**Verification**: `npm test` (JS suite) 686/687 green throughout (the one expected failure is the
dangling `D-handle-lifecycle` token check, resolved by this section existing). The deepest
verification this project has attempted: a real, disposable Postgres (local Homebrew Postgres for
manual verification, GitHub Actions' native `services:` container in CI, same
`POSTGRES_HOST_AUTH_METHOD: trust` convention `db-introspect`/A4 already established, own DB name
`bskel_o4_test`), the REAL emitted `migration.sql` applied via `psql`/a real `pg.Client` (never a
hand-copied duplicate), a genuinely running `@SpringBootTest(webEnvironment=RANDOM_PORT)` Spring
Boot app, and real HTTP calls (`java.net.http.HttpClient` for PATCH specifically -- `TestRestTemplate`'s
default `HttpURLConnection`-backed request factory throws `ProtocolException` on PATCH, confirmed
live). Four real integration tests, all passing against a real database: (1) the full lifecycle --
a real HTTP field-level PATCH through `HandleController` -> `WidgetResolver#patchField` (the exact
path that caught the `validateProperty` bug above) -> `WidgetServiceImpl#updateWidget` (annotated
`@RecordHandleSnapshot`) -> `HandleAspect` fires for real -> a real HTTP GET `recover` returns the
real recorded payload with `schema_drift:false`; (2) `recover`'s `schema_drift:true` branch, proven
directly against real registry/snapshot rows by registering under contract A, recording a snapshot
under A, then re-registering under contract B without a matching new snapshot -- a real contract
EDIT + re-emit + recompile + app restart mid-JUnit-run was judged out of scope for a single test
process (CONTRACT_REF being a baked constant recomputed from the contract file's real content hash
is already proven separately, live, during this item's own manual `handles emit` verification);
(3) field-level fetch resolving a real pointer and 404ing a missing one; (4) redaction proven at
the PERSISTENCE layer -- a `redact`-listed pointer's value is genuinely absent from the persisted
`payload` column (queried directly via `HandleSnapshotRepository`), not merely omitted from the
HTTP response, matching this item's own plan text exactly.

To run this locally: `./gradlew test --tests useJUnitPlatform()` requires two additions this item
also made to `test/fixtures/java-compile/build.gradle` that were previously entirely missing --
`test { useJUnitPlatform() }` and `testRuntimeOnly 'org.junit.platform:junit-platform-launcher'`
(newer Gradle no longer bundles the launcher) -- both confirmed necessary by real failing runs
("No tests found" / "Failed to load JUnit Platform"), not assumed. New
`scripts/java-integration-smoke.mjs` mirrors `java-compile-smoke.mjs`'s full CLI-pipeline-against-
a-scratch-copy shape plus `db-introspect-smoke.mjs`'s real-Postgres wiring (`BSKEL_TEST_DATABASE_URL`,
never `.env`), applies the real emitted `migration.sql` plus a small `widgets` table matching
`Widget.java`'s own JPA mapping exactly (`ddl-auto: none` in the new `application-test.yml` --
Hibernate never creates/alters schema on its own, matching `D-migration-scope`'s boundary for
`bskel` itself), then runs `./gradlew test` scoped to `HandleLifecycleIntegrationTest`. Wired into
CI as a new `java-integration` job (own dedicated job, not folded into `java-compile`, since it
needs both a JVM toolchain AND a database service container and runs a materially heavier
`./gradlew test` rather than `compileJava`) -- the wrapper-bootstrap mechanism
(`gradle wrapper --gradle-version 8.8`) is identical to `java-compile`'s own, already proven in CI;
the rest of the pipeline (CLI workflow, migration application, `./gradlew test` itself) was proven
correct by running the exact equivalent command sequence manually against a real local Postgres
(4/4 tests green) before this job was wired in, since this machine has no `gradle` bootstrap binary
installed to run the new script's own wrapper-generation step directly.

**Test-only fixture additions** (`test/fixtures/java-compile/`): `WidgetServiceImpl` (the first
real, non-stub service implementation this fixture has ever had -- `WidgetController`'s endpoints
previously always returned `ResponseEntity.ok(null)`), `WidgetRepository`, `Widget` gained
`@Getter`/`@Setter` (needed for both the new service impl and for Jackson's default
PUBLIC_ONLY-getter visibility to serialize this entity as anything but `{}`), and a test-only
`TestSecurityConfig` (`@EnableMethodSecurity` + a filter that unconditionally stamps a `ROLE_ADMIN`
authentication onto every request -- this test verifies the handle lifecycle plumbing, not a real
login flow).

**EXIT**: if a real contract-edit-triggers-drift end-to-end scenario is ever needed, it requires a
separate test harness that can re-emit + recompile + restart the app mid-test (out of scope for a
single JUnit process) -- `recover`'s comparison logic itself is already fully proven.

See also: `D-security-9` (the `recover()` cross-check this item's snapshot-recording finally makes
reachable); `D-resolver-scope`/`D-security-8` (the "never guess, always explicit" precedent
`resourceUidParam`/`redact` follow); `D-config-patch`/`D-migration-scope` (why `spring-boot-starter-aop`
and `migration.sql` are both "review and apply yourself", never auto-applied); `D-patch-strategy`
(A3, the `validateProperty` bug found and fixed here); `D-db-schema-plane` (A4, the real-Postgres
CI service-container convention this item's own `java-integration` job reuses exactly).


## D-verify-integrity (S6, continued): --build fail-closed, stdout+stderr capture, executable-mode drift, resolver conflict surfacing

**WHY**: CATALOG.md's S6 was marked partially implemented (`18d0838` -- only the `migration.sql`
disappearance case). Its full concrete-approach text names five things; grounding (real execution,
not assumed) confirmed four were still live gaps and re-scoped the fifth.

**1. `--build` fail-closed + `--allow-skip-build`.** Reproduced live before touching any code: with
every other gate passing, `bskel verify --feature <id> --build` on a repo with no recognized build
tool reported `VERIFY: PASS` / exit 0 -- `cmdVerify`'s old `buildOk = !build || !build.ran ||
build.ok` treated "didn't run" as "doesn't block" unconditionally, silently no-opping an explicit
user request for build assurance. Fixed: `buildOk = !build || build.ok || (!build.ran &&
allowSkipBuild)` -- a new `--allow-skip-build` flag (exact catalog wording) is the one explicit
opt-out, matching `--force`/`--offline`'s own "explicit request needs an explicit escape hatch"
shape elsewhere in this CLI. Verified live, isolated (all other gates forced to pass): without the
flag, exit 1; with it, exit 0.

**2. stdout+stderr capture.** Reproduced live: a failing `npm run build` whose only diagnostic text
is on stderr (`FATAL: ...`) was completely invisible in the reported failure message --
`runBuildCheck`'s catch block only ever read `err.stdout`. Real repro: npm's own generic `> pkg
build\n> cmd` banner lands on stdout, the actual fatal error entirely on stderr. Fixed: both streams
captured, each with its OWN last-30-lines window (not one combined window) -- a long stdout must not
crowd out a short-but-critical stderr message, which is exactly what the live repro showed.

**3. Executable-mode drift.** `stack/apply.mjs`'s `applyPlan()` sets a file's mode via
`fs.chmodSync` at apply time, but nothing ever re-checked it afterward -- the `stack` gate's
staleness token (`D-gate-precision`, S2) hashes each applied file's CONTENT only, which is blind to
a `chmod -x scripts/dev-tunnel.sh` (bytes unchanged, token unchanged, gate stays `pass` forever even
though the script no longer runs). Fixed with a sibling fingerprint: new `fileMode()` in
`lib/fsutil.mjs` (mirrors `sha256File`'s exact null-means-missing shape), tracked as a SEPARATE
`applied_file_mode:<relpath>` key alongside the existing `applied_file:<relpath>` content hash in
`stack.recompute()` -- deliberately a distinct key, not merged into the content hash, so
`diffInputs()` names "the mode drifted" specifically rather than a generic "stale". Tracks the
CURRENT mode unconditionally for every applied file (no "expected value" lookup against the catalog
entry) -- mirrors how content hashing already works, and avoids re-loading/re-validating YAML inside
a hot, frequently-called path. Verified live: stripping the executable bit while leaving both the
file's content and `.sbf/stack.json` itself byte-identical still makes the gate stale, naming the
`applied_file_mode:` key precisely; restoring it un-stales the gate.

**4. Resolver conflict surfacing -- and a real false-positive caught by the existing test suite
before it ever shipped.** O2's content-derived conflict detection (`classifyFile()`, `lib/
handles-manifest.mjs`) already runs on every `handles emit`/`handles plan --diff`, but `bskel
verify` never invoked it -- `checkArtifacts()`'s `handlesManifestChecks()` loads the same manifest
and iterates the same entries but only ever checks `fs.existsSync`. New `checkResolverConflicts()`
(`lib/verify.mjs`) reuses the EXACT dry-run call `handles plan`'s own D4 preview already makes
(`provider.plan()` -> `provider.emit({dryRun:true})`), wrapped in try/catch with every precondition
mirroring `handlesManifestChecks()`'s own graceful-skip philosophy (not handles-ran, missing scan
report, missing capability/provider, or a plan/emit throw -> `[]`) -- verify must never crash or
false-block just because handle codegen doesn't apply to this feature.

**The first draft made `conflicts.length === 0` part of the blocking `overallPass` computation --
wrong, caught immediately by `test/handles-cli.test.mjs`'s own pre-existing regression test**
("hand-finishing patchField() in a generated resolver does NOT stale the handles gate or fail
verify"), whose own comment already named the exact trap: `classifyFile()`'s `conflict` state
cannot distinguish "genuinely corrupted" from "intentionally hand-finished patchField()" -- the
latter is the NORMAL, PERMANENT end state for those files (see `D-resolver-scope`), and O2's own
`_engine.mjs` conflict message says so explicitly ("If you HAVE edited it ... leave it -- nothing
else in this run depends on it"). Blocking `verify` on this would have failed every feature that
ever hand-finished a resolver, forever -- reintroducing, via a different code path, precisely the
false-positive `D-gate-precision` (S2) already reasoned through and rejected for the `handles` gate's
own token. Fixed: `conflicts` is surfaced in the report (a new `## Conflicts` section, only printed
when non-empty; a new top-level `conflicts` array in `--json`) but does NOT affect `overallPass` --
same "detect and warn, never gate" precedent as A1 §7's path-prefix signals and A4's DB drift
reporting. `bskel status`/`bskel next` (`lib/workflow.mjs`) are deliberately untouched by this item
-- surfacing a conflict as a blocking `next` action is a real design question (what command would
`next` even suggest?) outside this item's own scope.

**5. Catalog artifacts -- re-scoped, not a gap.** `stack/apply.mjs`'s `STACK_ROOT =
path.dirname(fileURLToPath(import.meta.url))` -- `bskel catalog lint` (P4) only ever validates
`stack/catalog/*.yml` files bundled INSIDE the installed bskel package itself. There is no
mechanism today for a target repo to register its own catalog entries (P4's own DECISIONS.md text
explicitly deferred that: "keep extensions local/configured initially before designing a remote
registry"). A consumer's `bskel verify` run has no repo-specific catalog state to check --
folding `catalog lint` into it would just re-validate bskel's own bundled YAML on every consumer's
run, already covered by bskel's own `npm test`/CI before it ever ships. This is written down here so
it isn't silently re-litigated as an unclosed gap next time S6 is revisited.

**Verified**: `npm test` 688/688 (686 baseline + 2 net new: one new `--build` opt-out test replacing
the old bug-asserting one, one new stderr-capture test, one new chmod-drift test, plus assertions
folded into 2 existing tests rather than new files). Manual, live, isolated end-to-end for the two
highest-risk pieces: a real `--build` run against a repo with no build tool (both with and without
`--allow-skip-build`), and a real `stack apply` + chmod-strip + `verify` cycle.

See also: `D-gate-precision` (S2, whose `diffInputs`/`stack` token this item extends, and whose
own "never hash generated content into the handles token" reasoning is exactly what the
conflicts-blocking false-positive above reproduced and then had to un-reproduce);
`D-handles-ownership` (O2, `classifyFile()`'s own conflict semantics, unchanged by this item --
only reused, not reimplemented); `D-handles-dryrun` (D4, the exact `provider.emit({dryRun:true})`
call this item's conflict surfacing reuses); the original S1/S6 hardening entry (the `stack`-missing-
from-verify and `migration.sql`-existence-only-check bugs this item's own predecessor fixed).

## D-java-ast-helper (A2 Phase 2): a real JavaParser + Symbol Solver layer, opt-in, one working consumer

**WHY this got built at all, and why the Why is an explicit user override, not a grounded catalog
gap.** A2 Phase 1 (`D-java-analyzer`) closed the regex analyzer's real bugs. Grounding for Phase 2
found only ONE remaining concrete gap in that regex path -- a fully-qualified
`@jakarta.validation.constraints.NotNull` annotation isn't recognized as `@NotNull`, only the plain
simple-name form is -- and that gap hits 0 of 51 real DTO fields in the oracle repo and degrades
gracefully (the field is just not classified as required, not misclassified as something worse).
The catalog's own A2 text still names Phase 2 explicitly: a `java-spring-ast` capability using real
JavaParser + Symbol Solver, invoked only when installed, regex staying the permanent fallback. I
recommended NOT building it (weak cost/benefit against a real bundled-JVM-helper cost). **The user
explicitly overrode that recommendation and chose to build it exactly as originally specified** --
this entry documents that decision being honored in full, not a scoped-down substitute.

**Two API-risk findings from real research (WebSearch/WebFetch), not assumed, and both shape the
design below.** `com.github.javaparser:javaparser-symbol-solver-core:3.28.2` is confirmed live on
Maven Central. `javaparser/javaparser#1621` documents a `ClassCastException`
(`JavassistInterfaceDeclaration` cannot cast to `ResolvedAnnotationDeclaration`) when resolving an
`AnnotationExpr` node through `JavaSymbolSolver`, with no working fix in that thread -- building
this item's one concrete consumer (annotation FQN resolution) on top of a historically flaky API
would have been a bad trade for exactly the gap this item exists to close. `Type#resolve().describe()`
has no comparable reliability history and is the standard documented Symbol Solver pattern for type
resolution. **Design consequence**: annotation FQNs are resolved via a hand-built map from
`CompilationUnit.getImports()` (a written-fully-qualified annotation needs no resolution at all --
it's already fully qualified in the AST; a simple-name annotation is looked up against the import
map, falling back to the as-written name on no match) -- zero Symbol Solver dependency for the part
that's documented-unreliable. Symbol Solver (`CombinedTypeSolver` + `ReflectionTypeSolver` +
`JavaParserTypeSolver`) is used only for what it's actually reliable at: each DTO field's real type.

**Scope: one real working consumer this PR, the rest named and deferred, not silently dropped.**
The catalog's own text names four surface areas -- DTO fields, service signatures, validation,
security expressions. Service-signature resolution (across inheritance/generics) and SpEL parsing
for `@PreAuthorize` expressions are each their own substantial sub-project; building all four in one
PR would be a disproportionate single change against this session's own established pattern (see
`D-gate-precision`'s Part 1/Part 2 split). This PR builds the real, risky infrastructure the user
explicitly chose to accept -- the bundled JVM helper, real JavaParser + Symbol Solver -- plus ONE
genuinely working consumer: DTO field type + annotation resolution, feeding a new, explicit,
opt-in cross-check against A3's existing regex-based `classifyDtoFields()` (`patch-strategy.mjs`).
Service-signature and security-expression resolution are EXIT'd here, explicitly, as future work --
not claimed as done, not silently absent.

**Invocation model: an explicit opt-in command, not a silent automatic escalation.**
`classifyDtoFields()` stays synchronous and completely unchanged -- threading an async subprocess
call into it would force async through its entire existing call chain (`plan.mjs`, `handles/
_engine.mjs`, every CLI command that touches patch classification) for a capability the catalog's
own text already calls optional. Instead, `bskel handles plan --ast` is a new, separate flag: it
runs BOTH the existing regex classification and the new AST helper, and reports any field where
they disagree (an annotation the AST helper resolves to a `NotNull`/`Valid` FQN that regex didn't
recognize as such) as a new, purely informational `ast_disagreements` section -- never auto-changes
an approval, never blocks anything, same "detect and warn, never override a human decision"
precedent as `D-verify-integrity`'s resolver-conflict surfacing and A1's path-prefix signals. This
IS what the catalog's own "invoked only when installed" phrasing means in practice: a human opts in
for the deeper check; regex stays the permanent, always-on fast path exactly as the catalog specifies.

**The bundled helper itself, and a real bug the first live run caught immediately.**
`handles/providers/java-spring/ast-helper/` is a small Gradle `application` project (`Main.java`)
with a COMMITTED Gradle wrapper -- the opposite of `test/fixtures/java-compile/`'s own wrapper
(generated fresh at CI/local-run time, gitignored, never committed, per `D-fixture-corpus`): this
wrapper ships inside the npm package itself and runs on a real consumer's machine with an unknown
JDK, so it has to actually be present after `npm install`, not regenerated. Pinned to Gradle 9.5.1
(the same distribution this whole session's every real-compile verification has already used
successfully), deliberately NOT 8.8 like `java-compile-smoke.mjs`'s own throwaway CI-only wrapper --
this machine's own default JDK 26 already broke 8.8 once earlier in this session, and a shipped
runtime dependency needs the more robust, actively-maintained version, not the narrower CI pin.
`Main.java` configures `StaticJavaParser` with `JavaSymbolSolver(new CombinedTypeSolver(new
ReflectionTypeSolver(), new JavaParserTypeSolver(srcRoot)))`, finds the DTO's top-level `record`
declaration (matching `classifyDtoFields()`'s own current scope -- class-shaped DTOs are an
out-of-scope gap on BOTH the regex and the AST path, not newly introduced here), and for each
record component resolves its type (`type.resolve().describe()`, falling back to the as-written
type text on any resolution failure -- Symbol Solver failing on an unusual generic shape must
degrade a single field, never crash the whole run) and each annotation via the import-map above.
**The very first live `./gradlew run` against a real fixture DTO threw `ParseProblemException`**
("Record Declarations are not supported... must be JAVA_14+") -- `StaticJavaParser`'s default
`ParserConfiguration` language level doesn't support `record`. Fixed by explicitly calling
`StaticJavaParser.getParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17)`
before any parse call; re-verified successfully afterward against a fixture with both a plain
`@NotNull` field and a fully-qualified `@jakarta.validation.constraints.NotNull` field -- both
resolved to the identical FQN, and a `List<String>` field correctly resolved to
`java.util.List<java.lang.String>`.

**The Node-side bridge (`handles/providers/java-spring/ast-bridge.mjs`) mirrors this codebase's own
established network-disclosure precedent.** `detectAstHelperAvailable()` is synchronous, cheap
(`java -version` + wrapper-exists checks, both wrapped so it never throws) and is the SAME function
both `bskel doctor` (workflow-scoped, shown only under `--workflow handles`, `required: false`) and
`--ast`'s own upfront check call -- doctor and the real command can never disagree about
availability. `runAstClassify()` spawns the wrapper's `run` task; its first invocation on a machine
downloads JavaParser's own dependency from Maven Central, a real one-time network access, logged
explicitly to stderr before the subprocess runs -- the same "network access must be explicit, never
silent" rule P2's Spring Initializr call already established for this codebase, applied here rather
than reinvented.

**Verified**: real, live, manual end-to-end runs on this machine (`./gradlew build -x test` ->
`BUILD SUCCESSFUL`; a direct `runAstClassify()` invocation against a real fixture DTO, both
annotation forms resolving correctly) before any of this was wired into the CLI or CI, matching
this session's own established discipline of proving a real compile/run locally first. See
`test/handles-ast.test.mjs` and the CI `java-ast` job for the automated version of the same two
cases. `npm test` full suite: no regression in `classifyDtoFields()` or any existing `handles plan`
behavior -- `--ast` is additive and off by default (`ast: {type:'boolean', default:false}`,
`lib/cli.mjs`).

**A real `npm pack` bug found and fixed, not assumed correct.** `package.json`'s `files` array
already lists `"handles/"`, so no entry was expected to be needed for the new subdirectory --
verified live per this session's own "verify, don't assume" discipline anyway, and that check found
a real bug: `npm pack --dry-run` shipped the ENTIRE local `.gradle/`/`build/` output (11+MB of
compiled classes, a `.jar`, a `.tar`, a `.zip`) despite both being listed in the root `.gitignore`.
Root cause, confirmed by isolating it: once a directory is explicitly named in `files`, npm's
package walker does not reliably apply a ROOT-level `.gitignore`/`.npmignore`'s multi-segment
(full-path) patterns to paths nested inside that already-allowlisted directory -- a root
`.npmignore` with the identical patterns reproduced the same bug. Fixed with a SECOND, local
`.npmignore` placed directly inside `handles/providers/java-spring/ast-helper/` itself, using
directory-relative patterns (`.gradle/`, `build/`) -- confirmed via `npm pack --dry-run` to
correctly ship only the 7 real files (`build.gradle`, `settings.gradle`, `Main.java`, the four
wrapper files). The root `.gitignore` entries stay too (git itself isn't affected by this bug --
`git check-ignore -v` already confirmed both paths correctly ignored) -- the two files now serve
two different tools' two different walk semantics for the same excluded paths.

**Explicitly deferred, not silently dropped**: service-signature resolution (across inheritance and
generics) and security/SpEL-expression resolution (`@PreAuthorize` bodies) -- both substantial
enough to be their own future catalog items, not folded into this one.

See also: `D-java-analyzer` (A2 Phase 1, the regex path this item's `--ast` cross-checks against,
left completely unchanged); `D-patch-strategy` (A3, `classifyDtoFields()` itself, the function this
item deliberately does NOT thread async through); `D-npm-packaging` (P1, the `files` allowlist this
item's committed wrapper needs to actually ship); `D-verify-integrity` (S6, the "detect and warn,
never gate" precedent `ast_disagreements` follows).

## D-javascript-express-adapter (G6): a fourth scanner adapter, and the codegen half that measurement said not to build

**WHY**: a real production backend was completely invisible to this tool, for two independent
reasons that were confirmed by reading its actually-shipped code, not inferred. The app is an
ordinary `express.Router()` service on AWS Lambda (`nodejs20.x`), reached through a one-line
`serverless-http` wrapper -- the exact routing idiom G5's adapter already understands. It was
nevertheless scanned by `generic-grep` (specificity 0, `confidence: "low"`, one lumped `_generic`
module, no prefix resolution, and a feature-scoped scan that refuses to write its report at all
without `--accept-low-confidence`), because:
1. `detectTypeScriptExpressRoot()` restricts its ripgrep source search to `-g '*.ts'`. The app is
   plain JavaScript (`"type": "module"` ESM, `.js` files, no `typescript` devDependency anywhere),
   so `detect()` returns `null` unconditionally.
2. Even a hypothetical TypeScript port would still fail the handles-codegen precondition:
   `handles/providers/typescript-express/plan.mjs`'s `findDataSource()` requires a TypeORM
   `DataSource`. This app has no ORM at all -- `mysql2`/`mariadb` are called directly from
   controller code.

Reason 1 is a scanner gap with a mechanical fix. Reason 2 is not, and the two were shipped
separately: **Phase 1 (the scanner) is built; Phase 2 (handles codegen) is deliberately not, on
measured evidence** -- see EXCLUDED. This follows `D-fastapi-adapter`'s own precedent exactly:
G2 shipped a real, first-class adapter with `codegen.handles: false` and zero codegen, and codegen
only arrived in G4 once a second real provider existed to factor a boundary against. A real
scanner adapter with no codegen provider is a legitimate shipped state, not a half-finished one.

**A fork, not a generalization -- decided from real code, not preemptively.** The obvious move was
to widen `typescript-express`'s glob from `*.ts` to `*.{ts,js}` and be done. Three findings, each
from writing the adapter against a real-shaped fixture, made that wrong:
1. **Capabilities are per-adapter booleans.** A merged adapter would have to declare ONE value for
   `codegen.handles` and `resource.fetch`. `true` is a lie for a plain-JS repo (the provider's own
   `detectProjectRoot()` requires a `tsconfig.json` and would throw, not refuse cleanly, on a repo
   that has none); `false` is a regression that would silently disable G5's shipped, working
   codegen. The honest declaration is per-stack, so the adapter has to be per-stack.
2. **`import express from 'express'; const r = express.Router()` is the dominant plain-JS idiom.**
   G5's `detect()` requires a NAMED `import { Router } from 'express'` and never sees it.
3. **The router variable is frequently not called `router`.** G5 hardcodes the identifier
   (`/\brouter\.use\s*\(/`, `/\brouter\.(get|post|...)\(/`); the real target app's own entry file
   declares `const route = express.Router()`.

**SCOPE**: `scanners/adapters/javascript-express.mjs` (specificity 80, zero-registration, mirrors
G1's registry exactly); `scanners/adapters/_express-shared.mjs` (the primitives both Express
adapters genuinely share, extracted from `typescript-express.mjs` verbatim rather than copied --
same `_`-prefixed convention `_java-spring-analyzer.mjs` uses, same reasoning that produced
`scanners/text-util.mjs` under `D-scanner-evidence`); a synthetic, hand-built fixture corpus
(`test/fixtures/javascript-express/backend/`, same P3 precedent as the other three, NOT a vendored
copy of any real repo); two new test files (`test/javascript-express-cli.test.mjs`,
`test/express-shared.test.mjs`); a `test/conformance-harness.test.mjs` `ADAPTER_FIXTURES` wiring;
a one-line roster update in `test/adapter-registry.test.mjs`; the adapter lists in `README.md` and
`SKILL.md`. Also, unavoidably, two changes to `typescript-express.mjs` itself -- the
shared-primitive extraction (no behavior change, proved by its 19 tests passing unmodified) and the
comment-masking bug fix (a real behavior change, see Mechanism).

`test/handles-provider-registry.test.mjs` needed **no** change: its biconditional test
(`codegen.handles === true` iff a same-id provider is loaded) already generalizes over every real
shipped adapter, and passing it with `codegen.handles: false` and no provider is exactly the proof
that this item's honest scoping is machine-checked rather than asserted.

**EXCLUDED -- Phase 2 (handles codegen over raw SQL), and why measurement, not schedule, killed it**

CATALOG.md's G6 text proposed a second phase: generate handle resolvers for this stack by reading
the table name, primary key, and a safe column allow-list out of the raw `mysql2`/`mariadb` SQL
string literals at the fetch call site. That phase was investigated with a real fixture and real
executed probes before any of it was designed, and it is **deliberately not built**. Three
independent blockers, in increasing order of how fatal they are:

*Blocker A -- the extraction itself does not work on ordinary code.* A probe implementing the most
generous plausible heuristic (find every `SELECT ... FROM <table>` literal reachable from an
exported handler, take the projection list as the allow-list, take a `<col> = ?` predicate as the
key) was run against the committed fixture's controllers, which are modelled on what raw-SQL
Express code actually looks like. Result: **0 of 5 SELECT literals extract cleanly.** The specific
failures are not exotic:
- `getOrder` -- the single-resource GET for the `order` resource -- is a two-table `JOIN`, so
  `FROM <first table>` is not reliably the resource's table; it projects `o.*`, so there is no
  column allow-list at all; and its key predicate is alias-qualified (`o.order_id = ?`).
- `searchOrders` builds its statement by concatenation at runtime (`sql += ' AND status = ?'`), so
  no literal anywhere in the file ever contains the finished query.
- `countOrders`'s statement lives in a separate constants module, not at the call site.
- `listUsers` and `getUser` project DIFFERENT column sets from the same table -- "which columns is
  this resource safe to expose" is not one answer per table, it is one answer per call site.

*Blocker B -- even the one near-miss silently changes behavior.* `getUser` is the friendliest
possible shape (single table, explicit column list, one placeholder) and still carries a second
WHERE predicate: `... WHERE user_uid = ? AND deleted_at IS NULL`. A generated resolver can only
bind the ONE value a handle carries (the resource UUID), so the soft-delete predicate is dropped by
construction. Executed against a real SQL engine (`node:sqlite`), not reasoned about: for the same
UUID, the app's own query returns **0 rows** and the reconstructed query returns **1 row** -- the
handle resolver would serve a deleted account the application itself refuses to serve. Generalize
that predicate to a tenancy or ownership scope and it is precisely the IDOR-shaped defect
`D-security-8`'s service-arity check already exists to prevent -- except here there is no compiler
to catch the arity mismatch, because the target language is untyped. `mysql2` binds a missing
parameter as `NULL` and returns a wrong answer rather than failing.

*Blocker C -- generating SQL is outside what a resolver is allowed to be.* `D-resolver-scope` fixed
this boundary at the start of the project: `fetch()` is a read-only call into an EXISTING,
already-tested method, never hand-written business logic. All three shipped providers honor it --
java-spring calls a real `<Entity>Service` method, python-fastapi goes through the app's own
session, typescript-express goes through TypeORM's typed repository with the app's own
`select: [...]` allow-list. A raw-SQL provider has nothing to delegate to: it would have to AUTHOR
a new query. That is a category change, not a harder version of the same job.

Two rescue attempts were considered and both fail:
- **A schema/migration file** (the fixture ships a realistic `database.sql`) can answer the
  UUID-versus-integer primary-key question that SQL text alone cannot -- the fixture's own
  `user.user_uid` is `CHAR(36)` while `order.order_id` is `BIGINT AUTO_INCREMENT`, and nothing in
  `WHERE order_id = ?` reveals which one you are looking at. But a hand-maintained dump is a
  per-app habit, not a framework convention: `mysql2` has no Alembic version table and no TypeORM
  entity metadata, so nothing at runtime enforces that the file still matches the live database.
  It also enumerates what EXISTS (including `password_hash` and `phone_e164`), never what is safe
  to expose. It does not touch Blocker B or C.
- **Requiring a hand-written marker** in the target app (some `/* bskel:table=user, pk=user_uid */`
  convention) would be inventing a requirement this ecosystem's real code does not demonstrate --
  the exact opposite of how G5 chose its own `select: [...]` precondition, which was adopted
  because the ecosystem already used it.

`bskel scan --db` (A4, `D-db-schema-plane`) already scans migration files adapter-independently and
report-only, which is the right home for whatever a `database.sql` can honestly contribute. It
needed no change for this item.

**Also EXCLUDED, named rather than dropped**: CommonJS Express apps (`require('express')`) -- out of
scope BY CONSTRUCTION rather than by a special case, since a CJS file has no `import ... from
'express'` statement for `detect()` to match; a `Router as R` import alias (the local name is not
resolved, and the declaration is skipped rather than guessed at); a router returned from a factory
(`const r = buildRouter()`); a computed mount prefix; a non-relative mount specifier; and monorepo
shapes where two package.json files both declare express (the shallowest declaring one wins, as it
already does for `typescript-express`).

**Mechanism**:
- `detectJavaScriptExpressRoot()`: the same two-independent-signal bar every other first-class
  adapter uses -- (a) a package.json declares `express`, (b) at least one ESM source file under it
  both imports express and calls `Router()` / `<name>.Router()`. Returns `{projectRoot, globs}`
  rather than a bare path, because which extensions are ESM is part of the detection result.
- **Which files are ESM is Node's own rule, applied as written, not a heuristic**: `.mjs` is
  unconditionally ESM; `.js` is ESM only when the nearest package.json says `"type": "module"`.
  This is why CommonJS falls out of scope without an exclusion check, and it is tested in both
  directions (an `.mjs` file in a package with no `"type"` IS scanned; a `.js` file in the same
  package is NOT).
- **Mount graph over (file, router-variable) nodes**, the single most novel piece. G5 models one
  node per FILE and one hardcoded `router` identifier per node, which cannot represent the shape
  the real target app actually uses: the global `/api` prefix lives on an INTRA-FILE edge from the
  `express()` application to a locally-declared Router (`app.use('/api', route)`), with no import
  involved at all. Nodes here are `(file, variable)` pairs, so intra-file and cross-file edges are
  the same mechanism. `app.use(...)` and `router.use(...)` are treated identically because they ARE
  identical in Express -- a framework fact, not an assumption. `declaredMountables()` binds whatever
  name each file actually declares.
- `prefixChainFor()` carries a `seen` set. That is not defensive boilerplate: intra-file edges make
  a genuine cycle representable (`a.use('/x', b); b.use('/y', a)` in one file), which G5's
  file-to-file model cannot express, and without the guard that shape is infinite recursion rather
  than a wrong answer. Covered by its own test.
- `resolveEsmImport()` probes the exact specifier first (real ESM requires the extension:
  `'./routes/user.route.js'`), then the extensionless `.js`/`.mjs`/`index.*` forms people write
  anyway. Uses `statSync().isFile()`, not `existsSync()` -- `'./v1'` names a DIRECTORY that exists,
  and treating it as a resolved module would silently create a mount edge to nothing.
- Module name strips a trailing `.route`/`.routes`/`.router` segment (`user.route.js` -> `user`), a
  near-universal Express file-naming convention that carries no information. This is a
  display/scoring LABEL only -- nothing downstream generates code from it (`codegen.handles` is
  false), so the cost of the convention being wrong somewhere is a slightly odd module name, never
  wrong output.
- One controller per (file, router-variable), not per file: a file declaring two routers mounted at
  two different prefixes has two genuinely different base paths, and collapsing them onto the file
  would attribute the wrong absolute path to half its endpoints.
- **`specificity: 80`, deliberately below `typescript-express`'s 85.** A repo containing both a
  `.ts` Express app and `.mjs` ESM sources can be detected by both; the TypeScript one carries
  strictly more (real entity metadata, a working codegen provider), so it should win that overlap
  quietly rather than tripping `runScan()`'s same-specificity ambiguity error. Same documented
  trade-off `D-fastapi-adapter` made at 90.
- **`confidence: 'high'`, with `codegen.handles: false`** -- these are orthogonal, and G2 shipped
  exactly this combination. Confidence describes trust in what the scan REPORTS: this adapter does
  real module inference and real mount-graph prefix resolution, which `generic-grep` (`low`) does
  not. The practical consequence is load-bearing and tested: a feature-scoped scan of the fixture
  exits `AWAITING_DISPOSITION(3)` and writes its report, instead of `LOW_CONFIDENCE_SCAN(16)` and
  writing nothing.

**Real bugs found and fixed while building this, all reproduced live, none hypothetical**:
- **A comment-masking bug that silently collapsed the entire mount graph.** The fixture's own
  header comment contains the words `import { Router } from 'express'` (as prose describing what
  the TS adapter looks for), and the unmasked `import\s+([^;]*?)\s*from\s*['"]express['"]` pattern
  matched starting at the word "import" INSIDE that comment and ran across the newline into the
  real statement below it. Every route was still reported, with a plausible-looking path -- just
  with the prefix silently missing. This is the same defect class A2 Phase 1's `maskNonCode()`
  already fixed for Java (`D-java-analyzer`'s phantom-`operationId`-in-a-comment bug), so the fix
  is the same technique: a new `maskJsComments()` in `_express-shared.mjs` that blanks line and
  block comments in place (length, newline positions and every other character index preserved, so
  no offset-based consumer shifts) while leaving string and template literals fully INTACT -- unlike
  the Java masker, which blanks string interiors, because every path this adapter reports is read
  straight out of a string literal.
  **Applied to `typescript-express.mjs` as well, deliberately.** The same exposure means a
  commented-out `// router.get('/old', oldHandler)` was being extracted and reported as a LIVE
  endpoint by the G5 adapter. That is a correctness bug in a directly-adjacent file discovered by
  this work, with a test that was confirmed to FAIL against the pre-fix code before being kept --
  not an incidental refactor. G5's own 19 tests pass unmodified.
- **A regex anchored to the wrong end**, which classified every `express.Router()` as a bare
  `Router()` call. The member-call test was `/\.\s*Router\s*\($/`, but the matched declaration text
  ends at the closing `)` of `Router()`, so the `$` anchor never held. With no named `Router` import
  in the file, the declaration was dropped entirely and the whole mount graph came back empty.
  Found by running the real fixture, not by review.
- **A path-normalization mismatch between `rg --files` output and `path.resolve()`.** `rg` echoes
  paths in whatever style its `dir` argument used, while `resolveEsmImport()` always builds absolute
  candidates, so with a relative `repoRoot` the two never compare equal, every cross-file mount edge
  is dropped, and every route loses its prefix while still looking successfully scanned. Latent
  rather than user-visible today (real callers pass an absolute `repoRoot` from `git rev-parse
  --show-toplevel`), fixed by normalizing the file list up front. The same latent fragility exists
  in `typescript-express.mjs`'s `buildMountEdges()`; left untouched there, named here, see EXIT.
- **`Router({ mergeParams: true })` was invisible to BOTH adapters.** Every `Router()` check in
  this codebase required literally empty parens (`/\bRouter\s*\(\s*\)/`) -- G5's detect signal, G5's
  per-file extraction gate, and G6's own mountable-declaration regex. An options object is
  completely ordinary Express, and the consequence is not "an option is ignored": for G5 the whole
  FILE is skipped, and for G6 the variable is never recognized as a router at all, so the file
  yields no routes. Fixed to `/\bRouter\s*\(/` in all three places -- a strict widening of the
  second half of an already-conjunctive signal (a named `Router` import from `'express'`, or a
  `<name>.Router` member call, is still required), and `\b` cannot match inside `makeRouter(`, so
  it can never claim an unrelated factory. Found by probing the regex directly against real Express
  idioms, not by an end-to-end failure -- nothing in either adapter's existing fixtures used the
  options form.
- **Semicolon-less ESM broke import-clause parsing.** The first draft matched a whole statement
  forward (`import\s+([^;]*?)\s*from\s*['"]express['"]`). In standard.js-style code with no
  semicolons, `[^;]` runs straight through the PREVIOUS import statement, so
  `import cors from 'cors'` + newline + `import express from 'express'` yields the clause
  `cors from 'cors' import express` -- which fails the identifier check, leaves `defaultName` null,
  and therefore finds no `express()` application at all, losing any global prefix mounted on one.
  Rewritten to anchor on `from 'express'` and scan BACKWARD to the nearest `import` keyword, with
  a strict clause-shape check (`express`, `{ Router }`, or `express, { Router }` only) so an
  unparseable clause is REFUSED rather than parsed optimistically into a wrong binding name. This
  also fixed multi-line clauses (`import express, {\n Router\n} from 'express'`) for free, which
  the forward line-oriented pattern could never have matched, and let detect()'s ripgrep pre-filter
  shrink to just the `from 'express'` tail (rg matches line by line, so a fuller pattern would miss
  a wrapped clause; the masked re-read is the real gate either way).
- **A regex literal containing a quote defeated the masker for the rest of the file.**
  `const re = /'/g;` has an odd number of quote characters, and the first `maskJsComments()` draft
  tracked only strings and comments -- so that `'` opened a phantom string that ran to the next
  quote ANYWHERE later in the file, leaving every comment in between unmasked and reintroducing
  precisely the phantom-route bug the function exists to prevent. Confirmed live. Fixed by tracking
  regex literals too, deciding `/`-is-regex-vs-division from the previous significant character
  (the standard JavaScript-lexer heuristic), with two deliberate bounds: the preceder set is kept
  narrow (arithmetic operators are legal regex-preceders in the grammar but never precede one in
  real code, while `y++ / 2` genuinely occurs, so including them would only buy false positives),
  and an unterminated literal bails at end of line so a misjudged division can damage at most the
  rest of one line rather than running away. Comment markers still win unconditionally over regex
  detection, which is correct: `//` is never a valid empty regex and a regex body cannot begin
  with `*`.

**Verification**: 28 net new tests, `npm test` 743 -> **771**, every pre-existing test passing
unmodified.
- `test/javascript-express-cli.test.mjs` (x15) -- everything goes through the real `bin/bskel.mjs`
  CLI against a real git repo, never through the adapter's exported functions, because the claim
  under test is "a plain-JS Express app is visible to bskel" and only a real registry dispatch
  establishes that. Covers: adapter selection at specificity 80; the headline regression (the same
  repo is no longer handled by `generic-grep`, no `_generic` lumping); the 2-hop mount graph
  resolving `/api/user/:userUid` through an intra-file `app.use()` edge and a Router named `route`,
  asserted alongside a direct check that the leaf file does not contain `/api` anywhere; both import
  idioms; balanced-paren middleware extraction with a line-number cross-check against the real
  source; commented-out routes absent; all four capabilities false via `doctor --json`; zero
  entities reported; `AWAITING_DISPOSITION(3)`-not-`LOW_CONFIDENCE_SCAN(16)` on a feature-scoped
  scan followed by a passing `scan` gate; `contract emit` exiting 17 naming `api.operations` and
  pointing at `--openapi-file`; `handles plan` exiting 17 naming `codegen.handles` with nothing
  written to disk; CommonJS falling back to `generic-grep`; `.mjs`-without-`"type"` detected and
  `.js`-without-`"type"` not; and an intra-file mount cycle terminating.
- `test/express-shared.test.mjs` (x13) -- `maskJsComments()` directly, because the properties that
  matter are invisible end-to-end: that offsets never shift (asserted character by character
  against the original), that a `//` inside a URL string, a template literal, or after an escaped
  quote is never treated as a comment, and all three regex-literal cases (a regex containing a
  quote, division NOT misread as a regex, and a `/` inside a `[...]` character class). Plus the
  phantom-route regression and the `Router({ mergeParams: true })` regression, each for BOTH
  adapters, and a semicolon-less + multi-line-import repo whose full `/api/thing/:id` prefix chain
  only resolves if both clause shapes parsed correctly.
- `test/conformance-harness.test.mjs` gained the real fixture wiring and passes
  `checkAdapterConformance` (including its back-to-back determinism check) on first run. It has
  deliberately NO `checkProviderConformance` entry for this adapter, with a comment saying so and
  pointing at the biconditional test that actually enforces the absence.
- Phase 2's rejection is measured, not asserted: a SQL-extraction probe (0/5 clean) and an executed
  `node:sqlite` divergence check (app 0 rows vs. reconstructed 1 row for the same UUID), both run
  against the committed fixture. The probes were throwaway investigation scripts and are not
  shipped; the fixture they ran against IS committed, so the finding is reproducible.
- `npm run test:typescript-compile` re-run because this item edits G5's adapter; `npm pack
  --dry-run` re-run to confirm the two new `scanners/adapters/` files ship (the `files` allowlist
  already names the whole directory, so this needed no packaging change).

There is **no real-world oracle for this item at all** -- weaker footing than even G5's, which at
least had one hand-read community boilerplate. The target app was described from its shipped code
by the session that found it, and this implementation was built against a synthetic fixture written
to match that description. Nothing here was verified against the real repository, by deliberate
choice: it is not ours to touch. That is a standing property of this item, named as an EXIT below,
not a gap a later slice is expected to quietly close.

**COST**: this stack can never reach `contract emit` without a real OpenAPI document
(`api.operations` is false and plain Express generates no operation identity) or `handles
plan`/`emit` at all (`codegen.handles` is false, permanently for the reasons in EXCLUDED). Zero
entities are reported for a raw-SQL app, so `resource.fetch` is false and the exit-17 message
correctly blames `codegen.handles` rather than misattributing the block. A CommonJS Express app,
a `Router as R` alias, a factory-built router, a computed mount prefix, and a non-relative mount
specifier are each silently skipped rather than guessed at. Module names rest on a filename
convention. `typescript-express.mjs` now behaves differently for commented-out routes than it did
before this item -- an intended correctness fix, but a change to already-shipped behavior, recorded
here rather than smoothed over. `test/adapter-registry.test.mjs`'s hardcoded roster went from 4
adapters to 5 -- the correct amount of coupling for a test whose entire job is asserting the real,
current adapter list.

**EXIT**: build Phase 2 only if the ecosystem itself grows something to delegate to -- a real query
layer, a repository module convention, or an app-authored allow-list the way TypeORM's
`select: [...]` gave G5 one. Generating SQL from scanned literals should not be revisited on a
better regex alone; Blockers B and C survive any parser. Extend to CommonJS if a real target needs
it (it needs its own `require()`/`module.exports` edge resolution, not a widened glob). Resolve
`Router as R` aliases, factory-built routers, or computed mount prefixes if a real app's shape
demands it. Normalize `typescript-express.mjs`'s own file paths the way this adapter now does, if
a caller ever passes a relative `repoRoot` (no such caller exists today). Re-ground this item
against a real plain-JS Express repository if one becomes available to read -- its verification
confidence is the weakest of the four first-class adapters and will stay that way until then.

Cross-references: `D-fastapi-adapter` (G2, the scanner-first/codegen-later precedent this item
follows, and the `high`-confidence-plus-false-`codegen.handles` combination it reuses);
`D-typescript-express-provider` (G5, the sibling adapter this one forks from, shares primitives
with, and fixes a comment-masking bug in); `D-adapter-registry` (G1, the zero-registration registry
and capability vocabulary this item adds one file to and edits nothing else for);
`D-handles-providers` (G4, whose biconditional invariant is what makes a false `codegen.handles`
machine-checked rather than a promise); `D-resolver-scope` (Blocker C -- the reason a resolver
delegates and never authors query logic); `D-security-8` (Blocker B -- the same silently-dropped
scoping-argument defect class, here with no compiler to catch it); `D-java-analyzer` (A2 Phase 1,
the masking technique `maskJsComments()` reproduces for JavaScript, against the same defect);
`D-scanner-evidence` (D3, the "three adapters privately duplicated this helper" extraction
precedent `_express-shared.mjs` follows); `D-db-schema-plane` (A4, the adapter-independent,
report-only home for whatever a hand-maintained schema dump can honestly contribute);
`D-generic-grep-reconnaissance` (G3, the low-confidence fallback this item's target repo was
landing on before); `D-fixture-corpus` (P3, the synthetic-not-vendored fixture precedent this
item's own corpus follows).

## D-greenfield-parameters (P2b): every value `bskel new` writes is either the user's or the upstream service's -- and which of the two is decided by measurement, not by taste

**WHY**: P2 (`D-greenfield-bootstrap`) shipped `bskel new --stack spring|fastapi --slug <name>` and
nothing else. Every other value in a scaffolded project was a constant: `groupId` was
`com.example`, `javaVersion` was `17`, the dependency set was the same five ids, and the entire
FastAPI template had exactly ONE substitutable token (`{{SLUG}}`) -- `requires-python`, the version,
the description, the license and the dependency list were all frozen text. That is a defensible
place to stop for a first slice, and an indefensible place to stay: `bskel new` is the one command
whose whole job is producing a project someone then owns, and "you may name it, and nothing else"
makes the command a demo rather than a tool. P2b parameterizes it.

The design question is not "which flags would be nice". It is **which values can `bskel` afford to
pass through to an upstream authority, and which must it check itself** -- and that was answered by
probing the real service, not by reasoning about it.

### The measured validation matrix (start.spring.io, 2026-08-23)

Every row below is a real request executed against the live API, not an inference from its docs:

| Parameter | Probe | Result |
|---|---|---|
| `dependencies` (unknown id) | `not-a-real-dep` | HTTP 400, clean message `"Unknown dependency 'not-a-real-dep' check project metadata"` |
| `type` (unknown) | `nope` | HTTP 400, clean message |
| `packaging` (unknown) | `nope` | HTTP 400, clean message |
| `language` (unknown) | `cobol` | HTTP 400, clean message |
| `javaVersion` | `99` | **HTTP 200** -- returns a real project whose `build.gradle` literally says `JavaLanguageVersion.of(99)`. Fails OPEN. |
| `bootVersion` | `9.9.9` | HTTP 500, an internal Spring config-class error message -- useless to surface to a user |
| `groupId` | `com.new` (a Java reserved word as a package segment) | **HTTP 200** -- produces `com.new.probe`, which never compiles. Fails OPEN. |
| `groupId` | `has space` | **HTTP 200**. Fails OPEN. |

Read as a rule: **pass-through validation is safe for exactly `dependencies` and `packaging`**
(clean 400s, and their valid sets are Initializr's own moving catalog, which no local copy could
track). It is **unsafe for `groupId`/`packageName`/`artifactId`** (fail open into an uncompilable
project -- these need a local validator) and **unsafe for `javaVersion`** (fails open, but its valid
set moves, so a local list would be wrong too -- see the live-metadata mechanism below).
`bootVersion` is excluded outright.

**Point-in-time caveat, stated as loudly as the table itself**: this is a measurement of one
external service on one day, not a property of it. Initializr can tighten `javaVersion` validation,
change a status code, or reword a message at any time without telling anyone. The same caveat this
project attaches to every external-service fact it records (`D-openapi-reconciliation`'s "regenerate
the document after any real source change", `D-greenfield-bootstrap`'s refusal to pin a
`bootVersion`) applies here: if a future session finds this table wrong, the table is what is stale,
not the code that was built from it. `bootVersion.default` on the same day was `4.1.1.RELEASE`.

### SCOPE

**New**: `lib/template.mjs` (the `{{VAR}}` renderer + `RESIDUAL_TEMPLATE_VAR_RE`, extracted from two
places that already had it); `new/params.mjs` (local validators + the on-demand Initializr metadata
check); `test/new-params.test.mjs`.

**`--stack spring`** gains: `--group-id`, `--artifact-id`, `--package-name`, `--java-version`,
`--packaging`, `--dependencies`, `--add-dependencies`.

**`--stack fastapi`** gains: `--python-version`, `--port`, `--license`, `--database`.

**Both** gain: `--name`, `--description`, `--project-version`.

`--project-version`, not `--version`: `--version` is already a GLOBAL flag intercepted in `main()`
before any command-specific parsing (it prints `bskel <version>`), so a command-level `--version`
would be unreachable, and naming it that would silently shadow the global for anyone who typed it.
Both stacks use the same name for the same concept -- "the generated project's own version field".

**Defaults are unchanged, byte-for-byte.** `buildInitializrUrl({ slug })` with no new parameters
produces a URL identical to the pre-P2b one *including query-parameter order* (which is why the four
optional keys are `set()` after the original eight rather than interleaved), pinned by a test that
holds the literal string rather than reconstructing it. The FastAPI template's `requires-python`
still defaults to `>=3.11` and its version to `0.1.0`.

### The safe/unsafe line this item works from

`bskel new` writes into a directory it refuses to touch if non-empty -- it can never overwrite
anything, unlike `handles emit`, which needed the whole ownership system of `D-handles-ownership`
because it writes into a LIVE repo. So the operative question is not "does this run in production"
(nothing here does). It is: **does the generated file encode a claim about the user's domain that
the user did not state?**

A group id, a Java version, a dependency id, a port, a database driver pin, a `requires-python`
floor -- each is either something the user typed or a value from the upstream service's own defined
vocabulary. Safe. An initial entity, a starter controller with plausible fields, a `db.py` with a
guessed connection URL -- that is `bskel` inventing a domain. Never built, in this slice or a future
one; the same register as `D-resolver-scope`'s permanently-stubbed `patchField()` and
`D-javascript-express-adapter`'s refusal to generate SQL.

### EXCLUDED -- refused loudly, not omitted quietly

Three real Spring Initializr controls are declared in `COMMANDS.new.options` as `hidden` and then
REFUSED with exit 14 and a specific, cited reason. They are declared rather than left unknown on
purpose: all three exist on start.spring.io's own web UI, so a user who reaches for one deserves the
reason instead of `Unknown option '--type'`. `hidden` (the mechanism `scan --db` used while it was a
documented-but-inert placeholder) keeps them out of `--help` and out of
`test/doc-integrity.test.mjs`'s usage()-vs-COMMANDS flag-set equality check.

- **`--type`** (no Maven, no Kotlin-DSL Gradle). Cited blocker, not a shrug:
  `handles/providers/java-spring/emit.mjs`'s `detectJacksonPackage()` reads `build.gradle` ONLY and
  falls back to the Jackson 2 package name when the file is absent. A Maven scaffold has `pom.xml`
  and no `build.gradle`, so a later `bskel handles emit` would generate code importing
  `com.fasterxml.jackson.databind.ObjectMapper` -- not on the classpath under Initializr's current
  default Spring Boot 4 (Jackson 3, measured above). A project that scaffolds fine and then fails to
  compile is strictly worse than a refusal.
- **`--language kotlin|groovy`**. `scanners/adapters/java-spring.mjs`'s `listJavaFiles()` globs
  `*.java` only, `detectJavaSpringRoot()` requires `src/main/java`, and every java-spring codegen
  template emits `.java`. A Kotlin scaffold falls straight through to `generic-grep` (specificity 0,
  `confidence: "low"`, no codegen provider at all) -- see `D-generic-grep-reconnaissance`.
- **`--boot-version`**. HTTP 500 with an internal Spring error on a bad value (measured), plus
  `D-greenfield-bootstrap`'s own standing maintenance argument against pinning it.

**`baseDir` is excluded harder than the three above: it is never a flag AND never sent.** Verified
by downloading a real archive: with no `baseDir` the zip is FLAT (`build.gradle`, `settings.gradle`,
`src/`, `gradlew` at the root), which is exactly what `scaffoldSpring`'s `unzip -d dir` and every
downstream adapter's `detect()` require. Setting it would nest the project one level down and
silently break detection everywhere. Pinned by a regression test that greps both `new/spring.mjs`
and `lib/cli.mjs` for it and re-asserts the committed fixture archive really is flat.

Also excluded, named rather than dropped: a `LICENSE` file. `--license` writes only
`pyproject.toml`'s `license` metadata field. Generating real legal text -- which varies in required
wording and attribution per license -- is not something this tool has any business copying into
someone's repository.

### `--dependencies` REPLACES, and the warning that is the price of that

The original recommendation from this item's own research was additive-only. **The user explicitly
chose replacement**, and that decision is recorded here rather than smoothed over, because it is the
one place in P2b where the more dangerous semantics won:

- `--add-dependencies a,b,c` extends the baseline five. It cannot drop anything, so it never warns.
- `--dependencies a,b,c` REPLACES the baseline five entirely.
- Passing both is `BAD_ARGS` (exit 14). They are not merged: "did I replace or extend?" has to stay
  answerable from the command line alone.

Replacement is made safe by making the danger **visible**, not by preventing it. If the resolved set
is missing any of three specific ids, one warning per missing id goes to stderr -- naming the id and
the concrete downstream consequence -- and the scaffold then proceeds:

- `web` -- no `@RestController`/`@RequestMapping` endpoints exist at all, so `bskel scan`'s
  java-spring adapter finds no controllers and `contract emit` has nothing to build operations from.
- `data-jpa` -- no `@Entity` classes exist, so the adapter reports zero resources and `handles plan`
  approves nothing (`resource.fetch` has nothing to fetch).
- `validation` -- the resolver `handles emit` generates will not compile: its `patchField()` imports
  `jakarta.validation.Validator`/`ConstraintViolation` (`D-patch-strategy`).

`security` and `lombok` are in the baseline but nothing in `bskel` itself requires them, so dropping
either warns about nothing. Warnings go to **stderr**, which this CLI's own contract
(`D-cli-contract`) says is never suppressed by `--quiet` and never mixed into a `--json` payload's
stdout -- and they are printed BEFORE the network call, so the danger is visible even if the
download then fails. They also appear in the `--json` payload's `warnings` array.

This is "warn loudly, then trust the user", not a refusal. It is the same register the FastAPI half
uses for a `--python-version` floor below what the shipped template itself needs.

### Mechanism

**`--java-version`: a live metadata fetch, on demand, never cached, never persisted.**
`javaVersion` fails open (measured: `99` returns HTTP 200 and writes `JavaLanguageVersion.of(99)`
into `build.gradle`), so it cannot be left to Initializr. But its valid set MOVES -- so a local list
would be the very thing `D-greenfield-bootstrap` refused when it rejected a persisted
`.bskel/config.yml`: a local copy of external truth that silently drifts. Instead
`new/params.mjs` fetches `https://start.spring.io/metadata/client` -- the same document the
start.spring.io web UI populates its own dropdowns from -- **only when a non-default
`--java-version` is actually passed**, and nothing is written to disk. A user who does not ask pays
no extra round-trip; the check happens before any `starter.zip` request and before any filesystem
write.

The response shape was fetched once and read directly rather than assumed:
`javaVersion` is `{type: "single-select", default: "17", values: [{id, name}, ...]}`, with ids
`["26","25","21","17"]` on 2026-08-23. The parser is defensive about all of it anyway -- a non-ok
response, unreadable JSON, and a missing `javaVersion.values` list each produce their own clean,
actionable message rather than a `TypeError`.

**Local Java validation, and why it does NOT go stale the way a dependency list would.** The Java
package-name grammar (JLS 3.8) and reserved-keyword list (JLS 3.9) are language-specification
constants. Adding a keyword to Java is a language-version event; adding a starter to Initializr
happens continuously. `requireValidJavaPackageName()` (shared by `--group-id` and `--package-name` --
same grammar, one implementation) rejects an empty segment, a non-identifier segment, and all 54
reserved tokens (JLS 3.9's 51 keywords -- the 50 classic ones plus `_` -- plus the reserved literals
`true`/`false`/`null`). Contextual keywords (`var`, `record`, `yield`, `sealed`, `permits`,
`module`) are deliberately NOT rejected: they remain legal identifiers, and rejecting them would be
over-validation. Deliberately narrower than the language in one respect: ASCII identifiers only.
Java itself accepts any `Character.isJavaIdentifierStart` codepoint, but this is a scaffolder writing
a directory tree that has to survive whatever filesystem and CI runner the project later lands on --
and nothing upstream is checking it either way.

`--artifact-id` reuses `lib/featureid.mjs`'s existing `SLUG_RE` (exported for this; it was
module-private) rather than declaring a second, subtly different grammar for the value it defaults
to. `--group-id` alone also moves the DEFAULT package name, preserving P2's own
`<groupId>.<slug minus hyphens>` derivation instead of stranding it at `com.example`.

**One shared `{{VAR}}` renderer, and a fail-closed check for the tree that never had one.**
`stack/apply.mjs`'s private `renderTemplate(templatePath, vars)` and `new/fastapi.mjs`'s
`text.replaceAll('{{SLUG}}', slug)` were two implementations of the same idea; `lib/template.mjs`
is now the one, following the extraction precedent `scanners/text-util.mjs` and
`scanners/adapters/_express-shared.mjs` already set. Pure code motion, and proved so the way
`D-handles-providers`' own extraction proved it: `test/stack-cli.test.mjs` passes 12/12 **completely
unmodified** (`git diff --stat -- test/` was empty at that commit).

`RESIDUAL_TEMPLATE_VAR_RE` moved with it, and gained a second consumer. P4
(`D-extension-conformance`) has run that regex over `stack/catalog/` templates since `catalog lint`
shipped; `new/templates/**` never had the check at all. `scaffoldFastapi()` now renders the whole
tree **into memory**, scans every rendered file, and refuses to write anything if a `{{VAR}}`
survived. Deliberately not "write, then verify, then delete what was written": `dir` comes from user
input (`--dir`), and an `rm -rf` of a user-supplied path to clean up after our own bug is a worse
failure mode than the bug. Nothing partial ever exists on disk.

**Per-stack parameter acceptance, checked before anything happens.** `new/index.mjs`'s `STACKS` map
stays a plain object -- the reason two first-party stacks do not justify `scanners/registry.mjs`'s
dynamic-load machinery has not changed just because each record grew three fields -- but each entry
now declares `acceptedParams` and `refusedParams`. `cmdNew` checks a refused flag first (cited
reason), then a wrong-stack flag (naming the stack that DOES take it), then the local validators,
and only then the one check that costs a network round-trip. A rejected invocation exits 14 having
written nothing and called nothing.

### Judgment calls, made explicitly

- **`--python-version`'s accepted shape.** There is no live authority here: python.org publishes no
  machine-readable "currently supported" document equivalent to Initializr's metadata, and the value
  is only ever substituted into `pyproject.toml` as a string. So this validates that it is
  SYNTACTICALLY sane, never that the version exists. Accepted, deliberately narrow: a bare `3.12` /
  `3.12.1` (normalized to `>=3.12`), or a single-operator floor (`>=`, `>`, `~=`, `==`). A bare
  upper bound (`<3.13`) and a compound specifier (`>=3.11,<4.0`) are both rejected -- the flag is
  documented as a FLOOR, and silently accepting a specifier that says the opposite would be exactly
  the "encodes a claim the user did not state" failure this item's own safe/unsafe line rules out.
  A project needing a compound specifier edits one line of a file it now owns outright.
  A floor below `3.9` WARNS rather than refuses, because `new/templates/fastapi/app/main.py`
  annotates `-> dict[str, str]`, a PEP 585 builtin generic that raises `TypeError` at runtime on
  older interpreters, and FastAPI evaluates route return annotations. That is a measured property of
  the shipped template, not a claim about Python in general -- and a caller who intends to rewrite
  `main.py` is making a legitimate choice this tool should not veto.
- **`--license` is shape-validated only.** No bundled copy of the SPDX list: that list is external
  truth that changes, and unlike `--java-version` there is no cheap on-demand authority to consult.
  The error message says so, rather than implying a check that is not happening.
- **`--database` gets an explicit "this is all it did" note.** Yes, the clarification was worth
  printing. It uses `handles emit`'s own `postEmitNotes` shape (`postScaffoldNotes` on stdout, and in
  the `--json` payload) rather than stderr, because it is narration about what deliberately did NOT
  happen, not a warning about a risk the user took. The note is accurate per choice: `postgres`
  really did add a dependency line, `sqlite` deliberately added nothing (CPython ships `sqlite3`).
  Saying "pinned the driver" for sqlite would be a small lie in exactly the place the note exists to
  prevent one. The same explanation is written into the generated `README.md`, where it stays with
  the project instead of scrolling out of a terminal.
- **`--port`'s default is 8000, not `stack apply --port`'s 8080.** The VALIDATION shape is mirrored
  exactly (`numeric: {min: 1, max: 65535}`); the default is uvicorn's, because 8080 is a Spring
  convention that means nothing to a FastAPI project. `--port` is honest about its reach: it changes
  the generated `README.md`'s run command and nothing else, because a uvicorn port is a run-time
  argument, not a source-level constant.

### Real bugs found live, not reasoned about

**★ `--name "Demo Service"` produced a FastAPI project that could not be installed.** The first
working run of the new FastAPI path wrote `name = "Demo Service"` into `pyproject.toml` -- valid
TOML, and an invalid project name. Reproduced directly against pip rather than assumed:

```
error: subprocess-exited-with-error
    configuration error: `project.name` must be pep508-identifier
```

Unlike Spring, where Initializr sanitizes `name` into a main-class identifier on its own, NOTHING
downstream of this tool checks a FastAPI project name -- the same fail-open shape as `groupId`, in
the half of the command that has no upstream at all. Fixed with `requireValidPythonProjectName()`
(the PEP 508 grammar, reproduced verbatim). Documented consequence rather than a worked-around one:
`--name` sets both `pyproject.toml`'s `name` and FastAPI's `title=`, so a prose title with spaces is
rejected; editing `app/main.py`'s one `FastAPI(title=...)` line is the escape hatch, and splitting
this into two flags would be inventing a distinction the user did not ask for.

**A miscount caught by its own test.** `new/params.mjs`'s comment claimed "the 51 reserved keywords,
plus `_`", which double-counts -- JLS 3.9's list is 51 INCLUDING `_` (50 classic keywords plus `_`).
Caught by the size assertion in `test/new-params.test.mjs`, which existed precisely because a
hand-transcribed keyword list is the kind of thing that is quietly wrong. Both the comment and the
assertion now say 54 (51 keywords + 3 reserved literals).

### Verification

`npm test`: **771 -> 819** (48 net new), every pre-existing test passing unmodified.

- `test/new-params.test.mjs` (20 new) -- the pure validators. Every fail-OPEN case from the matrix
  above (`com.new`, `has space`, `com.1abc`, a trailing/leading/doubled dot, a non-ASCII segment) is
  asserted rejected AND asserted to have cost **zero** `fetch()` calls, via a spy installed on
  `globalThis.fetch` -- "rejected locally" is the actual claim, not just "rejected". Plus the whole
  `--java-version` metadata path against a mocked `fetchImpl`: an in-list id passes, an out-of-list
  id is rejected with a message explaining WHY this cannot be left upstream, and a network failure,
  a non-ok response, unreadable JSON and an upstream shape change each produce their own clean
  message rather than a `TypeError`.
- `test/new-cli.test.mjs` (28 new) -- the default-URL byte-identity regression first (a literal
  string, not a reconstruction); every new Spring parameter landing on its own query key;
  `--group-id` moving the default `packageName` without disturbing `artifactId`; an omitted optional
  parameter being absent from the query rather than sent empty; the `baseDir` double regression;
  replace-vs-add semantics with each warning asserted to name its actual consequence
  (`@RestController`, `@Entity`, `jakarta.validation.Validator`) rather than merely saying
  "missing"; the Initializr 400 `message` surfaced verbatim; cross-stack rejection in both
  directions with nothing written; all three refusals with their cited reasons; and
  `detectPythonFastApiRoot()` re-asserted across **seven** different parameter combinations, because
  that invariant is P2's own and is the thing most at risk from editing the template.
- **The fail-closed check was written to fail first.** With `if (offenders.length > 0)` temporarily
  neutered to `if (false)`, the broken-template test reports
  `AssertionError [ERR_ASSERTION]: Missing expected rejection.` -- confirmed, then the check
  restored and the test re-run green. Same `maskJsComments()` discipline as
  `D-javascript-express-adapter`: a guard that can only ever pass proves nothing.
- **`test/stack-cli.test.mjs`: 12/12 pass, file completely unmodified**, which is the whole proof
  that the `lib/template.mjs` extraction was behavior-preserving rather than a refactor with side
  effects.
- **Real end-to-end Spring run, by hand, not in CI** (2026-08-23), re-run because this item changes
  what gets requested from Initializr:
  `bskel new --stack spring --slug p2b-manual --group-id com.acme --add-dependencies actuator
  --packaging war --description 'P2b manual verification' --project-version 0.9.0`.
  Every non-default parameter landed in the generated `build.gradle`: `group = 'com.acme'`,
  `version = '0.9.0'`, `description = 'P2b manual verification'`, `id 'war'`,
  `spring-boot-starter-actuator`, `JavaLanguageVersion.of(17)`. Then, for real:

  ```
  $ ./gradlew compileJava --no-daemon
  > Task :compileJava
  BUILD SUCCESSFUL in 6s
  ```

  **Spring Boot version Initializr returned that day: `4.1.1`** (Gradle 9.5.1). The scaffolded
  project is still detected as `java-spring` by `bskel doctor` -- `--packaging war` adds a
  `ServletInitializer.java` but leaves the layout `detect()` needs intact.
- **Real end-to-end FastAPI run, by hand**: the fully-parameterized project really installs.
  `pip install -e .` in a fresh venv yields
  `name: billing-svc | version: 0.9.0 | requires-python: >=3.12 | license: MIT`, and the generated
  `pyproject.toml` parses under `tomllib` with the `psycopg[binary]` pin present.
- `npm pack --dry-run` re-run: `lib/template.mjs`, `new/params.mjs` and the new
  `new/templates/fastapi/README.md` all ship, with no `package.json` change needed (the `files`
  allowlist already names `lib/` and `new/` wholesale -- confirmed, not assumed).

**Deliberately unchanged, confirmed rather than overlooked**:
`test/fixtures/spring-initializr-fixture.zip` (the mocked-fetch extraction test does not depend on
any query parameter, so it stays valid as-is -- and the `baseDir` regression test now reads it to
assert it is still flat); `package.json`'s `files` allowlist (already covers both new directories);
and `.github/workflows/ci.yml` -- **no new job, deliberately**. `D-greenfield-bootstrap`'s test
strategy states that no test in this project hits a live external service and that CI must not start
now. The `--java-version` metadata path is therefore covered entirely against a mocked `fetchImpl`,
and no `BSKEL_TEST_FETCH`-style hook was added to production code to drive it from the CLI either --
a test seam in shipped code would be worse than the coverage it buys. The one CLI-level assertion
that IS possible without either is made: the DEFAULT `--java-version` never triggers a fetch at all.

### COST

`bskel new`'s usage line is now very long -- one line, unavoidably, because
`test/doc-integrity.test.mjs` parses `usage()` line-by-line and a wrapped continuation would read as
a different command. `--help` is the readable view.

Three flags exist that can only ever fail (`--type`, `--language`, `--boot-version`). That is the
deliberate price of answering with a reason instead of "unknown option", and it means
`COMMANDS.new.options` no longer describes only things that work.

`--dependencies` can produce a project that no later `bskel` command can do anything useful with.
Warned about, three times over, and still permitted -- by explicit decision.

`--name` means two different things per stack: free text for Spring (Initializr sanitizes it), a
PEP 508 identifier for FastAPI (nothing else validates it). Same flag, genuinely different
constraint, because the two ecosystems genuinely differ.

`--port` only edits the generated README's run command. `--license` only writes a metadata field.
Both are honest about their reach in the docs, but neither does as much as its name might suggest.

`lib/featureid.mjs`'s `SLUG_RE` is now exported -- a slightly wider public surface for that module
than it had, in exchange for not having a second artifact-id grammar drift away from the slug one.

The FastAPI template grew a `README.md`, so a scaffolded project now has one more file than before.

### EXIT

Extend `acceptedParams` when a real target needs a parameter, not preemptively -- the same rule
`D-javascript-express-adapter`'s EXIT applies to widening its own scanner. Specifically:

- Revisit `--type`/`--language` only if the java-spring adapter and provider grow real Maven or
  Kotlin support; the refusal is a consequence of that gap, not an independent policy, and the cited
  reasons name exactly what would have to change (`detectJacksonPackage()`, `listJavaFiles()`,
  `detectJavaSpringRoot()`, the `.java` templates).
- Re-run the validation matrix above before trusting it again. If Initializr starts rejecting an
  unknown `javaVersion` with a 400, the live-metadata fetch becomes redundant and should be dropped
  rather than kept "just in case" -- an unnecessary network call in a scaffolder is a cost, not a
  safety margin.
- `--database` must not grow into code generation. If a future slice wants engine/session wiring, it
  needs its own decision entry arguing why that is not `bskel` inventing a domain, against this
  entry's safe/unsafe line -- not an incremental widening of a flag that currently only edits a
  dependency list.
- A `.bskel/config.yml` remembering these parameters between runs is still refused, for
  `D-greenfield-bootstrap`'s original reason. `bskel new` runs once per project; there is nothing to
  remember.

Cross-references: `D-greenfield-bootstrap` (P2, the command this item parameterizes, the
`bootVersion` argument it inherits, and the anti-persisted-state principle the live-metadata fetch
follows); `D-extension-conformance` (P4, the residual-`{{VAR}}` check whose regex this item moves
and gives a second consumer); `D-handles-providers` (G4, the "prove an extraction by leaving the old
tests untouched" bar `lib/template.mjs` had to meet); `D-resolver-scope` (the permanent-stub line
`--database`'s no-codegen scope reuses); `D-patch-strategy` (A3, why a missing `validation`
dependency breaks generated code, not just a lint); `D-javascript-express-adapter` (G6, the
measured-refusal register the three excluded flags follow, and the fail-first test discipline);
`D-cli-contract` (D2, the strict parser, the `hidden` flag mechanism, and the stdout/stderr split the
warnings rely on); `D-generic-grep-reconnaissance` (G3, what a Kotlin scaffold would actually fall
through to); `D-adapter-registry` (G1, the fresh-every-run detection this item's no-persisted-config
stance is consistent with); `D-fastapi-adapter` (G2, `detectPythonFastApiRoot()`, the invariant every
template edit here is tested against); `D-npm-packaging` (P1, the `files` allowlist this item needed
no change to).

**Update (beta-release-prep)**: a second-opinion review (Codex, asked to independently assess this
project's own next direction) flagged a real residual risk in this item's own design that had gone
unaddressed: the live `start.spring.io` validation matrix recorded above is explicitly a
**point-in-time measurement** of a service this project doesn't control, but `npm test`'s own
coverage of it is entirely mocked-`fetch` (by design -- `D-greenfield-bootstrap`'s "CI must not hit
an external service" rule, which this item inherited unchanged). That combination meant nothing
would ever notice if Initializr's real, live behavior drifted from what was measured when this item
shipped -- a `--java-version` value that fails open today could start failing closed tomorrow (or
vice versa) with no test anywhere catching it. Closed with a new `spring-initializr-canary` CI job
(`.github/workflows/ci.yml`) and `scripts/spring-initializr-canary.mjs`: a real, unmocked
`bskel new --stack spring --java-version 21 --add-dependencies actuator` against the live API,
followed by a real `./gradlew compileJava`, run on a **daily schedule only** (`cron`), never on
push/PR -- the same "keep a live-service dependency off the blocking path" posture
`D-greenfield-bootstrap` already established for why this whole command needs `--offline` and never
auto-chains into anything. Verified locally before shipping: the scaffold step alone (no network-adjacent
JDK-availability confound) correctly produces a `build.gradle` requesting `JavaLanguageVersion.of(21)`
`com.example.canary`/`spring-boot-starter-actuator`; a full scaffold-then-compile pass against a real
non-default Java version (26, the one actually installed on the verifying machine -- 21 was not
locally available, a real environment gap distinct from anything this item's own code does)
produced a clean `BUILD SUCCESSFUL`, confirming the mechanism end-to-end. The CI job's own
`actions/setup-java@v4` step is pinned to Java 21 specifically to match the canary script's own
hardcoded `--java-version` -- the two must be changed together, noted inline in both files.

## D-openapi-export (A6): the export direction, and the four ways a lossy projection can lie

**WHY**: A1 built the OpenAPI IMPORT direction and A2/A3 made it load-bearing -- `python-fastapi`,
`typescript-express` and `javascript-express` all declare `api.operations: false` and depend on
`--openapi-file` for any usable contract at all. Nothing could get back OUT. That asymmetry is not
merely aesthetic: the internal contract is feature-scoped, single-module, and fully `$ref`-inlined
(`inlineSchema()` guarantees zero `$ref` by construction, a promise `cmdContractToolSchema` already
depends on), which makes it MORE useful than the source repo's own whole-repo document for three
concrete consumers -- a Swagger UI page scoped to one feature instead of 148 operations, a client
generator that chokes on `$ref`, and a mock-server or gateway config for one feature's operations.
Confirmed new work before claiming a new letter: grep across DECISIONS.md/CATALOG.md/SKILL.md/
README.md for export-direction language returns zero hits, and `D-openapi-reconciliation`'s own EXIT
clause names only import-direction future work (live drift detection). So this is A6, architecture's
next letter after A5, not another update appended to A1.

**The central constraint: this is a LOSSY, NARROW projection, and it must never synthesize.**
Measured against the real 148-operation Team-IZ-Backend oracle document, the internal contract
carries:
- **no query parameters** -- `indexOpenApiDocument()` never reads `operation.parameters`. 33/148
  real operations (22.3%) have them, 99 in total.
- **no header parameters** -- 23/148 (15.5%) real operations have them.
- **no security requirements** -- auth is mined by the *handles* provider from `@PreAuthorize`,
  never by the contract. 148/148 real operations require bearer auth.
- **no summary/description/tags** -- `DROPPED_KEYWORDS` strips `description` even inside a schema.
- **no per-status responses** -- collapsed to `responseSchema` (union of all 2xx) and `errorSchema`
  (union of all 4xx/5xx). 22% of real operations do not return 200.
- **nothing for a non-JSON request body** -- `applyRequestBodySchema` skips non-JSON media types;
  5 real operations have multipart bodies the contract has nothing at all for.

Every one of those is disclosed twice -- in prose on `info.description`, and machine-readably as
`info.x-bskel-omitted` -- and the disclosure is phrased as "this projection cannot represent X",
never as "the real API has X that we dropped", because this tool has no way to know the latter.
That is the same "describe the method, not an unchecked fact about the repo" discipline
`D-openapi-reconciliation`'s §7 addendum applied when it rewrote `api_surface_source`'s unverified
"no committed openapi spec found" claim.

**`security` is the sharpest case, and it decided the general rule.** Emitting `security: []` would
be the easy thing to do, and -- confirmed by executing the real 3.1 meta-schema against a document
containing it -- it is perfectly VALID. It is also a positive false claim that no authentication is
required, on an API where 148/148 real operations need a bearer token. Schema validity therefore
cannot be the thing that decides what to emit; truthfulness has to. `security` is OMITTED, which in
OpenAPI means "unspecified", which is the truth. The same rule kills every other tempting synthesis:
no `summary`/`description` invented from an operationId or a module name, no `{type: 'object'}`
invented for a body whose shape the contract does not know (see Mechanism), no status code invented
for a response whose status the contract never recorded.

**SCOPE**: `bskel contract export --feature <id> [--out <path>] [--json] [--allow-unprefixed]
[--status-codes range|literal]`, stdout by default. New `contracts/export.mjs` (pure -- no I/O, no
gate awareness, mirroring `buildContract()`/`reconcileModule()`); `cmdContractExport` in
`bin/bskel.mjs` (all the I/O and gate work); one `COMMANDS` entry; the two importer fixes below;
the self-import guard; `test/contract-export.test.mjs` plus the vendored official 3.1 meta-schema
under `test/fixtures/`. The contract-flow test harness moved from inline in
`test/contract-cli.test.mjs` to `test/_contract-fixture.mjs` so both files drive one fixture --
same `_`-prefixed shared-internal-module convention `_express-shared.mjs`/
`_java-spring-analyzer.mjs` already use, and the same "three adapters privately duplicated this
helper" extraction precedent `D-scanner-evidence` set. All 43 of `contract-cli.test.mjs`'s tests
pass completely unmodified across that move, which is what makes it a move rather than a rewrite.

**EXCLUDED, named rather than silently dropped:**

*OpenAPI 3.0 output, not even behind a flag.* This is a cited exclusion, verified by executing the
official `2021-09-28` 3.0 meta-schema, not a scheduling decision. Three independent blockers: (1)
3.0's `Operation` has `required: ["responses"]`, so every operation the contract knows nothing about
would force synthesizing a response object out of thin air -- 3.1's `$defs.operation` has no
`required` array at all, so omitting is legal there and honest; (2) 3.0 types
`exclusiveMinimum`/`exclusiveMaximum` as BOOLEANS (`{"type": "boolean", "default": false}`) while
`COPIED_KEYWORDS` copies them as the NUMBERS a 3.1 source document used -- emitting one into a 3.0
document silently INVERTS its meaning, the worst possible failure mode for a constraint; (3) 3.0's
Schema Object has no `const` and restricts `type` to a string enum with no `"null"` member, both of
which a projected contract schema can legitimately contain (springdoc's own nullable idiom produces
`{"type": "null"}` inside a `oneOf`). A 3.0 mode would be a schema-silently-means-something-else
generator.

*The naive round trip.* "Export then re-import produces byte-identical results for ANY contract" was
traced through the real code and found to be actively dangerous, so it is deliberately NOT the
invariant this item claims. A `drift` operation (ERROR-severity `CONTRACT_OPENAPI_DRIFT`) still
lands in `contract.operations` at the scan's own UNCORRECTED verb/path -- so an export puts it in
the document at exactly that verb/path, `computeDelta()` then agrees, and the ERROR silently
reclassifies as `matched`. Same for `missing` (`CONTRACT_OPENAPI_MISSING_OPERATION`). An `ambiguous`
endpoint is worse: it is never in the contract at all, so re-importing an export makes it read as a
plain `CONTRACT_UNMATCHED_ENDPOINT` -- a DIFFERENT code, which breaks any waiver already recorded
against it, since `{code, subject}` is the waiver key (`D-contract-completeness`). What IS claimed,
and tested, is the narrow version: for a contract whose completeness is `complete` (zero ERROR
warnings, so by construction no drift/missing/ambiguous/unmatched entry exists to launder), export →
`contract emit --openapi-file <the export>` against the SAME scan report reproduces the `operations`
object exactly. Stated precisely: this is convergence after one step, not identity with some
hypothetical upstream document -- `format: 'uuid'` is rewritten to a bare-UUID `pattern` on import
(`D-security-2`), and a multi-shape `anyOf` union re-imports as one raw node rather than N. Both are
stable from the first emitted contract onward, which is exactly what the test asserts.

*A `--path-prefix`-style escape for the prefix refusal.* `--allow-unprefixed` is a yes/no override,
not a way to inject a prefix at export time. Correcting paths is `contract emit --openapi-file`'s
job against a real oracle (A1); doing it here, from a scan SIGNAL rather than a real document, would
be exactly the guessing A1's anchor-based inference already refuses when anchors disagree.

**Mechanism**:
- **Gated on the `contract` gate having PASSED**, the same posture `handles emit` takes, and
  deliberately not the ungated posture `contract validate`/`contract tool-schema` take: those read a
  contract to answer a question about one payload, this one hands a whole API description to a
  client generator or a mock server, where a contract nobody has accepted yet is a materially
  different risk. Implemented by calling the same `requireNamedGate(root, 'contract', ...)`
  machinery `cmdHandlesEmit` already uses, including its "an `awaiting_disposition` contract almost
  always means partial/blocked, so point at `contract waive`/`gate force`, not at re-emitting" hint.
- **Deliberately does NOT also require `preflight`**, unlike `contract emit`/`handles emit`/`stack
  apply`. Those write into the target repo's own source tree or establish new state, so "is this
  worktree even based on the real default branch" is live for them. This command derives a read-only
  artifact from a contract that has already passed its gate -- and that gate's own token
  transitively covers the scan report and the disposed module's files (S2, `D-gate-precision` part
  2), which is the integrity property that actually matters here. Requiring preflight would mostly
  mean failing an export because a 30-minute TTL expired (`D-preflight-freshness`), which says
  nothing about whether the contract is trustworthy.
- **A5's completeness policy lands as three different behaviors, not one.** A `blocked`
  (zero-operation) contract is REFUSED outright -- a `paths: {}` document is a positive false claim
  that this API has no operations, which is a different and worse thing than an incomplete one. It
  is refused even past a passing gate, because `bskel gate force contract` can legitimately pass a
  blocked contract's gate (that escape hatch exists so a module with genuinely no HTTP surface does
  not wedge the workflow) and forcing a gate must not become a way to publish an empty API
  description; exit 14 mirrors `cmdContractWaive`'s own blocked refusal exactly, no new exit code
  for the same situation. An unwaived `partial` contract never reaches the check at all, because the
  gate itself has not passed. A `partial` contract whose ERROR warnings were explicitly waived IS
  exportable -- this project already decided a waived-partial contract is good enough to feed
  `handles emit`, and exporting it is not a weaker bar; the export discloses
  `completeness: "partial"` in `x-bskel-generated` so a consumer can see it. No completeness logic
  is re-derived anywhere in this item; the gate check is the whole mechanism.
- **Refuses by default on an unreflected global path prefix.** A1 §7's `path_prefix_signals` exist
  precisely because a source-annotation scan cannot see a framework-level global prefix -- a
  contract emitted without `--openapi-file` in that situation has paths silently missing it
  (Team-IZ-Backend's own `ApiPathConfig.java` sets `/api/v0`). Publishing THOSE to a client
  generator is a wrong-URL-at-runtime bug with no compile step to catch it, so it is refused rather
  than warned about, naming the exact evidence file, with `--allow-unprefixed` as the explicit
  override. The check is "does ANY operation path fail to sit under the signalled prefix", not
  "all" -- a partially-reconciled contract (matched operations corrected, a drifted one left at its
  scan path) is exactly the dangerous mixed case, and half-right paths are no safer than wholly
  wrong ones. Segment-boundary safe, reusing `PATH_PREFIX_RE` rather than re-deriving it, so
  `/api/v0` never counts `/api/v0abc` as prefixed.
- **Status codes.** `responseSchema` → `responses["2XX"]`, `errorSchema` → `responses["default"]`,
  and an operation with neither gets no `responses` key at all. All three facts were verified by
  executing the official 3.1 meta-schema rather than assumed: `$defs.responses` accepts exactly
  `^[1-5](?:[0-9]{2}|XX)$` plus an explicit `default` property, `$defs.operation` does not require
  `responses`, and `responses: {}` is illegal anyway (`minProperties: 1`) -- so omitting is both
  legal and honest, where guessing a status would be neither. `--status-codes literal` swaps `2XX`
  for `200` for tooling that cannot read range keys, and prints a stderr note ONCE per document (not
  per operation) saying plainly that `200` is a bskel-chosen stand-in: the contract records no status
  codes whatsoever, so under `literal` EVERY operation gets the same stand-in and N copies of the
  note would say nothing more.
- **`content: {'application/json': {}}` -- a media-type entry with no schema -- is load-bearing, not
  an oversight.** It is the only way to say "this operation takes a JSON body whose shape the
  contract does not know" without inventing one. Emitting `{type: 'object'}` there (the shape
  `operationPayloadSchema` itself falls back to) would be a fabricated schema AND would break the
  round-trip invariant, since re-importing would produce a `requestBodySchema` the original contract
  never had. A known-bodyless operation (`body: false`) gets no `requestBody` at all; a `body:
  'unknown'` one gets the media-type entry without `required`, matching exactly what
  `operationPayloadSchema` already enforces for that case.
- **`x-bskel-omitted` is derived from the contract, not a fixed disclaimer.** The structural entries
  (query/header parameters, security, summaries, tags, non-JSON media types, per-status responses,
  descriptions) are always present because the contract format carries none of them for any
  contract; `request-body-schemas`, `response-schemas` and `error-schemas` are added only when at
  least one operation in THIS contract actually lacks them. Tested in both directions, including a
  fixture where every operation documents a response and an error and neither entry appears -- the
  case that would be impossible if the list were hardcoded.
- **`info.version` is a 12-char prefix of the contract hash**, not an invented semver. OpenAPI
  requires `info.version` to be a string and the contract carries no API version; a content
  identifier (stable across re-exports of the same contract, different the moment it changes) says
  something true, where `"1.0.0"` would read as a claim about the API's own versioning. Explained in
  `info.description` so nobody mistakes it for one.
- **`x-bskel-generated.contract_sha256` is the self-import guard's key material AND the same number
  the gate hashes.** `contractSha256()` hashes `JSON.stringify(contract, null, 2) + '\n'` -- byte-
  identical to what `cmdContractEmit` writes to disk -- so it equals `lib/gate-definitions.mjs`'s
  own `contract_hash` (`sha256File`) rather than being a second, parallel notion of identity. Proven
  by a test against a real emitted file, not left as a claim.
- **Output shape.** With no `--out`, stdout is the document itself, so `--json` is a documented
  no-op there (stdout is already exactly one JSON document either way) -- the same treatment `scan
  disposition` and the always-JSON gate commands already get, and `--quiet` never touches it because
  the document IS the payload. With `--out`, the document goes to the file and stdout carries a
  human summary, or an `sbf.contract-export/1` envelope under `--json`. Every path leaves stdout
  holding exactly one JSON document when `--json` is given, preserving `D-cli-contract`'s invariant.
- **`process.exitCode`, never `process.exit()`, after printing.** An exported document is routinely
  LARGER than the contract it came from (every projected schema reproduced verbatim, plus the prose
  disclosure), so this exit path was in the exact bug class `D-process-exit-audit` swept -- built
  correctly from the start rather than fixed later, with the same >64KB pipe-capture regression test
  the other two call sites already have.

**Two importer fixes this item forced -- real, general capability gains, not round-trip plumbing.**
Verified by executing the actual regexes: `SUCCESS_STATUS_RE = /^2[0-9]{2}$/` does NOT match `2XX`,
and `ERROR_STATUS_RE = /^[45][0-9]{2}$/` matches neither `4XX`/`5XX` nor `default`. Range keys and
`default` are ordinary in real hand-written OpenAPI documents, so before this widening `bskel` could
not read one at all -- and did so SILENTLY, because "no matching status" is (correctly) not a failure
anywhere in `projectResponseSchemas`, so a document written that way lost every response and error
schema with no warning emitted anywhere.
1. Widened to `/^2(?:[0-9]{2}|XX)$/` and `/^[45](?:[0-9]{2}|XX)$/`, matching the official 3.1
   meta-schema's own `^[1-5](?:[0-9]{2}|XX)$` exactly.
2. `default` folded into the ERROR side only, via an explicit `includeDefault` parameter. The
   asymmetry is the whole point: `default` means "every status not otherwise listed", so folding it
   into SUCCESS would let an error shape satisfy success validation -- a real false negative.
   Folding it into ERROR can only ever WIDEN the error union, which A3's `anyOf` design already
   tolerates by construction ("matches at least one documented shape"), and never narrows what a
   real response is permitted to be.

Both were confirmed to FAIL against the pre-fix code before the tests were kept, the same discipline
`D-javascript-express-adapter`'s comment-masking fix used. Reverting all three edits and re-running
the real CLI: `2XX` + `4XX` projects NEITHER schema, `2XX` + `5XX` neither, `200` + `default` loses
the error one, `default` alone yields nothing -- and the round-trip test fails on `createWidget`
losing both its `responseSchema` and its `errorSchema`. Restored: all four project correctly, and
`default` alone still produces NO success schema, which is the asymmetry stated as an executable
assertion rather than only as a comment.

**The self-import guard -- a real, structural hazard this design creates, closed structurally.**
Once export exists, piping its output straight back into `contract emit --openapi-file` would make
the contract "confirm" itself: `stats.matched` reads N/N and A1's entire point (an INDEPENDENT
oracle) evaporates silently. Worse than a no-op, per the drift/missing/ambiguous laundering traced
under EXCLUDED above. Closed by checking for the `x-bskel-generated` extension on `info` immediately
after a successful `loadOpenApiDocument()` inside `buildReconciliation()`, and returning the same
`{ok:false, error}` shape a malformed `--openapi-file` already returns -- so it surfaces through the
EXISTING exit-14/`BAD_ARGS` path with no new exit code and no new machinery. The constant lives on
the READING side (`contracts/openapi.mjs`) and `contracts/export.mjs` imports it, so writer and
reader cannot drift apart and silently disarm the guard. The error message names the exact escape
hatch (remove the extension) rather than leaving a user stuck.

The guard is proven LOAD-BEARING, not decorative, by a pair of tests: a contract carrying a real
`drift` operation is exported and re-imported, and the re-import is refused; then the SAME document
with only `x-bskel-generated` stripped is re-imported, and the drifted operation genuinely does
reclassify to `matched` with `provenance: "scan+openapi"`, the `CONTRACT_OPENAPI_DRIFT` ERROR
vanishes entirely, and a contract that was `partial` now reads `complete`. Nothing else in the
system catches it.

**Real findings during implementation, all reproduced by execution, none hypothetical**:
- **OpenAPI 3.1 REQUIRES `description` on a Response Object** (`$defs.response.required:
  ["description"]`), which the plan for this item did not anticipate. There is no way to emit a
  response at all without one. Resolved by making the two description strings describe the
  PROJECTION rather than the API ("The source contract records the union of every documented 2xx
  JSON body for this operation, with no per-status detail -- see info.x-bskel-omitted"), so a string
  the format forces on us still makes no claim we cannot back up.
- **Ajv 8.20.0 mis-resolves the official 3.1 meta-schema's own `{"$dynamicRef": "#meta"}` nodes.**
  Instead of resolving to `$defs.schema` (which carries the matching `$dynamicAnchor: "meta"`), it
  applies the ENCLOSING subschema to the referenced value -- so a path parameter's `schema` gets
  validated against the Parameter Object and fails with "must have required property 'name'" and
  "must NOT have unevaluated properties", and a response schema of `{type: 'object'}` fails
  `unevaluatedProperties` while a bare `{}` passes. Reproduced against a 6-line synthetic schema of
  the same shape to confirm it is Ajv's behavior and not a usage error here. Handled by rewriting
  those 4 nodes to a plain `$ref: '#/$defs/schema'` before compiling -- which is exactly what the
  2020-12 spec says a `$dynamicRef` degrades to when nothing in the dynamic scope overrides the
  anchor, and that is the case for a standalone 3.1 document (only the separate `schema-base`
  dialect variants override it). The adaptation lives in the TEST, in one commented place, with an
  assertion that it actually found nodes to rewrite; the vendored file itself stays byte-identical
  to the published one.
- **`security: []` validates cleanly** against the real meta-schema, confirmed by running it. That
  is the finding that decided the omit-never-fabricate rule above, and it is pinned as an explicit
  test assertion (`the reason it is never emitted is truthfulness, not validity`) so a future reader
  does not "fix" the missing key.
- **A pre-existing test had explicitly PINNED the old `default` behavior**, which is the only test
  in the whole suite this item had to modify: `test/contract-openapi.test.mjs`'s "a response
  documented only under `default` contributes to neither success nor error bucket". That is worth
  recording rather than quietly rewriting, because it means the old behavior was deliberate at the
  time, not an oversight -- A3 simply had no reason to read `default` (Team-IZ-Backend's own
  document does not use it) and pinned what it did. Retargeted to assert the new asymmetry, with
  the SUCCESS half of the original assertion kept verbatim and now carrying the real weight
  (`default` must never become a success schema). Confirms the COST note above is a genuine change
  to shipped behavior, not a theoretical one.

**Deliberately unchanged, confirmed rather than skipped**:
- `contracts/completeness.mjs` -- no new warning codes. Export READS A5's existing verdict (through
  the gate) and adds nothing to it; a warning code is for something `contract emit` found in the
  contract, and export finds nothing new about the contract.
- `lib/gate-definitions.mjs` -- no new gate, no new gate-token input. Export is an OUTPUT derived
  from the contract, not an input to it; hashing an exported file into the `contract` gate's token
  would make the gate go stale the moment anyone re-exports, backwards for a derived artifact. Same
  reasoning `D-handles-ownership` used for keeping generated handle files out of the `handles`
  token. `test/gate-definitions.test.mjs`'s exact 4-key assertion is untouched, and would fail
  loudly if a 5th key were added by mistake.
- `lib/verify.mjs` -- unchanged, same reasoning A1 and A5 both already used for not extending
  `checkArtifacts()`: an exported document is not an artifact any gate declares, and re-deriving
  anything about it at verify time would be pure duplication.
- `.github/workflows/ci.yml` -- no new job. Pure Node, no external toolchain, runs inside plain
  `npm test`. Contrast with `java-compile`/`python-import`/`typescript-compile`/`db-introspect`,
  each of which needed a job precisely because it needs a toolchain `npm test` does not have.

**Verification**: `npm test` 771 → 792 (21 net new -- 20 in `test/contract-export.test.mjs` plus one
`cli-contract` required-field case the new command's own COMMANDS-coverage guard demanded). Exactly
ONE pre-existing test was modified, the `default`-bucket one described above; every other test in the
suite passes completely unmodified, including all 43 in `test/contract-cli.test.mjs` across the
harness extraction.
`test/contract-export.test.mjs` drives everything through the REAL CLI against real git repos, never
through `contracts/export.mjs`'s exported functions -- the claim under test is "a contract can be
published as an OpenAPI document", and only a real CLI dispatch establishes that. Every exported
document is validated against the vendored official 3.1 meta-schema, and the checker itself is
self-verified against nine real defects (an empty `responses`, a response with no `description`, a
path parameter with no `required`/with `required: false`/with no `schema`, a bogus status key, a
paths key not starting with `/`, a `requestBody` with no `content`, an `info` missing `version`) --
a meta-schema test that can only ever pass is worth nothing. The round trip runs as two real
subprocess CLI invocations, not direct function calls. `npm pack --dry-run` re-run to confirm the
vendored meta-schema ships nowhere (`test/` is excluded by `package.json`'s `files` allowlist, so
this needed no packaging change -- confirmed, not assumed).

**COST**: an exported document is a genuinely partial description of one feature, and a consumer who
does not read `info.x-bskel-omitted` can mistake it for a complete one -- the disclosure is
prominent but not enforceable. A client generated from one will have no query/header parameters and
no auth wiring, and a mock server built from one will accept unauthenticated requests; both are
correct reflections of what the contract knows and neither is discoverable from the generated code
itself. The `--status-codes literal` mode ships a stand-in status code by design, mitigated only by
a stderr note nobody is forced to read. The prefix refusal is conservative and will occasionally
block an export whose feature genuinely lives outside a repo-wide prefix, costing one
`--allow-unprefixed`. The self-import guard makes an exported document permanently unusable as an
`--openapi-file` input without a manual edit, which is the intent but is also friction for anyone
who wanted an export as a starting point for a hand-maintained document. The two importer regex
widenings change how an already-shipped command reads an already-existing document shape: a document
using `4XX`/`5XX`/`default` that previously projected NO error schema now projects one, so an
`error` envelope that used to pass unconstrained can now legitimately fail -- an intended
correctness fix, but a real behavior change to shipped behavior, recorded here rather than smoothed
over.

**EXIT**: `contracts/export.mjs`'s `STRUCTURAL_OMISSIONS`/`OMISSION_PROSE` are the single place to
add a disclosure the day the contract format grows (or keeps failing to carry) another field;
`buildRequestBody`/`buildResponses` are the single place the projection's shape lives. Add a 3.0
output mode ONLY by first resolving the three dialect blockers named under EXCLUDED -- a better
renderer does not make `exclusiveMinimum` mean the same thing in both dialects. If query/header
parameters or security ever become real contract fields (they would have to come from a
scanner/adapter that can see them, not from this module), they drop out of `STRUCTURAL_OMISSIONS`
and into real emitted content with no other change. The `$dynamicRef` adaptation in the test can be
deleted outright the day Ajv resolves `$dynamicAnchor` correctly -- the assertion that it found
nodes to rewrite is what will fail first and point at it. Live drift detection against a running
server remains open and is still A1's EXIT, untouched by this item.

Cross-references: `D-openapi-reconciliation` (A1, the import direction this is the inverse of, the
`path_prefix_signals` this item's own refusal consumes, and the "describe the method, not an
unchecked fact" discipline the omission prose follows); `D-openapi-request-schema` (A2, the
`inlineSchema()` no-`$ref` guarantee that makes an exported document self-contained, and the
`format: 'uuid'` → `pattern` rewrite that makes the round trip "convergence after one step");
`D-openapi-response-schema` (A3, the `responseSchema`/`errorSchema` union this item projects back
out, and the `anyOf`-never-`oneOf` reasoning that makes folding `default` into the error side safe);
`D-contract-completeness` (A5, the three-way completeness verdict this item's three different
behaviors read, and the `{code, subject}` waiver key an ambiguous-endpoint laundering would break);
`D-gate-precision` (S2, the `contract` gate token that transitively covers scan report + disposed
module files, which is why preflight is not additionally required here); `D-handles-ownership` (O2,
the "a derived artifact does not belong in the gate token" precedent `lib/gate-definitions.mjs`
staying unchanged follows); `D-process-exit-audit` (the >64KB pipe-truncation class this command's
own exit path was built against from the start); `D-cli-contract` (D2, the `--json` invariant and
the existing BAD_ARGS/exit-14 path the self-import guard reuses rather than extending);
`D-security-1`/`D-security-2` (the prototype-pollution and bare-UUID-pattern classes this item
inherits unchanged); `D-scanner-evidence` (D3, the "privately duplicated helper" extraction
precedent `test/_contract-fixture.mjs` follows); `D-artifact-determinism` (O6, the no-timestamps,
byte-identical-re-run property an export inherits and is tested for);
`D-javascript-express-adapter` (G6, the "confirm the test fails against the pre-fix code before
keeping it" discipline both importer fixes followed).

**Update (2026-08-24, real dogfooding, Phase 3, Team-IZ/Backend)**: `--path-prefix` is only ever
read inside `buildReconciliation()`, called only when `--openapi-file` is also given
(`bin/bskel.mjs`'s `cmdContractEmit`) -- passing `--path-prefix` alone was a silent no-op with zero
feedback, found by a real Codex-run dogfooding pass against Team-IZ/Backend, not by review. Fixed
with an early, repo-independent check in `cmdContractEmit`: `--path-prefix` without
`--openapi-file` now fails closed (exit 14, BAD_ARGS) with a message naming exactly why (the flag
has no effect on its own), before any gate/feature-state work runs. New regression test in
`test/contract-cli.test.mjs`. See D-contract-completeness above for the companion
`CONTRACT_UNREFLECTED_PATH_PREFIX` fix from the same dogfooding pass -- that one is the more
consequential of the two (it changes a real module's completeness verdict); this one is a pure
CLI-ergonomics fix with no completeness-logic change.

## D-openapi-passthrough (A7): copying is not synthesizing -- what a real source document licenses the export to say

**WHY**: A6's whole design is dominated by "never synthesize what the contract does not know" --
but by the time A6 shipped, the contract genuinely did not know query/header/cookie parameters,
security, summaries, or tags, because A1's `indexOpenApiDocument()` never retained them off the
source document in the first place. That is a gap in what gets INDEXED, not a permanent limit on
what an export is allowed to say. A7 changes the antecedent, not the rule: when `contract emit
--openapi-file <real doc>` reconciles an operation as `matched`/`adopted`, a real, human-supplied,
already-validated document said something concrete about that exact operation -- copying those
bytes across is the same class of act as A1 copying `docEntry.path`, or A2/A3 copying a
`$ref`-inlined body/response schema. The rule an implementer can apply mechanically: a field may be
copied iff its value exists verbatim in the source document, on the operation object reconciliation
already tied to THIS contract operation (or in a `components` section that operation's own value
names), and the only transformation applied is one this codebase already performs mechanically
elsewhere (`inlineSchema()`'s `$ref` inlining + keyword whitelist + `format: uuid` -> bare-pattern
rewrite). Anything requiring a decision about what the API probably does stays omitted.

**`security` is the sharpest case, and it flips A6's own stated rule rather than merely extending
it.** A6 refused to ever emit `security: []` because inventing it is a positive false claim of "no
auth required." Copying `security: []` from a source document that states it is the opposite: it is
the DOCUMENT's own positive claim, transported, not invented. Measured on the real 148-operation
Team-IZ-Backend oracle (`~/Desktop/Team-IZ-Backend/build/api-docs.json`, re-measured now, by
execution, not carried over from A6's own prose): 137/148 operations carry `[{"bearerAuth":[]}]`
and 11 carry a literal `[]` -- 11 genuinely public endpoints whose public-ness was, until this item,
unrepresentable by this projection at all. A7 emits `[]` only when the source said `[]`, never as a
default, never as a fallback.

**Schema validity still decides nothing -- reconfirmed, not assumed, by executing the vendored
`test/fixtures/openapi-3.1-meta-schema.json`.** A document whose `security` requirement names a
scheme with no `components.securitySchemes` entry at all validates `true`; two parameters sharing
the same `(name, in)` also validate `true`. Both are real spec violations the meta-schema cannot
express. So the exporter enforces scheme-resolution and `(name, in)` uniqueness itself, the same
"truthfulness, not validity" lesson A6 already recorded for `security: []`.

**Measured coverage, re-run now against the real oracle, not trusted from the plan that preceded
this implementation pass** (`node --input-type=module -e '...'` against
`contracts/openapi.mjs`'s own exported functions, no changes to the oracle repo):

| Field | Oracle measurement (re-confirmed) |
|---|---|
| operations with >=1 query param | 33/148 |
| operations with >=1 header param | 23/148 |
| operations with >=1 cookie param | 2/148 |
| total parameter objects | 255 (max 9 on one operation) |
| operations with an explicit `security` | 148/148 -- 137 x `[{bearerAuth:[]}]`, 11 x `[]` |
| `components.securitySchemes` | exactly one: `bearerAuth` (`type: http`, `scheme: bearer`, `bearerFormat: JWT`) |
| `$ref` parameter objects / path-item-level `parameters` / `style`/`explode` / parameter `content` / operation `servers` / `callbacks` / `deprecated` | 0 of each |
| operations with `summary` / `tags` | 148 / 148 |
| operation vendor extensions | 148 x `x-readiness` |

Every one of these numbers reproduced exactly against the real oracle -- confirming the pre-existing
plan's own measurements rather than taking them on faith, per this project's standing "no agent
self-report is trusted, including a prior plan's" discipline.

**`inlineSchema()` learns `default` -- the one real keyword-policy change this item forced, and its
blast radius was measured, not assumed.** Parameter schemas resolved 222/253 before this change;
all 31 failures shared one root cause -- `default` (22 x `unsupported-keyword:default`, 9 x
`ref-with-siblings` where the sibling *is* `default`, e.g. `{"$ref": ".../ProjectListSort",
"default": "READINESS"}`). Adding `default` to `COPIED_KEYWORDS` (for a plain node) and tolerating
+ merging it as a `$ref` sibling (for the ref-with-siblings case) lifts resolution to **253/253** --
re-run directly against the live code in this branch, not carried over as a claim. The blast radius
onto ALREADY-SHIPPED A2/A3 output was also re-measured directly: walking every real request-body
and response schema reachable in the oracle finds **zero** that contain `default` anywhere, so this
change provably produces zero bytes of difference in A2/A3's own output on the real document.
`default` is annotation-only in 2020-12 and this repo's Ajv runs with `useDefaults` off, so it is
inert for validation either way -- the value is purely informational, carried through because it is
real and human-authored, not because it changes what a payload validates against.

**One unplanned, real, disclosed-not-fixed finding, reconfirmed by execution**: the contract's own
path-param heuristic (`contracts/emit.mjs`'s `pathParamsSchema`, `/id$/i` -> `BARE_UUID_PATTERN`)
disagrees with the oracle on exactly one of 130 real path parameters --
`findTraineeRegistrationProgress`'s `batchRequestId` is declared plain `{"type":"string"}` in the
real document while the contract pins it to a UUID pattern, i.e. `contract validate` today would
reject a real, valid request shaped like `"trainee-batch-001"`. This is a genuine, small,
pre-existing false-negative in shipped validation. A7 discloses it (the new
`path-parameter-schemas` omission entry, always-on) but does NOT fix it -- replacing the contract's
path-parameter schemas with copied source path parameters is out of THIS item's scope, named as a
separate future item in EXIT below, not silently folded in.

**SCOPE (Phase 1 only)**: parameters (query/header/cookie), security (+referenced
securitySchemes), summary, tags. Default-on whenever `--openapi-file` is given -- no new CLI flag
(measured ~234 bytes/operation across all 9 real modules with an HTTP surface, see COST; small
enough that gating it behind a flag would only add friction for no real protection). Per-status
responses, non-JSON media types, and operation `description` are explicitly Phase 2 and are NOT
touched by this pass --
`contracts/validate.mjs`'s response/error union logic is unmodified, no per-status response field
was added, no multipart handling was added.

**EXCLUDED from this pass, named rather than silently dropped:**
- *Per-status responses, non-JSON request media types (multipart), operation `description`* -- all
  Phase 2, independently shippable later, not started here.
- *Vendor `x-*` extensions* -- copyable in principle (`x-readiness` appears on all 148 real
  operations), excluded because their semantics are tool-specific. Disclosed as a new, always-on
  `vendor-extensions` omission entry rather than silently dropped.
- *Document-level `security` inheritance -> operation.* Only operation-level `security` is ever
  copied; if absent, omitted -- never a root `security`, which would silently also cover operations
  A7 did not individually resolve.
- *Replacing the contract's path-param schemas with the source's* -- disclosed (the `batchRequestId`
  finding above, and the new `path-parameter-schemas` omission entry) but not implemented; a
  separate future item, named in EXIT.
- *Turning copied `security` into generated authorization code* -- hard no, permanently, stated
  explicitly here because "the contract now knows the endpoint needs `bearerAuth`" is exactly the
  kind of fact a future reader will be tempted to codegen from. A copied requirement is
  documentation, not an authorization contract; every provider's `check_access`/`requiredAuthority`
  stays a fail-closed stub, completely untouched by this item.
- *OpenAPI 3.0 output* -- unchanged from A6's three cited blockers; not revisited here.

**Mechanism**:
- `indexOpenApiDocument()` retains `parameters`/`security`/`summary`/`tags` (raw nodes) on each
  entry, and indexes `doc.components.securitySchemes` into a Map (never a plain object, same
  `COMPONENT_SCHEMA_NAME_RE` whitelist `componentSchemas` already uses, same prototype-pollution
  reasoning), bounded by new `MAX_SECURITY_SCHEMES = 64` (real observed: 1). `security` is retained
  via `Array.isArray(...) ? ... : null` specifically so a real, explicit `[]` (11/148 real
  operations) is distinguishable from "absent" -- collapsing them would silently destroy the exact
  fact this item exists to preserve.
- New caps, same "generous multiple of the real observed max" style as every existing one:
  `MAX_PARAMETERS_PER_OPERATION = 64` (real max 9), `MAX_SECURITY_REQUIREMENTS_PER_OPERATION = 32`
  (real max 1), `MAX_SECURITY_SCHEMES = 64` (real 1). Exceeding a cap fails that ONE field closed
  for that operation, never the whole reconciliation -- same posture as every other cap in this
  module.
- **Parameter Object key policy** (`copyParameter()`), mirroring `inlineSchema()`'s
  RECURSED/COPIED/DROPPED/fail-closed structure one level up, so there is one house style for "what
  may I copy": COPIED verbatim (`required`, `deprecated`, `description`, `style`, `explode`,
  `allowReserved`, `allowEmptyValue`); RESOLVED (`schema`, through `inlineSchema()`); DROPPED
  (`example`/`examples`, annotation-only); FAIL CLOSED for that ONE parameter (`$ref` -- needs
  `components.parameters`, which this module does not index; `content` -- a media-type-keyed
  alternative to `schema`, Phase 2 machinery; any other unrecognized key). A parameter whose
  `schema` alone fails to resolve is STILL added to `sourceParameters` (every other field it carries
  is real and safe) just without a `schema` key -- the exporter fills `{}`, the same honest-minimum
  fallback `buildPathParameters()` already uses for a path parameter with no known schema. `path`
  parameters are filtered out before this policy even runs (path stays contract-derived); dedup is
  on `(name, in)`, source order, first occurrence wins.
- **`applyParameters()` rides the schema-bearing dialect gate** (`schemaProjectionEnabled`) -- a 3.0
  document disables it exactly like A2/A3, recording `parameters: "skipped:dialect"` in the
  snapshot. **`applySecurity()`/summary/tags are dialect-INDEPENDENT** and always attempted --
  a Security Requirement Object, a `summary` string, and a `tags` array mean the same thing under
  3.0 and 3.1, unlike a Schema Object's `exclusiveMinimum`/`nullable`. This is a deliberate,
  documented asymmetry between the four fields, tested in both directions
  (`test/contract-openapi.test.mjs`'s two "dialect-INDEPENDENT" tests), not an oversight.
- **`applySecurity()` is all-or-nothing per operation**, unlike parameters' per-item fail-closed: a
  requirement naming a scheme that could not be resolved against `index.securitySchemes` drops the
  WHOLE `security` value for that operation, never a dangling reference -- the meta-schema
  demonstrably cannot catch this itself (see the reconfirmed finding above). A shared `Set`,
  threaded through both `reconcileModule()` call sites (`matched`/`adopted`, the exact placement
  A2/A3's own helpers already occupy -- see the refusal-behaviour bullet below), accumulates every
  scheme name any operation's COPIED security actually referenced; at the end of `reconcileModule()`
  this is resolved against `index.securitySchemes` into `sourceSecuritySchemes` (a Map, only the
  referenced subset, never the document's whole catalog) and propagated through
  `buildReconciliation()` to `contracts/emit.mjs`'s `buildContract()`, which attaches it at the
  CONTRACT ROOT (`sourceSecuritySchemes`, omitted entirely when empty).
- **`buildOpenApiDocument()` (export side)**: `buildOperationParameters()` appends
  `op.sourceParameters` to the path-derived list, deduped on `(name, in)` with the path-derived ones
  winning -- the exporter enforces uniqueness itself, since the meta-schema demonstrably does not. A
  parameter with no `schema` key gets `{}` appended before emission (never dropped). `security` is
  emitted (via `Array.isArray`, not a truthy check, so `[]` survives) exactly when
  `op.sourceSecurity` is present; `summary`/`tags` likewise. `components.securitySchemes` is emitted
  from `contract.sourceSecuritySchemes` verbatim -- no re-verification needed at export time, since
  `applySecurity()` already guarantees every name it references resolves.
- **Snapshot decision fields**, exactly parallel to A2/A3's `request_body_schema`/`response_schema`/
  `error_schema` (`snapshotFromReconciliation()` "records the DECISION, not the schema itself"):
  `parameters: "copied:N" | "partial:M-of-N" | "none" | "skipped:dialect"`,
  `security: "copied:N" | "copied:public" | "unresolved:<reason>" | "none"`,
  `summary: "copied" | "none"`, `tags: "copied:N" | "none"`. New stats counters
  (`parameters_copied`/`_unresolved`/`_none`/`_skipped_dialect`,
  `security_copied`/`_public`/`_unresolved`/`_none`, `summary_copied`, `tags_copied`), initialized
  up-front for the same shape-stability reason A2/A3's own counters are.
- **Two new WARN codes** (`contracts/completeness.mjs`), each ONE warning per OPERATION (not per
  individual parameter/reason), same "subject is the operationId, message enumerates the specifics"
  shape as `CONTRACT_OPENAPI_SCHEMA_UNRESOLVED`: `CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED` (at least
  one parameter could not be copied -- names each `name`+`in`+reason in the message) and
  `CONTRACT_OPENAPI_SECURITY_UNRESOLVED` (the operation's security could not be copied). Two codes,
  not one shared, for the identical reason `D-openapi-response-schema` split response/error: a
  waiver keyed `{code, subject}` for one must never silently cover an unrelated failure sharing the
  same operation. Both WARN, not ERROR -- the contract stays correct on verb/path/body, this is a
  missed enhancement.
- **The self-import guard is hardened, not just extended.** A passthrough-heavy export (real
  query/header parameters, a real bearer-auth requirement, real summaries/tags) reads much closer to
  the source oracle than A6's original thin projection, so the documented escape hatch (stripping
  `info.x-bskel-generated`) needed to get harder to trigger by accident, proportionate to how real
  the export now looks. A second marker, `BSKEL_PASSTHROUGH_EXTENSION = 'x-bskel-passthrough'`
  (value `{source_sha256: <12-char prefix>}`), is stamped on every operation that actually carries at
  least one copied field; `hasBskelExportMarker()` now returns `true` if EITHER the `info` marker OR
  any operation's marker is present. Both constants live on the reading side
  (`contracts/openapi.mjs`), imported by the writer, so writer and reader cannot drift apart. Proven
  load-bearing, not decorative: stripping ONLY `info.x-bskel-generated` from a passthrough-heavy
  export is still refused (the operation markers alone trigger the guard); stripping BOTH is what
  actually disarms it.
- **The round-trip claim is extended, with one new, disclosed asymmetry.** For a `complete`
  contract, export -> re-import (all markers stripped, both kinds) against the same scan report
  reproduces `operations` exactly, including all four new `source*` fields and the root
  `sourceSecuritySchemes` -- tested end to end through the real CLI, not through direct function
  calls. One new, real asymmetry, same class as A6's own `format:'uuid'` rewrite: a parameter whose
  `schema` failed to resolve is exported as `schema: {}` (the honest-minimum fallback); `{}` is a
  trivially valid JSON Schema, so RE-importing that export resolves it successfully the second time
  around -- the original "unresolved" status is not perfectly preserved through one round trip. This
  is "convergence after one step," the exact phrase A6 already used for the same class of behavior,
  not a new kind of lossiness; the round-trip TEST for this item deliberately uses only
  fully-resolvable fields to keep the asserted invariant clean, the same restraint A6's own
  round-trip test already used.
- **Migration cost, real and different from A2/A3's own "no migration cost" framing.**
  `schemas/feature-contract.schema.json` bumps `sbf_contract` `"4"` -> `"5"`
  (`CONTRACT_SCHEMA_VERSION`, exported once from `contracts/emit.mjs`, imported by `bin/bskel.mjs`
  so the literal is never duplicated). Unlike A2/A3 (which shipped before S5's `loadContract()`
  schema-validated contracts on READ), this bump has a REAL read-time consequence: every
  previously-emitted contract now fails `contract export`/`waive`/`validate`/`tool-schema` against
  the raw ajv dump, unless a targeted pre-check catches it first. `loadContract()` now checks
  `parsed.sbf_contract !== CONTRACT_SCHEMA_VERSION` BEFORE the full schema validation and, only for
  that specific case, prints *"this contract was emitted by an older bskel ... re-run \`bskel
  contract emit --feature <id>\`"* instead of a raw ajv dump; any OTHER schema violation still falls
  through to the generic message, confirmed by a dedicated regression test.
- **Mixed passthrough coverage is disclosed, not newly refused.** Trace it: every operation that
  reaches `contract.operations` via a kind OTHER than `matched`/`adopted` (a waived `drift`/
  `missing`) already carries an ERROR through an EXISTING code
  (`CONTRACT_OPENAPI_DRIFT`/`CONTRACT_OPENAPI_MISSING_OPERATION`), so a `complete` contract (zero
  unwaived ERRORs) has 100% passthrough coverage BY CONSTRUCTION -- mixed coverage can only arise in
  an explicitly waived `partial` contract. `buildOpenApiDocument()` computes a per-operation boolean
  map (`generated.passthrough`, always present, machine-readable) and returns whether coverage is
  genuinely mixed; `cmdContractExport` prints ONE stderr note (not per-operation) naming how many
  operations lack it, only when mixed. This is disclosure, not a new refusal -- proven by a pair of
  tests (a waived-drift contract prints the note with the exact map; a `complete` contract prints
  nothing).
- **Refusal behaviour, completely unaffected, verified not assumed.** `applyPassthrough()` is
  invoked from the exact same two call sites (`matched`, `adopted`) inside `reconcileModule()` that
  A2/A3's own helpers already occupy -- no other kind's `result` object ever reaches it. A dedicated
  test confirms `drift` never carries any of the four `source*` fields even when the doc entry has a
  perfectly copyable set of all four. `openapi: null` (no `--openapi-file` at all) never assigns any
  of the four fields nor `sourceSecuritySchemes` -- extends the existing byte-identity regression
  test.

**Real findings during implementation, reproduced by execution, none hypothetical**:
- The `default`-keyword fix and its zero-blast-radius-on-A2/A3 proof, both above.
- The `batchRequestId` path-param-heuristic disagreement, above -- disclosed via the new
  `path-parameter-schemas` omission, not fixed.
- **The size-cost estimate this item's own preceding plan cited (~130 bytes/operation) undershot
  the real, re-measured cost by roughly 1.8x.** Measured directly, twice, at increasing scope: first
  organization/member/curriculum (47 real operations, 227.8 bytes/op average), then re-measured
  across all 9 real modules with an HTTP surface (104 real operations --
  organization/member/curriculum/academicoperations/notification/projectexecution/reporting/
  usagemetering/analytics -- the serialized bytes of exactly the four new operation fields plus the
  root `sourceSecuritySchemes`): **234.5 bytes/operation** on average, ranging 112.6 (academicoperations)
  to 693.0 (notification, only 2 operations, high variance from a small sample), not ~130. The
  likely cause, not merely asserted: the plan's estimate did not account for
  `summary`/`description` text being real, multi-byte-UTF-8 Korean prose (Team-IZ-Backend's own API
  is documented in Korean), nor for the nested-object overhead of nesting a nontrivial `schema` and
  `description` inside every copied parameter. Recorded here, not silently corrected, per this
  project's Data-First Numerics discipline -- a plan's own cited number is a hypothesis, not a fact,
  until re-measured against the running code.
- **The preceding plan's own §4 claim about the `contract` gate's "exact 4 keys" named the wrong
  fourth key.** It stated the set as `contract_hash, head_sha, resolution_hash,
  openapi_snapshot_hash`; the actual, real key set (`lib/gate-definitions.mjs`'s `contract.recompute`,
  and `test/gate-definitions.test.mjs`'s own exact-key-set assertion, both re-read directly before
  writing this item) is `contract_hash, openapi_snapshot_hash, resolution_hash, scan_report_hash` --
  `scan_report_hash`, not `head_sha`. `head_sha` was removed from this gate entirely by S2
  (`D-gate-precision`, "head_sha is GONE"), before A6 was even written; A6's own DECISIONS.md text
  correctly says `scan_report_hash` in its own EXCLUDED/Deliberately-unchanged section, so this was
  specifically an error introduced while drafting the A7 plan's own §4 recap, not a pre-existing
  documentation bug. Recorded here because the instruction to "re-run what the plan measured rather
  than trust it" caught it; the gate machinery itself needed and received zero changes either way
  (unchanged per this item's own SCOPE), so no code was affected by the error -- only a sentence in
  the plan that preceded this implementation.

**Verification**: `npm test` 841 -> **900** (59 net new, counted directly from each file's own
`^test(` occurrence count before/after this item, not estimated: 35 in
`test/contract-openapi.test.mjs` covering `inlineSchema`'s `default` handling,
`copyParameter`/`applyParameters`/`applySecurity`/`applySummaryAndTags` in isolation, the dialect
asymmetry, the snapshot decision fields, and `hasBskelExportMarker`'s new operation-level check; 8
in `test/contract.test.mjs` covering `buildContract()` integration -- both new warning codes, the
root `sourceSecuritySchemes`, drift refusal, and the extended byte-identity guarantee; 3 in
`test/contract-completeness.test.mjs` covering the two new warning-code table entries and their
waiver-key independence; 13 in `test/contract-export.test.mjs` covering parameter merge/dedupe,
`security`/`components.securitySchemes` emission, the derived (ANY-based) omissions, the hardened
guard, the extended round trip, mixed-coverage disclosure, and `loadContract()`'s friendly
`sbf_contract` message).
Zero pre-existing tests were rewritten to accommodate new behavior except the two that PINNED the
old `sbf_contract: "4"` literal as a fixture value (`test/schema-validate.test.mjs`,
`test/contract.test.mjs`) -- both are updated to `"5"`, and both still assert the exact same claim
they always did (a minimal valid contract passes; a non-UUID `feature_uid` is rejected), unaffected
by the version bump itself. Re-run against the real oracle (`~/Desktop/Team-IZ-Backend`, disposable
worktree, no writes to the shared checkout): reconciling ALL 148 real operations at once (a
synthetic module built from every real `operationId`, so every operation reconciles as `matched`)
produced `parameters_copied: 55`, `parameters_unresolved: 0`, `security_copied: 137`,
`security_public: 11`, `security_unresolved: 0`, `summary_copied: 148`, `tags_copied: 148`,
`sourceSecuritySchemes: {bearerAuth}` -- exactly the coverage table above, zero unresolved anywhere,
confirming both the `default` fix and the whole passthrough mechanism end to end against real data,
not only against synthetic fixtures. Exported documents for all 9 real modules with an HTTP surface
(`organization`/`member`/`curriculum`/`academicoperations`/`notification`/`projectexecution`/
`reporting`/`usagemetering`/`analytics`, 104 real operations total), plus a fully-synthetic
full-passthrough fixture, all validate against the vendored official 3.1 meta-schema AND against
`schemas/feature-contract.schema.json` -- re-run a second time, at wider scope, in a disposable copy
of the oracle repo (never the shared checkout itself) after the first, narrower 3-module pass.

**COST**: larger contracts (~234 bytes/operation measured across 9 real modules, not the ~130
originally estimated -- see the finding above). A real `sbf_contract` bump with a real read-time consequence for the first
time (mitigated by the friendly re-emit message, not eliminated -- any OTHER tool reading the
contract file directly, outside `bskel` itself, still needs to handle the version change). Two new
WARN codes whose non-ERROR severity means an operation can silently lose its query parameters or
its security requirement in an export with only a warning, never a hard failure -- the same
trade-off A2/A3 already accepted for schema projection, extended here. An export that is now much
easier to mistake for the real source document -- mitigated by disclosure (`x-bskel-omitted`, the
mixed-coverage stderr note) and the harder-to-disarm guard, not made impossible; a consumer who
reads one operation's `security` and generalizes to the rest of the document will be wrong exactly
in the mixed-coverage case the disclosure exists to flag. The standing, permanent asymmetry that
`security` is now sometimes present and sometimes absent on operations of the SAME exported
document is itself a new kind of thing to misread, where A6's original all-or-nothing omission
could not be.

**EXIT**: `contracts/openapi.mjs`'s `copyParameter()`/`applyParameters()`/`applySecurity()` are the
single place to widen what may be copied later (e.g. teaching `content`-keyed parameters, or
`components.parameters` `$ref` resolution, once a real need is measured). `contracts/export.mjs`'s
`STRUCTURAL_OMISSIONS`/`OMISSION_PROSE`/`collectOmissions()` remain the single place a disclosure
lives, extended, not replaced. Phase 2 (per-status responses, non-JSON media types, operation
`description`) is the named next slice -- do not build it as part of any future A7 follow-up without
naming it A8 or later, the same "confirm no existing work claims this before writing code" discipline
this item's own WHY used when confirming A7 itself was unclaimed. Replacing the contract's
path-parameter heuristic with copied source path parameters (closing the real, disclosed
`batchRequestId` false-negative) is a separate, already-scoped future item, not silently folded into
a later A7 update. Turning copied `security` into generated authorization code is EXCLUDED
permanently, not deferred -- see EXCLUDED above; a future item that wants to do this must argue past
this item's own stated reasoning, not merely cite that `security` is now present in the contract.

Cross-references: `D-openapi-export` (A6, the export mechanism this item extends field-by-field, the
`security: []`-is-spec-legal-but-untruthful finding this item's own security handling generalizes,
the self-import guard this item hardens, and the round-trip invariant this item extends with one new
disclosed asymmetry); `D-openapi-reconciliation` (A1, the `indexOpenApiDocument()`/`byOperationId`/
`byRoute` machinery this item's `applyPassthrough()` reuses unchanged, and the "describe the method,
not an unchecked fact about the repo" omission-prose discipline this item's rewritten `security`/
`summaries` prose follows); `D-openapi-request-schema` (A2, `inlineSchema()`'s keyword-whitelist
structure `copyParameter()` mirrors one level up, and the `format:'uuid'` rewrite this item's own
parameter-schema resolution inherits unchanged); `D-openapi-response-schema` (A3, the two-separate-
codes-not-one-shared reasoning this item's `CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED`/
`CONTRACT_OPENAPI_SECURITY_UNRESOLVED` split follows exactly); `D-contract-completeness` (A5, the
`{code, subject}` waiver-key discipline both new WARN codes respect, and the three-way completeness
verdict the mixed-passthrough-coverage disclosure reads through the gate); `D-persistence-integrity`
(S5, the `loadContract()` schema-validation-on-read this item's `sbf_contract` bump has a real
consequence against for the first time); `D-gate-precision` (S2, the `contract` gate's real 4-key
token set -- `scan_report_hash`, not `head_sha` -- this item's own preceding plan mis-cited, verified
directly against `lib/gate-definitions.mjs` before writing this section); `D-security-1`/
`D-security-2` (the prototype-pollution and bare-UUID-pattern classes this item inherits unchanged,
including in the new `securitySchemes` Map and parameter-name handling).

## D-openapi-per-status (A8): additive, not a second union -- per-status responses and non-JSON request media types

**WHY:** A7's own EXIT clause named this the next slice and said to number it A8, not fold it into
"A7 Phase 2" -- followed here. A7 copied query/header/cookie parameters, `security`, `summary`, and
`tags` from a real `--openapi-file` source document, but two real gaps remained structural (always
omitted, for every contract): per-status responses (A3's `responseSchema`/`errorSchema` collapse
every documented `2xx`/`4xx`/`5xx` body into two `anyOf` unions and record no real status codes at
all) and non-JSON request media types (a `multipart/form-data` body is entirely invisible -- the
contract only ever knows `application/json`). Both are real, measured gaps: on the real
Team-IZ-Backend oracle (148 operations, re-measured fresh for this item, not carried over from A7's
own numbers), 694 response-status entries exist across those operations (4.69/operation, max 9),
and 5 real operations declare a `multipart/form-data` request body invisible to A2's
`requestBodySchema`.

**The central design question, resolved by reading the real code rather than guessing: additive,
never replacing the union.** `contracts/validate.mjs`'s entire response/error path is nine lines --
`direction === 'response' ? opContract.responseSchema : opContract.errorSchema`, wrapped in an
envelope with no status-code field at all (`schemas/agent-envelope.schema.json` has never had one).
Three facts made "replace the union with per-status data" strictly worse, not merely more work: (1)
the envelope genuinely has nowhere to put a status code, so a per-status-only representation would
give `contracts/validate.mjs` a map and no key to look it up with; (2) the only way to make replace
work would be moving A3's `canonicalJson` dedup, `anyOf`-never-`oneOf` choice, and
fail-closed-on-first-unresolvable rule out of `contracts/openapi.mjs` (pure, already tested) into
`contracts/validate.mjs` (which today contains zero projection logic and compiles an Ajv schema per
call) -- re-deriving at read time a decision this codebase already makes once, at emit time; (3) the
decisive measurement: 0/148 real operations have more than one distinct 2xx schema, and 0/148 have
more than one distinct 4xx/5xx/default schema. Every union in the real oracle has exactly one
source. Per-status data therefore carries **zero additional schema information** on real data --
replacing two ~1,883-byte union fields with a per-status structure encoding the identical shapes at
each of their real status keys would cost roughly double the bytes to say the same thing twice.
**`contracts/validate.mjs` is untouched by this item -- verified by diff, not merely intended.**

**`sourceResponses`, keyed by the source document's own literal status key (a literal code, a range
key, or `default`) -- never re-bucketed.** Each entry carries at most one body descriptor:
`schemaFrom: "response"|"error"` (this status's JSON body is canonically identical to the
operation's already-stored `responseSchema`/`errorSchema` -- **provable, not guessed**: A3's own
`projectResponseSchemas()` already deduplicated every status in its bucket down to `sources`
distinct resolved shapes, so if `sources === 1`, every status in that bucket with a JSON schema
resolved to that one shape by construction; this function only has to point at it), `schema` (an
inline, individually-resolved shape, for the rare `sources > 1` case -- never observed on real
data -- or a status outside both buckets, e.g. a `1xx`/`3xx` key), `mediaTypes` (a non-JSON
response's media type NAMES, disclosed, its shape never projected -- 0/674 real occurrences), or
none of the three (no body declared, e.g. a bare `204`). **Measured: 674/674 real status entries
with a JSON schema take the `schemaFrom` branch; zero ever needed individual resolution.** That is
what keeps this item's real cost additive rather than duplicative.

**Fail-closed invariant that makes the `schemaFrom` shortcut sound, and keeps per-status coverage
honest:** `sourceResponses` is written for an operation only when BOTH of A3's own bucket outcomes
are `resolved` or `none` -- never `unresolved`. If either bucket failed to resolve, this silently
and correctly falls back to the pre-A8 union-only export path for that operation; the failure is
already recorded via A3's own `responseSchemaUnresolvedReason`/`errorSchemaUnresolvedReason`, and
nothing here duplicates it. **A direct, structural consequence, proven by tracing every reachable
resolution kind, not asserted:** every contract-resident operation that lacks a source entry
already carries an ERROR through an *existing* code (`CONTRACT_OPENAPI_DRIFT`/
`CONTRACT_OPENAPI_MISSING_OPERATION`/`CONTRACT_OPENAPI_AMBIGUOUS`/`CONTRACT_UNMATCHED_ENDPOINT`), so
a `complete` contract emitted with `--openapi-file` has **100% per-status coverage by
construction**. Mixed coverage (some operations per-status, some union-only) can therefore only
arise in an explicitly waived `partial` contract -- exactly the coverage this item's export-side
disclosure (below) exists to surface, never a silent gap in an otherwise-trusted contract.

**No new WARN code for per-status failure -- reasoned from the real code, not from symmetry with
A7's own two new codes.** Per-status failure is not independent of A3's existing failure: both walk
the exact same `responses` map through the exact same `inlineSchema()` at the exact same
`MAX_RESPONSES_PER_OPERATION` cap. Whatever makes a bucket `unresolved` already fires
`CONTRACT_OPENAPI_RESPONSE_SCHEMA_UNRESOLVED`/`CONTRACT_OPENAPI_ERROR_SCHEMA_UNRESOLVED` -- a third
code here would be a duplicate warning for one root cause, the exact "flood every contract with N
warnings for one cause" failure A2's own dialect-gate comment already refuses. **One new code IS
needed for the multipart side**, `CONTRACT_OPENAPI_REQUEST_MEDIA_TYPE_UNRESOLVED` (WARN, waivable):
a real operation can legally accept both `application/json` and `multipart/form-data`
simultaneously, so this failure genuinely is independent of A2's own `CONTRACT_OPENAPI_SCHEMA_UNRESOLVED`
(the JSON-body code) -- sharing one would let a waiver for one silently cover the other, the same
`{code, subject}`-key reasoning `D-openapi-response-schema` already established for its own
response/error split and A7 reused for parameters/security.

**`security: []`'s sharpest-case precedent, reapplied to `sourceRequestBody`: `content` here NEVER
contains `application/json`.** That stays A2's `requestBodySchema` field -- the one representation
of that one fact, enforced structurally (the copy loop explicitly excludes the JSON media type key)
and expressed as a schema invariant (`schemas/feature-contract.schema.json`'s `not: {required:
["application/json"]}`) rather than trusted to stay true by convention alone.

**A real, pre-existing disagreement this item makes newly visible, not one it invents:** the real
oracle's multipart handlers use `@RequestPart("file") MultipartFile file`, never `@RequestBody` --
`contracts/emit.mjs`'s `detectRequestBody()` greps only `/@RequestBody/`, so these operations carry
`body: false` from the scan alone. After this item, the export emits a copied `multipart/form-data`
body for an operation whose contract says `body: false`. This is NOT a new class of disagreement --
`contracts/export.mjs`'s `buildRequestBody()` already checked `op.requestBodySchema` *before*
`op.body` for the JSON case (an operation with `body: false` and a projected JSON schema already
exported a `requestBody`, and `test/contract.test.mjs` already pinned this), so this item extends a
shipped behavior rather than inventing one. Disclosed, not fixed here.

**A second real bug, found by running a multipart-only fixture through the exporter, not by
inspection: the pre-A8 `op.body === true` bare-JSON fallback would ALSO fire alongside a real
`sourceRequestBody`, emitting a self-contradicting document.** `buildRequestBody()`'s
`content: {'application/json': {}}` fallback exists for "the scan detected a body, its shape is
genuinely unknown" -- a real gap in information. But when `op.sourceRequestBody` is present,
reconciliation already positively determined this operation's real media type(s) from a source
document, and `application/json` was not among them. Applying the guess on top of that positive
fact produced `content: {'application/json': {}, 'multipart/form-data': {...}}` for an operation
whose real document declared multipart ONLY -- worse than the gap it was meant to extend, since it
actively claims an unconstrained JSON body the source document said does not exist. Fixed by
suppressing the bare-JSON fallback whenever `op.sourceRequestBody` carries real content, JSON or
not -- positive information from a real document always wins over the scan's own guess.

**A real round-trip hazard, found by executing the export -> re-import cycle, not by inspection,
and closed structurally:** OpenAPI 3.1 requires `description` on every Response Object. When the
source document had none, the exporter must synthesize a stand-in string to stay spec-valid --
but the FIRST implementation of this let that stand-in text round-trip back in as if it were real:
export a contract whose responses had no `description`, strip the self-import marker, re-import,
and the synthetic filler text came back as a genuine copied `description`, breaking A6's own
"export -> re-import reproduces operations exactly" invariant for a `contract-field`, not merely a
`stats`, difference (reproduced directly with the fixture `widgetOpenApiDoc({withResponses:true})`
before the fix: `after.warnings` carried 14 entries where `before.warnings` had 0). **Pre-A8's two
equivalent union-path stand-ins (`SUCCESS_RESPONSE_DESCRIPTION`/`ERROR_RESPONSE_DESCRIPTION`) never
had this problem** -- nothing on the import side ever reads a response object's `description`, only
its `content` schema; this item is the first field to read `description` back in at all, which is
what introduced the hazard. Fixed the same way `BSKEL_GENERATED_EXTENSION`/
`BSKEL_PASSTHROUGH_EXTENSION` close the self-import hole: a shared constant
(`PER_STATUS_NO_DESCRIPTION_STANDIN`), declared on the reading side so writer and reader cannot
drift apart, and `applyPerStatusResponses()` explicitly refuses to copy a `description` that
matches it byte-for-byte. Re-verified after the fix: the same round trip now reproduces
`after.warnings === []` and `after.operations` byte-identical to `before.operations`.

**The self-import guard needed a real widening, not a "probably fine" assumption.**
`contracts/export.mjs`'s `hasPassthrough` (which decides whether an operation gets the
`x-bskel-passthrough` per-operation marker) checked exactly A7's four fields. An operation whose
ONLY copied content is per-status responses or a multipart body -- no source parameters, no
security, no summary, no tags -- got NO marker under the pre-A8 code, silently reopening the exact
hole A7 closed for that one operation: stripping only `info.x-bskel-generated` would again be
sufficient to disarm the guard, for that operation. Never arises on the real oracle (148/148
operations already carry `summary`+`tags`+`security`), but is structurally reachable from a
minimal hand-written document declaring only `responses` -- fixed by adding both new fields to
`hasPassthrough`'s OR chain; `contracts/openapi.mjs`'s `hasBskelExportMarker()` needed no change
(it already returns true on any operation-level marker, generically).

**`literalStatusStandIn` needed a real fix, not a redundant flag check.** The pre-A8 computation
(`statusCodes === 'literal' && ops.some(op => Boolean(op.responseSchema))`) would have printed
"`200` is a bskel-chosen stand-in" for a document where every `200` is a real, copied status key --
false, and misleading. Fixed to exclude any operation that took the per-status path: `... &&
ops.some(op => op.responseSchema && !hasPerStatus)`. `renderDescription()`'s status-codes paragraph
gained a third variant, computed from the contract's own content (never guessed): none of an
export's response/error-bearing operations carry per-status data (the pre-A8 wording, unchanged),
all of them do (a new sentence stating plainly that every status code here is a copied fact), or a
mix (names the count on each side and points at `info.x-bskel-generated.passthrough` for which is
which).

**`collectOmissions()` restructured, following the exact ANY-based doctrine A7 already established
for its own four fields.** `per-status-responses` and `non-json-media-types` (renamed
`non-json-request-media-types`, since the response side gets its own, separately-tracked entry)
move out of the always-on `STRUCTURAL_OMISSIONS` list into the derived set -- present only when at
least one exported operation genuinely lacks the field. **Proven derived, not merely renamed, by a
real test**: a fixture where every operation documents a resolvable `200` and `400` shows
`per-status-responses` genuinely ABSENT from its omission list -- the case that would be impossible
if the list were still a fixed disclaimer. Two new genuinely-structural entries join
`STRUCTURAL_OMISSIONS`: `non-json-response-schemas` (a non-JSON response media type's NAME is
disclosed via a per-status entry's `mediaTypes`, but its SHAPE is never projected -- 0/674 real
occurrences, so building that machinery would violate this project's own "don't build for zero real
cases" discipline) and `response-headers` (a per-status response's `headers`/`links` -- 0/694 real
occurrences, a gap only genuinely visible now that per-status responses otherwise look complete).
`descriptions`' own prose was rewritten from "not yet built" to state the real measured reason it
stays excluded (below).

**Operation-level `description`, the third field A7's EXIT clause named for this slice, deferred
again -- with a measured reason, not a repeated deferral.** Real average 2,442.7 bytes/operation
(max 13,758 bytes; the largest is a full Markdown API design document embedded in the OpenAPI
document, not a caption). That is larger than every other field this item copies, combined, and
roughly 1.3x the ENTIRE existing A3 schema-projection payload. If this is ever built, it must ship
opt-in behind a flag -- unlike every other field this project's OpenAPI-passthrough items (A7, this
one) have shipped default-on, because none of them came close to this cost. Recorded here as a
measured, deliberate scope narrowing relative to A7's own EXIT text, not a silent drop.

**COST:** ~576 bytes/operation across the real oracle's 9 modules with an HTTP surface (measured
directly, not estimated) -- a real, if modest, contract-size increase (roughly +24% on the
cumulative per-operation OpenAPI-derived payload, A2 through this item). `sbf_contract` bumped
`"5"` -> `"6"`, with a real read-time consequence (S5's `loadContract()` validates on read) --
mitigated, cheaply this time, by the friendly re-emit pre-check A7 already built (needed zero new
code; only its two regression tests' expected version strings needed re-pointing). Two new WARN
codes (well, one new -- see above) whose non-ERROR severity means an operation can silently lose a
multipart media type's shape with only a warning, not a block. An exported document carrying real
per-status data with real (often non-English) descriptions is measurably closer to indistinguishable
from the source oracle than A7's own export already was -- mitigated by the widened self-import
guard, not eliminated. The standing A7 asymmetry (fields present for some operations, absent for
others in a waived-`partial` contract) now also applies to per-status responses and request media
types.

**EXIT:** `contracts/openapi.mjs`'s `applyPerStatusResponses()`/`applyRequestMediaTypes()` are the
single place to widen what per-status/media-type data may be copied later (e.g. response
`headers`/`links`, should a real document ever need them). `contracts/export.mjs`'s
`STRUCTURAL_OMISSIONS`/`OMISSION_PROSE`/`collectOmissions()` remain the single place a disclosure
lives. Operation-level `description` is the next, explicitly-scoped-out slice, and must ship behind
a flag given its measured cost. Replacing the contract's path-parameter heuristic with copied
source path parameters (the `batchRequestId` finding, A7) and constraining envelope payloads with
copied query parameters remain separate, untouched future items. Turning a copied `security`
requirement into generated authorization code remains permanently excluded, unchanged from A7.
OpenAPI 3.0 output remains unchanged from A6's three cited blockers.

Cross-references: `D-openapi-passthrough` (A7, the mechanism this item extends -- the exact
matched/adopted-only `applyPassthrough()` call sites, the `source*` field-naming convention, the
`BSKEL_PASSTHROUGH_EXTENSION` self-import-guard marker this item widens, and the ANY-based
`collectOmissions()` doctrine this item's own two moved entries follow); `D-openapi-response-schema`
(A3, the `responseSchema`/`errorSchema` union and `projectResponseSchemas()` machinery this item is
strictly additive to, and the two-separate-codes reasoning this item deliberately does NOT apply to
per-status failure, reusing A3's own codes instead); `D-openapi-export` (A6, the exporter this
item's `buildResponses()`/`buildRequestBody()` extend, the `security: []`-is-spec-legal-but-
untruthful precedent this item's `content` invariant reapplies, and the round-trip invariant this
item both threatened and re-closed); `D-openapi-request-schema` (A2, `inlineSchema()` reused
unchanged for every schema this item resolves, and the `body:false`-with-a-projected-schema
precedent this item's multipart handling extends); `D-security-1`/`D-security-2` (the
prototype-pollution class `RESPONSE_STATUS_KEY_RE`/`MEDIA_TYPE_RE` guard against, structurally
mirroring `OPERATION_ID_RE`/`COMPONENT_SCHEMA_NAME_RE`); `D-persistence-integrity` (S5, the
`loadContract()` schema-validation-on-read this item's `sbf_contract` bump has a consequence
against, mitigated by the already-institutionalized friendly pre-check).

**FOLLOW-UP (independent Codex review of the merged commit, two real findings, both fixed):** the
merged A8 diff was handed to an independent Codex review with no fix authority -- read-only,
report-only. Three claimed invariants (the `validate.mjs`-untouched design, the fail-closed
100%-coverage gate, and the three self-found bugs already documented above) were each independently
re-derived from the diff and CONFIRMED. The review also surfaced two real gaps, both closed in a
direct follow-up commit (same "detect and honestly fix, never guess" posture as the three bugs
above -- these two were not caught during the original implementation because nothing in the test
suite exercised a hand-edited or `$ref`-shaped input for either path):

1. **`schemaFrom` was trusted, not re-checked, against its own status key.** The feature-contract
   schema's `enum` on `schemaFrom` only constrains the value to `"response"`/`"error"` -- it cannot
   express "and this must agree with the status key it sits under" (JSON Schema has no cross-property
   `propertyNames`-conditional mechanism for this). `contracts/export.mjs`'s
   `buildPerStatusResponses()` trusted the stored string outright. Real reconciliation output can
   never disagree (`applyPerStatusResponses()` in `contracts/openapi.mjs` only ever sets `'response'`
   under a `SUCCESS_STATUS_RE` key and `'error'` under an `ERROR_STATUS_RE`/`default` key), so this
   was purely a hand-edited-contract exposure -- but a real one, confirmed by a live probe: a
   `sourceResponses["400"].schemaFrom: "response"` document passed `feature-contract.schema.json`
   validation cleanly and exported the SUCCESS union's schema under HTTP 400. **Fixed** by exporting
   `SUCCESS_STATUS_RE`/`ERROR_STATUS_RE`/`DEFAULT_STATUS_KEY` from `contracts/openapi.mjs` and
   re-checking the status key's own class in `buildPerStatusResponses()` before trusting
   `schemaFrom` -- same S5/persistence-integrity "never trust the on-disk contract file" posture
   `RESPONSE_STATUS_KEY_RE`/`MEDIA_TYPE_RE` already follow in this same function. A mismatch now
   falls through to the entry's own inline `schema`/`mediaTypes`, or (as in the regression test) to
   a description-only entry with no `content` at all -- never the wrong union under the wrong status.

2. **A Response Object `$ref` was silently read as an empty entry.** OpenAPI 3.1 permits
   `components.responses.<Name>` + `$ref` in place of an inline Response Object (the vendored
   official meta-schema's `response-or-reference`), but `applyPerStatusResponses()` never checked for
   `resp.$ref` -- it fell through with `resp.description`/`resp.content` both `undefined`, which the
   exporter then filled with the synthetic `PER_STATUS_NO_DESCRIPTION_STANDIN`, falsely implying the
   source genuinely documented that status with no description. **Measured before deciding how to
   fix it** (this project's "don't build for zero real cases" discipline, already applied twice in
   A8 itself to `non-json-response-schemas`/`response-headers`): the real Team-IZ-Backend oracle has
   694 response objects across 148 operations and ZERO of them use `$ref`, and its document declares
   no `components.responses` section at all. Building a `components.responses` indexing/resolution
   subsystem (the same shape `componentSchemas` already gives schemas) to handle a 0-real-occurrence
   case would be exactly the over-building this project's own numerics discipline forbids. **Fixed**
   the honest, minimal way instead: `$ref`-shaped response entries are now explicitly skipped (not
   fabricated) in `applyPerStatusResponses()`, named as a permanent gap here rather than left as an
   accidental one. If a future real source document is found using `components.responses` `$ref`,
   resolving it is the natural next slice -- same shape as `componentSchemas`, gated the same way.

Both fixes are `contracts/openapi.mjs`/`contracts/export.mjs`-only; `contracts/validate.mjs` is
untouched by this follow-up too (`git diff --stat` confirms). Full suite: 930 → **932** (two new
regression tests, one per finding). No CATALOG.md/sbf_contract change -- both are within A8's
existing field shapes, not a new capability.

## D-openapi-path-params (A9): replacing a guess with a real answer, when one exists

**WHY:** A7's own implementation disclosed, but explicitly did not fix, a real, small false-negative:
`contracts/emit.mjs`'s `pathParamsSchema()` names every `{segment}` in a route by a pure heuristic
(`/id$/i` -> a bare-UUID `pattern`) with no awareness of the real source document, even when
`--openapi-file` was given. Against the real Team-IZ-Backend oracle this disagrees with reality on
exactly one of 130 real path parameters: `findTraineeRegistrationProgress`'s `batchRequestId` is a
plain string (`"trainee-batch-001"`-shaped) in the real document, but the heuristic pins it to a UUID
pattern -- meaning `contract validate` would reject a real, valid request today. A7's own EXIT
section named "replacing the contract's path-parameter heuristic with copied source path parameters"
as a separate future item, not silently folded in. This is that item, done directly at the user's
request (no agent delegation), following the exact scope A7 already named.

**THE FIX IS A REPLACEMENT, NOT AN ADDITIVE FIELD -- different in kind from A7/A8.** Every other
`source*` field this project has shipped (A7's `sourceParameters`/`sourceSecurity`/etc., A8's
`sourceResponses`/`sourceRequestBody`) sits ALONGSIDE an existing field, both present, contract
readers choosing which to trust. Path parameters are different: there is exactly one place
`contract validate` and `contract export` both read from (`pathParams`), and the bug is that its
VALUE is sometimes wrong. So this item corrects `pathParams` itself in place, per segment, rather
than adding a second, competing source of truth next to an unchanged, still-wrong one.

**Mechanism**: `contracts/openapi.mjs`'s new `applyPathParameterSchemas()` (called from
`applyPassthrough()`'s existing matched/adopted-only call sites -- no new call sites, same refusal
mechanism every A7/A8 field already relies on) resolves each `in: "path"` entry in the real
document's `parameters[]` through `inlineSchema()` (the same resolver every other schema-bearing
field in this file uses -- D-security-2's `format: 'uuid'` -> `BARE_UUID_PATTERN` rewrite is
therefore inherited for free, not reimplemented). Resolved schemas are stashed in a `Map<name,
schema>` on `result.pathParamSchemas` -- a Map, never a plain object, the same "sidestep prototype
pollution entirely rather than add a third whitelist regex" reasoning `componentSchemas`/
`securitySchemes` already established, since this is `--openapi-file`-sourced (untrusted) data keyed
by parameter NAME. `contracts/emit.mjs`'s `pathParamsSchema()` then prefers the source's schema for
any segment it can answer, falling back to the pre-existing heuristic per-segment for any it can't
(no source document, no schema declared for that name, or a schema that failed to resolve) --
`pathParamsHeuristic` (new, omitted when empty) names exactly which segments, if any, still rely on
the guess, giving `contracts/export.mjs`'s `collectOmissions()` a real per-operation signal instead
of an always-on disclaimer.

**`path-parameter-schemas` moves from STRUCTURAL to ANY-based derived**, the same migration A8 made
for `per-status-responses`/`non-json-request-media-types`: it used to be unconditionally true ("path
params are ALWAYS heuristic, never source-backed"), and after this item that claim is simply false
whenever a source document answers a segment -- so the omission is now present only for an operation
where `pathParamsHeuristic` is non-empty, derived from the contract's own content like every other
ANY-based entry, never hardcoded.

**A real round-trip finding, understood and accepted rather than "fixed" with more machinery**: both
existing round-trip tests broke on this item, and not from a mistake -- `contracts/export.mjs`'s
`buildPathParameters()` faithfully re-exports a heuristic-derived `pathParams` schema as a real
Parameter Object with a real `schema`. Re-importing that export (self-import-guard markers stripped,
simulating a genuinely independent document, exactly what those tests already do) means
`applyPathParameterSchemas()` correctly finds a resolvable schema and treats it as source-confirmed
-- so `pathParamsHeuristic` can legitimately shrink or disappear across one round trip, even though
the underlying schema VALUE (and therefore `contract validate`'s actual pass/fail behavior) is
byte-identical before and after. This is not a bug: the self-import guard is the ONLY mechanism this
project uses to distinguish "genuinely independent" from "our own export" (D-openapi-export), and
once its markers are gone, by this project's own established design there is no other signal left to
withhold trust on -- an independent document that happens to declare the exact schema our heuristic
already guessed IS legitimate confirmation, the same as any other independent document would be. This
is the same class of finding the existing round-trip tests already document for `format: 'uuid'`
rewriting and multi-shape `anyOf` collapsing ("convergence after one step, not identity with some
hypothetical upstream document") -- a third instance of the same, already-understood phenomenon, not
a new one. Both tests were updated (`withoutPathParamsHeuristic()`), not weakened elsewhere.

**No new WARN code.** A path segment whose source schema fails to resolve simply falls back to the
heuristic -- the exact same behavior as before this item, not a new failure mode, so (matching A8's
own reasoning for reusing A3's response/error codes) nothing new needs to fire.

`sbf_contract` bumped `"6"` -> `"7"` for the new `pathParamsHeuristic` field (the operation schema's
`additionalProperties: false` requires it to be explicitly whitelisted, same as every prior field).
`contracts/validate.mjs`, `lib/gate-definitions.mjs`, `lib/verify.mjs`, and `.github/workflows/ci.yml`
are all untouched (`git diff --stat` confirms) -- this item makes `contract validate`'s INPUT more
accurate without changing its logic at all, which is the entire point: the real
`batchRequestId`-shaped request that was wrongly rejected before is accepted now, with zero code
changed in the function that rejected it.

**Verified against the real 148-operation Team-IZ-Backend oracle** (a synthetic all-148-operations
module, every operation reconciling as `matched`, same technique A7/A8 both used): 107 of 148
operations carry at least one path parameter, and **all 107 resolve every one of their path
parameters from the real source document** (`path_params_copied: 107`, `path_params_unresolved: 0`,
zero names still falling back to the heuristic) -- including `batchRequestId` itself, confirming the
exact finding this item set out to fix. `problemNo` (a real path parameter name that does NOT end in
"Id", so the old heuristic would have guessed `{type:'string'}` with no pattern anyway) resolves from
source too, same as every other name -- real data wins regardless of whether the heuristic would
have happened to guess right or wrong for that particular name.

**EXIT**: constraining envelope payloads with copied query parameters (named alongside this item in
A7's own EXIT) remains a separate, untouched future item. Should a future real source document ever
use `components.parameters` + `$ref` for a path parameter (0 real occurrences observed, same
"don't build for zero real cases" reasoning A8 applied to `components.responses` $ref), resolving it
is the natural next slice -- `copyParameter()`'s existing `ref-parameter` refusal already fails this
case closed, consistent with every other unresolved-schema fallback in this item.

Cross-references: `D-openapi-passthrough` (A7, the `batchRequestId` finding this item fixes, first
disclosed there; the `applyPassthrough()` call-site placement this item's own call reuses
unchanged); `D-openapi-per-status` (A8, the STRUCTURAL-to-ANY-based omission migration pattern this
item reapplies, and the `hasSourceMediaTypeInfo`-style "positive information overrides a guess"
principle this item applies to path-param type instead of request media type); `D-openapi-export`
(A6, the self-import guard whose markers are the ONLY signal this item's round-trip finding turns
on); `D-security-2` (the `format: 'uuid'` -> `BARE_UUID_PATTERN` rewrite this item inherits for free
through `inlineSchema()`, and the "convergence after one step" round-trip framing this item's own
finding extends); `D-security-1` (the prototype-pollution class `Map`-based `pathParamSchemas`
sidesteps entirely, the same reasoning `componentSchemas`/`securitySchemes` already established).

## D-openapi-description (A10): the one source-backed field that stays opt-in

**WHY:** A7 and A8 each deferred operation-level `description` with the exact same measured
reason: real average 2,442.7 bytes/operation across the Team-IZ-Backend oracle, larger than every
other field this whole passthrough effort copies combined -- both explicitly said "if ever built,
must be opt-in behind a flag, unlike everything else this project's OpenAPI-passthrough work has
shipped default-on." This item builds it, on that exact term. User-directed ("operation-level
description... 진행하자"), following the design A7/A8 already committed to rather than inventing a
new one.

**Different from A7/A8/A9 in one respect: opt-in, not default-on.** Every other source-backed field
in this project activates automatically whenever `--openapi-file` is given -- the measured cost of
each was small enough that gating it behind a flag would only add friction for no real protection
(A7's own stated reasoning). Description breaks that pattern on cost alone, so `contract emit
--descriptions` is required in addition to `--openapi-file` -- refused with a `BAD_ARGS` error if
passed without it (`--descriptions only applies when reconciling against a real OpenAPI document`),
the exact same "would be a silent no-op otherwise" refusal `--path-prefix` already needed (Phase 3
dogfooding finding, `cad53c1`).

**Mechanism**: `indexOpenApiDocument()` retains raw `description` per entry (same "no size cap at
index time" posture as every other raw field -- the cap applies at the point of copying, not
indexing). New `applyDescription()` (called from `applyPassthrough()`'s existing matched/adopted-
only call sites -- no new call sites, same refusal mechanism every A7/A8/A9 field already relies
on) is a no-op unless `includeDescriptions` is true, threaded as a new parameter through
`reconcileModule()`/`buildReconciliation()` from `cmdContractEmit`'s own `--descriptions` flag.
Copied verbatim -- unlike a schema, there is no keyword whitelist to apply to a plain string, only
a length gate: `MAX_DESCRIPTION_LENGTH` (40,000, `.length` i.e. UTF-16 code units, same measure
`MAX_PATTERN_LENGTH` already uses) fails a too-long description closed with a new,
independent WARN code (`CONTRACT_OPENAPI_DESCRIPTION_UNRESOLVED` -- nothing else tracks description
length, so this cannot reuse an existing code, the same reasoning A8 used to justify its own new
multipart code instead of overloading `CONTRACT_OPENAPI_SCHEMA_UNRESOLVED`). The cap protects
gate-token hashing / contract-file size against a malformed or hostile `--openapi-file`, the same
defensive-cap class as D-security-1/D-security-2 that every other unbounded-size field in
`contracts/openapi.mjs` already defends against -- not a concern for a normal document (real max
observed: 9,083 `.length`, ~4.4x headroom to the cap).

**`descriptions` splits into two entries, one moves, one stays.** The old single structural
omission entry conflated two genuinely different gaps: field-level `description`/`title`/`example`
(dropped as `DROPPED_KEYWORDS` while inlining ANY schema -- request bodies, responses, parameters)
and operation-level `description`. This item only touches the second. `field-descriptions` (the
first) stays permanently structural -- no plan to build per-FIELD copying, a genuinely different
and much larger scope. `operation-descriptions` moves to the ANY-based derived set, the same
migration A8 made for `per-status-responses`/`non-json-request-media-types` and A9 made for
`path-parameter-schemas`: present whenever at least one exported operation lacks
`sourceDescription` -- which is EVERY operation whenever `--descriptions` was not passed at all
(the common case), so the omission fires unconditionally until the flag is used, same as how
`security`/`summary` read before A7 shipped.

**Verified against the real 148-operation Team-IZ-Backend oracle** (`reconcileModule()` called
directly with a synthetic all-148-operations module, `includeDescriptions: true`): **146/148
operations have their real description copied verbatim** (`description_copied: 146`), 2 genuinely
have none in the source (`description_none: 2`), zero exceed the length cap
(`description_unresolved: 0`) -- re-confirming the real max (9,083) sits comfortably under the
40,000 cap. With the flag held at its default `false` against the identical document: `0` copied,
`148` skipped via the flag gate -- confirming the opt-in default has zero effect until explicitly
requested, the regression check this item's whole design rests on.

**No round-trip hazard, unlike A8/A9.** A plain string has nothing analogous to A8's synthesized-
stand-in problem (no spec-required placeholder is ever invented for a missing `description` --
absent is legal, the key is simply omitted) or A9's heuristic-becomes-confirmed convergence (there
is no heuristic for description at all -- it is either real and copied, or absent). Exporting and
re-importing a `sourceDescription` is a straightforward byte-identical round trip.

`sbf_contract` bumped `"7"` -> `"8"` for the new `sourceDescription` field (the operation schema's
`additionalProperties: false` requires it to be explicitly whitelisted, same as every prior field).
`contracts/validate.mjs`, `lib/gate-definitions.mjs`, `lib/verify.mjs`, and
`.github/workflows/ci.yml` are all untouched (`git diff --stat` confirms) -- `sourceDescription` is
purely an export-time/disclosure field, `contract validate` never reads it, matching A8's own
`sourceResponses`/`sourceRequestBody` precedent exactly.

**EXIT** (superseded by A11, D-openapi-field-docs): field-level `description`/`example` copying is
now built -- see D-openapi-field-docs below. `title`, plural `examples`, `externalDocs`, `xml`, and
`deprecated` remain unbuilt and unscoped (0 real occurrences of any of the five, measured against
the Team-IZ-Backend oracle), named there as the permanent, deliberate remainder of this gap.

Cross-references: `D-openapi-passthrough` (A7, the exact deferral this item builds on, and the
`--path-prefix`-would-be-a-silent-no-op precedent `--descriptions` reuses); `D-openapi-per-status`
(A8, both the STRUCTURAL-to-ANY-based omission migration and the "one genuinely independent failure
needs its own new WARN code" reasoning this item follows); `D-openapi-path-params` (A9, the most
recent sibling item, same `applyPassthrough()` call-site placement); `D-openapi-export` (A6, the
`MAX_PATTERN_LENGTH`-style defensive-cap precedent this item's `MAX_DESCRIPTION_LENGTH` follows);
`D-openapi-field-docs` (A11, which extends this item's own `--descriptions` flag one level deeper).

## D-openapi-field-docs (A11): the same flag, one level deeper -- schema FIELD-level description/example

**WHY:** A10 closed operation-level `description` but explicitly left `field-descriptions` (schema
FIELD-level `description`/`title`/`example`, dropped as `contracts/openapi.mjs`'s
`DROPPED_KEYWORDS` while inlining ANY schema) as a named, permanent-looking gap. User asked how big
that gap actually was ("field-level description... 영구 구조적, 계획 없음?"); measuring first
(this project's own Data-First Numerics discipline) rather than guessing showed it was neither
uniformly real nor uniformly noise: `title`/plural `examples`/`externalDocs`/`xml`/`deprecated` each
have **0 real occurrences** against the Team-IZ-Backend oracle (a from-scratch walk of every schema
node in the 148-operation document), while `description` and `example` are both real and
substantial. A haiku sub-agent independently sampled real `example` values (including two that
looked suspicious in isolation -- a bare `409` and a bare `300`) and confirmed both are genuine,
correctly-typed documentation (an HTTP status code and a retry-after-seconds value respectively),
not noise -- the finding that justified building `example` alongside `description` rather than
`description` alone.

**What stays permanently unbuilt, and why**: `title`, plural `examples`, `externalDocs`, `xml`,
`deprecated` -- zero real occurrences each, so building copy machinery for them would violate this
project's own "don't build for zero real cases" discipline (the same discipline that already keeps
`non-json-response-schemas`/`response-headers` structural in `contracts/export.mjs`). These five
keep being unconditionally dropped inside `inlineSchema()`, in a renamed set: `DROPPED_KEYWORDS`
still holds exactly these five (down from the pre-A11 seven); `description`/`example` move to a new
`DOCUMENTATION_KEYWORDS` set that `inlineSchema()`'s caller can opt into.

**Mechanism: reuses A10's own `--descriptions` flag, does not add a second one.** The flag already
means "copy source-authored documentation prose when it exists"; field-level `description`/
`example` is the identical policy one schema level deeper, not a distinct feature that needs its
own opt-in. `inlineSchema(node, componentSchemas, opts)` gains `opts.includeFieldDocs` (default
`false`, preserving every prior call's byte-for-byte behavior with no argument change); its
existing keyword-walk loop gains one new branch: when `DOCUMENTATION_KEYWORDS.has(key)` and the
flag is off, `continue` (silently dropped, identical to `DROPPED_KEYWORDS`'s own branch); when on,
`description` is copied verbatim if it is a string under `MAX_DESCRIPTION_LENGTH` (**reusing A10's
existing 40,000 constant** -- real field-level max observed 3,148 bytes, no new constant needed),
and `example` is copied verbatim (any JSON type -- it is not string-only, per the real 409/300
findings above) if `JSON.stringify(value).length` is under a new `MAX_EXAMPLE_LENGTH = 2000` (real
max observed 70 serialized bytes, ~28x headroom). `reconcileModule()`'s existing `includeDescriptions`
parameter is threaded through as `includeFieldDocs` into every one of `contracts/openapi.mjs`'s six
`inlineSchema()` call sites: `applyRequestBodySchema`, `projectResponseSchemas` (called from both
`applyResponseSchemas`'s response and error branches), `copyParameter` (via `applyParameters`),
`applyPerStatusResponses`, `applyRequestMediaTypes`, and `applyPathParameterSchemas` -- the same
"one flag, every schema-bearing call site" shape A2's own `inlineSchema()` already established, not
a special case for any one of them.

**A too-long field-level description/example is silently dropped, with NO new WARN code and NO
stats counter -- deliberately different from A10's own operation-level handling.** Three reasons,
stated rather than assumed: (a) dropping one annotation never affects validation correctness, unlike
a genuinely unresolvable schema; (b) a single schema can carry dozens of documentable fields, so a
per-field WARN would be unusably noisy compared to A10's one-per-operation signal; (c) this path
never actually fires on real data (the real max is well under both caps) -- it exists purely as a
defensive bound against a hostile or malformed `--openapi-file`, the same D-security-1/D-security-2
class of concern every other unbounded-size field in this module already defends against, not a
condition this project expects to observe.

**A `$ref` sibling of `description`/`example` is tolerated, not merged -- unlike A7's own `default`
precedent.** `walkSchemaNode()`'s `ref-with-siblings` tolerance check already special-cased
`default` (A7: real, 9 occurrences, merged onto the resolved component schema) and unconditionally
tolerated `DROPPED_KEYWORDS` members as harmless siblings. This item adds `DOCUMENTATION_KEYWORDS`
to that same tolerance list -- a `$ref` alongside a sibling `description`/`example` no longer fails
`ref-with-siblings` -- but, unlike `default`, does NOT merge the value onto the resolved schema:
measured **0 real occurrences** of this exact combination (a `$ref` node carrying a sibling
`description` or `example`) against the oracle, so no merge semantics were built for a case that
does not exist, only tolerance for the shape itself (consistent with the zero-occurrence discipline
above -- tolerating an empty case costs nothing; building merge logic for it would be speculative).

**Verified against the real 148-operation Team-IZ-Backend oracle** (`reconcileModule()` called
directly with a synthetic all-148-operations module, same technique A9/A10 used): with
`includeDescriptions: true`, every one of the 148 operations carries at least one field-level
`description` or `example` somewhere in its request/response/error/parameter/per-status/path-param
schemas (recursive walk, correctly distinguishing a genuine annotation -- a string `description`
sibling of `type` -- from a same-named DOMAIN FIELD, e.g. `findConceptCandidates`'s own real
business property literally called `description`, which appears as `properties.description =
{type:[...]}`, an object, never a string, and so is never miscounted). With the flag held at its
default `false` against the identical document: **zero** field-level `description`/`example`
appear anywhere in any schema -- confirming the opt-in default has zero effect until explicitly
requested, the same regression check A10's own design rests on.

**The theoretical A3 dedup/sources-count interaction does not fire on real data.** A3's
`projectResponseSchemas()` deduplicates resolved schemas by canonical JSON to compute
`responseSchemaSources`/`errorSchemaSources`, which gates A8's `schemaFrom` shortcut eligibility at
`sources===1`; enabling field docs could in principle make two previously-identical-looking schemas
become distinct (differing only in field-level `description`/`example`), inflating `sources` and
changing which operations get the `schemaFrom` shortcut. Measured directly: running the full
148-operation reconciliation with the flag on and off and diffing every operation's
`responseSchemaSources`/`errorSchemaSources`/`schemaFrom` choice produces **zero** differences --
the oracle's actual response/error component schemas are either genuinely shared (and their field
docs, being on the shared component, stay identical across every operation that references them) or
already distinct for other reasons. Documented as a self-consistent, real, but currently-inert
possibility rather than either ignored or defended against with unneeded code.

**Export-side disclosure**: `field-descriptions` is repurposed (same name, new ANY-based meaning,
the identical migration pattern A10 used for `operation-descriptions`) rather than left permanently
structural -- present in `info.x-bskel-omitted` whenever at least one operation's projected
request-body/response/error schema (or the absence of any of the three) carries no field-level
annotation, absent only when every schema-bearing operation carries at least one. A new,
narrower structural entry, `field-metadata`, takes over describing the five permanently-dropped
keywords. Not tracked separately: field docs inside per-status responses, non-JSON request media
types, or path-parameter schemas -- those may carry them when the flag is on, but `collectOmissions()`
only walks `requestBodySchema`/`responseSchema`/`errorSchema` (where real field docs are
overwhelmingly concentrated -- ~98% of `description` occurrences sit in response schemas), a
named, narrower scope rather than a silent gap.

`sbf_contract` is **not** bumped, and `schemas/feature-contract.schema.json` is **unchanged** --
unlike A7/A8/A9/A10, this item adds no new top-level operation field. `description`/`example` live
INSIDE already-permitted `{"type": "object"}` schema blobs (`requestBodySchema`, `responseSchema`,
etc.), which carry no nested schema-of-schemas validation, so there is nothing new for the contract
meta-schema to whitelist. `contracts/validate.mjs`, `lib/gate-definitions.mjs`, `lib/verify.mjs`,
and `.github/workflows/ci.yml` are all untouched (`git diff --stat` confirms) -- same reasoning as
every prior passthrough-only slice. `bin/bskel.mjs`/`lib/cli.mjs` are also untouched: `--descriptions`
already flows end-to-end from the CLI to `reconcileModule()` since A10, so this item needed no new
flag plumbing at any layer above `contracts/openapi.mjs` itself.

**EXIT**: the five permanently-dropped keywords (`title`, plural `examples`, `externalDocs`, `xml`,
`deprecated`) remain a genuine, named, zero-measured-occurrence gap -- not revisited unless a future
oracle measurement finds a real occurrence. Field docs inside per-status responses, non-JSON request
media type schemas, and path-parameter schemas are copied (the same `includeFieldDocs` flag reaches
all of them) but their presence is not separately reflected in `x-bskel-omitted`'s `field-descriptions`
entry -- a named, narrower disclosure gap, not a functional one.

Cross-references: `D-openapi-description` (A10, the exact `--descriptions` flag this item reuses,
and the STRUCTURAL-to-ANY-based `field-descriptions`/`operation-descriptions` split this item
continues one level further); `D-openapi-passthrough` (A7, the `default`-merge-onto-`$ref`
precedent this item deliberately does NOT extend to `description`/`example`, and why);
`D-openapi-per-status` (A8, the `schemaFrom`/`sources` dedup mechanism this item's own real-oracle
verification confirms is unaffected in practice); `D-openapi-export` (A6, the `MAX_PATTERN_LENGTH`-
style defensive-cap precedent `MAX_EXAMPLE_LENGTH` follows).

## D-contract-history: a read-only view over whatever git already recorded, not a new store

**WHY:** After the OpenAPI-passthrough line (A7-A11) shipped and the repo went public, the user
asked for an ROI-ranked backlog closing self-identified weaknesses and extending differentiators.
The initial verbal design for this item assumed `specs/<feature_id>/contracts/<feature_id>.schema.json`
(the emitted contract) is "already committed" in every target repo -- **wrong, checked before
building**: `.gitignore`'s own comment on `.sbf/` says plainly that `.sbf/`/`specs/` are ephemeral
per-repo state `bskel` writes into a TARGET repo, not this skill's own; whether a target repo
commits them is entirely that repo's own choice, outside `bskel`'s control or knowledge. The
shared test fixture (`test/_contract-fixture.mjs`'s `buildFixtureRepo()`) itself gitignores
`specs/` by default -- confirming this is the REALISTIC common case, not an edge case. The command
therefore has to treat "never committed" as a normal, expected outcome, not a failure.

**A second wrong assumption caught before building, not after**: the original design also planned
to cross-reference each git commit against `.sbf/<feature>.history.jsonl`'s gate-pass `token`s, to
mark which revisions correspond to a real `contract` gate PASS. That file is itself gitignored,
per-machine, ephemeral state (same `.gitignore` comment) -- a git commit is shared across clones
and machines, but the local `.sbf/` history is not, so there is no reliable 1:1 relationship
between "this commit" and "a gate pass recorded on THIS machine." Building that cross-reference
would have quietly conflated two orthogonal facts. Dropped entirely; `bskel gate export` (a later,
separate backlog item) is the correct tool for "what did this machine's gate history record" --
this item only ever answers "what does git itself say changed."

**Mechanism**: `lib/repo.mjs` (already the module for small git read-helpers -- `repoRoot()`,
`localDefaultBranch()`, `remoteTrackingTip()`) gains `fileHistory(cwd, relPath)` (git log
`--follow` for rename survival, reversed into oldest-first order for a forward-walking diff) and
`showFileAtRevision(cwd, sha, relPath)` (`git show <sha>:<path>`, a read of history, never the
working tree). Both return an empty/null result rather than throwing when the path has no history
at that point -- matching every other absence-is-normal posture in this module. New
`bskel contract history --feature <id> [--json]` (`cmdContractHistory` in `bin/bskel.mjs`, `contract
history` in `lib/cli.mjs`'s COMMANDS table) walks the revisions oldest-to-newest, parses each
revision's own JSON, and diffs `Object.keys(operations)` against the previous revision to report
`operations_added`/`operations_removed` per commit -- alongside that revision's own
`sbf_contract`/`completeness.status`/`completeness.operation_count`. A revision that fails to
parse (a pre-JSON-era commit, a hand-corrupted one) is marked `parse_error: true` for THAT
revision only, never failing the whole command -- the same per-item-not-whole-operation fail
posture `contracts/openapi.mjs` already uses throughout.

**Read-only, no gate interaction.** Unlike every `contract` subcommand that touches state
(`emit`/`waive`), `history` never calls `requireNamedGate`/`passNamedGate` -- it works regardless
of whether the `contract` gate currently passes, mirroring `bskel gate history`'s own posture (gate
history is inspectable independent of current gate state).

**Verified**: a hand-built git repo with 3 controlled revisions (`test/contract-history-cli.test.mjs`)
confirms the operations-added/removed diff is correct and chronologically ordered; a corrupted
middle revision is isolated to that one entry; a real `bskel contract emit` output, once actually
committed by the fixture, round-trips through `contract history` with matching `sbf_contract`/
`operation_count` values pulled straight from the real emitted file. `npm test` 973 -> **981**
(8 new).

**EXIT**: field-level diffing (e.g. "which operation's `requestBodySchema` changed shape between
these two revisions") is out of scope for this item -- only the operation NAME set is diffed, not
the schemas inside each operation. Named here as a deliberately narrower scope than a full
structural diff, not an oversight.

Cross-references: `D-gate-history` (S4, the append-only `.sbf/<feature>.history.jsonl` mechanism
this item deliberately does NOT cross-reference, and why); `D-fixture-corpus` (P3, confirms
`specs/` is gitignored by default in the shared test fixture, the evidence this item's own
"not committed is the common case" design rests on).

## D-waiver-expiry: a genuinely different axis from staleness, not a variant of it

**WHY:** Part of the same ROI-ordered backlog as D-contract-history. `contract waive` records a
waiver permanently -- once written, it covers its `{code, subject}` pair forever, with no way to
say "look at this again in 90 days" short of manually editing the resolution file or deleting the
entry by hand. Real organizations commonly waive something as a temporary "not now" rather than a
permanent "never" -- letting that distinction go unexpressed means a genuinely temporary exception
quietly becomes permanent, the exact silent-tech-debt failure mode this item closes.

**Not the same thing `staleWaivers` already reports.** `evaluateResolution()` already had a
`staleWaivers` bucket -- but that means "the warning this waiver covered no longer exists at all"
(the underlying problem was fixed), a completely different fact from "the warning is STILL there,
but the grace period someone granted has run out." A waiver can be both at once (nothing prevents
the underlying warning from having also disappeared before the clock ran out) -- the two lists are
independent, computed independently, never conflated into one.

**Mechanism**: `contract waive` gains `--expires <Nd>` (whole days only, `N >= 1` -- deliberately
NOT a general ISO-8601 duration parser; `<N>d` is the realistic common case, and this project's own
"don't build for hypothetical cases" discipline argues against speculative unit support with zero
real demand). `parseExpiresFlag()` computes `expires_at` once, at write time, from the real command
clock (`Date.now()`), the same "no injectable now(), match the existing `lib/gates.mjs` convention"
posture every other time-dependent check in this codebase already uses (`checkFreshness()`'s own
`Date.now() - passedAt` is the precedent). `schemas/contract-resolution.schema.json`'s waiver item
gains an OPTIONAL `expires_at` (format date-time) -- omitted entirely when `--expires` wasn't
passed, so every waiver ever written before this feature existed remains valid and un-migrated.
`evaluateResolution()` computes `expiredWaivers` (any waiver whose `expires_at <= now`, inclusive
boundary -- fail-closed: a waiver expiring at exactly this instant is treated as already expired,
not still-valid) and excludes those from `waivedKeys`, so an expired waiver's warning becomes
unwaived again on the very next evaluation -- no separate sweep/cron job, no state mutation on
expiry, just a live re-evaluation exactly like `staleWaivers` already is.

**Disclosed the same way `staleWaivers` already is, at both call sites.** Both `cmdContractEmit`
and `cmdContractWaive` gained `expired_waivers` in their gate evidence and a matching stderr note
(`N recorded waiver(s) have expired and no longer cover their warning`) -- the exact same
double-call-site treatment `stale_waivers` already had, not a special case invented for this one
field.

**Verified**: unit tests (`test/contract-completeness.test.mjs`) cover future/past/exactly-now
boundaries, the no-`expires_at`-at-all case (unaffected, matching every pre-existing waiver), and
the both-stale-and-expired-at-once combination. CLI-level tests (`test/contract-cli.test.mjs`)
confirm `--expires 90d` computes a real `expires_at` from the actual command clock (not a fixed
literal), that omitting `--expires` writes no `expires_at` key at all (not `null` -- byte-identical
to every waiver written before this feature shipped), that five malformed `--expires` values
(`90`, `0d`, `-5d`, `1w`, prose) are all refused with `BAD_ARGS` and write no resolution file, and
a real end-to-end run: two waivers resolve a partial contract to a passing gate, one is
hand-backdated to a past `expires_at` (the CLI itself can only ever write a FUTURE one, so this
mirrors how other tests in this file already simulate states the CLI can't directly produce), and
the next `contract emit` genuinely re-blocks with the expiry disclosed in stderr.

**EXIT**: no automatic notification when a waiver is about to expire (or already has) outside of
running `contract emit`/`contract waive` again -- this is a pull-based check, not a push
notification. If that gap becomes real friction, `bskel status`/`bskel next` are the natural place
to surface it, not a new standalone command.

Cross-references: `D-contract-completeness` (A5, the `staleWaivers`/`blocking` mechanism this item
extends without altering); `D-gate-history` (S4, `--max-age-minutes`'s own "opt-in only, never
silently starts a clock" precedent `--expires` follows the same way).

## D-gate-export: CI-independent evidence, built to answer a real question this project itself has

**WHY:** The highest-ROI item in the same backlog as D-contract-history/D-waiver-expiry. This
repo's own GitHub Actions has been blocked on unresolved billing since 2026-08-26 (see the
project's own `feedback_backend_skeleton_ci_gate_suspended_billing` memory) -- every PR in this
whole backlog has been merged on local verification plus explicit human approval, not a real CI
run. `bskel gate export` is the direct, structural answer to "what did this PR actually get
verified against" that doesn't depend on CI having run at all: a standalone report of exactly what
`.sbf/*.history.jsonl` and the current `.sbf/<feature>.json` state already say, for every one of
the 5 gates, plus enough git provenance to know when it was captured.

**Deliberately NOT the same mechanism D-contract-history rejected.** That item's own design
originally tried to correlate a git commit to a `.sbf/`-recorded gate-pass token, and was corrected
before building anything: `.sbf/` is gitignored, per-machine, ephemeral state, with no reliable
1:1 relationship to a shared commit. This item does not repeat that mistake -- it reports the
CURRENT git HEAD/branch/dirty-state as capture-time PROVENANCE ("this is what was true when the
report was generated"), never as a claim that any specific historical gate-history line
corresponds to any specific commit.

**Mechanism**: `lib/repo.mjs` gains two more small git read-helpers, matching its existing
try/catch-returns-null convention: `currentBranch()` (`git rev-parse --abbrev-ref HEAD` --
deliberately distinct from the existing `localDefaultBranch()`, which answers a completely
different question, "what does origin/HEAD point at") and `isDirty()` (`git status --porcelain`
non-empty). New `bskel gate export --feature <id> [--out <path>] [--json]` (`cmdGateExport`) loops
`GATE_NAMES` (`preflight`, `scan`, `contract`, `handles`, `stack`), resolves each gate's real scope
via the existing `gateScopeId()` (`preflight` is repo-scoped -- `_repo` -- every other gate is
feature-scoped, exactly the same distinction `gate show`/`gate history` already make), and pairs
each gate's current state (`getGate()`) with its full history (the existing `readGateHistory()`,
called once per gate name rather than refactored into a single multi-gate reader -- the file is
small and this reuses an already-correct, already-tested function unchanged). Pure reader: never
calls `setGate`/`passNamedGate`/any mutating gate function, confirmed by a dedicated test that the
feature's own `.sbf/<id>.json` is byte-identical before and after a `gate export` call, including
with `--out` and `--json`.

**Report shape mirrors `contract export`'s own established "the document IS the payload" posture**
(`--json` only changes the `--out`-path confirmation message, never the report's own content,
which is JSON either way) -- not a new convention invented for this one command.

**Verified**: real end-to-end tests confirm `preflight` reports scope `_repo` while the other 4
gates report the feature's own id; a forced gate's real `--reason` shows up in both current state
and history; `--out` writes a file whose `git.head_sha` matches the real `git rev-parse HEAD`
output at test time (not a stubbed value); an uncommitted scratch file correctly flips
`git.dirty` to `true`; a feature with no gates run beyond `preflight`/`scan` correctly reports
`current: null, history: []` for the untouched gates rather than a crash or a fabricated state.

**EXIT**: no cryptographic signing of the exported report -- "verifiable" here means "an honest,
complete transcript of what this machine's local state actually says," not "cryptographically
provable to a third party who doesn't trust this machine at all." If that stronger guarantee is
ever needed, it is a genuinely separate, larger feature (report signing/attestation), not an
extension of this one.

Cross-references: `D-contract-history` (D7, the git-commit-correlation mistake this item was
deliberately built to NOT repeat); `D-gate-history` (S4, the append-only `.sbf/*.history.jsonl`
mechanism and `readGateHistory()` this item reads from unchanged); `D-openapi-export` (A6, the
"the document IS the payload, `--json` only changes the confirmation message" precedent this
item's own `--out` handling follows).

## D-unsupported-annotation-warning: 0 real occurrences on one oracle is not 0 occurrences everywhere

**WHY:** A11 (D-openapi-field-docs) narrowed `DROPPED_KEYWORDS` from seven to five keywords
(`title`, plural `examples`, `externalDocs`, `xml`, `deprecated`) on the strength of a real
measurement: 0 occurrences of any of the five, anywhere in the 148-operation Team-IZ-Backend
oracle. That measurement justifies never building copy support for them -- it does NOT justify
silently dropping them with zero signal. A genuinely different real `--openapi-file` document
could use any of these five, and a consumer would have no way to know their schema got quietly
thinner. This item closes that gap the cheapest possible way: presence detection, not support.

**A real bug caught and fixed before merge, not after.** The first implementation walked
`RECURSED_KEYWORDS` generically, including `properties` -- but `properties`' VALUE is a
field-name -> schema MAP, not a schema itself; recursing into the map object directly (instead of
`Object.values(...)` first) silently walked past every property's real schema and found nothing
underneath `properties` at all, ever. A dedicated test (`deprecated` nested three levels down
through `properties`) caught this immediately -- fixed by special-casing `properties` to recurse
its VALUES, leaving `items`/`additionalProperties` (already schemas directly) and
`oneOf`/`anyOf`/`allOf` (already arrays of schemas) unchanged.

**Scoped to genuine Schema Object structure, not a blanket document-wide key scan -- a second,
equally real precision problem caught before writing any scan logic, not discovered by a failing
test.** Several of `DROPPED_KEYWORDS`' names collide with real, UNRELATED OpenAPI 3.1 fields that
live outside any Schema Object entirely: an Operation Object has its OWN `deprecated` (marks a
whole ENDPOINT deprecated), and so does a Parameter Object (independent of that parameter's own
nested `schema.deprecated`). A naive "does this key appear anywhere in `paths`" scan would
misreport an ordinary, already-correctly-ignored `operation.deprecated: true` as "found an
unsupported schema keyword" -- false, and exactly the kind of unearned claim this project's own
discipline refuses to make. `findUnsupportedAnnotations()` therefore only ever descends from
CONFIRMED schema roots -- `components.schemas` entries, `requestBody`/`responses` media-type
`.schema`, and `parameters[].schema` -- the exact same roots `inlineSchema()` itself is ever
called on, walked via the same `RECURSED_KEYWORDS` set (`properties`/`items`/
`additionalProperties`/`oneOf`/`anyOf`/`allOf`) inlineSchema() itself recurses through. A test pair
(`operation.deprecated`/`parameter.deprecated` both correctly ignored; `parameter.schema.deprecated`
correctly found) locks this distinction in.

**Deliberately NOT routed through `walkSchemaNode()`'s fail-closed machinery.** This scan's only
job is presence detection across a document that inlineSchema() may never even attempt to resolve
(a schema-projection-disabled 3.0 document, an unresolvable `$ref`, a too-deep structure) -- it
must never throw on a shape inlineSchema() itself would reject. Bounded for free by
`loadOpenApiDocument()`'s own `MAX_DOCUMENT_BYTES` check upstream; no separate depth/node cap
needed.

**Module-wide, not per-operation.** `contracts/openapi.mjs`'s `buildReconciliation()` computes
`findUnsupportedAnnotations(loaded.doc)` once per `--openapi-file` document and exposes it as
`unsupportedAnnotations` (a sorted, deduped array of keyword names) at the reconciliation root.
`contracts/emit.mjs`'s `buildContract()` pushes AT MOST ONE new
`CONTRACT_OPENAPI_UNSUPPORTED_ANNOTATION_PRESENT` warning per detected keyword name (subject = the
keyword, e.g. `"title"`), independent of the per-operation endpoint loop -- a fact about the whole
document, not any one operation, so a per-operation warning would just be the same fact repeated
N times for no additional information.

**WARN, not ERROR -- and deliberately not proven waivable via the CLI in this item's own tests.**
Nothing this projection already copies is affected by an unsupported annotation being present;
this is pure disclosure. `contracts/completeness.mjs`'s `WARNING_CODES` marks it `waivable: true`
for consistency with every WARN-severity sibling code's own table entry, but `cmdContractWaive`'s
real, pre-existing filter (`w.severity === 'error'`) only ever matches ERROR-severity warnings --
a genuine, already-existing property of `contract waive`, not something this item changes or
should paper over with a misleading test. What this item DOES verify directly: the new warning
never blocks the `contract` gate, the same as every other WARN-severity `CONTRACT_OPENAPI_*`
sibling.

**Verified**: 10 unit tests (`test/contract-openapi.test.mjs`) cover an empty document, a
`components.schemas`-level occurrence, a properties-nested occurrence, the two real
Operation/Parameter-level false-positive traps (both correctly NOT reported), a genuine
`parameter.schema`-nested occurrence (correctly reported), request-body/response/deep
properties-then-items nesting, multi-keyword dedup+sort, a self-referential raw structure (does
not hang), and confirmation that A11's own `description`/`example` are never reported here (a
different, already-handled mechanism). 4 CLI-level tests confirm the real warning fires with the
right subject on a real `contract emit --openapi-file` run, two distinct keywords each get their
own entry while a repeated keyword doesn't duplicate, a document using none of the five never
fires it, and the gate never blocks because of it. Re-run against the real 148-operation
Team-IZ-Backend oracle through the actual shipped function (not a re-derived estimate): `[]` --
confirms A11's own original 0-occurrence measurement.

**EXIT**: still no copy support for any of the five keywords -- that remains a permanent,
deliberate gap (A11's own EXIT). This item only changes silence into disclosure.

Cross-references: `D-openapi-field-docs` (A11, the exact 0-occurrence measurement and
`DROPPED_KEYWORDS` set this item builds detection for, without changing what stays dropped);
`D-openapi-request-schema` (the original "silently dropping is worse than failing closed"
reasoning `DROPPED_KEYWORDS`' own inline comment already states, extended here from "assertion
keywords must fail closed" to "annotation keywords should at least be disclosed").

## D-docker-postgres-stack: proving the extension point, not building app containerization

**WHY:** Part of the same ROI-ordered backlog as `D-contract-history`/`D-waiver-expiry`/
`D-gate-export`/`D-unsupported-annotation-warning` -- the weakness this closes is
W1 ("narrow scope, no deployment story") from the differentiators/weaknesses discussion. The
answer given at the time was that `stack/catalog/*.yml` is a genuine, already-built extension
point (`listCatalogChoices()`'s own `fs.readdirSync` discovery, zero registration) and adding a
new deployment-adjacent stack choice should prove that out rather than stay a claim.

**Scoped DOWN from "Docker/K8s deployment" to a local dev Postgres, once the real shape of the
extension point was checked, not assumed.** The original framing ("a deployment-stack catalog
entry") implicitly meant application containerization -- a Dockerfile that builds and runs the
target app itself. That does NOT fit `stack apply`'s actual mechanism: `planApply()`/
`renderTemplateFile()` are pure, adapter-AGNOSTIC `{{VAR}}` text substitution (only `PORT` is ever
threaded through) with no awareness of which of the four scanner adapters (java-spring/
python-fastapi/typescript-express/javascript-express) detected the target repo -- and a real
Dockerfile's build steps are fundamentally different per language (`./gradlew build` vs. `pip
install` vs. `npm install`). Forcing that through the existing mechanism would mean either
building real adapter-conditional template selection into `stack/apply.mjs` (a genuinely new,
much larger architectural extension, not what this backlog item scoped) or shipping a Dockerfile
that quietly only works for one adapter while claiming to be generic. Neither is what "prove out
the extension point" should mean. A local Postgres dev database needs neither: every adapter can
equally use one, `docker compose up` for a stock `postgres:16-alpine` image needs no
adapter-specific build logic at all, and it directly complements A4's own already-existing
`--database postgres`/`--database-url-env` support rather than inventing an unrelated concern.

**A LOCAL DEV database only, not a production deployment recipe -- named as a permanent, deliberate
scope limit in the catalog entry's own `description`, not a to-do.** No TLS, a fixed default
password (`app`/`app`), a single unreplicated container, a Docker named volume (not a
production-grade persistent store). Real users who need a production Postgres are expected to use
their own real infrastructure -- this exists only to make local development friction-free.

**Mechanism: zero new code**, exactly the claim being proven. `stack/catalog/postgres-dev-db.yml`
(new catalog entry, discovered automatically) + `stack/bootstrap/docker-compose.postgres.yml`
(a stock Compose file, Docker's own `${VAR:-default}` substitution syntax -- deliberately NOT
this project's `{{VAR}}` template syntax, since Postgres's fixed 5432 port has nothing to do with
the app's own `--port`) + `stack/bootstrap/db-up.sh` (starts the container, polls
`pg_isready` for real readiness rather than a fixed sleep, writes `DATABASE_URL` into `.env` via
the SAME `env_upsert()` helper `scripts/_bskel-lib.sh` already provides for the ngrok stack choice
-- a second real consumer of that shared file, unmodified, not a second copy). No `--database-url-
env`-style fixed variable-name assumption: `db-up.sh`'s own final message explicitly tells the
user to rename `DATABASE_URL` to whatever name they pass to `bskel scan --db --database-url-env`.

**A real, self-inflicted lint bug found and fixed live, not by luck.** The first draft's own
explanatory comment in `docker-compose.postgres.yml` -- written to explain that Compose's
`${VAR:-default}` syntax is NOT this project's own double-brace template syntax -- spelled that
double-brace syntax out literally (`` `{{VAR}}` ``) to name it, which is byte-for-byte what
`lib/template.mjs`'s `RESIDUAL_TEMPLATE_VAR_RE` exists to catch. `bskel catalog lint
postgres-dev-db` caught it immediately (the exact tool this bug would otherwise have shipped past
unnoticed by), fixed by describing the syntax in prose instead of naming it literally.

**Verified end-to-end against a REAL Docker daemon, not just planApply()'s dry-run structure.**
`bskel catalog lint` passes for both catalog entries. A real fixture repo ran `stack apply
--choice postgres-dev-db --apply` followed by the actual generated `scripts/db-up.sh`: a real
`postgres:16-alpine` container came up, `pg_isready` readiness polling succeeded, `DATABASE_URL`
was written to `.env` with the exact expected connection string, and `psql -c "SELECT 1"` through
that exact connection string returned a real row -- confirmed working, not just "the script looks
right." The container, its named volume, and its network were torn down (`docker compose down -v`)
and confirmed absent afterward; the scratch fixture directory was removed. 3 new automated tests
in `test/stack-cli.test.mjs` (15 total in that file, including the pre-existing 12 -- covering
discovery/dry-run/apply/idempotence/executable-bit, the rendered Compose file's real shape, no
residual `{{VAR}}` tokens survive rendering, and the shared `_bskel-lib.sh` helper
file is unmodified by this second consumer) run without a real Docker daemon -- the live-container
run above was a one-time hands-on verification, not part of the automated suite (matching
`D-contract-history`/`D-gate-export`'s own "real end-to-end proof, then automated regression
coverage separately" pattern).

**EXIT**: application containerization (a Dockerfile that builds/runs the target app itself,
per-adapter) remains unbuilt and unscoped -- a genuinely different, much larger feature (real
adapter-conditional codegen in `stack/apply.mjs`) than this item, named here as a permanent,
deliberate gap rather than something this entry quietly claims to cover.

Cross-references: `D-db-schema-plane` (A4, the `--database postgres`/`--database-url-env`
convention this stack choice's own `.env` output is designed to feed, without assuming a fixed
variable name); `D7` (the original declarative-catalog-not-bespoke-code precedent this item's own
file layout and `env_upsert()` reuse follow, and `D-ngrok-no-static-config-file`, the sibling
decision on the ngrok entry's own script-vs-static-config split); `D-extension-conformance` (P4,
`bskel catalog lint`'s own residual-template-var check, the exact tool that caught this item's own
self-inflicted bug).

## D-openapi-extraction-hint (W5): reusing G1's own per-adapter diagnostics() mechanism, not new plumbing

**WHY:** Part of the same ROI-ordered backlog as `D-contract-history`/`D-gate-export`/
`D-unsupported-annotation-warning`/`D-docker-postgres-stack`. Weakness W5: `--openapi-file` is
where real accuracy comes from throughout the whole A1-A12 passthrough line, and for three of the
four real framework adapters it is outright load-bearing (`api.operations: false` means `contract
emit` cannot adopt a single operation without one -- see D-fastapi-adapter/G5/G6). None of that is
discoverable without already knowing to read `CATALOG.md`/`DECISIONS.md` prose first. This closes
that gap the cheapest way available: reusing G1's own existing `diagnostics(repoRoot)` mechanism
every adapter already implements for `bskel doctor`, rather than inventing a new plumbing path.

**Deliberately per-adapter, not one generic message.** Each of the three real framework adapters
gets a genuinely different, framework-accurate answer, not a templated "see your framework's
docs" placeholder:
- **java-spring**: `api.operations` is already `true` (operationIds come from real source
  annotations), so this is an ACCURACY improvement, not load-bearing -- worded accordingly. Names
  the REAL mechanism this project's own Team-IZ-Backend oracle file was produced by:
  `org.springdoc.openapi-gradle-plugin`'s `./gradlew generateOpenApiDocs` task, which boots the
  app briefly and writes `build/api-docs.json` without a human starting/curling a server by hand --
  confirmed by recognizing the oracle file's own path (`build/api-docs.json`) IS that plugin's
  default output location, not just plausible-sounding advice. Falls back to naming the manual
  `curl .../v3/api-docs` capture honestly when that plugin isn't configured.
- **python-fastapi**: `api.operations` is `false` -- worded as load-bearing, explaining WHY
  (FastAPI assigns operationIds at runtime, not from static source). Names FastAPI's own real,
  no-server-required mechanism: importing the `app` object and calling `app.openapi()` directly
  (`python -c "from app.main import app; ...`) -- the actual technique, not a guess.
- **typescript-express / javascript-express** (shared `expressDiagnostics()`): also load-bearing,
  worded the same way. Says PLAINLY that plain Express has no framework-native OpenAPI generation
  mechanism at all -- naming a real limitation rather than inventing a fake "just run this command"
  answer where none exists, and pointing at real third-party generators (swagger-jsdoc/tsoa/
  zod-to-openapi) a project might already use instead.
- **generic-grep**: deliberately excluded -- it isn't a real framework, so there is no
  framework-specific extraction method to name; a generic hint here would be empty filler.

**Always shown, not conditioned on whether `--openapi-file` was already used.** `bskel doctor`
has no mechanism to know a target feature's own command history (and inventing one would be a
disproportionate amount of new state-tracking for this item's own "S" scope) -- each hint's own
message text says plainly "ignore this if you already have a source document" instead.

**Verified**: `bskel doctor --json` against a real fixture confirms all four real framework
adapters (not `generic-grep`) carry the new `openapi-extraction-hint` diagnostic at `level: 'info'`,
and dedicated tests pin down each adapter's own real wording -- java-spring's Gradle-plugin task
name and manual curl fallback, python-fastapi's exact no-server-needed command and its
load-bearing (not just accuracy) framing, and both Express adapters' honest "no framework-native
generation" admission.

**EXIT**: no attempt to auto-run any of these extraction commands -- this is guidance text only,
matching every other `diagnostics()` entry in this codebase (informational, never executed by
`bskel doctor` itself).

Cross-references: `D-adapter-registry` (G1, the `diagnostics()` mechanism this item's whole design
reuses unchanged); `D-fastapi-adapter` (G2, the `api.operations: false` load-bearing-ness this
item explains to a human for the first time); `D-openapi-passthrough` (A7, the broader
`--openapi-file` accuracy story this hint exists to surface earlier, before a user has read any
prose documentation).

## D-adapter-verification-basis (W2/B6): a genuinely different axis from `confidence`, surfaced before commitment instead of buried in prose

**WHY:** Weakness W2/B6 from the differentiators analysis: each adapter's real verification
pedigree already existed in prose (G2's official FastAPI reference stack, G5's one hand-read
community boilerplate, G6's "no real-world oracle at all" admission, java-spring's real
Team-IZ-Backend production oracle) but only inside `DECISIONS.md`/`CATALOG.md`. Nothing in the
CLI itself told a user, before they committed to scanning their repo with a given adapter, how
well that adapter's own codegen had ever actually been checked against real code. `bskel doctor`
already runs per-adapter and already renders a `confidence` field — but `confidence`
(`schemas/adapter.schema.json`'s existing `enum: ["high","low"]`) answers a completely different
question: "how sure was `detect()` this repo uses this framework." Silently overloading that field
to also mean "how well-verified is this adapter" would collide two axes that can disagree in
either direction (a `confidence: high` detection on an adapter with `verificationBasis:
synthetic-only`, or vice versa) — so this ships as a new, separately-named required field instead.

**Mechanism.** `schemas/adapter.schema.json` gains `verificationBasis` (required, 5-value enum:
`official-reference`, `production-repo`, `community-sample`, `synthetic-only`, `not-applicable`),
each value's meaning spelled out in the schema's own `description` so the distinction from
`confidence` is documented at the point a new adapter author would actually read it. Adding a
required field to an already-shipped descriptor shape is a breaking change to the shape itself —
`contract` bumps from `sbf.adapter/1` to `sbf.adapter/2`, matching this project's own established
`sbf_contract`-bump convention (A7-A11) rather than inventing a new versioning scheme. All 5
shipped adapters set the value that matches what `CATALOG.md` already says in prose, checked
against each one's own `[IMPLEMENTED as G...]` entry rather than assumed from memory:
- **java-spring** → `production-repo` (Team-IZ-Backend, a real production codebase — G1/O4's
  own verification history).
- **python-fastapi** → `official-reference` (`fastapi/full-stack-fastapi-template`, the
  framework-author-maintained reference stack G2 cloned and ran against).
- **typescript-express** → `community-sample` (`mkosir/typeorm-express-typescript`, G5's own
  explicit "no framework-maintained Express reference exists" finding — one hand-read community
  boilerplate, not an official one).
- **javascript-express** → `synthetic-only` (G6's own words: "no real-world oracle at all... the
  committed synthetic fixture carries all of the regression weight").
- **generic-grep** → `not-applicable` — not a weaker tier than the other four, a different kind of
  answer: G3 keeps this adapter reconnaissance-only by design (every codegen capability is
  honestly `false`), so there is no codegen output to ever verify against any oracle at all.

`bin/bskel.mjs`'s `cmdDoctor` surfaces the field verbatim in both output modes: `--json`'s
per-adapter object gains `verificationBasis` alongside the existing `specificity`/`confidence`,
and the text-mode adapter line grows a `verified: <value>` segment
(`  <id> (specificity N, confidence high, verified: production-repo) -- capabilities: ...`).

**Verified**: `test/adapter-registry.test.mjs`'s shared `fixtureSource()` helper (used by every
zero-registration/arbitration/malformed-adapter test in that file) updated to the new
`sbf.adapter/2` contract and a `verificationBasis` default — otherwise every fixture-based test
would fail the exact same "declares contract X, this build only understands sbf.adapter/2" guard
real third-party adapters now hit. Dedicated tests in `test/doctor-cli.test.mjs` confirm all 5
shipped adapters carry their real, correct `verificationBasis` value in `--json` output, and that
the text-mode rendering names it alongside `specificity`/`confidence` for both a real-oracle
adapter (java-spring) and the reconnaissance-only one (generic-grep). `contracts/validate.mjs`/
`lib/gate-definitions.mjs`/`lib/verify.mjs`/`.github/workflows/ci.yml` all confirmed untouched —
this item never touches gate/validation logic, only the adapter descriptor shape and `doctor`'s
existing rendering path.

**EXIT**: no attempt to derive `verificationBasis` automatically (e.g. from git history or a
fixture-file heuristic) — it is a human judgment call recorded once per adapter at the point its
real oracle was established, the same way `confidence`'s own per-adapter values are hand-set, not
computed. No badge/README surface added in this slice — the original backlog item floated a
static README badge row idea, but `bskel doctor` already answers "which oracle backs this
adapter" at the exact moment (before committing to a scan) the question actually matters; a README
badge would be redundant with, not additive to, that.

Cross-references: `D-adapter-registry` (G1, the `contract`/`confidence`/`capabilities` shape this
item extends, and the exact bump precedent `sbf.adapter/1` → `sbf.adapter/2` follows);
`D-fastapi-adapter` (G2, `official-reference`'s real oracle); `D-typescript-express-provider` (G5,
`community-sample`'s real oracle and the "no framework-maintained reference exists" finding);
`D-javascript-express-adapter` (G6, `synthetic-only`'s own honest-gap admission this field now
makes machine-readable); `D-generic-grep-reconnaissance` (G3, why `not-applicable` is a distinct
answer, not a weaker `synthetic-only`).
