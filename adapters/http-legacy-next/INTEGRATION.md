# T11 integration handoff

Status: stage 1 of the T11 revival. This directory carries the framework-agnostic core only. It is
shadow-only, not activated by default, and T11 is not declared complete.

Provenance: ported from the draft PR 77 branch `scale/t11-http-legacy-modernization` at head
`5d328f906dd81fde508c1cd652a6ab159e22a29e`. The six `.mjs` modules and five test files listed below
are byte-identical to that head. This document is rewritten to describe what this stage ships.
Numbers that PR 77 recorded from the producer machine are PR 77 evidence and were not re-run here.

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
| `parity.mjs` | Semantic snapshot of a legacy report and a bounded diff (`maxDiffs` 1..1000). |
| `checkout-completeness.mjs` | Guard that refuses an incomplete sparse corpus checkout. |
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

## Not in this stage

- `corpus-parity-cli.mjs`, `test/http-legacy-next/corpus-parity.test.mjs` and
  `test/http-legacy-next/fixtures/corpus-baseline.json` (the pinned 17-repository corpus baseline)
  stay in PR 77 and are planned as per-framework follow-up PRs.
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
not measure them.

## Corpus checkout completeness

`checkout-completeness.mjs` is the guard that a later corpus parity CLI must call before it scans a
sparse checkout. PR 77 added it because:

- an earlier manual sparse acquisition included Rails config/controllers/models but omitted `lib/**`;
- the FastAPI Mealie acquisition omitted tracked Python under `dev/**` and `tests/**`;
- route/entity counts happened to remain stable, but `files_read` and semantic regression digests changed.

The guard:

- treats ordinary full working trees as complete;
- audits sparse Rails and FastAPI checkouts against the exact tracked paths their current scanners read;
- rejects sparse checkouts for other adapters until an adapter-specific tracked-read-set rule is audited;
- bounds `git ls-tree` output to 16 MiB and fails closed above that bound;
- normalizes the macOS `/var` to `/private/var` realpath alias before repository-root comparison.

Its tests build synthetic temporary git repositories. The producer-machine read-set counts that PR 77
recorded (Discourse 1550/1550, Forem 668/668, Mastodon 741/741, Polar/server 1700/1700, Mealie
636/636) are PR 77 evidence for the follow-up PRs to re-establish; they are not asserted here.

The semantic digest remains regression-only and never substitutes for exact ContractRef identity.
