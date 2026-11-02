# T00-03 lease protocol

Who may write which paths, for how long, and how a result is checked against that lease. The ownership map
(`INTERFACE_RFC.md`) says which track owns a path; a lease says which worker holds part of that ownership for a limited
time. `check-lease.mjs` is the gate, `lease-ledger.mjs` is the model it runs and `seal-lease-ledger.mjs` computes the
digests of a ledger. The lease gates are run by hand and are not wired into CI (see Limits). The separate read-only MET conveyor has its own CI workflow; it does not run lease gates.

## Inputs

- The lease ledger, a JSON file with the schema `bskel.t00-lease-ledger/1` and the members `counters` (track id to the
  highest fencing token issued to that track), `claims` (a list) and `head_digest`. A ledger with any other member fails.
- A claim holds `claim_id`, `track`, `repository`, `worker`, `worktree`, `base_sha`, `path_scopes`, `issued_at`,
  `expires_at`, `fencing_token` and `state` (`ACTIVE`, `RELEASED` or `EXPIRED`), then `prev_digest` and `entry_digest`.
  Every one is required, and a claim with any other member fails.
- The ownership map `ownership-map.json` of the checkout (`--repo-dir`, default this checkout). The gate first verifies
  that the map is derived from its inputs, as `check-ownership.mjs map` does; a stale map stops the gate with that
  gate's errors and exit code 2 before the ledger is judged. The policy of a track is the plan, suite and extra scopes the
  map lists for it.
- The instant `--at`, a UTC time like `2026-10-09T00:00:00Z`. The gate reads no clock; the caller states the time.
- Optionally a head digest kept outside the ledger file, `--head-digest` (see Digests, head and pin).
- For `result`: the claim id, the worker and the worktree that hand the result in, the fencing token, the base and head
  commits of the result, and the changed paths (operands, or, when there are none and both commits are 40 hex digits, the
  paths git reports between base and head in `--repo-dir`, listed as `check-ownership.mjs paths --git-diff` does, a rename
  counting as a delete and an add).

## Identity

A claim is named by `claim_id` (letters, digits, `.`, `_` and `-`, starting with a letter or digit), unique in the
ledger. A result names its claim by that id and the holder by `--worker` and `--worktree`, which must equal the `worker`
and `worktree` of the claim character for character (`RESULT_WRONG_HOLDER`, one error for each of the two). The names are
labels that the lead writes into the claim and the caller types; nothing authenticates them (see Limits). What ties a
result to its claim is the claim id, the holder, the fencing token and the base commit.

## Rules

Ledger:

1. Shape. Every field of a claim is required and has the form above, and neither the ledger nor a claim holds another
   member. A missing or malformed field is an error, never a default.
2. Time. A lease is half-open: live from `issued_at` (inclusive) until `expires_at` (exclusive), and `expires_at` is after
   `issued_at`. Instants are strict UTC (`YYYY-MM-DDTHH:MM:SSZ`) and must exist on the calendar.
3. Reservation. Only a live `ACTIVE` claim reserves scope; `RELEASED` and `EXPIRED` claims reserve nothing, whatever their
   times. The `ledger` command also reports every `ACTIVE` claim whose lease is over or has not started at `--at`, so an
   expired claim has to be marked before the ledger passes.
4. Ownership. The repository of a claim is the repository of its track, and every scope of the claim lies inside a scope
   the map gives that track (equal or below, with case counted). A reserved hot path belongs to no track, so no claim
   can hold it.
5. Conflicts. Two live `ACTIVE` claims of one repository do not hold overlapping scopes. Overlap ignores case, as a
   case-insensitive file system does.
6. Fencing. Within a track each token is greater than every earlier token of that track in ledger order, and
   `counters[track]` is at least the token of every claim of that track. A claim whose track has no counter fails, and so
   does a counter for a track the map does not hold.
7. Digests. The digests of every claim and of the ledger are what the contents hash to (next section).

Result:

8. The claim exists, is `ACTIVE`, and the result is judged inside its lease. Only the named claim's time is judged; the
   expiry of another claim does not fail a result.
