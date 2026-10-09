# T00-02 ownership map: interface RFC

Status: draft, reviewed with the pull request that adds `next/t00/ownership-map.json`. It says which track may write which
path in which repository and describes the gate that checks it. The gate only reads; it edits no hot file.

## 1. Inputs and output

| input | file | supplies |
|---|---|---|
| plan snapshot | `next/t00/fixtures/plan-write-scopes.json` | id, track, repository and write scopes of every plan task (the plan folder is in no repository) |
| nested runner | `scripts/run-next-nested-tests.mjs` (`SUITES`) | source and test directories of each track that has a nested suite |
| rules | `next/t00/fixtures/ownership-rules.json` | the reserved hot paths of each repository and the limits the map states |
| baseline lock | `next/t00/baseline.lock.json` | the repository roles and the files each private repository was observed to hold |
| T00 tests | `test/t00-*.test.mjs` | the extra scopes of T00 |

The output is `next/t00/ownership-map.json`, written only by `node next/t00/build-ownership-map.mjs`. It lists every track
with its repository and three scope lists (`plan_scopes`, `suite_scopes`, `extra_scopes`), the reserved hot paths, the
limits, and the canonical sha256 of each input. The checker recomputes the map from the inputs and fails if the committed
map differs from it in any member, extra or missing.

## 2. Identity

- Track: `Tnn`, one repository role per track (`bskel`, `becoder` or `beval`). Task ids are `Tnn-nn`.
- Scope: a repository-relative path with forward slashes, either one file or a directory written with a trailing `/**`.
  A segment uses only `[A-Za-z0-9._@+-]`: no other glob, no `.` or `..`, no empty segment, no backslash.
- Two scopes collide when one covers the other. Case is ignored in that comparison, because macOS and Windows treat `A` and
  `a` as one name.

## 3. Rules

1. A path is owned by the track whose scope covers it, and no path may be covered by two tracks of one repository
   (`SCOPE_COLLISION`). Plan scopes come from the track's tasks, suite scopes from the nested runner, and T00 also owns each
   `test/t00-*.test.mjs` (extra scopes exist for no other track).
2. Every directory of a nested suite lies inside a scope of its track (`SUITE_SCOPE_MISSING`), and every suite names a track
   of the map (`SUITE_UNKNOWN_TRACK`). T00, T15 and T16 have no nested suite and get no suite scopes.
3. A reserved hot path belongs to no track. It must exist (`HOT_PATH_MISSING`) and no scope may touch it (`HOT_PATH_CLAIMED`).
4. The plan scopes and the repository of a track in the map equal the plan snapshot's (`PLAN_SCOPE_MISMATCH`).
5. A path inside no scope is stable surface: nobody owns it, so a track that changes it fails (`PATH_UNOWNED`).

## 4. Unknown and partial

- An unknown track, an unknown path, an invalid path and a path that matches only when case is ignored all fail. A fact the
  gate cannot judge is never reported as met.
- `paths` first verifies the whole map against its inputs. A stale map fails there with `MAP_NOT_DERIVED` before any path
  is judged.
- A part of the context that is not given is not checked: the function `checkMap` skips the plan, suite and existence checks
  when its caller passes no plan, suites or `pathExists`. The CLI passes all three and its `OK` line names the checks run.
- Files of becoder and beval are not in this checkout. Whether their reserved files exist is judged against the artifacts
  that the baseline lock records for them, not against a live repository.
- Ownership is judged on path names only; contents, modes and symlinks are not read. With `--git-diff` a rename is checked
  as a delete and an add, so both names must belong to the track.

## 5. Commands and exit codes

```
node next/t00/check-ownership.mjs map
node next/t00/check-ownership.mjs paths --track T05 scanners/language/jvm/a.mjs test/language-jvm/b.mjs
node next/t00/check-ownership.mjs paths --track T05 --git-diff <merge-base> HEAD
node next/t00/build-ownership-map.mjs
node next/t00/make-ownership-report.mjs --write
node next/t00/snapshot-plan.mjs --check <backlog.json>
```

