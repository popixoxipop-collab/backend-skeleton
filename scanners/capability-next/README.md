# capability-next

This directory is an opt-in, pure-data capability policy layer. It deliberately does **not** change
`sbf.adapter/2`, `scanners/capabilities.mjs`, the CLI, or any existing adapter descriptor.

The current adapter booleans keep their existing narrow meanings. `fromLegacyCapabilities()` only
bridges those exact meanings into the five-state model and marks the source as
`legacy-adapter-boolean`; it is not evidence that a broader future capability has been certified.

The axes stay separate:

- adapter `confidence`: how sure detection is that a repository uses a framework;
- adapter `verificationBasis`: how the adapter implementation itself was checked historically;
- capability `status`: whether one named capability is supported/partial/unsupported/unknown/not-applicable for the current scope;
- support `level`: discovery/contract/runtime-tested certification for an explicit target/profile;
- codegen state: none/scaffold/build-tested/behavior-tested, independent of the support level.

Policy evaluation is fail-closed. A missing capability is `unknown`, and `unknown` can never be an
accepted requirement status. `partial` and `not-applicable` are accepted only when a policy says so
explicitly. Non-waivable integrity/trust failures remain blocked regardless of a waiver record.

## Legacy compatibility bridge

`compatibility.mjs` reads the stable `COMMAND_CAPABILITIES` and satisfier metadata without
changing them. A legacy satisfier such as `--openapi-file` is only projected as a next
`supported` record when the caller supplies an immutable evidence reference. Merely seeing the
flag name is not certification evidence.

`buildLegacyCompatibilityView()` is intentionally marked `certified:false`. It is a
machine-generated compatibility snapshot for migration and drift checks, not the support matrix
that T19 conformance/runtime evidence will eventually certify.

## Cross-track integration

See [INTEGRATION.md](INTEGRATION.md) for the explicit T00/T01/T14/T19 handoff. Shared CLI, schema,
provider registry, and release support tables are intentionally not modified on the T03 branch.
