# T22 SDK npm distribution — candidate V1

**Scope:** versioned, additive distribution note for the current **T22-05 packaging candidate**. The frozen `sdk/next/BASELINE.json`, its pinned README, and the original T22-01 source baseline remain unchanged. The historical README phrase “not shipped by npm yet” describes the pinned historical build, not the new candidate.

The root `package.json` allowlist now adds **`sdk/`**. When and only when this candidate is independently reviewed, merged, installed, and eventually published, consumers will be able to import `backend-skeleton/sdk/next/index.mjs` from the distributed npm package. The current public npm release has **not** been updated by this local source change.

The T22 SDK is strictly **manifest validation, protocol types, support explanation, conformance test helpers and package inventory review**; it is not an external adapter loader. Importing this module must not dynamically execute untrusted adapter code. `reviewAdapterPackage` always leaves `executable=false` and `requiresApproval=true` even if the inventory matches and the SHA digest is internally consistent. Runtime execution would require a separate T19/T20-controlled permission boundary and independent authority.

## Product acceptance target T22-05

- Input: exact reviewed root `package.json` and frozen `sdk/next/**` modules.
- Real package: npm pack tarball contains SDK `index.mjs`, its transitive local imports and **all nine JSON Schema files**.
- Real isolated consumer: install tarball with npm network access disabled (`--offline`) and lifecycle scripts disabled (`--ignore-scripts`), import the **installed** SDK rather than the repo source tree, exercise a valid manifest, negative duplicate/path traversal package inventory and fail-closed activation. This requires a dependency cache pre-warmed from the exact `package-lock.json`; the package declares registry dependencies and is not a hermetic single-tarball install.
- Report: pass/fail/skip, exit code, SHA-256 for pack/test/receipt, bound candidate source HEAD.
- Explicit blockers: no npm publication, main merge, GitHub PR CI, independent T19/T23 security/packaging signature, no real third-party execution or network permission.
- Historical `sdk/next/README.md` and `BASELINE.json` remain unchanged. New distribution status is recorded **additively** here.

**Do not confuse a green local installation with official MET promotion.** Main merge, exact-head CI and independent reviewer judgments remain necessary under T00's strict audit rules.

## Durable distribution receipt and offline precondition

`npm run test:t22-distribution -- --output <absolute-server-owned-directory> --expected-head <40-hex-commit>` creates the real tarball once, installs that exact tarball in the consumer tests, and atomically preserves the tarball, TAP transcript, stderr transcript, `receipt.json`, and detached `receipt.sha256` outside disposable scratch space. The receipt binds the tested Git HEAD/tree, `package.json`, `package-lock.json`, relevant SDK source bytes, tarball bytes and member inventory, test command/exit/counts, Node/npm versions, and transcript digests. It refuses a dirty checkout or an unexpected HEAD. CI uploads the directory even when the verifier fails, so a failure receipt remains reviewable.

The verifier also performs an empty-cache negative install. That install is required to fail offline, confirming the documented precondition. The acceptance install then succeeds only with npm's pre-warmed cache and records the exact lockfile SHA-256. “Offline” here therefore means **network-disabled with a pre-warmed dependency cache**, not dependency-complete from this tarball alone.

## Consumer / runner / provider conjunction (T22-05 scoped QA)

The installed npm SDK is additionally exercised through its exported `runAdapterSdkConformance` entrypoint, using a caller-injected **test-only provider**. This covers the original T22-05 requirement to combine the packed consumer with an in-memory runner/provider contract, without registering or executing untrusted external adapter modules.

- Valid `detect` and conservative `analyze` statuses `ok`, `unknown`, `unsupported` are preserved rather than promoted to runtime-certified support.
- Requests passed to the injected provider are immutable; post-first-invoke mutation of the caller's manifest/cases cannot change the next recorded input.
- Incorrect provider `requestId` or `adapterId` becomes `invalid-response` and a failed conformance result.
- Provider errors become `invoke-threw` failures, not empty-success responses.
- Invalid or auto-activation manifests are rejected before any provider callback is invoked.
- All conformance results leave `activation.executable=false`, `autoImport=false` and `inputBinding.certificationAuthority=false`.

The suite provides **an installed-package consumer + injected provider positive/negative fixture**. It does NOT run a real third-party executable adapter, test isolation of an OS process, provide permission revocation or perform T19/T20 security certification. Independent product review, authorized CI, main merge and T00 exact-head re-audit are still necessary for official T22-05 MET.

## Pinned evidence source and npm invocation

The report now exports the exact Git commit into a private scratch snapshot. Both npm pack and the two distribution test files run from that snapshot, not the mutable checkout. Relevant source hashes are checked after export and all installed SDK member bytes are compared with the snapshot. The existing initial dirty-check remains a refusal, not the sole provenance guarantee.

Evidence runs reject `T22_TEST_NPM`. The resolved npm CLI entrypoint runs under the same absolute Node executable; its absolute path, SHA-256 and command are recorded and passed to the installed consumer. External receipt verification additionally requires independently obtained `expectedNpmExecutable` and `expectedNpmExecutableSha256`. Do not copy these expectations from a receipt. The installed Node/npm toolchain and its dependencies remain a trusted execution prerequisite; these entrypoint pins are not whole-OS/toolchain cryptographic attestation. Historical fault-injection receipts remain historical failures or reproductions, not accepted current evidence.
