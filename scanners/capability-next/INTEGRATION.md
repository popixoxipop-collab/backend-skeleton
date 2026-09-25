# T03 integration handoff

Branch: `scale/T03/capability-policy-next`
PR: #81

T03 owns the pure policy/certification layer only. This document is a change request to neighboring
tracks; it is not permission to mutate their shared files from this branch.

## Stable surfaces intentionally left untouched

- `scanners/capabilities.mjs`
- `schemas/adapter.schema.json`
- `scanners/registry.mjs`
- `handles/registry.mjs`
- `bin/bskel.mjs`
- `package.json` / lockfile
- existing adapter and provider descriptors

The next layer imports stable command/satisfier metadata read-only so drift is caught by tests. It
never changes legacy booleans in place.

## Request to T01 — contract / schema owner

T03 needs an interface-frozen artifact/evidence reference type before its records are promoted into a
shared product schema. The required semantic properties are:

1. immutable identity for the evidence bytes or immutable execution record;
2. family/version information so unrelated evidence cannot satisfy a capability accidentally;
3. no display name as identity;
4. unknown major/version must fail closed;
5. compatibility vectors must prove old adapter booleans keep their existing narrow meanings.

T03 deliberately uses opaque non-empty `evidenceRefs` strings until T01 freezes that shared type.
Do not infer that every current string is already a valid product ArtifactRef.

## Request to T00 — integrator / CLI owner

After T01 freezes the interface, wire commands through an adapter instead of replacing stable logic
in one step:

1. shadow-evaluate the next policy beside current `requireCapabilitiesOrExit()`;
2. compare verdicts on current adapters and fixtures;
3. treat disagreement as diagnostic evidence, not an automatic override;
4. keep current CLI behavior as the source of truth until the integration gate accepts parity;
5. only then switch one command/profile at a time.

An unknown command name in the next bridge is an error. Do not turn it into an empty policy.

## Request to T14 — codegen / provider owner

Keep command dispatch and provider requirements separate:

- `handles plan/emit` command dispatch requires `codegen.handles`;
- each current first-party handles provider separately requires `resource.fetch`.

The next bridge already models and tests that separation. Future providers may declare different
requirements; do not hard-code `resource.fetch` back into the command-level policy.

## Request to T19 — independent QA / conformance owner

The public support matrix must be produced from accepted evidence, not from adapter names or legacy
booleans. T03 provides `certificationRecord()` and `buildSupportMatrix()`; T19 should supply the
reviewed inputs after its interface is frozen.

Minimum input semantics required by T03:

- target ID and exact approved scope;
- support level: discovery / contract / runtime-tested;
- immutable evidence refs for **every** certification level;
- runtime profile for runtime-tested;
- independent codegen state;
- limitations / unsupported scope.

`buildLegacyCompatibilityView()` is explicitly `certified:false` and must never be published as
the certified support matrix.

## Waiver boundary

A normal waiver is valid only when all of these match:

- exact failure code;
- exact subject/scope;
- reason;
- approver;
- unexpired expiry.

The following failure classes are non-waivable in T03:

- `identity.hash-mismatch`
- `trust.sandbox-escape`
- `trust.secret-leak`
- `evidence.replay`
- `contract.unknown-major`

If T20 expands the non-waivable vocabulary, T03 should consume the interface-frozen list rather than
duplicating policy silently.

## Current T03 completion boundary

Implemented inside T03:
- five-state records and legacy bridge;
- fail-closed policy evaluator;
- current command/provider compatibility projection;
- external satisfier evidence projection;
- structured policy diagnostics;
- waiver checks;
- certification and deterministic matrix projection;
- real current adapter/provider registry regression coverage.

Not completed by T03 alone:
- shared schema migration;
- stable CLI/gate cutover;
- T19 report ingestion;
- runtime certification data;
- release/public support-matrix publication.

Those are cross-track integration gates, not missing hidden behavior in this branch.
