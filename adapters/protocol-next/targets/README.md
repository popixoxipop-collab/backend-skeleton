# Protocol target scope records

One directory per protocol target of the T18 protocol suite: `graphql/`, `asyncapi/`, `websocket/`. Each holds a machine-readable `SCOPE.json` and a README generated from it in the same change.

A scope record states what the importer supports and what it does not, with counterexample fixtures for the unsupported claims, pinned specification and library versions, and what could be run: nothing here is Runtime-tested, and a record never marks a target as supported (`status` is always `scope-recorded`).

- schema: `adapters/protocol-next/schemas/protocol-target-scope.schema.json`
- fixtures: `test/protocol-next/fixtures/targets/<family>.fixtures.json` (replayed through the real adapter by the tests)
- static oracle evidence (graphql, asyncapi): `test/protocol-next/fixtures/targets/<family>.oracle.json`, produced by `test/protocol-next/tools/target-oracle.mjs` with the lockfiles vendored under `test/protocol-next/fixtures/targets/oracle-locks/`
- online pin verification: `node test/protocol-next/tools/verify-target-pins.mjs` (needs the network; the tests do not)
- tests: `test/protocol-next/protocol-target-scope.test.mjs` (all records) and `protocol-<family>-scope.test.mjs`

The plan declares the write scope `adapters/protocol/<family>/**`. That directory does not exist; the T18 suite owns `adapters/protocol-next/**` and `test/protocol-next/**`, so the records live here.
