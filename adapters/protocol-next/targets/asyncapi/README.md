# AsyncAPI 2.x and 3.x document importer: scope record

Plan item PROTO-asyncapi-01. Status: `scope-recorded`. This is a scope record, not a support claim: nothing here marks the target as supported, and nothing was Runtime-tested.

Machine-readable form: `SCOPE.json` (schema `adapters/protocol-next/schemas/protocol-target-scope.schema.json`, checked by `test/protocol-next/protocol-asyncapi-scope.test.mjs`). The plan declares the write scope `adapters/protocol/asyncapi/**`, which does not exist; the record lives next to the adapter code instead.

Fixture corpus: `test/protocol-next/fixtures/targets/asyncapi.fixtures.json`, canonical sha256 `a46e0822ffc62efde08aa83132e0c9166ef017cedb805cb9d7497d485f116816`, 43 scan cases and 7 flow cases. Every case is replayed through the real adapter by the tests.

## Profile

- inputs: AsyncAPI documents in YAML or JSON (asyncapi.yaml, asyncapi.json)
- dialects observed: `asyncapi-1.2.0`, `asyncapi-2.0.0`, `asyncapi-2.1.0`, `asyncapi-2.2.0`, `asyncapi-2.3.0`, `asyncapi-2.4.0`, `asyncapi-2.5.0`, `asyncapi-2.6.0`, `asyncapi-2.6.1`, `asyncapi-3.0`, `asyncapi-3.0.0`, `asyncapi-3.0.0-rc1`, `asyncapi-3.0.1`, `asyncapi-3.1.0`, `asyncapi-3.9.9`, `asyncapi-4.0.0`, `asyncapi-unknown`, `asyncapi-v3.0.0`
- scan status: `partial` (a successful scan is never complete)
- version_pattern: ^(?:2|3)\.\d+\.\d+$
- untested_warning: ASYNCAPI_VERSION_UNTESTED
- missing_warning: ASYNCAPI_VERSION_MISSING
- reference_parser_supported_versions: ["2.0.0","2.1.0","2.2.0","2.3.0","2.4.0","2.5.0","2.6.0","3.0.0","3.1.0"]
- reference_spec_tags: ["v2.6.0","v3.0.0","v3.1.0"]
- broker_and_client_libraries: UNKNOWN: the importer reads no servers, bindings or client library, so no broker product, broker version or client library version is recorded, exercised or pinned; host, protocol and protocolVersion under servers are dropped

## Supported

| claim | statement | fixtures |
| --- | --- | --- |
| `S-AAPI-VERSION-PATTERN` | An asyncapi value that is a string matching ^(?:2\|3)\.\d+\.\d+$ selects the dialect asyncapi-<value> without a warning. Every version the official parser 3.6.3 accepts (2.0.0 to 2.6.0, 3.0.0, 3.1.0) is covered; the pattern also admits versions the parser rejects. | 12 |
| `S-AAPI-VERSION-WARNINGS` | A string that does not match the pattern yields ASYNCAPI_VERSION_UNTESTED (dialect asyncapi-<value>); an absent, empty or non-string value yields ASYNCAPI_VERSION_MISSING (dialect asyncapi-unknown). Neither warning blocks the scan. | 9 |
| `S-AAPI-V2-CHANNELS` | AsyncAPI 2.x channels with publish and subscribe operations (operationId, message references) and components.messages are recorded as channel, operation and message records. | 1 |
| `S-AAPI-V3-OPERATIONS` | AsyncAPI 3.x channels (address), operations (action send or receive, channel reference, message references) and components.messages are recorded as channel, operation and message records. | 2 |
| `S-AAPI-SERIALIZATION-INDEPENDENT` | YAML and JSON spellings of the same document produce the same contract planes. | 2 |
| `S-AAPI-BLOCKED-AND-ERRORS` | A document with neither version nor channels, or with a version but no channels, is blocked and cannot produce a protocol contract; a remote $ref, a non-object document and undecodable YAML raise errors. | 6 |

## Not supported

| claim | behavior | statement | fixtures |
| --- | --- | --- | --- |
| `U-AAPI-BINDINGS` | dropped | Server, channel, operation and message bindings (mqtt qos and retain, kafka topic, partitions, group and key, amqp ack and deliveryMode, bindingVersion) are not recorded: documents that differ only in bindings produce identical contract planes. | 4 |
| `U-AAPI-SERVERS` | dropped | servers (host, protocol, protocolVersion) are not recorded, so broker identity and broker version are unknown for every scanned document. | 2 |
| `U-AAPI-REPLY-CORRELATION` | dropped | Operation reply (request-reply) and message correlationId are not recorded. | 2 |
| `U-AAPI-RETRY-IDEMPOTENCY-DELIVERY` | dropped | No retry, idempotency or delivery-guarantee semantics. AsyncAPI documents carry them only in bindings, extensions and message headers (x-retry, x-idempotency-key, x-delivery, an idempotency header); none is recorded. At the flow layer retry, idempotency and timeout are caller declarations that nothing ties to the document, and delivery, qos, ack and redelivery step fields are silently dropped. | 10 |
| `U-AAPI-CHANNEL-LEVEL-MESSAGES` | dropped | Only components.messages become message records; messages declared inline under a channel produce no message record. | 1 |
| `U-AAPI-ONEOF-MESSAGES` | dropped | A message oneOf list on an operation yields no message references. | 1 |
| `U-AAPI-EXTERNAL-REFS` | flagged | Relative-file $ref values are not resolved: the referencing channel is recorded as null and each reference raises ASYNCAPI_EXTERNAL_REF_UNRESOLVED; remote $ref values are refused with an error. | 2 |
| `U-AAPI-SCHEMA-VALIDATION` | accepted | The document is not validated against any AsyncAPI JSON Schema: 2.x and 3.x constructs in one document are both read, a missing info object is accepted, and the versions 2.6.1, 3.0.1 and 3.9.9, which the official parser rejects, are accepted without a warning (the specification repository has no tag for 2.6.1 and 3.9.9, and its release for tag v3.0.1 is titled "v3.0.1 - INVALID"). | 5 |

