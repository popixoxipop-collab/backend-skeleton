---
name: backend-skeleton
description: Use when scaffolding a new backend feature from a spec into an existing (brownfield) or new (greenfield) repo, and you need the plan to actually account for what already exists in the codebase instead of guessing. Covers pre-flight branch/worktree sanity, a brownfield collision scan before any spec/plan step, feature_id-scoped machine-readable contracts, UUID-addressable field handles, and stack-choice (e.g. ngrok) wiring.
license: MIT
metadata:
  version: 0.1.0
  author: popixoxipop
  based_on: "https://github.com/popixoxipop-collab/backend-skeleton"
  status: "Phase 0 (spine) + Phase 1 (preflight) + Phase 2 (brownfield scan) implemented. Phase 3-6 not yet built -- see below."
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
| 2 | `bskel feature init --slug <name>` | — | not yet built (feature_id string is currently just typed by hand, e.g. `001-organization-management`) |
| 3 | `bskel scan --feature <id>` (+ `scan disposition` if collision) | blocks 4-10 | **implemented** |
| 4 | `/speckit.specify` (or `bskel spec template`) | — | depends on spec-kit if present |
| 5 | `bskel contract emit` + `bskel contract validate` | blocks 6-10 | not yet built |
| 6 | `/speckit.plan` (with scan disposition injected) | — | depends on spec-kit if present |
| 7 | `bskel handles plan` → `bskel handles emit` | — | not yet built |
| 8 | `bskel stack apply --choice ngrok` | — | not yet built |
| 9 | `/speckit.tasks` | — | depends on spec-kit if present |
| 10 | `bskel verify` | — | not yet built |

**You MUST run `bskel preflight` before anything else touches this repo.** Do not substitute
your own `git status`/`git log` reasoning for it -- the gate token is computed from a specific,
re-verifiable input set (current `HEAD` sha + locally-resolved default branch), and every
downstream command that checks the `preflight` gate will refuse to proceed without it having
actually run and passed.

Steps 5, 7, 8, 10 (marked "not yet built" above) do not exist yet. If you are asked to do
contract emission, handle codegen, or stack wiring right now: say so plainly, point at the plan
file's phased build order, and do NOT hand-simulate what those commands would output -- that
recreates exactly the "agent got lucky" problem this skill exists to eliminate.

## What's actually usable today

```bash
cd <target-repo>            # must be a git repo
bskel doctor                 # checks: inside a git repo, git/gh/rg on PATH
bskel preflight               # 3-way default-branch cross-check + behind/ahead + worktree provenance
bskel preflight --json         # same, machine-readable
bskel preflight --allow-dirty  # skip the clean-working-tree requirement
bskel preflight --max-behind N # tolerate up to N commits behind (default: 0)

bskel gate require preflight   # exit 0 pass / 2 not-run / 3 awaiting-disposition / 4 stale
bskel gate force preflight --reason "..."   # explicit, audited bypass
bskel gate show                # dump the full gate-state JSON for this repo

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

## Design reference (for implementing the remaining phases)

- `scanners/` is implemented (Phase 2). `contracts/`, `handles/`, `stack/` are still empty --
  see the plan file's Component 3-4 sections for exactly what each should contain, and the
  phased build order (Phase 3 through 6) for what to implement next and in what order.
- `~/.agents/skills/archify/` is the packaging precedent to copy from directly: `schemas/` +
  ajv-standalone-compiled validators (see `archify/scripts/generate-validators.mjs`, and this
  skill's own `package.json` already wires the same `generate:validators`/`check:validators`
  script names for when `scripts/generate-validators.mjs` is written in Phase 3).
- `~/.claude/skills/graphify/SKILL.md` is the structural precedent for this file's own
  numbered/gated workflow style, once later phases add more real steps here.
- Every new gate-emitting command must register its own entry in `GATE_RECOMPUTERS` in
  `bin/bskel.mjs` (see `D1` in `DECISIONS.md`) -- skipping this silently degrades that gate to
  "cannot detect staleness."
