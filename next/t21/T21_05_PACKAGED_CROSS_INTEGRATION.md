# T21-05 — packed distribution / T02–T21 shadow cross-integration

Status: integration candidate. Never changes stable scan execution, the production runner, shared package manifests, GitHub workflow, historical GC, or current release authority.

## Delivery boundary

Only new files under next/t21/ are written. They exercise the real published npm tarball, as installed into a separate scratch consumer, rather than importing source-checkout lib/ paths. The T21 sources and immutable T21-01/T21-02 baselines remain unchanged.

## Reproduce

Use Node 24 (and repeat on CI Node 22 if available):

    node --test next/t21/t21-05-installed-integration.test.mjs
    node next/t21/t21-05-installed-integration.mjs

The second command prints a machine-readable JSON receipt. Capture stdout/stderr, SHA-256, source commit/tree, exact commands, operating environment and the packed .tgz in a writable external evidence directory. Do not use timing data as an SLO gate.

## Integration assertions

* npm pack / npm install --ignore-scripts yields the actual backend-skeleton installation in a separate scratch consumer.
* All 13 T21 modules and every export listed in the T21-02 interface RFC can be imported from the installed package; the integration harness itself is not shipped.
* The installed first-party registry and T02 buildRegisteredProjectGraph discover three real fixtures (Java Spring, JavaScript Express, Python FastAPI).
* The installed T02 executeProjectScanPlan provider runs unchanged legacy scans for each project; the installed T21 runProjectGraphCached runner executes the same graph with concurrency/byte limits.
* T02 provider reports and T21 results compare byte-for-byte by JSON serialization for cache OFF, cold MISS and warm HIT, with three real adapter descriptors. This is an exact-result test, not merely a schema test.
* A source edit in one project invalidates that project's cache key without forcing a miss in the other two projects.
* A changed graph marker fails closed before scan. Tampering with a referenced artifact produces a failed task, not a silent recomputation.
* The evidence explicitly records the unmodified production boundary, unsupported breadth, source/packaged identity, and non-authoritative timing.

## Limits and remaining work

This is a shadow-only, explicit consumer. It does not wire T21 into the stable bskel CLI or a live beval/becoder provider, does not implement GC writer exclusion or timeouts, and does not certify every platform or workload. The graph schema remains draft. Independent approval, full rollback plan, supported-scope release acceptance, and production promotion are separate T21-06 decisions. Other track files are strictly read-only.

T21-05 may be marked MET only after checked source ownership, the exact PR-head CI, independent technical review, clean protected merge, postmerge replay of this command, and one-row CAS update in the canonical T00 tracker. Success of this test alone never changes the 291-item official ledger.
