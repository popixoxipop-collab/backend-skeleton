# backend-skeleton

Spec-driven backend scaffolding for brownfield (and greenfield) Java/Spring Boot, Python/FastAPI,
and TypeScript/JavaScript Express repos: a brownfield-collision gate before any spec/plan step,
feature_id-scoped machine-readable contracts, UUID-addressable field handles, and stack-choice
(e.g. ngrok) wiring — all enforced by disk `content-hash` gates, not prompt instructions a future
session could ignore.

`bskel` exists because a previous ad-hoc agent-driven scaffolding attempt branched a worktree 658
commits behind the real default branch and never noticed. Every gate in this tool is a regression
check for a specific failure mode found the same way — see `DECISIONS.md` for the full record.

## Status: beta

This is the first public release, and it's deliberately labeled a beta rather than `1.0.0`
stable. Split by actual maturity, not by feature list:

- **`scan`, `contract` (including `export`), and `new`** are the most exercised paths — real,
  measured verification against a real production Spring Boot repo (see `DECISIONS.md`), plus a
  synthetic fixture corpus for every adapter, run in CI on every change.
- **`handles`** (the UUID-addressable resolver/codec/router codegen) is functionally complete and
  tested the same way, but has never been deployed to a real production repo, and two named gaps
  stay open specifically because of that: generated `fetch()`/`patch()` paths never check
  `HandleRegistry` for revocation, and generated authorization is inferred from a single
  `@PreAuthorize(hasRole(...))` shape rather than a real policy contract. Both are tracked as `O3`
  and `O5` in `CATALOG.md`, explicitly deferred until handles are actually used somewhere real --
  treat `handles emit`'s output as a scaffold to finish by hand, not a production-ready subsystem,
  until that work lands.

Version numbers, install instructions, and a real feedback path will firm up as this gets used
against more real repos.

## Quickstart

```bash
npm install -g backend-skeleton@beta   # or: npx backend-skeleton@beta <command>
cd <target-repo>                  # must be a git repository

bskel doctor                      # what's on PATH, which scanner adapter detects this repo, and why
bskel preflight                   # confirms HEAD is actually based on the real default branch,
                                   #   not a stale/abandoned one -- required before anything else

bskel feature init --slug organization-management
bskel scan --feature 001-organization-management --terms organization
                                   # brownfield-collision scan; refuses to proceed silently if this
                                   #   module already exists elsewhere in the codebase
bskel scan disposition --feature 001-organization-management --mode reuse --note "..."
                                   # required once scan finds a collision/adjacent match

bskel contract emit --feature 001-organization-management
                                   # feature_id-scoped JSON Schema contract, from real source annotations
bskel handles plan --feature 001-organization-management
bskel handles emit --feature 001-organization-management
                                   # UUID-addressable field handles + generated resolver code

bskel verify --feature 001-organization-management --build
                                   # aggregates every gate's current status; --build also runs the
                                   #   target repo's own build wrapper (gradlew/mvnw/npm), if present
```

### Starting from nothing (greenfield)

Every command above assumes an existing Spring Boot or FastAPI repo. If you don't have one yet:

```bash
bskel new --stack spring --slug my-service    # calls start.spring.io (network required), or:
bskel new --stack fastapi --slug my-service   # a local starter template, no network call

cd my-service
# create a remote you own and push to it (e.g. `gh repo create --private --source=. --push`),
# then: git remote set-head origin --auto
bskel preflight                               # now resolvable -- picks up from the Quickstart above
```

`bskel new` deliberately never creates a remote itself and never auto-chains into `preflight` --
`preflight` requires a real `origin` remote with a resolvable default branch, which a brand-new
local-only repo doesn't have yet. See `D-greenfield-bootstrap` in `DECISIONS.md`.

