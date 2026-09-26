# External adapter onboarding

This document is the T22 contribution path. It intentionally stops before executing untrusted
adapter code.

## 1. Write fixtures first

Create the smallest representative fixture and at least one negative/unknown fixture. Record the
target framework/runtime version and what the fixture proves. Do not generate expected output from
the adapter under test and then call that output an independent oracle.

## 2. Create a data-only manifest

The manifest declares:

- adapter id/title/version
- existing descriptor contract (`sbf.adapter/2` in this preview)
- bskel compatibility min/max versions
- worker protocol and package-relative entrypoint metadata
- requested permissions
- fixture paths
- existing verification-basis vocabulary
- activation mode `manual-approval-required`

The validator rejects path traversal, absolute entrypoints, unknown top-level keys and permissive
network/subprocess defaults.

## 3. Generate a task packet

Use `createAdapterTaskPacket()` to record the base commit, narrow write scope, fixtures,
mandatory tests and ownership constraints. The packet is designed to be copied between agents or
sessions without losing the safety boundaries.

## 4. Review the package inventory without executing it

Describe the package as a regular-file inventory with path, SHA-256 and byte size entries.
`reviewAdapterPackage()` checks that the declared entrypoint and fixtures exist, rejects
traversal/nonportable/colliding paths, and can compare a caller-supplied package digest.

This review still returns `packageBytesTrusted: false`: T22 does not read a tarball, verify its
signature, or authorize execution. Those belong to the approved acquisition/security boundary.

## 5. Test the protocol in memory

Use `runAdapterSdkConformance()` with a caller-supplied `invoke` implementation. Unit tests can
use an in-memory worker. This verifies envelope compatibility without installing or loading an
external package.

## 6. Build support evidence and submission review

Create exact support explanations, then derive the machine-generated support evidence matrix. Use
`reviewAdapterSubmission()` to combine manifest, inventory and support evidence. The strongest
T22 result is `ready-for-execution-review`; it still returns `executable: false` and
`requiresApproval: true`.

## 7. Request execution approval

A future executor/security owner must separately verify immutable package bytes, trust/revocation
policy, permissions and isolation. A valid manifest is not an execution grant.

## 8. Publish support honestly

Produce a support explanation with the exact supported/partial/unknown/conflict states and evidence
references. Runtime-tested status must come from the runtime evidence owner, not from T22's SDK
validator.

## Packaging blocker

This branch deliberately does not modify `package.json`, the lockfile, `bin/bskel.mjs`, shared
schemas or the first-party registry. Therefore the SDK remains a source-tree preview until the
package/release and integration owners explicitly add it to the npm package and CLI/test entry
points.
