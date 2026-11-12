# T22-06 package release replay and rollback evidence

This additive tool closes the package-level replay/rollback-bundle gap after T22-05
installed SDK delivery. It never publishes npm packages or changes a running service.
The historical SDK baseline, README and earlier task numbering remain unchanged.

## Exact scope

`release-replay.mjs build` creates two real npm archives from exact Git commits:
the previous package and a candidate containing the first-party SDK. It retains each
archive, complete Git-derived package file hashes, source commit/tree identities,
pack command logs and the current replay harness hashes in one manifest.

`release-replay.mjs replay` first checks an **externally supplied manifest SHA-256**
and both retained archives. It then uses one new, disposable consumer prefix:
previous install → candidate install/probe → previous reinstall/probe. It checks the
complete installed package inventory against the selected source inventory at every
step, including absence of candidate-only SDK files after rollback. Candidate
failure still triggers baseline restoration once the initial baseline was verified.
The failure stays a failure; successful restoration does not convert it to PASS.

The SDK probe imports only the installed first-party SDK, loads all nine schemas,
validates a normal manifest, verifies manual activation and exercises an injected
in-memory `unknown` provider response. It never imports an external adapter.

## Commands

Run from a trusted, reviewed checkout containing this tool. Both Git objects must
already be available; build performs no network fetch.

```sh
node next/t22/release-replay.mjs build --repo /absolute/repo \
  --previous <40-hex-previous-commit> --candidate <40-hex-candidate-commit> \
  --output /absolute/new-bundle-directory

node next/t22/release-replay.mjs replay --bundle /absolute/bundle \
  --manifest-sha256 <independently-recorded-manifest-sha256> \
  --output /absolute/new-run-directory
```

The digest printed by build must be reviewed/retained separately from the bundle.
Do not treat the editable `manifest.sha256` file as an independent trust anchor.
Do not replay an unreviewed bundle: fixed digest checks establish identity, not
permission to execute arbitrary package code. The harness refuses a bundle bound
to different probe/module bytes; use the same reviewed harness for reproduction.

Build exit 0 means archives and manifest were retained. Replay exit 0 means the
entire baseline→candidate→rollback rehearsal passed. Invalid input, command/probe
failure or failed restoration is exit 2. Existing output directories are never
overwritten. Receipts retain command/exit/signal/error and stdout/stderr hashes.
Inspect `status`, not merely the existence of `receipt.json`.

## Prerequisites and limits

Trusted Git, Node, installed npm and operating system are required. npm entrypoint
bytes are selected and checked using the existing T22 distribution helper.
All installs use `--offline --ignore-scripts`, so exact dependency versions must
already exist in npm's cache. This is not a hermetic dependency-complete bundle.
Current validation targets POSIX hosts with `git` and `tar`; no new Windows support
or old-Node support is claimed by this task.

Rollback is a disposable **package-level reinstall**, not an atomic service rollout,
database rollback or zero-downtime recovery. The package inventory is restored;
external application state does not exist in the rehearsal. Processes and fixtures
use bounded timeouts. Host compromise, arbitrary concurrent modification of the
private scratch directory and power-loss recovery are outside this tool's claim.

Every manifest/receipt keeps `release_authorized=false`, `runtime_certified=false`,
and `publication_performed=false`. These artifacts support a later review; they
cannot approve themselves or satisfy unrelated global release gates.

## Acceptance

The existing root test glob executes `test/t22-replay-bundle.test.mjs`, which exports
immutable repository sources to a disposable Git fixture and uses the real current
first-party SDK. It covers two successful replays, byte-exact restoration, corrupt
archives, metadata rehashing, unsafe/duplicate inventories, substituted harnesses,
protected evidence outputs and a genuine candidate-load failure with recovery.
These are reproducible development fixtures, not a fresh holdout.

In addition, delivery must retain a run built from the actual previous and candidate
project commits. Required whole-repository CI, independent code review, protected
main merge and the T00 scoped audit remain separate gates. No MET credit is implied
by unmerged local evidence.
