# bskel adapter SDK preview

This directory is the T22 source-tree SDK preview. It is **not shipped by npm yet** because the
current package allowlist does not include `sdk/`.

The SDK is deliberately data-first. Importing it does not load an external adapter, execute target
repository code, spawn a process, read environment variables, or grant network access.

## Quick start

```js
import {
  createAdapterSdkManifest,
  createAdapterTaskPacket,
  createSupportExplanation,
  diagnosticsToSarif,
  planExternalAdapterActivation,
  runAdapterSdkConformance,
} from './sdk/next/index.mjs';

const manifest = createAdapterSdkManifest({
  adapter: {
    id: 'typescript-nestjs',
    title: 'NestJS',
    version: '0.1.0',
  },
  bskel: {
    minInclusive: '1.9.0',
    maxExclusive: '2.0.0',
  },
  entrypointPath: 'adapter-worker.mjs',
  fixtures: ['fixtures/minimal'],
  verificationBasis: 'synthetic-only',
});

// Validation is not execution approval.
console.log(planExternalAdapterActivation(manifest));
// => executable:false, requiresApproval:true, autoInstall:false, autoImport:false

const task = createAdapterTaskPacket({
  taskId: 'HTTP-typescript-nestjs-02',
  targetId: 'HTTP-typescript-nestjs',
  baseSha: '<40-character git SHA>',
  writeScope: ['adapters/http-wave-a/typescript-nestjs/**'],
  fixtures: ['test/fixtures/typescript-nestjs/minimal'],
  mandatoryTests: ['node --test test/typescript-nestjs.test.mjs'],
});
```

## Exports

| Module | Purpose |
|---|---|
| `manifest.mjs` | safe manifest builder, validation, compatibility checks, activation plan |
| `protocol.mjs` | versioned request/response envelope; no transport implementation |
| `task-packet.mjs` | copyable scope/test/constraint handoff |
| `explain.mjs` | capability and field support states with provenance/conflicts/next actions |
| `sarif.mjs` | diagnostic projection to SARIF 2.1.0 |
| `testkit.mjs` | caller-injected protocol conformance; no spawning/import |
| `schema-catalog.mjs` | stable IDs and package-relative locations for six JSON schemas |

## Schema vs runtime validation

The JSON Schemas cover shape and conditional state invariants that editors/CI can evaluate.
Runtime validation remains authoritative for semantic relationships that JSON Schema cannot
naturally compare, such as `minInclusive < maxExclusive` under SemVer precedence.

A schema-valid manifest therefore still does not authorize code execution.

## Trust boundary

The existing first-party `scanners/adapters/*.mjs` registry is repository-owned trusted code.
Do not point it at external directories or packages. External adapter execution needs a separate
T20-approved isolation/permission/revocation path. This SDK only supplies data contracts and
conformance helpers for that later boundary.
