# T22 SDK npm distribution — candidate V1

**Scope:** versioned, additive distribution note for the current **T22-05 packaging candidate**. The frozen `sdk/next/BASELINE.json`, its pinned README, and the original T22-01 source baseline remain unchanged. The historical README phrase “not shipped by npm yet” describes the pinned historical build, not the new candidate.

The root `package.json` allowlist now adds **`sdk/`**. When and only when this candidate is independently reviewed, merged, installed, and eventually published, consumers will be able to import `backend-skeleton/sdk/next/index.mjs` from the distributed npm package. The current public npm release has **not** been updated by this local source change.

The T22 SDK is strictly **manifest validation, protocol types, support explanation, conformance test helpers and package inventory review**; it is not an external adapter loader. Importing this module must not dynamically execute untrusted adapter code. `reviewAdapterPackage` always leaves `executable=false` and `requiresApproval=true` even if the inventory matches and the SHA digest is internally consistent. Runtime execution would require a separate T19/T20-controlled permission boundary and independent authority.

## Product acceptance target T22-05

- Input: exact reviewed root `package.json` and frozen `sdk/next/**` modules.
- Real package: npm pack tarball contains SDK `index.mjs`, its transitive local imports and **all nine JSON Schema files**.
- Real isolated consumer: install tarball offline with `--ignore-scripts`, import the **installed** SDK rather than the repo source tree, exercise a valid manifest, negative duplicate/path traversal package inventory and fail-closed activation.
- Report: pass/fail/skip, exit code, SHA-256 for pack/test/receipt, bound candidate source HEAD.
- Explicit blockers: no npm publication, main merge, GitHub PR CI, independent T19/T23 security/packaging signature, no real third-party execution or network permission.
- Historical `sdk/next/README.md` and `BASELINE.json` remain unchanged. New distribution status is recorded **additively** here.

**Do not confuse a green local installation with official MET promotion.** Main merge, exact-head CI and independent reviewer judgments remain necessary under T00's strict audit rules.
