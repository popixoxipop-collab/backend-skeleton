# T21-05 — opt-in T02 provider / T21 cached runner bridge

Status: **shadow-only candidate**. No stable CLI imports this file. No production provider or external runner is replaced, no deletion or release is authorized.

## Verified behavior

The new T21-owned module next/t21/t21-05-shadow-provider.mjs exports executeT21ShadowProvider().

- Default shadowEnabled=false returns the unmodified T02 executeProjectScanPlan() output and never calls T21 caching. No cache path or implementation digest is required.
- Explicit shadowEnabled=true requires a cacheRoot isolated outside the repository and a caller-pinned digest for every selected adapter. It first executes T02, including project markers and selected-adapter read-set validation, then runs the T21 bounded cache runner.
- Each project ID, root, selected adapter and serialized sbf.scan-report/2 must agree with T02's result. Any failed, missing, or conflicting shadow result fails closed; only a matching run yields cache-hit and digest sideband observations.
- A source edit without a refreshed graph is rejected as stale. With a refreshed graph it invalidates only the affected project's cache. A corrupt referenced artifact is rejected.
- Source-local cache paths, including symlink escapes, are rejected. Shared products and stable CLI are not changed.

## Scope limits

T02 runs on every shadow-enabled call. Timing does not establish an optimized production runner. This is not live beval/becoder provider integration, does not correct historical GC or supply T21-06 rollback and release certification.

## Reproduce

    node --test --test-reporter=tap next/t21/t21-05-shadow-provider.test.mjs

The tests exercise disabled mode, three adapters' OFF/MISS/HIT equivalence, local invalidation with graph rebuilding, stale marker failure, corrupted artifacts, cache-isolation and identity guards. This follows the PR #307 installed-tarball 13-module/3-adapter proof. Official T21-05 MET, if any, requires an independent canonical T00 adjudication and must never be implied from a green test alone.
