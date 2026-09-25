# T22 → T23 change request: package / CI integration

## Current T22 state

The SDK implementation and tests are confined to `sdk/next/**`, `docs/scale-sdk/**` and
`test/sdk-next/**`. T22 intentionally did not modify `package.json`, the lockfile, top-level CLI
or GitHub workflows.

## T23 changes requested after review

1. Add the approved `sdk/` subtree to the npm package allowlist.
2. Extend package-manifest/install tests so the exact SDK modules and seven JSON Schemas are present.
3. Add a CI/test entry point for `test/sdk-next/*.test.mjs`.
4. Exercise that entry point on the minimum supported Node version as well as the normal CI matrix.
5. Keep the package default behavior unchanged: no external adapter is installed/imported/executed merely because SDK files ship.

## Release gate

A packed tarball must be installed into a clean temporary consumer project and successfully import
the documented public SDK entry point and load all seven schema files. Source-checkout success is not
a substitute.

T22 does not request a version bump or npm publication by itself. Release/version policy remains
T23-owned.
