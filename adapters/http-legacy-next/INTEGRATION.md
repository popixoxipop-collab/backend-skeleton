# T11 integration handoff

Status: stage 1 of the T11 revival. This directory carries the framework-independent core with
per-adapter pins for the five shipped adapters. It is shadow-only, not activated by default, and T11
is not declared complete.

Provenance: ported from the draft PR 77 branch `scale/t11-http-legacy-modernization` at head
`5d328f906dd81fde508c1cd652a6ab159e22a29e`. The stage began as a byte-identical port of the modules
listed below. Fixes that followed read-only review by substitute agent reviewers (not an independent
attestation) changed `parity.mjs`, `shadow-projection.mjs`, `cutover-readiness.mjs`,
`checkout-completeness.mjs` and their tests, and added `bridge.test.mjs`. `baselines.mjs`,
`bridge.mjs` and `baseline.test.mjs` are still byte-identical to that head. This document is
rewritten to describe what this stage ships. Numbers that PR 77 recorded from the producer machine
are PR 77 evidence and were not re-run here.

## Owned implementation

All T11 product and test files live under:

- `adapters/http-legacy-next/**`
- `test/http-legacy-next/**`

The stable scanner remains authoritative. This lane does not edit `scanners/index.mjs`,
`scanners/registry.mjs`, stable schemas, package manifests, workflows, or existing adapter
descriptors. The only files outside those two paths that this stage touches are
`scripts/run-next-nested-tests.mjs` and its test `test/run-next-nested-tests.test.mjs`: the runner
fails a suite that still declares itself absent once its source or tests exist, so the T11
`expectedAbsent` declaration is removed in the same change that adds the first T11 files.

## What this stage ships