Exit 0: verified. Exit 2: errors, one stdout line each, `FAIL <code> <subject> <detail>`; control characters in a file name
are escaped as `\xNN`, so a name cannot add a line. Exit 1: usage error or unreadable input, a message on stderr and nothing
on stdout. `--repo-dir <dir>` checks another checkout and imports (runs) that checkout's nested runner.

## 6. Codes

| code | raised when |
|---|---|
| `MAP_SCHEMA` | the map is not an object of this schema or lacks a member the checks read |
| `DUPLICATE_TRACK` | a track is listed twice |
| `INVALID_SCOPE` | a scope breaks the grammar, or an extra scope is not a T00 test file |
| `SCOPE_COLLISION` | two tracks of one repository own overlapping scopes |
| `HOT_PATH_MISSING` | a reserved path is not in the checkout, or not in the lock's artifacts of a private repository |
| `HOT_PATH_CLAIMED` | a track's scope overlaps a reserved path |
| `PLAN_SCOPE_MISMATCH` | a track's plan scopes or repository differ from the plan snapshot, or a track is on one side only |
| `SUITE_UNKNOWN_TRACK` | the nested runner has a suite for a track that the map does not hold as a bskel track |
| `SUITE_SCOPE_MISSING` | a suite directory lies inside no scope of its track |
| `INPUT_INVALID` | the plan snapshot, rules, lock, runner or T00 test names are invalid; the map is not judged |
| `MAP_NOT_DERIVED` | the committed map differs from the map derived from the inputs |
| `UNKNOWN_TRACK` | `--track` names a track the map does not hold in that repository |
| `INVALID_PATH` | a path is empty, absolute, has `..` or an empty or dot segment, or (from git) has a backslash |
| `PATH_OWNED_BY_OTHER_TRACK` | a scope of another track covers the path |
| `PATH_RESERVED_HOT` | the path is a reserved hot path or lies inside one |
| `PATH_CASE_MISMATCH` | the path matches a scope or reserved path only when case is ignored |
| `PATH_UNOWNED` | the path lies inside no scope and no reserved path |
| `PLAN_SNAPSHOT_STALE` | printed by `snapshot-plan.mjs --check`: the snapshot differs from the backlog |

## 7. Reserved hot paths

| repository | reserved paths |
|---|---|
| bskel | `package.json`, `package-lock.json`, `.github/workflows/**`, `CATALOG.md`, `DECISIONS.md`, `README.md`, `scripts/run-next-nested-tests.mjs` |
| becoder, beval | `package.json`, `package-lock.json`, `.github/workflows/**` |

## 8. How a track uses the gate

1. Before the push run `paths --track Tnn --git-diff <merge-base> HEAD`. Exit 0 means every changed path is the track's own.
2. A change that has to touch a reserved path or another track's path is a stated exception. Name the path and the reason
   in the pull request body and leave the edit to the coordinator. The gate has no override.
3. A change to `SUITES` (a hot file), to a plan write scope or to `test/t00-*.test.mjs` makes the committed map stale. Run
   `build-ownership-map.mjs` and `make-ownership-report.mjs --write` and commit both with the change; the map test in
   `test/t00-ownership.test.mjs` fails until then.

## 9. Limits

- The plan folder and the hot-path list of the playbook are in no repository. The snapshot and the rules file are their
  committed copies, and `snapshot-plan.mjs --check` against the backlog is a maintainer step, not a CI step.
- The map is coupled to the live `SUITES` list and the `test/t00-*.test.mjs` list of this checkout.
- Private-repository facts come from the lock and are not recomputable in CI.
- The task files live in `next/t00/`; the coordination branch keeps its maps in `integration/scale/`, not synchronized.

## 10. Provenance

Earlier maps are on the coordination branch `scale/T00/bootstrap-baseline` under `integration/scale/` (commit
`7b517e7a3a566eca80f680f01687a946a4b32461`). They were read and not copied; nothing here depends on them and CI does not
fetch that commit.
