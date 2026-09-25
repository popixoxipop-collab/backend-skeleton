# External adapter protocol preview

Contract: `sbf.adapter-worker/1`

This is a data protocol, not an execution service. The SDK validates envelopes but never opens a
socket, forks a process, imports a package, or evaluates target repository code.

## Request

```json
{
  "contract": "sbf.adapter-worker/1",
  "direction": "request",
  "requestId": "case-1",
  "operation": "detect",
  "adapterId": "typescript-nestjs",
  "snapshotRef": "sha256:opaque-snapshot",
  "payload": {}
}
```

Operations in this preview:

- `detect`
- `analyze`
- `diagnostics`
- `read-set`

`snapshotRef` is intentionally opaque. The SDK does not accept an arbitrary host filesystem path
as authority to read. The future executor owns the mapping from an approved snapshot to read-only
bytes.

## Response

```json
{
  "contract": "sbf.adapter-worker/1",
  "direction": "response",
  "requestId": "case-1",
  "adapterId": "typescript-nestjs",
  "status": "ok",
  "result": {},
  "diagnostics": []
}
```

Statuses are `ok`, `unsupported`, `unknown`, and `error`. Unsupported and unknown are
first-class results, not aliases for success.

The response validator binds `requestId` and `adapterId` back to the originating request so a
result from another adapter/request cannot be silently substituted.

## Conformance test kit

`runAdapterSdkConformance()` accepts an explicit `invoke(request)` function from the caller.
This preserves an important boundary: the SDK tests protocol behavior but does not decide how or
where external code is executed. A future isolated runner can supply `invoke`; a unit test can use
an in-memory function.

A conformance pass is not a runtime support certificate. It only says the supplied invocation
answered the requested protocol cases with valid envelopes and expected statuses.
