# WebSocket manifest importer: scope record

Plan item PROTO-websocket-01. Status: `scope-recorded`. This is a scope record, not a support claim: nothing here marks the target as supported, and nothing was Runtime-tested.

Machine-readable form: `SCOPE.json` (schema `adapters/protocol-next/schemas/protocol-target-scope.schema.json`, checked by `test/protocol-next/protocol-websocket-scope.test.mjs`). The plan declares the write scope `adapters/protocol/websocket/**`, which does not exist; the record lives next to the adapter code instead.

Fixture corpus: `test/protocol-next/fixtures/targets/websocket.fixtures.json`, canonical sha256 `af4ae73ea51183f6efe73e06d49fe2a7417278083fa7811a2741671079820822`, 27 scan cases and 8 flow cases. Every case is replayed through the real adapter by the tests.

## Profile

- inputs: WebSocket manifest documents in JSON or YAML (dialect bskel-websocket-manifest)
- dialects observed: `bskel-websocket-manifest/1`, `bskel-websocket-manifest/999`
- scan status: `partial` (a successful scan is never complete)
- manifest_dialect: bskel-websocket-manifest/<version>; version 1 when the manifest version is absent or falsy
- rfc: RFC 6455 (December 2011, Proposed Standard, updated by RFC 7936, RFC 8307 and RFC 8441); WebSocket protocol version 13 is not modeled by the manifest dialect
- library_candidate: ws 8.22.0 (not selected)
- suite_candidate: Autobahn|Testsuite v25.10.1 (not selected)

## Supported

| claim | statement | fixtures |
| --- | --- | --- |
| `S-WS-MANIFEST-RECORDS` | A JSON or YAML manifest (dialect bskel-websocket-manifest/<version>, default 1) with connections (id, endpoint, subprotocols) and messages (connection_id, name, direction, schema_ref, correlation_field) is recorded as connection and message records. | 4 |
| `S-WS-SERIALIZATION-ORDER-INDEPENDENT` | JSON and YAML spellings of one manifest give the same records, and the order of manifest arrays does not change the contract planes. | 2 |
| `S-WS-DIRECTION-VOCABULARY` | The direction values client-to-server, server-to-client and bidirectional are recorded; any other value raises a warning and the message is skipped. | 4 |
| `S-WS-BLOCKED-AND-ERRORS` | A manifest without connections and messages is blocked and cannot produce a protocol contract; non-object documents, invalid JSON and remote $ref values raise errors. | 5 |

## Not supported

| claim | behavior | statement | fixtures |
| --- | --- | --- | --- |
| `U-WS-MANIFEST-ONLY` | not-discovered | Messages and connections exist only when a manifest declares them: WebSocket usage in source code, frames, close events or traffic is never discovered, and a JavaScript source file is not an input. | 3 |
| `U-WS-STATE-MACHINE` | dropped | No connection state machine (connecting, open, closing, closed), close codes, heartbeat or reconnect model: manifest keys for them are ignored, and the flow layer does not require a connection step before a message step or check message direction against step order. | 7 |
| `U-WS-RETRY-IDEMPOTENCY` | dropped | Retry, reconnect and idempotency are caller declarations on flow steps with no tie to the manifest: manifest-level retry and idempotency keys are ignored, a retry is accepted on a server push, and ack, state and close-code step fields are silently dropped. | 6 |
| `U-WS-ENDPOINT-VALIDATION` | accepted | The endpoint is a free string: the RFC 6455 section 3 rules (ws or wss scheme, absolute URI, no fragment) are not checked. | 4 |
| `U-WS-VERSION-NOT-VALIDATED` | accepted | The manifest version is not validated: any truthy value selects the dialect bskel-websocket-manifest/<value>, while a falsy value (0) or no version selects bskel-websocket-manifest/1. It is unrelated to the RFC 6455 protocol version 13. | 3 |
| `U-WS-SUBPROTOCOL-RULES` | accepted | Subprotocols are stringified and sorted; RFC 6455 section 4.1 rules (non-empty token strings, no duplicates, order of preference) are not checked, and the declared preference order is lost. | 2 |
| `U-WS-DIRECTION-DEFAULT` | defaulted | A message without a direction is recorded as bidirectional; the manifest schema marks direction optional and does not name a default. | 1 |
| `U-WS-MANIFEST-SCHEMA-NOT-ENFORCED` | accepted | websocket-manifest.schema.json is not applied by the loader or the importer: manifests the schema rejects (unknown keys, non-string or duplicate subprotocols, wrong types, an unknown direction) are still imported. | 4 |
| `U-WS-DIAGNOSTICS` | misleading | An unresolved connection reference or a duplicate connection id blocks the scan with the misleading warning WEBSOCKET_MANIFEST_EMPTY, and malformed entries are skipped without any warning. | 3 |
| `U-WS-RFC6455-WIRE` | not-modeled | No RFC 6455 wire behaviour is modeled: opening handshake, frame format, opcodes, masking, fragmentation, ping and pong, the closing handshake and extensions. Manifest keys that name them (opcode, close_codes) are ignored. | 2 |

Counterexample fixtures: 25 (listed with their control fixtures in `SCOPE.json`, key `counterexamples`).

## Pins

- yaml 2.9.0 (importer runtime dependency (YAML and JSON document decoding), version from the root lock), published 2026-05-11T10:16:24.045Z
- ws 8.22.0 (WebSocket library candidate for a future runtime oracle; not selected), published 2026-09-26T15:00:57.748Z
- RFC 6455 (December 2011, PROPOSED STANDARD), sha256 `765775326aee0ecca9b04bde3fd1f52932d498e33e34e428bd61b8a24da0fa3b`, 162067 bytes; verified online only
- crossbario/autobahn-testsuite tag v25.10.1 (commit `6ed6f439dc7ed0d7432fe2cf7481b110905ecc5c`); not selected

Pins that need the network are checked by `test/protocol-next/tools/verify-target-pins.mjs` (last run 2026-10-08, exit 0, 11 checks); the lock based pins are recomputed offline by the test.

## Runtime and oracle

- runtime: BLOCKED. No WebSocket peer is started or connected to, and no frame is exchanged. The isolated runtime oracle (T18-05) is itself blocked on the T16 runtime plane (adapters/protocol-next/docs/T18_TO_T16_PROTOCOL_ORACLE_HANDOFF.md), so no Runtime-tested claim exists.
- oracle: BLOCKED. The manifest dialect is defined by this repository, so there is no independent reference implementation of it, and RFC 6455 wire conformance (for example the Autobahn|Testsuite) needs a live WebSocket peer, which belongs to the blocked T16 runtime plane. No library or suite was run; the candidates are recorded in the pins as not selected.

## Claims not made

- Only messages and connections declared in a manifest exist: WebSocket usage in source code, frames, close events and traffic are never discovered.
- No connection state machine, retry, reconnect or idempotency semantics are claimed; flow steps carry caller declarations that nothing ties to the manifest.
- No RFC 6455 wire behavior is modeled or claimed; the RFC and library pins are references and candidates, not conformance statements.
- The websocket manifest JSON schema is not enforced by the importer (see the unsupported list).
- Not Runtime-tested: nothing was executed against a WebSocket peer.

## Re-running

```
node --test test/protocol-next/protocol-websocket-scope.test.mjs test/protocol-next/protocol-target-scope.test.mjs
node test/protocol-next/tools/verify-target-pins.mjs --family websocket
```
