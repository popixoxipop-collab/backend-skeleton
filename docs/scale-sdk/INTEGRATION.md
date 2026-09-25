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

Until that happens, `npm pack` intentionally excludes `sdk/next/**`.

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

- `node --test test/sdk-next/*.test.mjs`: 13/13 PASS after fixing one Windows-path SARIF bug.
- existing adapter registry tests: 14/14 PASS.
- existing doctor CLI tests: 16/16 PASS.
- existing schema validation tests: 26/26 PASS.
- existing package manifest tests: 6/6 PASS.
- full `npm test` was attempted but exceeded the 10-second remote execution limit; it was not
  recorded as a full-suite pass.

These numbers are branch-local evidence, not a release certification.
