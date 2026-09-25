# T11 integration handoff

Status: draft / T11-owned compatibility lane.

## Owned implementation

All T11 product and test files live under the ownership-policy paths:

- `adapters/http-legacy-next/**`
- `test/http-legacy-next/**`

The stable scanner remains authoritative. This lane does not edit `scanners/index.mjs`,
`scanners/registry.mjs`, stable schemas, package manifests, CLI/gates, or existing adapter
descriptors.

## T00/T23 change request

The current repository test script is `node --test test/*.test.mjs`, which does not discover the
nested T11 tests. T11 intentionally does not modify `package.json` or workflows to work around
that ownership boundary.

Before landing/cutover, T23/T00 should add an approved nested-test discovery mechanism that includes
`test/http-legacy-next/*.test.mjs` without forcing unrelated tracks into the shared root test
namespace. Until then, T11 runs explicitly:

```bash
node --test \
  test/http-legacy-next/baseline.test.mjs \
  test/http-legacy-next/parity.test.mjs \
  test/http-legacy-next/corpus-parity.test.mjs
```

## T11-03 boundary

T01 exact-byte HTTP identity and the T03 five-state capability vocabulary are candidate seams.
T02 ProjectGraph remains an internal draft because its serialized graph still carries an absolute
checkout path. T11 therefore must not publish a portable normalized project identity derived from
T02 yet.

A stacked shadow integration may consume draft T02/T03 outputs only for differential measurement.
It must remain non-authoritative and must not replace `sbf.scan-report/2` or publish certification.

## T11-04 / T11-05

`parity.mjs` compares only already-observed legacy scanner semantics and has a bounded diff.
Its semantic SHA-256 is regression-only and is explicitly not ContractRef identity.

`corpus-parity-cli.mjs` is read-only. It scans an already-prepared checkout, verifies an optional
exact ref, checks the expected legacy adapter, and can require a pinned semantic regression digest.
It never clones, installs target dependencies, or boots target applications.


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
`apply_allowed: false`; stable wiring remains T00/T23-owned.


## Corpus checkout completeness

T11-05 now verifies sparse-checkout completeness before accepting a corpus result.

Why this exists:
- an earlier manual sparse acquisition included Rails config/controllers/models but omitted `lib/**`;
- the FastAPI Mealie acquisition omitted tracked Python under `dev/**` and `tests/**`;
- route/entity counts happened to remain stable, but `files_read` and semantic regression digests changed.

The accepted corpus baselines were regenerated only after matching the scanner's tracked read-set:
- Discourse: 1550 expected / 1550 materialized Rails read files
- Forem: 668 / 668
- Mastodon: 741 / 741
- Polar/server: 1700 / 1700 Python files
- Mealie: 636 / 636

`checkout-completeness.mjs`:
- treats ordinary full working trees as complete;
- audits sparse Rails and FastAPI checkouts against the exact tracked paths their current scanners read;
- rejects sparse checkouts for other adapters until an adapter-specific tracked-read-set rule is audited;
- bounds `git ls-tree` output to 16 MiB and fails closed above that bound;
- normalizes the macOS `/var` ↔ `/private/var` realpath alias before repository-root comparison.

`corpus-parity-cli.mjs` exits before scanning when this guard reports an incomplete checkout.
The semantic digest remains regression-only and never substitutes for exact ContractRef identity.
