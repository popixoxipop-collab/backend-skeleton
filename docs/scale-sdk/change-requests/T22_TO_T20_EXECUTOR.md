# T22 → T20 change request: isolated external-adapter executor

## Why T22 is blocked here

T22 now validates a data-only adapter manifest and a versioned `sbf.adapter-worker/1` protocol.
It deliberately never imports, installs or spawns external adapter code.

## T20 interface requested

Provide an execution boundary that accepts:

- immutable adapter package/blob digest
- validated T22 manifest
- approved source snapshot reference
- explicit operation request using `sbf.adapter-worker/1`
- approved resource budget and permission profile

and returns a response that T22's `validateSdkResponse()` can validate.

The executor must independently enforce read roots, write roots, network, environment, subprocess,
resource limits and cleanup. Manifest permissions are requests, not grants.

## T22 assumptions T20 must not weaken

- `activation.mode = manual-approval-required`
- valid manifest != execution approval
- default network/subprocess permission is deny
- external code cannot be wired into the existing first-party `scanners/adapters/*.mjs` dynamic import path
- snapshot references are opaque to the SDK; the executor resolves only approved immutable snapshots
- request/response ids and adapter ids remain bound

## Acceptance needed by T22

1. an executor profile schema/revision
2. one in-memory/mock conformance path plus one actually isolated execution path
3. negative tests for read/write escape, network/subprocess denial, env leakage and cleanup
4. immutable package/executor/profile digests in the execution result
5. a caller function or transport adapter that can be supplied to `runAdapterSdkConformance()`

Until this arrives, T22-03 remains complete only through the pre-execution boundary.