9. The result names the holder of the claim: its worker and its worktree both equal the claim's.
10. The result carries the claim's token. A token below the track's counter is reported as stale as well.
11. The base of the result is the claim's base, and its head is 40 lowercase hex digits.
12. The result names at least one path. Each path is normalized (a leading `./` is dropped) and refused when it is empty,
    holds a NUL byte, has a `..` segment or holds a backslash; a backslash is a file-name character in git, so it is not
    read as a separator. Each path lies inside a scope of the claim, with case counted: a path that matches only when
    case is ignored is outside.

## Digests, head and pin

Every claim carries `prev_digest`, the `entry_digest` of the claim before it (64 zeros for the first), and
`entry_digest`, the SHA-256 of the JSON text, written without spaces, of an object that holds the eleven fields of the
claim in the order listed under Inputs and then `prev_digest`. A member the claim lacks is left out of that object, and
the order of the members in the file does not matter. The ledger carries `head_digest`, the SHA-256 of the JSON text,
also without spaces, of the array `[schema, number of claims, entry_digest of the last claim (64 zeros when there is
none), [track, counter] pairs sorted by track]`. A digest is 64 lowercase hex digits.

- `LEDGER_ENTRY_DIGEST_MISMATCH`: a claim was edited after it was sealed. Only that claim fails.
- `LEDGER_CHAIN_BROKEN`: a claim before the last one was removed, a claim was added or claims were moved.
- `LEDGER_HEAD_DIGEST_MISMATCH`: the head does not match the count, the last digest and the counters, so a claim cut off the
  end, a claim added at the end or a changed counter fails here (and a claim removed from the middle fails here too).

The digests are not secret, and `seal-lease-ledger.mjs` computes them for any content, so a ledger rewritten and sealed
anew passes the three checks above. Only a head digest kept outside the file tells it from the original:
`--head-digest <sha256>` makes the gate fail with `LEDGER_HEAD_PIN_MISMATCH` when the head of the ledger differs, and the
`OK` line of `ledger` says whether the head was pinned. A pin stored where the person who edits the ledger can also write
it protects nothing.

## Versions and exit codes

A ledger whose schema begins with `bskel.t00-lease-ledger/` and is not exactly `bskel.t00-lease-ledger/1` gets one error,
`LEDGER_VERSION_UNSUPPORTED`, and exit code 3; nothing else of that ledger is judged. Any other schema, or none, is
`LEDGER_SCHEMA` with exit code 2. The exit codes of the gate:

- 0: verified; one `OK` line on stdout.
- 1: usage error or unreadable input; a message on stderr and nothing on stdout.
- 2: errors; one `FAIL <code> <subject> <detail>` line each and nothing else on stdout. Control characters in a subject or
  detail are printed as `\xNN`, so one error is one line.
- 3: the ledger has another schema version.

## The seal tool

`seal-lease-ledger.mjs <file>` prints the ledger with `prev_digest`, `entry_digest` and `head_digest` computed, in ledger
order. It reads the file, prints to stdout and writes nothing. It judges nothing and signs what it is given. It exits with
code 1, a message on stderr and nothing on stdout, for a usage error (not exactly one operand, or an operand that starts
with `--`) and for input it cannot hash: a file that cannot be read or is not JSON, a ledger that is not an object of this
schema with `counters` and `claims`, a member that a ledger or a claim does not have, a counter that is not a non-negative
integer, or a claim member that is not a plain value. To edit a ledger on purpose, edit it, seal it into a new file, run
`check-lease.mjs ledger` on that file, and only then replace the ledger and record the new head digest as the pin.

## Unknown and partial cases

- Nothing is skipped silently. A field the gate needs and cannot read is an error. A check that needs a value an earlier
  error made unusable (the scopes of an unknown track, for example) is not run for that claim; the earlier error is
  already reported.
- A ledger without the schema, the object `counters` and the array `claims` gives one error and nothing else is judged.
  A claim id the ledger does not hold gives one error for the result and nothing else is judged; a claim id held twice
  never reaches the result check, because the ledger checks stop it as `DUPLICATE_CLAIM_ID`.