Both stacks accept `--name`, `--description` and `--project-version` (the *generated project's* own
version -- `--version` is a global flag that prints `bskel`'s). Beyond that the parameters differ,
because the two ecosystems do:

```bash
bskel new --stack spring --slug my-service \
  --group-id com.acme --artifact-id billing --package-name com.acme.billing \
  --java-version 21 --packaging war --add-dependencies actuator,postgresql

bskel new --stack fastapi --slug my-service \
  --python-version 3.12 --port 9000 --license MIT --database postgres
```

- **`--add-dependencies` extends** the baseline (`web, data-jpa, security, validation, lombok`).
  **`--dependencies` REPLACES it** -- and if the result drops `web`, `data-jpa` or `validation`, you
  get a specific stderr warning naming what stops working downstream, then it scaffolds anyway.
- **`--group-id`/`--package-name`/`--artifact-id` are validated locally** against the Java package
  grammar. That isn't belt-and-braces: `start.spring.io` accepts `groupId=com.new` (a reserved word)
  and `groupId=has space` with HTTP 200 and hands back a project that cannot compile.
- **`--java-version` is checked against `start.spring.io`'s own live metadata**, fetched on demand
  only when you pass a non-default value, never cached to disk -- for the same reason: `javaVersion=99`
  returns HTTP 200 and writes `JavaLanguageVersion.of(99)` straight into `build.gradle`.
- **`--database` pins a driver and nothing else** -- no engine, session or connection code is
  generated, because that would be `bskel` inventing your domain.
- `--type`, `--language` and `--boot-version` are deliberately **refused** with a specific reason
  each (Maven/Kotlin scaffolds break this tool's own scanner and codegen assumptions; a bad
  `bootVersion` gets an unusable HTTP 500). Run `bskel new --stack spring --type maven-project` to
  see the actual explanation.

The full parameter list, the measured API-validation matrix behind that split, and the warning
behaviour are in `D-greenfield-parameters` in `DECISIONS.md`.

### Publishing a feature's contract as OpenAPI (optional)

```bash
bskel contract export --feature 001-organization-management --out openapi/organization.json
```

Renders an already-emitted, gate-passing contract as a standalone **OpenAPI 3.1** document — the
inverse of `contract emit --openapi-file`. Useful for a Swagger UI page scoped to one feature
instead of the whole repo, a client generator that can't follow `$ref` (an exported document has
none), or a mock server for one feature's operations.

It is a **deliberately lossy, narrow projection, and it says so** — every omission is disclosed
both in prose (`info.description`) and machine-readably (`info.x-bskel-omitted`). Nothing is
invented to fill a gap: an operation whose body shape the contract doesn't know gets a JSON
media-type entry with no schema rather than a fabricated one, and an operation with no per-status
source data still collapses its 2xx/4xx/5xx bodies into two unions rather than guessing a status
code.

Query/header/cookie parameters, `security` (plus the referenced security schemes), `summary`,
`tags`, per-status responses, and non-JSON request media types (e.g. `multipart/form-data`) **are**
emitted — but only when a real `--openapi-file` source document said something for that exact
operation, copied byte-for-byte, never reconstructed. `security: []` is emitted when the source
document itself said `[]` (a genuine claim that no authentication is required); it is never
invented as a default. Where no source document was given, or it said nothing for an operation
(or a particular field of one), the key is simply omitted, meaning "unspecified." Operation-level
`description` remains excluded — measured too expensive to copy by default (real average 2,442.7
bytes/operation).

Export refuses a zero-operation contract, refuses when the scan found a global path prefix the
contract's paths don't reflect (`--allow-unprefixed` overrides), and stamps every document with an
`x-bskel-generated` marker that `contract emit --openapi-file` then refuses to read back in —
reconciling a contract against its own export would make it confirm itself. See `D-openapi-export`
in `DECISIONS.md`.

### Database schema (optional)

`bskel scan --db` additionally scans Flyway/Liquibase migration files (local only, no network).
Add `--database-url-env <NAME>` (naming an environment variable you've already exported, never
read from `.env`) for live, read-only Postgres introspection (`information_schema`/`pg_catalog`,
inside a `BEGIN TRANSACTION READ ONLY`) and a source-vs-live drift report. Both are informational
additions to the scan report — neither blocks any gate. See `D-db-schema-plane` in `DECISIONS.md`.

Every command is read-only until you explicitly run one of the mutating steps above — `bskel
status`/`bskel next` (no arguments needed) tell you which gate is next and print the exact
copy-pasteable command for it, without touching anything.

The full gated workflow, what each phase writes, and every flag is documented in `SKILL.md`
(present in this repository, not in the installed npm package — see "What ships in the package"
below).

## Compatibility

