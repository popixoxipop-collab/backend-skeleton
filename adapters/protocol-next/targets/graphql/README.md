# GraphQL SDL and introspection importer: scope record

Plan item PROTO-graphql-01. Status: `scope-recorded`. This is a scope record, not a support claim: nothing here marks the target as supported, and nothing was Runtime-tested.

Machine-readable form: `SCOPE.json` (schema `adapters/protocol-next/schemas/protocol-target-scope.schema.json`, checked by `test/protocol-next/protocol-graphql-scope.test.mjs`). The plan declares the write scope `adapters/protocol/graphql/**`, which does not exist; the record lives next to the adapter code instead.

Fixture corpus: `test/protocol-next/fixtures/targets/graphql.fixtures.json`, canonical sha256 `9b2190f36405b8d43b33cde335f738bf695ac21291f06866eeabf27766907efe`, 33 scan cases and 0 flow cases. Every case is replayed through the real adapter by the tests.

## Profile

- inputs: SDL documents (.graphql, .gql, .graphqls); introspection result JSON ({"data":{"__schema":...}} or {"__schema":...})
- dialects observed: `graphql-introspection-json`, `graphql-sdl`
- scan status: `partial` (a successful scan is never complete)
- importer_spec_edition: UNKNOWN: SDL carries no edition and the importer implements no edition grammar; the editions below are references for the recorded claims, not importer properties
- reference_editions: ["October2021","September2025"]
- reference_libraries: ["graphql 16.14.2","graphql 17.0.2"]
- edition_to_library_mapping: UNKNOWN: the graphql-js documentation declares no specification edition for either release
- edition_dependent_syntax: the token oneOf occurs 0 times in the October2021 Type System section and 10 times in the September2025 one; both library versions accept it, and the importer ignores it like any directive

## Supported

| claim | statement | fixtures |
| --- | --- | --- |
| `S-GQL-SDL-DECLARATIONS` | SDL documents (.graphql, .gql, .graphqls) yield one record per type, interface, input, enum, union and scalar declaration, with kind, name, file and line. | 2 |
| `S-GQL-SDL-FIELDS` | Field declarations of object, interface and input types are recorded, with the type text kept verbatim on one line (it is not canonicalized). | 3 |
| `S-GQL-SDL-ROOT-OPERATIONS` | Root operations come from an explicit schema definition (schema { query: X }) or from the implicit Query, Mutation and Subscription types; every root field is one operation record. | 3 |
| `S-GQL-COMMENTS-MASKED` | Line comments, block strings and single-line description strings are masked before declarations are read, so declarations written inside them are not recorded. | 1 |
| `S-GQL-INTROSPECTION` | Introspection JSON, either {"data":{"__schema":...}} or {"__schema":...}, yields type, field and root-operation records including field arguments with default values; the introspection kind names (object, input_object) are kept as they are. | 3 |
| `S-GQL-BLOCKED-ON-NO-DECLARATIONS` | A document without any type declaration (empty, comment-only, or executable operations only) is blocked with GRAPHQL_TYPES_NOT_FOUND and cannot produce a protocol contract; introspection input that is not valid JSON or has no __schema raises an error. | 5 |

## Not supported

