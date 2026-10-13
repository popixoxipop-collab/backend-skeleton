# T00-03 lease protocol

Who may write which paths, for how long, and how a result is checked against that lease. The ownership map
(`INTERFACE_RFC.md`) says which track owns a path; a lease says which worker holds part of that ownership for a limited
time. `check-lease.mjs` is the gate and `lease-ledger.mjs` is the model it runs.

## Inputs

- The lease ledger, a JSON file with the schema `bskel.t00-lease-ledger/1`: `counters` (track id to the highest fencing
  token issued to that track) and `claims` (a list).
- A claim holds `claim_id`, `track`, `repository`, `worker`, `worktree`, `base_sha`, `path_scopes`, `issued_at`,
  `expires_at`, `fencing_token` and `state` (`ACTIVE`, `RELEASED` or `EXPIRED`). Every field is required.
- The ownership map `ownership-map.json` of the checkout (`--repo-dir`, default this checkout). The gate first verifies
  that the map is derived from its inputs, as `check-ownership.mjs map` does; a stale map stops the gate with that
  gate's errors. The policy of a track is the plan, suite and extra scopes the map lists for it.
- The instant `--at`, a UTC time like `2026-10-09T00:00:00Z`. The gate reads no clock; the caller states the time.
- For `result`: the claim id, the fencing token, the base and head commits of the result, and the changed paths (operands,
  or the paths git reports between base and head in `--repo-dir`, listed as `check-ownership.mjs paths --git-diff` does).

## Identity

A claim is named by `claim_id` (letters, digits, `.`, `_` and `-`, starting with a letter or digit), unique in the
ledger. `worker` and `worktree` are labels, not credentials. What ties a result to a claim is the claim id together with
the fencing token.

## Rules

Ledger:

1. Shape. Every field of a claim is required and has the form above. A missing or malformed field is an error, never a
   default.
2. Time. A lease is half-open: live from `issued_at` (inclusive) until `expires_at` (exclusive), and `expires_at` is after
   `issued_at`. Instants are strict UTC (`YYYY-MM-DDTHH:MM:SSZ`) and must exist on the calendar.
3. Reservation. Only a live `ACTIVE` claim reserves scope; `RELEASED` and `EXPIRED` claims reserve nothing, whatever their
   times. The `ledger` command also reports every `ACTIVE` claim whose lease is over or has not started at `--at`, so an
   expired claim has to be marked before the ledger passes.
4. Ownership. The repository of a claim is the repository of its track, and every scope of the claim lies inside a scope
   the map gives that track (equal or below, with case counted).
5. Conflicts. Two live `ACTIVE` claims of one repository do not hold overlapping scopes. Overlap ignores case, as a
   case-insensitive file system does.
6. Fencing. Within a track the tokens rise strictly in ledger order, and `counters[track]` is at least the token of every
   claim of that track. A claim whose track has no counter fails.

Result:

7. The claim exists once, is `ACTIVE`, and the result is judged inside its lease. Only the named claim's time is judged;
   the expiry of another claim does not fail a result.
8. The result carries the claim's token. A token below the track's counter is reported as stale.
9. The base of the result is the claim's base, and its head is 40 lowercase hex digits.
10. The result names at least one path. Each path is normalized (a leading `./` is dropped) and refused when it is empty,
    holds a NUL byte, has a `..` segment or holds a backslash; a backslash is a file-name character in git, so it is not
    read as a separator. Each path lies inside a scope of the claim, with case counted: a path that matches only when
    case is ignored is outside.

## Unknown and partial cases

- Nothing is skipped silently. A field the gate needs and cannot read is an error. A check that needs a value an earlier
  error made unusable (the scopes of an unknown track, for example) is not run for that claim; the earlier error is
  already reported.
- A ledger without the schema, the object `counters` and the array `claims` gives one error and nothing else is judged.
  A claim id the ledger does not hold, or holds twice, gives one error for the result.
- An unreadable or non-JSON ledger, a missing flag or a malformed `--at` is a usage error: exit code 1, a message on
  stderr and nothing on stdout. A git diff between base and head that is empty is also exit code 1, because nothing to
  check is not a pass.
- The gate prints either one `OK` line or only `FAIL` lines. There is no partial pass.

## Commands

```
node next/t00/check-lease.mjs [--repo-dir <dir>] ledger --ledger <file> --at <instant>
node next/t00/check-lease.mjs [--repo-dir <dir>] result --ledger <file> --at <instant> --claim <id> --token <n> --base <sha> --head <sha> [<path>...]
```

Exit code 0 means verified, 2 means errors (one `FAIL <code> <subject> <detail>` line each; control characters in a subject
or detail are printed as `\xNN`, so one error is one line), 1 means usage or unreadable input. `result` runs the ledger
checks first, without the lease currency check of the other claims.

