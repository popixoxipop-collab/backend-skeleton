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
limit. `src/`-layout and PEP 420 namespace packages are refused outright. The generated router
needs two lines of manual wiring into the app's own router composition -- never automatic. `npm
test` now requires `python3` on PATH as a hard dependency (`lib/doctor.mjs`'s new check is
`required: false` for `bskel` itself, but the test suite's own codec cross-check is not skippable).
Python's `SessionDep`-alias detection is a single regex looking for `Annotated[Session,
Depends(...)]` -- an app using a different session-dependency shape (no `Annotated`, a different
type name than `Session`) gets no router/resolvers generated at all, silently narrowed rather than
guessed at.

**Honest verification gap, left open on purpose**: this item closes the "byte-identical" claim for
JS<->Python (executed, both directions, positive AND negative parity, see Verification). The
matching JS<->Java claim (`handles/codec.mjs`'s own header comment, and
`HandleCodec.java.tmpl`'s) has **never once been executed in this repository** -- no `.java` file
from that template has ever actually been compiled or run here; the claim rests entirely on
javadoc-level assertion. This item does not close that gap (closing Python's was the explicit,
scoped goal) -- it is recorded here, honestly, as still open. Two options for whoever picks it up:
gate a `test/handles-codec.test.mjs`-analogous Java test behind a real JDK/`javac` check (mirroring
this item's `python3`-required pattern exactly), or commit the JS reference vectors as a JSON
fixture a target repo's own JVM test suite can consume without this project needing a JDK at all.

**EXIT**: add a `--provider` override flag if a real N:1 (one adapter, multiple viable providers)
case is ever observed -- none has been, so it was not spec'd speculatively. Implement `recover()` +
its tables for Python if `O4` (the Java side) ever actually gets implemented and used -- until then,
both stay unwired by design, not oversight. Relax the `SessionDep`-shaped-alias requirement (or add
a second detection pattern) if a real FastAPI app using a different session-dependency convention
needs this provider. Generalize `RESOLVER_OWNER_MARKER_RE`/`BSKEL_GENERATED_MARKER` further if a
third provider's own doc-comment convention doesn't fit the two `(...)`/`({@code ...})` forms this
item's regex already handles. Close the Java codec's own never-executed verification gap (see
above) using either of the two named approaches.

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
