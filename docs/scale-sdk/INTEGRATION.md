# T22 integration request

This file records changes that T22 intentionally did **not** make outside its ownership boundary.

## Current branch status

The source-tree SDK, docs and dedicated tests live only under:

- `sdk/next/**`
- `docs/scale-sdk/**`
- `test/sdk-next/**`

No existing CLI, shared schema, adapter registry, package manifest or lockfile was edited.

## Requests for the integration / package owner

### 1. Package allowlist

If the SDK is approved for public distribution, add `sdk/` to `package.json#files` and extend the
package-install/package-manifest tests to assert the expected SDK files are present.

Until that happens, `npm pack` intentionally excludes `sdk/next/**`. T23's landed shared nested-test integration runs T22 tests on its coordination branch, but its approved package-shadow allowlist still does not include the SDK.

### 2. Test entry point

The existing `npm test` script expands `test/*.test.mjs`, so it does not include
`test/sdk-next/*.test.mjs`. Add a dedicated script or broaden the test runner only after the
package/test owner reviews the impact.

T22's direct command is currently:

```bash
node --test test/sdk-next/*.test.mjs
```

### 3. CLI names

Do not add new commands merely because the SDK contains the underlying pure functions. Names such
as `capability explain`, adapter onboarding, diagnostics export or SARIF output must be reviewed
against the current CLI grammar, exit codes and JSON envelope.

### 4. Shared capability vocabulary

`sdk/next/explain.mjs` accepts a richer display-state vocabulary
(`supported/partial/unsupported/unknown/not-applicable/conflict`) without changing
`scanners/capabilities.mjs` or `schemas/adapter.schema.json`.

The shared capability owner must decide whether/when those product-level states become a stable
cross-tool contract. T22 must not change the existing four capability names unilaterally.

### 5. External execution

The SDK only validates manifest/protocol data and a caller-supplied invocation function. It must
not be connected to arbitrary package installation, dynamic import, environment inheritance,
network access or subprocess execution until the security/executor owner supplies a reviewed
isolation and approval path.

## Verification already run on the T22 branch

- `node --test test/sdk-next/*.test.mjs`: 65/65 PASS on the current defect-fix worktree under Node 18, Node 22, and Node 24.
- existing adapter registry tests: 14/14 PASS.
- existing doctor CLI tests: 16/16 PASS.
- existing schema validation tests: 26/26 PASS.
- existing package manifest tests: 6/6 PASS.
- full `npm test` was attempted but exceeded the 10-second remote execution limit; it was not
  recorded as a full-suite pass.

These numbers are branch-local evidence, not a release certification.


## Defect-closeout boundary

The current T22 corrective slice is deliberately limited to input/security/evidence hardening. It
does not add a framework, execution backend, registry entry, CLI command, package allowlist or
default activation.

The data-only invariants remain:
- `executable: false`
- `requiresApproval: true`
- `autoInstall: false`
- `autoImport: false`

T03 owns support/certification policy. T22 only projects the five-state status/diagnostics and refuses
arbitrary string evidence for a non-legacy supported projection. T01 `sbf.artifact-ref/1` values
are kept as opaque exact references; independent byte verification remains upstream. T20 remains
the authority for effective permission/trust enforcement, and T23 remains the package/CI owner.