Intended use, a convention that no code enforces: the lead appends a claim with the next token of the track and raises
`counters[track]` to that token in the same change; `ledger` should pass before the worker starts; at hand-in the lead runs
`result` with the claim, token, base and head; after the merge or the abandonment the claim is set to `RELEASED` or
`EXPIRED`.

## Codes

| Code | Raised when |
|---|---|
| `LEDGER_SCHEMA` | the ledger lacks the schema, an object `counters` or an array `claims`, or a counter is not a non-negative integer |
| `INVALID_CLAIM` | a claim is not an object, its `claim_id` is missing or outside the allowed characters, or `worker` or `worktree` is missing or empty |
| `DUPLICATE_CLAIM_ID` | another claim has the same `claim_id` |
| `UNKNOWN_TRACK` | a claim or a counter names a track the ownership map does not hold |
| `TRACK_REPO_MISMATCH` | the repository of the claim differs from the repository the map gives its track |
| `INVALID_BASE_SHA` | the `base_sha` of a claim, or the base of a result, is not 40 lowercase hex digits |
| `INVALID_FENCING_TOKEN` | `fencing_token` is not a positive integer |
| `INVALID_LEASE_TIME` | `issued_at` or `expires_at` is not a strict UTC instant that exists on the calendar (a malformed `--at` is refused earlier, as a usage error) |
| `INVALID_LEASE_INTERVAL` | `expires_at` is not after `issued_at` |
| `INVALID_CLAIM_STATE` | `state` is not `ACTIVE`, `RELEASED` or `EXPIRED` |
| `MISSING_PATH_SCOPES` | `path_scopes` lists no scope |
| `INVALID_CLAIM_SCOPE` | a scope breaks the scope grammar of the ownership model |
| `SCOPE_OUTSIDE_OWNERSHIP` | a scope lies inside no scope of the claim's track |
| `FENCING_TOKEN_REGRESSION` | a token is not greater than the previous token of its track in ledger order |
| `LEDGER_COUNTER_BEHIND_CLAIM` | the counter of the track is missing or below the token of a claim |
| `LEASE_EXPIRED` | `ledger` only: the lease of an `ACTIVE` claim is over at `--at`; mark it `EXPIRED` or `RELEASED` |
| `LEASE_NOT_STARTED` | the lease starts after `--at`: for every `ACTIVE` claim under `ledger`, for the named claim under `result` |
| `ACTIVE_SCOPE_CONFLICT` | two live `ACTIVE` claims of one repository hold overlapping scopes, case ignored |
| `UNKNOWN_CLAIM` | `result` only: the ledger holds no claim with this id, or more than one |
| `RESULT_CLAIM_NOT_ACTIVE` | the claim is `RELEASED` or `EXPIRED` |
| `RESULT_AFTER_LEASE_EXPIRY` | the result is judged at or after the `expires_at` of the claim |
| `RESULT_FENCING_TOKEN_MISMATCH` | the token of the result differs from the token of the claim |
| `RESULT_STALE_FENCING_TOKEN` | the token of the result is below the counter of the track |
| `RESULT_BASE_SHA_MISMATCH` | the base of the result is not the base of the claim |
| `INVALID_RESULT_HEAD_SHA` | the head of the result is not 40 lowercase hex digits |
| `INVALID_RESULT_PATH` | the result names no path, or a path that is empty, holds a NUL byte, has a `..` segment or holds a backslash |
| `RESULT_PATH_OUTSIDE_CLAIM` | a path lies inside no scope of the claim; a match that needs case ignored counts as outside |

## Limits

- The gate is run by hand. No workflow calls `check-lease.mjs` and nothing blocks a merge on its result; only
  `test/t00-lease.test.mjs`, which the root `npm test` runs, exercises it.
- The ledger is a file, not a service. The gate verifies the file it is given; it cannot tell that a worker read an older
  copy.
- A fencing token protects only where this gate runs. A writer that never presents its token to the gate is not stopped.
- `worker` and `worktree` are names. Nothing here authenticates who wrote a result.
- The instant is an argument. The gate does not know whether the caller passed the real time.
- The gate does not check that a commit exists when paths are given as operands, nor that the head descends from the base.
- `lease-report.json` and `fixtures/lease-ledger.json` are coupled to the ownership map: they name scopes of T00, T05 and
  T07. A change to those scopes fails the recorded cases until the fixture is adjusted and the report is regenerated
  with `make-lease-report.mjs --write`.
- No live ledger is committed. The fixture holds fixed instants and is not a record of any real claim.

## Provenance

The lease and fencing vocabulary follows the lease sources of the coordination branch `scale/T00/bootstrap-baseline` at
commit `7b517e7a3a566eca80f680f01687a946a4b32461`. They were read for vocabulary; nothing was copied or imported, and that
branch may be deleted without effect here.