| Module | Purpose |
| --- | --- |
| `baselines.mjs` | Descriptors and inventories for the five committed legacy fixtures (`java-spring`, `ruby-rails`, `python-fastapi`, `typescript-express`, `javascript-express`). Offline. |
| `bridge.mjs` | Lossless `sbf.http-legacy-bridge/1` wrapper (mode `compatibility-only`) around an existing legacy scan report. Fails closed on an adapter/report mismatch and on adapters outside T11. |
| `parity.mjs` | Semantic snapshot of a legacy report (each endpoint's HTTP `verb` and handler `method` included) and a bounded diff (`maxDiffs` 1..1000). The snapshot and digest depend on the checkout location unless the optional absolute `root` is passed. |
| `checkout-completeness.mjs` | Guard for sparse checkouts of ruby-rails and python-fastapi projects: it lists the tracked paths with `git ls-tree -r -z` and requires the files that adapter's scanner reads to exist. A checkout is sparse when `core.sparseCheckout` is `true` or any tracked entry carries the skip-worktree bit (`git ls-files -t -z`). Other sparse checkouts are refused; a working tree that is not sparse is reported complete without being checked. See "Corpus checkout completeness" for what is and is not verified. |
| `cutover-readiness.mjs` | Fail-closed 10-check migration checklist. |
| `shadow-projection.mjs` | Dependency-injected, non-authoritative comparison shell. |

Everything above runs offline: no network, no clone of an external repository, no installation of
target dependencies.

## Running it

The root test script is `node --test test/*.test.mjs`, which does not descend into nested
directories. T11 runs through the nested runner. `T11` is registered in
`scripts/run-next-nested-tests.mjs`, and CI runs it as the `T11 http-legacy-next` step of the
`nested-next` job:

```bash
node scripts/run-next-nested-tests.mjs T11
```

## Consequence of merging

`baselines.mjs` pins the descriptors (title, specificity, confidence, verification basis,
capabilities) and the fixture inventories (module list, counts, files read) of the five adapters, and
`baseline.test.mjs` checks them against the registry and the committed fixtures. Once this directory is
merged, that test is part of the required `T11 http-legacy-next` step of the `nested-next` job. A
later pull request that changes one of those five adapters or their fixtures in a way the pins record
must therefore also edit `adapters/http-legacy-next/baselines.mjs`, or that check turns red.

## Not in this stage

- `corpus-parity-cli.mjs`, `test/http-legacy-next/corpus-parity.test.mjs` and
  `test/http-legacy-next/fixtures/corpus-baseline.json` (the pinned 17-repository corpus baseline)
  stay in PR 77 and are planned as per-framework follow-up PRs. No pinned corpus digest exists in
  this stage; see "Location-independent snapshots and digests" before a follow-up reuses PR 77's.
- Re-running the corpus. It needs external repositories at pinned refs and is not part of CI.
- Any wiring into stable dispatch, schemas or packages. `apply_allowed` is always `false`, and
  `promotion_allowed` is always `false`.
- A frozen shared projection, a framework support or certification record, or ContractRef identity.

## T11-03 boundary

As recorded in PR 77 (2026-09-25) and not re-verified in this stage: T01 exact-byte HTTP identity and
the T03 five-state capability vocabulary are candidate seams. T02 ProjectGraph remained an internal
draft because its serialized graph still carried an absolute checkout path, so T11 must not publish a
portable normalized project identity derived from T02.

A stacked shadow integration may consume draft T02/T03 outputs only for differential measurement.
It must remain non-authoritative and must not replace `sbf.scan-report/2` or publish certification.

## T11-04 parity

`parity.mjs` compares only already-observed legacy scanner semantics and has a bounded diff.
Its semantic SHA-256 is regression-only and is explicitly not ContractRef identity.

The snapshot covers the report's adapter, confidence, API surface source, verdict, path-prefix
signals and `files_read`, and per module its name, controllers (class name, base path, file, and
each endpoint's handler `method`, HTTP `verb`, `path`, `operationId` and file), entities, enums and
DTOs. A scan report's endpoint carries both `method`, the handler's name, and `verb`, the HTTP verb, and
the snapshot keeps them apart. An endpoint without a `verb` records `null`, so a change that only flips,
changes the case of or removes an HTTP verb makes `equal` false, shows as a `value` difference at
`modules[i].controllers[j].endpoints[k].verb` and moves the digest. The snapshot does not cover line
numbers or the report's other fields (`terms`, `unknowns`, `collisions`, `rg_available`).

A digest computed before the `verb` became part of the snapshot is not comparable with one computed now:
every endpoint gained a key, so every digest changed, also for a report whose verbs did not change. That
includes any digest quoted from an earlier head of this stage's pull request, and PR 77's
`semantic_sha256` values, whose parity module never recorded the verb. The schema string stays
`sbf.http-legacy-semantic-snapshot/1` because nothing in this repository stores a snapshot or a digest
(no fixture, test pin or release file holds one), so there is no stored value that a new version string
would protect. Whoever pins a digest must compute it with this module.

### Location-independent snapshots and digests

A legacy scan report carries absolute paths in the `.file` of every controller, endpoint, entity, enum
and DTO, and it does not say which directory was scanned. Without more information the snapshot and
its digest depend on where the checkout lives: the same bytes scanned in two directories give two
digests, and a parity comparison differs at every file.

The optional `root` (or `expectedRoot` and `actualRoot` for a comparison) is the `repoRoot` string the
scan was given. It rewrites each `.file` to a POSIX path relative to that root:

- `legacyHttpSemanticSnapshot(report, { root })`, `legacyHttpSemanticDigest(report, { root })`,
  `compareLegacyHttpReports(expected, actual, { expectedRoot, actualRoot })` and
  `runLegacyHttpShadowProjection({ ..., root })`.
- Without these options the files stay as the scan reported them, so the snapshot and the digest again
  depend on where the checkout lives (the `verb` change above applies either way).
- It fails closed. A `.file` that is not strictly below the root (another directory, a sibling that
  shares a name prefix, a `..` climb, the root itself), is not a string or is not an absolute path
  throws. `root` must be a non-empty absolute path: `path.relative` would resolve a relative `root`
  or `.file` against the working directory, and the same report would then give different snapshots
  from different directories. Only a report (not a snapshot) can be given a `root`, and `expectedRoot`
  and `actualRoot` must be given together.
- This is narrower than what this branch accepted up to commit `d8883ce`: a relative `root`, and a
  relative `.file` given a `root`, were resolved against the process working directory there. All four
  entry points above now throw on them, `runLegacyHttpShadowProjection({ root })` before the projector
  is called. A caller that scanned with a relative `repoRoot` scans again with an absolute one and
  passes that string as `root`; a report is still accepted without `root`, with its files as reported.
- The scanner builds `.file` from the `repoRoot` string as passed and does not resolve symlinks, so
  scan with an absolute `repoRoot` and pass that same string as `root`. Given a relative `repoRoot`,
  the java-spring, ruby-rails, python-fastapi and typescript-express scanners put that string in
  front of every `.file` (`test/fixtures/java-spring/src/...`), a path relative to the scan's working
  directory and not to the root, and javascript-express reports absolute real paths; `root` rejects
  the first kind rather than guess the directory.
- The Rails scanner's `tmp`, `log`, `vendor/bundle`, `.bundle` and `node_modules` excludes are anchored
  at ripgrep's working directory, so for a project with a `Gemfile` below one of those trees
  `files_read`, and with it the snapshot and the digest (with a `root` too), depend on the directory
  the scan ran from. Pin a Rails digest from a fixed scan working directory. The committed ruby-rails
  fixture has no `Gemfile` below those trees, and each of the five committed fixtures gives the same
  digest (with its absolute `root`) from the repository root, from a temporary directory and from the
  fixture directory.
- The bridge still keeps the absolute paths in `bridge.legacy_report`, because it is lossless by
  design. With `root`, the shadow shell hands the projector the snapshot with root-relative files and
  the projector must report its files the same way.

Digests recorded by a producer from a scan in its own checkout path embed that path. PR 77's
`semantic_sha256` values were produced that way (its corpus CLI builds the snapshot without a root),
so every one of them, for every adapter and not only the Express ones, has to be re-measured with the
root before it can be compared on another machine or in another directory, and with this module's
snapshot, which also records the verb (see "T11-04 parity").

## T11-03 pre-freeze shadow shell

`shadow-projection.mjs` provides a dependency-injected comparison shell. It does not define or
import T01/T02/T03 draft IR. A future frozen projector may return a T11 semantic snapshot for
differential comparison. The shell:

- keeps `sbf.scan-report/2` authoritative;
- deep-freezes projector input;
- does not return projector private/raw IR;
- reports bounded semantic diffs and regression-only digests;
- always emits `promotion_allowed: false`.

This is plumbing for T11-03, not completion of the shared normalized projection.

## T11-06 cutover readiness

`cutover-readiness.mjs` is a pure fail-closed migration checklist. It is not T03 certification.
It requires ownership, baseline/bridge/parity/corpus, exact-head CI, frozen T01/T03 seams,
independent review, and nested-test integration. Even when every check is true it emits
`apply_allowed: false`; stable wiring remains T00/T23-owned. The checks are inputs: this module does
not measure them. Only own properties of `checks` are read, so a gate that is merely inherited from a
prototype is rejected like a missing one.

## Corpus checkout completeness

`checkout-completeness.mjs` is the guard that a later corpus parity CLI must call before it scans a
sparse checkout. PR 77 added it because:

- an earlier manual sparse acquisition included Rails config/controllers/models but omitted `lib/**`;
- the FastAPI Mealie acquisition omitted tracked Python under `dev/**` and `tests/**`;
- route/entity counts happened to remain stable, but `files_read` and semantic regression digests changed.

What the guard does:

- It treats a checkout as sparse when `core.sparseCheckout` is `true`, or when any tracked entry
  below `repoRoot` carries the skip-worktree bit, which `git ls-files -t -z` prints with the tag `S`
  (NUL-separated like the paths; sparse checkout sets the bit on every entry it leaves out of the
  working tree). The second condition catches a worktree whose flag was switched off with
  `git config --worktree core.sparseCheckout false` while the files stay missing and `git status`
  stays clean. The bit counts, not the flag, so a checkout that was sparse and then disabled with
  `git sparse-checkout disable` (which clears the bits and restores the files) is a full one again.
- When it is not sparse in either sense it returns `complete: true` with mode
  `full-working-tree` and checks nothing else. It shows that the checkout is not sparse, not that
  every tracked file is present: a working tree with deleted or modified tracked files, or a copy
  that is not a git sparse checkout, is reported complete by design.
- For a sparse checkout of ruby-rails or python-fastapi it lists the tracked paths of `HEAD` with
  `git ls-tree -r -z --name-only` (NUL-separated, so non-ASCII names, quotes and surrounding
  whitespace stay exact; restricted to the project directory when `repoRoot` is below the git top
  level) and requires each file the adapter's scanner would read to exist in the working tree.
  - python-fastapi: every tracked `.py` file except those with a path part `.venv`,
    `site-packages`, `node_modules` or `__pycache__`.
  - ruby-rails: every tracked `Gemfile` and `Gemfile.lock` at any depth, plus every tracked `.rb`
    file under `config/`, `app/controllers/`, `app/models/` or `lib/`. The scanner's `tmp`, `log`,
    `vendor/bundle`, `.bundle` and `node_modules` excludes are anchored at ripgrep's working
    directory, which the guard cannot know, so it may over-require Gemfiles below those trees and
    never under-requires.
- It rejects sparse checkouts for other adapters (`sparse-unsupported-adapter`, `complete: false`)
  until an adapter-specific tracked-read-set rule is audited. A skip-worktree bit counts as sparse
  here too, so a file someone marked with `git update-index --skip-worktree` sends its checkout down
  this path: for ruby-rails and python-fastapi the read set is then checked (and found present), for
  the other adapters the answer is `complete: false` although nothing is missing. The guard cannot
  tell that use of the bit from a sparse checkout, so it errs on the side of refusing.
- It throws when `repoRoot` is not in a git repository or when its git working tree is configured
  elsewhere (`core.worktree`); for a sparse checkout it also throws when the project directory is not
  tracked in `HEAD`. It bounds the output of `git ls-files` (run whenever `core.sparseCheckout` is not
  `true`) and of `git ls-tree` (run for sparse checkouts) to 16 MiB each and fails closed above that
  bound: a project with more tracked files than that fits throws instead of being reported complete.
- Every git call runs without the variables git itself lists as repository-local (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_CONFIG_COUNT` with its `KEY`/`VALUE` entries, `GIT_CONFIG_PARAMETERS`, ...),
  on a copy of the environment, because a caller inside a git hook inherits them and the guard
  would answer about another repository or configuration.
- It normalizes the macOS `/var` to `/private/var` realpath alias before repository-root comparison.

What is verified, and what is not:

- The tests build synthetic temporary git repositories. Two of them also run the FastAPI and the
  Rails scanner on such a repository and compare the guard's expected read set with the scanner's
  `files_read` (FastAPI: same count; Rails: same count for a scan that runs from a directory outside
  the project, at least that of a scan from inside it, and every file the scan from inside reads is
  also read by the other). They do not assert the Rails scanner's own counts, which depend on its
  working directory.
- They also cover a worktree whose `core.sparseCheckout` was switched off with `git config --worktree`
  (incomplete while a read-set file is missing, complete when the read set is present), a full
  checkout, one that was sparse and then disabled, file names that merely start with `S ` or hold a
  line break followed by `S `, a sparse index (`git sparse-checkout init --sparse-index`: `git ls-files`
  expands it in memory, which git may announce on stderr and which is slow for a very large project,
  and then tags every omitted file `S`), a project below the git top level, and
  `git update-index --skip-worktree` on a file that is present.
- The guard has not been run against the 17 corpus repositories. The producer-machine read-set counts
  that PR 77 recorded (Discourse 1550/1550, Forem 668/668, Mastodon 741/741, Polar/server 1700/1700,
  Mealie 636/636) are PR 77 evidence for the follow-up PRs to re-establish; they are not asserted here.
- Presence is checked with `fs.existsSync`, so on a case-insensitive file system a tracked path counts
  as present when only a differently-cased path exists, and two tracked paths that differ only in case
  cannot both be materialized. The guard is not reliable there; this is a known limit.

The semantic digest remains regression-only and never substitutes for exact ContractRef identity.