- A usage error is exit code 1 with a message on stderr and nothing on stdout: an unknown or repeated option, an option
  without its value, a missing flag, a malformed `--at`, `--head-digest` or `--token`, and a `ledger` command given result
  flags or paths. So is an input the process cannot read or parse: the ledger, the ownership map or one of its inputs. A
  ledger that the process may not read (`EACCES`) is such an input and never a verdict. A git diff between base and head
  that is empty is also exit code 1, because nothing to check is not a pass. So is a git diff that git cannot produce, for
  example because the checkout does not hold the base commit: stderr then starts with `git diff <base> <head> failed in`
  followed by the directory, a colon and git's own message.
- The gate prints either one `OK` line or only `FAIL` lines. There is no partial pass.

## Commands

```
node next/t00/check-lease.mjs [--repo-dir <dir>] ledger --ledger <file> --at <instant> [--head-digest <sha256>]
node next/t00/check-lease.mjs [--repo-dir <dir>] result --ledger <file> --at <instant> --claim <id> --worker <name> --worktree <name> --token <n> --base <sha> --head <sha> [--head-digest <sha256>] [<path>...]
node next/t00/seal-lease-ledger.mjs <ledger.json>
```

`result` runs the ledger checks first, all of them but the lease currency check, so that an `ACTIVE` claim that is over or
not yet started elsewhere in the ledger is no error there; it then judges the result against the claim it names, whose own
time is judged. The recorded runs and the mutation check are `node next/t00/make-lease-report.mjs --check` and
`node next/t00/lease-mutants.mjs`.

Intended use, a convention that no code enforces: the lead appends a claim with the next token of the track, raises
`counters[track]` to that token, seals the ledger and records the head digest outside the file; `ledger --head-digest`
should pass before the worker starts; at hand-in the lead runs `result` with the claim, the holder, the token, the base
and the head; after the merge or the abandonment the claim is set to `RELEASED` or `EXPIRED` and the ledger is sealed
again.

## Codes

| Code | Raised when |
|---|---|
| `LEDGER_SCHEMA` | the ledger is not an object with the schema `bskel.t00-lease-ledger/1`, an object `counters` and an array `claims` (another version of the schema has its own code), or a counter is not a non-negative integer |
| `INVALID_CLAIM` | a claim is not an object, its `claim_id` is missing or outside the allowed characters, or `worker` or `worktree` is missing or empty |
| `DUPLICATE_CLAIM_ID` | another claim has the same `claim_id` |
| `UNKNOWN_TRACK` | a claim or a counter names a track the ownership map does not hold |
| `TRACK_REPO_MISMATCH` | the repository of the claim differs from the repository the map gives its track |
| `INVALID_BASE_SHA` | the `base_sha` of a claim, or the base of a result, is not 40 lowercase hex digits |
| `INVALID_FENCING_TOKEN` | `fencing_token` is not a positive integer |
| `INVALID_LEASE_TIME` | `issued_at` or `expires_at` is not a strict UTC instant that exists on the calendar (a malformed `--at` is refused earlier, as a usage error) |
| `INVALID_LEASE_INTERVAL` | `expires_at` is not after `issued_at` |
| `INVALID_CLAIM_STATE` | `state` is not `ACTIVE`, `RELEASED` or `EXPIRED` |
| `MISSING_PATH_SCOPES` | `path_scopes` is not a list or lists no scope |
| `INVALID_CLAIM_SCOPE` | a scope breaks the scope grammar of the ownership model |
| `SCOPE_OUTSIDE_OWNERSHIP` | a scope lies inside no scope of the claim's track |
| `FENCING_TOKEN_REGRESSION` | a token is not greater than every earlier token of its track in ledger order |
| `LEDGER_COUNTER_BEHIND_CLAIM` | the counter of the track is missing or below the token of a claim |
| `LEASE_EXPIRED` | `ledger` only: the lease of an `ACTIVE` claim is over at `--at`; mark it `EXPIRED` or `RELEASED` |
| `LEASE_NOT_STARTED` | the lease starts after `--at`: for every `ACTIVE` claim under `ledger`, for the named claim under `result` |
| `ACTIVE_SCOPE_CONFLICT` | two live `ACTIVE` claims of one repository hold overlapping scopes, case ignored |
| `LEDGER_VERSION_UNSUPPORTED` | the schema begins with `bskel.t00-lease-ledger/` and is not `bskel.t00-lease-ledger/1`; exit code 3, and nothing else of the ledger is judged |
| `UNKNOWN_LEDGER_MEMBER` | the ledger or a claim holds a member that is not listed under Inputs |
| `INVALID_LEDGER_DIGEST` | a `prev_digest`, `entry_digest` or `head_digest` is missing or is not 64 lowercase hex digits |
| `LEDGER_ENTRY_DIGEST_MISMATCH` | the `entry_digest` of a claim is not the hash of the claim |
| `LEDGER_CHAIN_BROKEN` | the `prev_digest` of a claim is not the `entry_digest` of the claim before it (64 zeros for the first) |
| `LEDGER_HEAD_DIGEST_MISMATCH` | `head_digest` is not the hash of the schema, the number of claims, the last `entry_digest` and the counters |
| `LEDGER_HEAD_PIN_MISMATCH` | `--head-digest` is given and the `head_digest` of the ledger differs from it |
| `UNKNOWN_CLAIM` | `result` only: the ledger holds no claim with this id (the model also returns it for an id held twice, which the gate stops earlier) |
| `RESULT_CLAIM_NOT_ACTIVE` | the claim is `RELEASED` or `EXPIRED` |
| `RESULT_AFTER_LEASE_EXPIRY` | the result is judged at or after the `expires_at` of the claim |
| `RESULT_WRONG_HOLDER` | `--worker` or `--worktree` differs from the `worker` or `worktree` of the claim; one error for each that differs |
| `RESULT_FENCING_TOKEN_MISMATCH` | the token of the result differs from the token of the claim |
| `RESULT_STALE_FENCING_TOKEN` | the token of the result is below the counter of the track |
| `RESULT_BASE_SHA_MISMATCH` | the base of the result is not the base of the claim |
| `INVALID_RESULT_HEAD_SHA` | the head of the result is not 40 lowercase hex digits |
| `INVALID_RESULT_PATH` | the result names no path, or a path that is empty, holds a NUL byte, has a `..` segment or holds a backslash |
| `RESULT_PATH_OUTSIDE_CLAIM` | a path lies inside no scope of the claim; a match that needs case ignored counts as outside |

