# T21-06 — scoped release eligibility, rollback and exact-source replay

**Status:** Shadow-only rehearsal candidate. Not an operator-approved production release.

## Supported and excluded scope

T21_06_SUPPORTED_SCOPE.json defines an explicit three-adapter cohort: Java Spring, JavaScript Express, and Python FastAPI. The project graph is still sbf.project-graph/draft-1. The T02 direct-provider remains authoritative; the T21 shadow comparator is disabled by default. Stable CLI, live external beval/becoder integration, GC deletion, npm publishing, production routing, database/service rollback, and certified performance remain excluded.

The existing interface RFC section 7 still lists missing production gates: no approved timing SLO, no GC writer exclusion, no scheduler timeout/cancellation, draft T02 graph, incomplete supported-platform validation, and no signed independent attestation. This rehearsal does not waive any of them.

## Immutable build and replay commands

Use a trusted Git checkout with complete historical objects. The output paths must be absolute, fresh and outside the checkout. The verifier does not fetch source code.

    node next/t21/t21-06-release-rehearsal.mjs build \
      --repo /absolute/backend-skeleton \
      --previous 924f58524652260ed06162f3aef11a490a53966c \
      --output /absolute/fresh-bundle

    node next/t21/t21-06-release-rehearsal.mjs replay \
      --repo /absolute/backend-skeleton \
      --bundle /absolute/fresh-bundle \
      --manifest-sha256 EXTERNALLY_RECORDED_64_HEX_SHA256 \
      --output /absolute/fresh-success-replay

    node next/t21/t21-06-release-rehearsal.mjs replay \
      --repo /absolute/backend-skeleton \
      --bundle /absolute/fresh-bundle \
      --manifest-sha256 EXTERNALLY_RECORDED_64_HEX_SHA256 \
      --output /absolute/fresh-fault-replay \
      --inject-failure

The build pins exact HEAD and tree, previous commit/tree, SHA-256 plus Git blob SHA of every selected T02/T21 module, the full three-adapter fixture inventory and this tool. Independently retain the printed manifest digest; a digest stored only beside the editable bundle is not an independent authority. Replay verifies source authority, commit/tree, ancestor, regular files, Git blob integrity, complete inventory, and external digest before creating output.

## Observed phases

1. Direct T02 baseline with shadow disabled. No cache path is created.
2. T21 enabled only in a disposable scratch project. All three adapters return exact T02 reports on cold cache MISS and warm HIT.
3. Shadow disabled again: direct T02 result remains byte-identical, and disabling does not touch the cache index.
4. A wrong-semantic yet internally valid SHA-256 artifact is planted in the scratch cache. T21 must reject it as T21_SHADOW_SEMANTIC_MISMATCH.
5. Direct T02 is restored after the denied candidate and the disposable scratch cache is deleted. No caller or live cache is touched.
6. A separate injected candidate failure remains FAILED_EXPECTED_WITH_ROLLBACK (CLI exit 2), even when direct T02 restoration and cleanup succeed.

Only PASS_SHADOW_ONLY indicates a passing shadow rehearsal. Generated receipts retain all phase checks and the source/manifest identity, but cannot authorize deployment.

## What is not demonstrated

The rollback only disables an opt-in shadow comparator and restores the *same source revision's* authoritative T02 result. It is not package reinstall, service rollback, database migration reversal, or zero-downtime promotion. T21-05 did not change published package bytes, so package identity alone cannot establish a rollback. Time measurements are not approved SLOs. The original historical GC is unchanged and is not safe to promote.

Scoped T21-06 evidence acceptance requires reviewed and merged source, CI, independently checked receipts, negative cases, and a single-row T00 adjudication. Production release must remain BLOCKED unless separate operator-approved and independently attested prerequisites are actually satisfied.
