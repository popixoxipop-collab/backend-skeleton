# Scale SDK (T22) — developer UX and extension boundary

Status: source-tree implementation preview on the T22 branch. It is **not** wired into the published npm package or the `bskel` CLI yet.

The SDK exists to make adapter contributions and support diagnostics composable without turning the
existing internal adapter registry into a user-controlled code execution path.

## User journey

The target workflow is:

```text
discover -> plan -> scan -> reconcile -> contract -> verify
```

The existing CLI remains authoritative while the scale work is staged:

| Desired phase | Existing bskel surface | T22 SDK contribution |
|---|---|---|
| discover | `bskel doctor`, adapter detection | data-only adapter manifest and compatibility range |
| plan | command-specific capability checks | copyable task packet with write scope and mandatory tests |
| scan | existing first-party registry and scanners | worker protocol envelope; no automatic import |
| reconcile | existing OpenAPI/source logic | structured status/provenance payloads for downstream UX |
| contract | `bskel contract emit/verify` | support explanations never rewrite contract identity |
| verify | existing gates / beval integration boundary | structured diagnostics and SARIF projection |

This mapping is documentation and library support; it does not create new CLI commands.

## What is implemented in this branch

- `sdk/next/manifest.mjs`: pure-data external adapter manifest validation and version range checks.
- `sdk/next/protocol.mjs`: request/response envelope for a future isolated adapter worker.
- `sdk/next/task-packet.mjs`: copyable adapter work packets that preserve ownership constraints.
- `sdk/next/explain.mjs`: machine-readable capability/field explanation plus a human Markdown table.
- `sdk/next/sarif.mjs`: projection of structured diagnostics into SARIF 2.1.0.
- `sdk/next/testkit.mjs`: caller-injected conformance harness. It never spawns/imports adapter code.

## Security boundary

The current internal registry imports `scanners/adapters/*.mjs` because those files ship at the same
trust level as bskel itself. The Scale SDK does **not** make that directory configurable and does
not auto-install packages, run install hooks, import an external module, inherit environment
variables, or grant network/subprocess permissions.

A valid manifest only proves that the data follows the SDK shape. `planExternalAdapterActivation()`
always returns `executable: false` and `requiresApproval: true`. A later security/executor owner
must verify package bytes, signer/revocation policy and an isolated permission profile before any
external code can run.

## Compatibility

This preview intentionally references the existing first-party descriptor contract
`sbf.adapter/2` rather than inventing a replacement for it. A manifest has an explicit
`minInclusive` / `maxExclusive` bskel version range. That range is a compatibility declaration,
not proof that a framework/runtime combination is behaviorally correct.

## Testing

From a repository checkout:

```bash
node --test test/sdk-next/*.test.mjs
```

The existing `npm test` glob only includes `test/*.test.mjs`, and T22 does not own
`package.json`. Wiring this suite into package scripts and shipping `sdk/next` in the npm
`files` allowlist requires an integration change by the package/release owner.