| Requirement | Constraint | Why |
|---|---|---|
| Node.js | `>=18` | ES2022 (`Object.hasOwn`) + ESM top-level `await` — nothing newer is used anywhere in the runtime code (verified by grep across every recent-ES-addition pattern; see `D-npm-packaging` in `DECISIONS.md`) |
| git | required | every gate is git-state-derived |
| [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) | required for `scan`/`handles` | every scanner adapter shells out to it directly, and throws (not degrades) if it's missing |
| `gh` (GitHub CLI) | optional | only used for `preflight`'s 3-way default-branch cross-check; already soft-guarded, never a hard requirement |
| `python3` | optional | only needed to run this repository's own cross-language codec test — `bskel` itself never invokes `python3` |
| a build wrapper (`gradlew`/`pom.xml`+`mvnw`/`package.json`) | optional | only `bskel verify --build` needs one; `handles emit` never compiles anything itself |

Run `bskel doctor` in any target repo to see exactly which of these it found, with a remediation
string for anything missing.

**Supported scanner adapters** (auto-selected by specificity, never hardcoded — see
`D-adapter-registry` in `DECISIONS.md`):
- `java-spring` — Spring Boot (`build.gradle`/`pom.xml` + `src/main/java`). Full capability set:
  operation extraction, request-body detection, and a real codegen provider for `handles emit`.
- `python-fastapi` — FastAPI + SQLModel. Real codegen provider for `handles emit`; contract-grade
  operation extraction is not supported (FastAPI generates operation ids at runtime) — pass a real
  OpenAPI document via `--openapi-file` for a trustworthy contract.
- `typescript-express` — TypeScript + Express + TypeORM. Real codegen provider for `handles emit`
  (entities come from `@Entity`/`@PrimaryGeneratedColumn`); no operation extraction — plain Express
  has no operationId concept, so pass `--openapi-file` for a contract. See
  `D-typescript-express-provider` in `DECISIONS.md`.
- `javascript-express` — plain-JavaScript ESM Express with **no ORM** (raw `mysql2`/`mariadb`),
  including `serverless-http`/Lambda deployments. **Scanner only** — routes and their real absolute
  paths are resolved through a full mount-graph walk, but every capability is honestly `false`:
  there is no codegen provider, because raw SQL string literals carry no trustworthy
  table/primary-key/column-allow-list metadata. See `D-javascript-express-adapter` in `DECISIONS.md`
  for the measured reasoning.
- `generic-grep` — unconditional last-resort fallback (Express/Flask/FastAPI-shaped route
  detection). Reconnaissance only, never contract-grade — always `confidence: "low"`, requires
  `--accept-low-confidence` to proceed past a feature-scoped scan.

## Generated-file policy

`bskel handles emit` writes real Java/Python source into your repository. Two things are always
true about what it writes:

- **`fetch()` is wired to a real, existing, already-tested read-only service method** — never
  hand-written business logic. It's generated only when a matching `<Entity>Service` method exists
  and takes exactly the one resource UUID argument a resolver always passes (a mismatch there means
  "no resolver generated", not "generate one and hope", since silently calling the wrong overload
  can drop a required scoping argument — see `D-security-8` in `DECISIONS.md`).
- **`patchField()` is always a stub.** Real codebases mix at least three different partial-update
  DTO conventions; guessing wrong would silently bypass real validation. A human finishes this by
  hand, every time.