## Limits

- The gates are manual and not wired into CI. No workflow calls `check-lease.mjs`, `check-ownership.mjs` or
  `seal-lease-ledger.mjs`. The root `npm test`, which the CI test job runs, executes `test/t00-lease.test.mjs` and
  `test/t00-ownership.test.mjs`; they run the gates on fixtures and on this checkout's map, so a stale map or a stale
  `lease-report.json` fails that job. No job runs a gate on the diff of a pull request or on a real ledger.
- The ledger is a file, not a service. The gate verifies the file it is given; it cannot tell that a worker read an older
  copy.
- A fencing token protects only where this gate runs. A writer that never presents its token to the gate is not stopped.
- `worker` and `worktree` are names. The holder check catches a result handed in under the wrong claim; it does not
  authenticate who wrote a result.
- The digests are not secret and the seal tool signs anything. A ledger rewritten and sealed anew passes unless its head
  digest was kept outside the file and is given as `--head-digest`; the gate cannot tell where the pin was kept.
- The instant is an argument. The gate does not know whether the caller passed the real time.
- The gate does not check that a commit exists when paths are given as operands, nor that the head descends from the base.
- The map is read from the working tree that is judged, together with the inputs it is checked against. Whoever can
  change both can change the policy the gate applies, and `--repo-dir` imports (runs) the nested runner of that checkout.
- `lease-report.json` and `fixtures/lease-ledger.json` are coupled to the ownership map and to the sources named in
  `make-lease-report.mjs`: they name scopes of T00, T05 and T07. A change to one of them fails the recorded cases until
  the fixture is adjusted (and sealed again) and the report is regenerated with `make-lease-report.mjs --write`.
- No live ledger is committed. The fixture holds fixed instants and is not a record of any real claim.

## Provenance

The words claim, lease and fencing token follow `integration/scale/T00-03-LEASE-PROTOCOL.md` on the coordination branch
`scale/T00/bootstrap-baseline` at commit `7b517e7a3a566eca80f680f01687a946a4b32461`. That protocol also binds a claim to a
branch, an interface revision and a resource class and key; a claim here names none of them.
