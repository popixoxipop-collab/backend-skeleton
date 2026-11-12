# T21-01 — capped garbage-collection baseline supplement

## Scope and historical truth

This supplement addresses the capped-plan omission in the original T21-01 record.
`lib/scan-scheduler-next/BASELINE.json` remains a historical measurement of its
own exact commit. It is **not** replaced, re-sealed, or represented as a measurement
of this new observer. The old `lib/artifact-store-next/gc.mjs` is unchanged.
All its normal and negative fixtures and its previously recorded limitations remain.

The legacy collector returns a **digest-ordered prefix**, not a best-fit subset.
It checks reachability and minimum age first, then stops at the first eligible
blob exceeding the count or byte budget. It does not search behind that blob.
It returns the same shape for a complete and a capped plan; `total_blobs` includes
protected and young blobs, and therefore cannot determine completeness.

Concrete development fixture in digest order: 20-byte `cccccccccccccccccccc`,
5-byte `small`, 7-byte `1234567`. The complete plan has three blobs and32bytes.
A6-byte budget selects **zero**, even though a5-byte blob exists later. A20-byte
budget or one-item budget selects the first20-byte blob and leaves two blobs.
A0-byte budget on nonempty eligible input is not evidence of an empty store.
Those legacy results remain valid only as capped prefixes, not complete inventories.

`gc-baseline-probe.mjs` executes both implementations on these actual temporary
content-addressed files, checks the legacy outputs against explicit expectations,
and emits eleven complete normal/counterexample observations. It neither opens
caller stores nor deletes anything outside its own disposable fixture.
The repository-resident `evidence/` record identifies the exact source commit,
command, exit, source-file hashes, raw stdout and test counts for that execution.
The current CI bridge rechecks the retained evidence and repeats the probe.
This is development evidence, not an unseen holdout or signed host attestation.

## Additive read-only observation

The opt-in `observeGarbagePlan()` and CLI in `gc-plan.mjs` expose the omission
without changing the old collector's output contract or default scan path.

```sh
node next/t21/gc-plan.mjs /absolute/caller-owned/store --max-count 100 --max-bytes 1048576
node next/t21/gc-baseline-probe.mjs
node --test test/t21-gc-plan.test.mjs
```

| Field | Meaning |
|---|---|
| `selection_policy` | `digest-ordered-prefix`; never best-fit packing. |
| `selection_complete` | Every observed eligible regular blob was selected. |
| `inventory_complete` | No unexpected entries occurred in this observed layout. |
| `status` | `complete` only when both booleans are true, otherwise `partial`. |
| `stop_reason` | `max_delete_count`, `max_delete_bytes`, or null when nothing was deferred. |
| `eligible_count` / `eligible_bytes` | All observed valid, unreachable, old-enough blobs before budget selection. |
| `deferred_count` / `deferred_bytes` | Eligible blobs not selected, including everything behind the first over-budget item. |
| `first_deferred` | First omitted eligible blob, or null. |
| `unexpected` | Malformed names, nonregular members or unexpected prefixes; not traversed or selected. |

Reaching the budget exactly on the final eligible blob is complete. An empty
eligible set with a zero budget is complete. Reachable/young blobs do not count
as deferred. Unexpected layout entries make the overall status partial even if
all known eligible blobs fit. Invalid numbers, invalid reachable identities,
nonfinite clock, nonexistent caller root, or a symlink in the immediate root /
blobs / sha256 layout throw; the CLI returns2 and does not emit a success object.
An existing real directory with no blobs layout is an empty observed store.

`dry_run=true`, `deleted=[]`, `deletion_authorized=false`, and
`content_integrity_verified=false` are invariant. `dryRun:false` is rejected.
The CLI returns0 for either a complete or partial successfully observed plan;
consumers must inspect `status`. It writes JSON to stdout only. There is no apply
mode or automatic live-retention integration.

## Limits and ownership

The filesystem, input options and quiescent caller-owned store are trusted.
This is not a filesystem sandbox, content-hash verification, an atomic snapshot,
a durable deletion lease or a proof against hostile concurrent filesystem changes.
Read/list errors propagate instead of becoming a complete result. Candidate limits
bound selection only; traversal still enumerates the whole store and is not a
memory/time budget. Regular-file sizes and aggregate bytes must be safe integers.
The legacy collector's historical concurrency and deletion limits are not fixed
or upgraded by this read-only observer. Stable scan wiring, provider integration,
performance certification, Windows certification and global release authority
remain outside this T21-01 baseline supplement.

Implementation, fixtures, record and these limits belong to `next/t21/**`.
`test/t21-gc-plan.test.mjs` and `test/t21-gc-evidence.test.mjs` are additive T00
coordinator-owned CI discovery bridges, requiring an explicit exception under
`next/t00/INTERFACE_RFC.md` section8. No existing T21 source, historical baseline,
workflow, ownership checker, other track, release rule or deletion policy changes.
T21-02 RFC shortcomings are not claimed resolved by this supplement.