Reruns are safe by construction, not by convention (`D-handles-ownership` in `DECISIONS.md`):
safety is derived from the generated file's actual on-disk **content**, not from a manifest that
might be absent (a fresh checkout, CI, or a repo that doesn't commit `.sbf/`). A file that diverged
from what `bskel` generated (a hand-finished `patchField()`, someone else's edit) is never silently
overwritten — it reports a conflict, and the escape hatch (`--force --reason "..."`) is always
audited, never silent.

## Security model

`bskel` generates code that runs in production, so it was put through an adversarial security
review (Codex, security-only lens, independent of the build process) — 8 findings, all fixed, each
with an inline `D-security-N` comment at its exact location in the code. Highlights (full record,
including 3 additional defensive-hardening items, in `DECISIONS.md`'s "Security hardening pass"
section):

- **Prototype-pollution guards** everywhere a user-controlled string indexes a plain object
  (`operation_id` values like `"constructor"`/`"__proto__"` are rejected, not silently resolved via
  the prototype chain).
- **Path-traversal containment** on every stack-catalog-driven file write (`--choice`, and every
  catalog entry's own declared template/path fields).
- **No predictable temp files, no silent permission downgrades** in the generated bootstrap
  scripts that touch `.env` (`mktemp` + an unconditional `chmod 600`).
- **Authority derivation is per-method, not per-file** — a controller's first `@PreAuthorize` match
  no longer silently applies to every resolver generated from that file; an unsupported annotation
  shape (`hasAnyRole`, SpEL) fails closed to a `TODO_ROLE` placeholder rather than guessing.
- **Handle recovery cross-checks type/kind/pointer against the registry row**, not just the raw
  UUID — the most severe finding: an attacker who controls the handle's `type` field could
  otherwise request a different, more sensitive resource's snapshot history that happens to share
  the same UUID.

## Troubleshooting

Start with `bskel doctor` — it names exactly which required tool is missing and why, or run `bskel
status`/`bskel next` to see which gate is currently blocking and the exact command to resolve it.

Every command shares one exit-code table (`lib/exit-codes.mjs`) and, with `--json`, an additive
diagnostic envelope on payload-less early exits — the number is the stable contract, `reason` in
the envelope is supplementary precision:

| Exit | Meaning |
|---|---|
| `0` | OK |
| `2` | a required gate hasn't passed yet, or a referenced resource/adapter/provider doesn't exist (`--json`'s `reason` field disambiguates which) |
| `3` | a gate is awaiting a disposition decision (`bskel scan disposition`/`bskel contract waive`) |
| `4` | a gate is stale — either an input actually changed, or (`preflight` only) the pass is simply too old |
| `10` | not inside a git repository |
| `11` | `preflight`: HEAD is behind the real default branch |
| `12` | `preflight`: the three independent sources for "what is the default branch" disagree, or none could be determined |
| `13` | `preflight`: uncommitted changes present (`--allow-dirty` to override) |
| `14` | bad arguments |
| `16` | a low-confidence scan was blocked (`--accept-low-confidence` to proceed anyway) |
| `17` | the selected adapter/provider doesn't support a capability the command needs |
| `18` | `preflight`: a `git fetch` was attempted and failed (`--offline` to accept a local-only verdict instead) |

Common cases:
- **`preflight` fails with `STALE_BASE`**: your branch really is behind — `git worktree add
  <path> -b <branch> origin/<default-branch>` (or rebase in place), then re-run.
- **`scan` exits `16`**: the scanner fell back to `generic-grep` (low confidence, no real parser).
  If this repo actually is Java/Spring or Python/FastAPI-shaped, run `bskel doctor` first — it
  explains exactly why the real adapter didn't detect it, rather than reflexively passing
  `--accept-low-confidence`.
- **`handles emit`/`contract emit` exits `17`**: the adapter that scanned this repo doesn't
  declare the capability that command needs (e.g. `generic-grep` never declares `codegen.handles`
  — there's no codegen provider for a route-pattern-only stack). `bskel doctor` lists every
  installed adapter's declared capabilities.
- **A previously-passed `preflight` now reports stale with `ttl_expired`**: passes expire after 30
  minutes by default (data-derived, see `D-preflight-freshness` in `DECISIONS.md`) — re-run
  `bskel preflight`, or pass `--max-age-minutes 0` to disable the TTL for a deliberately
  long-running or offline session.

The full exit-code/`reason` taxonomy, global flags (`--help`/`--version`/`--json`/`--quiet`), and
the complete gated-workflow reference live in `SKILL.md` and `DECISIONS.md` in this repository.

## What ships in the package

`npm install` ships only what `bskel` reads at runtime — `bin/`, `lib/`, `contracts/`,
`scanners/`, `handles/` (including every codegen template), `stack/` (including the catalog and
bootstrap templates), `schemas/`, and `scripts/preflight-base-ref.sh`. This repository's own test
suite, `SKILL.md` (this project's Claude Code skill definition), `DECISIONS.md`, and `CATALOG.md`
are not part of the published package — clone this repository directly if you want those.

## License

MIT — see `LICENSE`.