| claim | behavior | statement | fixtures |
| --- | --- | --- | --- |
| `U-GQL-SPEC-EDITION` | not-detected | No GraphQL specification edition is detected, enforced or recorded: SDL carries no edition, the importer implements no edition grammar, and edition-dependent syntax (@oneOf: the token oneOf occurs 0 times in the October 2021 Type System section and 10 times in the September 2025 one) is ignored like any other directive. The edition pinned in SCOPE.json is the reference for these claims, not an importer property. | 2 |
| `U-GQL-DIRECTIVES` | dropped | Directive definitions and usages are not recorded: adding or removing them leaves the contract unchanged, and a directive written on the schema definition hides its root operations. | 5 |
| `U-GQL-FEDERATION` | dropped | No federation semantics: @key, @link, @shareable, entity resolution, the _entities and _service fields and Federation 1 extend type are read as plain declarations; nothing marks a subgraph, an entity or a key. | 2 |
| `U-GQL-TYPE-EXTENSIONS` | misread | extend type is recorded as a second, plain type declaration; it is indistinguishable from a duplicate definition and is not merged into the extended type. | 2 |
| `U-GQL-SDL-ARGUMENTS` | dropped | Field arguments and their default values are not recorded for SDL input (they are for introspection input), so operation signatures from SDL carry no arguments. | 3 |
| `U-GQL-TYPE-RELATIONS` | dropped | implements clauses, union member lists and enum values are not recorded. | 2 |
| `U-GQL-MULTILINE-DECLARATIONS` | misread | The scanner is line oriented: a declaration whose opening brace is not on the declaration line is recorded without fields and operations, and nested list types are truncated (the field type [[Int]] is read as [[Int]). | 4 |
| `U-GQL-SCHEMA-VALIDATION` | accepted | No schema validation: undefined type references, duplicate type definitions, two schema definitions and an interface used as the query root are accepted without a warning. | 4 |
| `U-GQL-RESOLVERS` | rejected | Resolver source code is not an input: a JavaScript resolver module is rejected as an undecodable document, and no resolver wiring or resolver behaviour is extracted from anywhere. | 1 |
| `U-GQL-EXECUTABLE-DOCUMENTS` | blocked | Executable documents (operations and fragments) are not schema inputs; they are blocked like an empty document. | 1 |

Counterexample fixtures: 22 (listed with their control fixtures in `SCOPE.json`, key `counterexamples`).

## Pins

- graphql 16.14.2 (reference library of the static oracle run), published 2026-06-09T09:08:23.122Z
- graphql 17.0.2 (reference library of the static oracle run), published 2026-07-03T06:28:49.985Z
- yaml 2.9.0 (importer runtime dependency (YAML and JSON document decoding), version from the root lock), published 2026-05-11T10:16:24.045Z
- GraphQL specification October2021 (commit `51337a9b820e296fa7d03ae77d534cb4b247c201`), sha256 `fa2bd4600883bf365116b8fad7900ca9d9bbabde687f097a98a799a40f2cd98c`, 70894 bytes; verified online only
- GraphQL specification September2025 (commit `89d93ebbe05db06787646d76a696ead8de117b2b`), sha256 `5456b4674b8079eb5651f1d682025453f6aa4f1d3aa8cdab35332947139ca843`, 81291 bytes; verified online only

Pins that need the network are checked by `test/protocol-next/tools/verify-target-pins.mjs` (last run 2026-10-08, exit 0, 14 checks); the lock based pins are recomputed offline by the test.

## Runtime and oracle

- runtime: BLOCKED. No GraphQL server, gateway or federation subgraph is started or queried, and no resolver is executed. The isolated runtime oracle (T18-05) is itself blocked on the T16 runtime plane (adapters/protocol-next/docs/T18_TO_T16_PROTOCOL_ORACLE_HANDOFF.md), so no Runtime-tested claim exists.
- oracle: RUN-static (static declaration and acceptance comparison against graphql-js (no server executed)) on 2026-10-09, evidence `test/protocol-next/fixtures/targets/graphql.oracle.json` (canonical sha256 `bc85e4ccfd9455d0db757351d5f0fbd3bb6781d859104f21cba4aa8386841f11`).
- oracle summary: {"compared":32,"agree_on_acceptance":27,"adapter_accepts_oracle_rejects":["gql-c01b-federation-v1-extend-type","gql-c09a-two-schema-definitions","gql-c09b-undefined-type-reference","gql-c09c-duplicate-type-definition","gql-c10-interface-named-as-root"],"with_divergent_categories":["gql-c01-federation-subgraph","gql-c03-schema-definition-with-directive","gql-c04-brace-on-next-line","gql-c05-nested-list-type","gql-c06-extend-type","gql-c07-sdl-arguments-dropped","gql-c11-oneof-input-edition-dependent","gql-n01-sdl-explicit-roots","gql-n02-sdl-implicit-roots","gql-n04-introspection-data-wrapper","gql-n05-introspection-bare-schema"]}
  - limit: Compares declaration lists (types, fields, root operations) and whether the document is accepted; it executes no server and no resolver.
  - limit: graphql-js is a validator of GraphQL documents, not an independent conformance suite for the importer; the run covers this corpus only.
  - limit: Argument default values are excluded from the comparison because graphql-js 16 and 17 expose them differently.
  - limit: Versions 16.14.2 and 17.0.2 agreed on every compared case, so the run says nothing about version dependent behavior.

## Claims not made

- No GraphQL specification edition is claimed for the importer: the pinned editions are references for the recorded claims, not an importer property, and no mapping from a graphql-js release to an edition is documented (UNKNOWN).
- No claim for federation, directives, type extensions, SDL arguments, implements, union and enum members, multi-line declarations, schema validation, resolvers or executable documents (see the unsupported list).
- Not Runtime-tested: nothing was executed against a GraphQL server.
- The static oracle run is not an independent conformance claim for the importer.

## Re-running

```
node --test test/protocol-next/protocol-graphql-scope.test.mjs test/protocol-next/protocol-target-scope.test.mjs
node test/protocol-next/tools/target-oracle.mjs --family graphql --oracle-dir <empty directory outside the repository> --install
node test/protocol-next/tools/verify-target-pins.mjs --family graphql
```