Counterexample fixtures: 18 (listed with their control fixtures in `SCOPE.json`, key `counterexamples`).

## Pins

- @asyncapi/parser 3.6.3 (reference parser of the static oracle run), published 2026-08-08T07:50:40.356Z
- @asyncapi/specs 6.11.1 (JSON schemas used by the reference parser (the latest published release; 6.11.2 is not published)), published 2026-01-30T15:29:14.004Z
- yaml 2.9.0 (importer runtime dependency (YAML and JSON document decoding), version from the root lock), published 2026-05-11T10:16:24.045Z
- asyncapi/spec tag v3.1.0 (commit `b3fac5bb522771428ea57b16129b273cd3ea0180`)
- asyncapi/spec tag v3.0.0 (commit `d78dcea70c9b094a3df72f9a4e811828cec778cc`)
- asyncapi/spec tag v2.6.0 (commit `1824379ba6252bfb52550337a86ca9b10a33b3aa`)
- asyncapi/spec tag v3.0.1 (commit `4ae48a3664c7bb9973c8ce4c391dc590a29cc5f6`); not selected
- asyncapi/spec has no tag v2.6.1, 2.6.1, v3.9.9, 3.9.9

Pins that need the network are checked by `test/protocol-next/tools/verify-target-pins.mjs` (last run 2026-10-08, exit 0, 16 checks); the lock based pins are recomputed offline by the test.

## Runtime and oracle

- runtime: BLOCKED. No broker (MQTT, Kafka, AMQP or any other) is started, published to or consumed from, and no client library is exercised. The isolated runtime oracle (T18-05) is itself blocked on the T16 runtime plane (adapters/protocol-next/docs/T18_TO_T16_PROTOCOL_ORACLE_HANDOFF.md), so no Runtime-tested claim exists.
- oracle: RUN-static (static acceptance and element count comparison against the official AsyncAPI parser (no broker executed)) on 2026-10-08, evidence `test/protocol-next/fixtures/targets/asyncapi.oracle.json` (canonical sha256 `efd87ab6274325595a13dc10bbeed5c6427d3efb6e5fac92115a39c1cf5df6e4`).
- oracle summary: {"compared":42,"agree_on_acceptance":27,"adapter_accepts_oracle_rejects":["aapi-c07-relative-file-ref","aapi-c08-mixed-2x-and-3x-constructs","aapi-c09-missing-required-info","aapi-v-missing-empty-string","aapi-v-missing-key","aapi-v-missing-numeric-3","aapi-v-missing-unquoted-3.0","aapi-v-silent-2.6.1","aapi-v-silent-3.0.1","aapi-v-silent-3.9.9","aapi-v-untested-1.2.0","aapi-v-untested-3.0.0-rc1","aapi-v-untested-4.0.0","aapi-v-untested-quoted-3.0","aapi-v-untested-v3.0.0"],"with_divergent_categories":["aapi-c05-channel-level-messages-only"]}
  - limit: Compares whether the document is accepted and the channel, operation and message counts; it compares no message semantics.
  - limit: The parser runs offline: relative file references cannot be resolved and the remote reference case is not compared.
  - limit: The parser supports exactly the versions listed in the profile and rejects every other version string regardless of the document content.
  - limit: The parser is a validator of AsyncAPI documents, not an independent conformance suite for the importer; the run covers this corpus only.

## Claims not made

- No retry, idempotency or delivery-guarantee semantics are claimed: AsyncAPI documents carry them only in bindings, extensions and headers, none of which the importer records.
- No broker product, broker version or client library version is recorded, exercised or pinned (UNKNOWN).
- The version pattern admits version strings that the official parser rejects (see the version matrix); a matching version is not an accepted version.
- Not Runtime-tested: nothing was executed against a broker.
- The static oracle run is not an independent conformance claim for the importer.

## Re-running

```
node --test test/protocol-next/protocol-asyncapi-scope.test.mjs test/protocol-next/protocol-target-scope.test.mjs
node test/protocol-next/tools/target-oracle.mjs --family asyncapi --oracle-dir <empty directory outside the repository> --install
node test/protocol-next/tools/verify-target-pins.mjs --family asyncapi
```
