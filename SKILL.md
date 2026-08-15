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

## What's actually usable today

```bash
cd <target-repo>            # must be a git repo
bskel doctor                 # checks: inside a git repo, git/gh/rg on PATH
bskel preflight               # 3-way default-branch cross-check + behind/ahead + worktree provenance
bskel preflight --json         # same, machine-readable
bskel preflight --allow-dirty  # skip the clean-working-tree requirement
bskel preflight --max-behind N # tolerate up to N commits behind (default: 0)

bskel gate require preflight   # exit 0 pass / 2 not-run / 3 awaiting-disposition / 4 stale (name must be one of: preflight|scan|contract|handles|stack -- an unknown name exits 14, it does not report not-run)
bskel gate force preflight --reason "..."   # explicit, audited bypass
bskel gate show                # dump the full gate-state JSON for this repo
bskel gate show stack          # or just one gate's own record (optional <name> positional arg)

bskel scan --terms organization                      # ad-hoc, read-only, no files/gate touched
bskel scan --feature 001-organization-management      # writes specs/<id>/brownfield-scan.{json,md}, sets the `scan` gate
bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel --note "..."
                                                        # required before anything downstream can pass the `scan` gate
                                                        # for a feature whose verdict was collision/adjacent
```

`scan`'s verdict: `greenfield` (no related code found -- gate auto-passes), `adjacent` (weak
relation found, still needs a disposition), `collision` (strong match -- e.g. an existing
controller/entity/enum for the same module). Adapter is `java-spring` (ripgrep + full-file
regex, no real Java parser -- see `scanners/adapters/java-spring.mjs`) when `build.gradle`/
`pom.xml` + `src/main/java` are present, else `generic-grep` (lower confidence route-pattern
matching for Express/Flask/FastAPI-shaped code).

`preflight` exit codes: `0` PASS, `10` not a git repo, `11` STALE_BASE (HEAD is behind the real
default branch -- this is the exact bug class the tool exists to catch: a worktree silently
based on a stale/abandoned branch), `12` WRONG_DEFAULT (the three independent sources for "what
is the default branch" disagree, or none could be determined -- never guess `main`), `13` DIRTY
(uncommitted changes present, pass `--allow-dirty` to override), `14` bad arguments.

```bash
bskel feature init --slug organization-management
  # -> mints feature_id (e.g. 001-organization-management, auto-numbered) + a UUIDv4 feature_uid,
  #    writes specs/<id>/feature.json + .sbf/feature-index.json. Requires preflight to have passed.

bskel contract emit --feature <id> [--module <name>]
  # -> requires the `scan` gate to have passed (greenfield auto-pass, or a recorded disposition).
  #    Seeds specs/<id>/contracts/<id>.schema.json's operations from the scan's controller
  #    endpoints for the given module (defaults to the top-scoring related module): verb, path,
  #    path-param schema (uuid-format for *Id-named params), and whether the endpoint takes a
  #    body (re-checks the source for @RequestBody per-method -- verb alone is not reliable,
  #    e.g. a DELETE that still takes a confirm-name body).

bskel contract validate --feature <id> --file envelope.json
  # -> validates a {sbf, feature_id, feature_uid, operation_id, direction, payload} envelope:
  #    structural check against schemas/agent-envelope.schema.json, then feature_id/feature_uid
  #    must match this exact contract, operation_id must be one it defines, and (for
  #    direction:"request") payload.pathParams/body must satisfy that operation's specific
  #    shape. Wrong feature, wrong operation, missing a required path param, and an unexpected
  #    body on a bodyless operation all fail distinctly -- see test/contract.test.mjs.

bskel contract tool-schema --feature <id> --operation <operationId>
  # -> prints {name, description, input_schema} for that operation -- input_schema is plain
  #    JSON Schema, usable directly as an Anthropic tool-use tool definition.

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

bskel handles emit --feature <id> [--module <name>] [--resource Type1,Type2]
  # -> requires the `contract` gate to have passed. Writes, under the detected base package:
  #      global/handle/{HandleCodec,HandleRegistry,HandleSnapshot,HandleRegistryRepository,
  #        HandleSnapshotRepository,ResourceResolver,HandleController}.java
  #      domain/<module>/infrastructure/<Type>Resolver.java   (one per resource `plan` approved)
  #      specs/<id>/handles/migration.sql   (sbf_handle + sbf_handle_snapshot tables -- NOT applied)
  #    <Type>Resolver's fetch() calls the real service method directly -- a read-only call into
  #    existing, tested code, and only ever emitted once `plan`'s D-security-7/8 checks above
  #    passed, not assumed safe by default. patchField() is ALWAYS a stub -- see the workflow
  #    section above and D-resolver-scope in DECISIONS.md for why.

bskel verify --feature <id> [--build] [--json]
  # -> aggregates all 5 gates (lib/gate-definitions.mjs is the single source both this and every
  #    gate-writing command consume) via the same machinery every other command uses, plus
  #    artifact existence checks (contract file, handles migration if applicable). Each gate
  #    carries a verifyPolicy: `required` (preflight/scan/contract -- not_run or stale always
  #    fails overall) or `required-when-present` (handles/stack -- not_run does NOT fail overall,
  #    but a gate that HAS run and is stale/awaiting_disposition still does -- "optional" means
  #    "not every feature needs this", not "once run, correctness stops mattering"). Each gate's
  #    JSON entry reports `scope`/`policy`/`blocking`/`ran` alongside its status. --build actually
  #    runs the detected build tool (gradlew/mvnw/npm) and reports real pass/fail, not just gate
  #    status -- exits 0 only if everything blocking passed.
```

**Handle format**: `sbf1_<base64url(kind:type:uuid[:pointer])>` -- `kind` is `r` (whole
resource), `f` (one field, via an RFC 6901 JSON Pointer), or `o` (reserved, unused). A plain-
UUID `handle_uid` is derivable from the same components (`kind=r`: the resource's own uuid;
`kind=f`: a UUIDv5 of `type:uuid:pointer`) without any DB round-trip. Verified byte-identical
between the JS reference implementation (`handles/codec.mjs`) and the generated Java
(`HandleCodec.java`) on the same inputs, and `uuidv5` independently matches the standard RFC
4122 test vector -- see `test/handles-codec.test.mjs` and `D5/D6` in `DECISIONS.md`.

**Contract scope note**: only `direction: "request"` payloads are checked against an
operation-specific shape (path params + whether a body is required/disallowed). `response`/
`error` payloads pass envelope-structure validation but aren't checked further -- that would need
actual Java DTO field-level parsing, out of scope for Phase 2's ripgrep+regex scanner. See
`D-contract-scope` in `DECISIONS.md`.

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
