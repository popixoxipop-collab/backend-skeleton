# T11 integration handoff

Status: stage 1 of the T11 revival. This directory carries the framework-independent core with
per-adapter pins for the five shipped adapters. It is shadow-only, not activated by default, and T11
is not declared complete.

Provenance: ported from the draft PR 77 branch `scale/t11-http-legacy-modernization` at head
`5d328f906dd81fde508c1cd652a6ab159e22a29e`. The stage began as a byte-identical port of the modules
listed below. Fixes that followed a read-only substitute review of this stage (not an independent
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
| `parity.mjs` | Semantic snapshot of a legacy report and a bounded diff (`maxDiffs` 1..1000). The snapshot and digest depend on the checkout location unless the optional `root` is passed. |
| `checkout-completeness.mjs` | Guard for sparse checkouts of ruby-rails and python-fastapi projects: it lists the tracked paths with `git ls-tree -r -z` and requires the files that adapter's scanner reads to exist. Other sparse checkouts are refused; a non-sparse working tree is reported complete without being checked. See "Corpus checkout completeness" for what is and is not verified. |
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
each endpoint's handler `method`, `path`, `operationId` and file), entities, enums and DTOs. It does not
cover an endpoint's HTTP `verb`, line numbers, or the report's other fields (`terms`, `unknowns`,
`collisions`, `rg_available`). A change that only flips an HTTP verb therefore leaves `equal` true and
the digest unchanged. Adding the verb would change every digest, so it is a known limit of this stage,
not something it fixes.

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
- Without these options nothing changes: the snapshot, the digest and the comparison are what they
  were before, so a digest computed the old way stays valid.
- It fails closed. A `.file` that is not strictly below the root (another directory, a sibling that
  shares a name prefix, a `..` climb, the root itself) or is not a string throws. `root` must be a
  non-empty string, only a report (not a snapshot) can be given one, and `expectedRoot` and
  `actualRoot` must be given together.
- The scanner builds `.file` from the `repoRoot` string as passed and does not resolve symlinks, so
  pass that same string as `root`. A relative `repoRoot` is resolved against the working directory
  as the scanner does, but the scanners do not treat a relative and an absolute root alike
  (javascript-express reports absolute real paths, typescript-express reports different paths), so use
  an absolute `repoRoot` for any digest meant to be compared.
- The bridge still keeps the absolute paths in `bridge.legacy_report`, because it is lossless by
  design. With `root`, the shadow shell hands the projector the snapshot with root-relative files and
  the projector must report its files the same way.

Digests recorded by a producer from a scan in its own checkout path embed that path. PR 77's
`semantic_sha256` values were produced that way (its corpus CLI builds the snapshot without a root),
so every one of them, for every adapter and not only the Express ones, has to be re-measured with the
root before it can be compared on another machine or in another directory.

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

- When `core.sparseCheckout` is not `true` it returns `complete: true` with mode
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
  until an adapter-specific tracked-read-set rule is audited.
- It throws when `repoRoot` is not in a git repository or when its git working tree is configured
  elsewhere (`core.worktree`); for a sparse checkout it also throws when the project directory is not
  tracked in `HEAD`. It bounds `git ls-tree` output to 16 MiB and fails closed above that bound.
- Every git call runs without the variables git itself lists as repository-local (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_CONFIG_COUNT` with its `KEY`/`VALUE` entries, `GIT_CONFIG_PARAMETERS`, ...),
  on a copy of the environment, because a caller inside a git hook inherits them and the guard
  would answer about another repository or configuration.
- It normalizes the macOS `/var` to `/private/var` realpath alias before repository-root comparison.

What is verified, and what is not:

- The tests build synthetic temporary git repositories. Two of them also run the FastAPI and the
  Rails scanner on such a repository and compare the guard's expected read set with the scanner's
  `files_read` (FastAPI: same count; Rails: same count when the scan runs from another directory, at
  least that of a scan from inside the project).
- The guard has not been run against the 17 corpus repositories. The producer-machine read-set counts
  that PR 77 recorded (Discourse 1550/1550, Forem 668/668, Mastodon 741/741, Polar/server 1700/1700,
  Mealie 636/636) are PR 77 evidence for the follow-up PRs to re-establish; they are not asserted here.
- Presence is checked with `fs.existsSync`, so on a case-insensitive file system a tracked path counts
  as present when only a differently-cased path exists, and two tracked paths that differ only in case
  cannot both be materialized. The guard is not reliable there; this is a known limit.

The semantic digest remains regression-only and never substitutes for exact ContractRef identity.
