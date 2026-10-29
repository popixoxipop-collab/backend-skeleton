# T17 game plane: interface RFC

Status: draft, shadow only. T17 is not declared complete and nothing here is active by default. Exact revision: 15a38e923cb5e079c6f8e2a4c2a9386406c41f52, the base commit that `BASELINE.json` pins. Scope: the three modules in `adapters/game-next` and the legacy web path beside them.
Companions: `README.md` (reading order, focused commands), `INTEGRATION.md` (handoff), `NATIVE_STRUCTURE_FORMATS.md` (payload profiles), `BASELINE.json` (behaviour pinned by T17-01), `native-export-envelope.schema.json` (shape of the envelope, T17-02) and
`test/game-next/interface-doc.test.mjs`, which fails when this text and the code drift apart. Backticked words, key lists in braces and the tables are machine checked, so keep them literal.

## 1. Purpose and non-goals

The legacy web path stays authoritative: `scanWebgame` and `buildWebgameContract` emit `sbf.webgame-scan/1` and `sbf.webgame-contract/1`, and nothing in `adapters/game-next` reads, wraps or changes them. The shadow modules add an intake for engine exports: an envelope that binds exact bytes
(`native-export-envelope.mjs`), a normalizer that keeps declared structure only (`native-structure-normalizer.mjs`) and two text exporters for Unity and Godot scenes (`native-text-source-exporters.mjs`). They import only `node:crypto` and each other, read no file and start no engine or editor.
No file outside the two T17 directories names them (limit `shadow-plane-is-not-named-outside-its-directories`) and the published package does not ship them (limit `shadow-plane-is-not-in-the-published-package`). Every verification claim they emit is false: a valid envelope or structure says which bytes were bound and what they declare, never what an engine does at run time.

## 2. What is not here

An earlier draft described a bridge from `sbf.webgame-contract/1` documents into a game graph, with test files of its own. Neither the bridge nor those tests exist at this revision, so nothing may rely on them (limit `bridge-is-described-but-not-on-main`). Also absent: an exporter for Unreal sources (limit `exporters-cover-unity-and-godot-text-only`),
a producer of `editor-export` or `headless-export` data and any export from a real engine (limit `real-engine-export-is-blocked`), per-engine adapter directories (limit `no-schema-and-no-engine-adapter-directories`), and every call from the scanner, the registry, the command line or the contracts into the three modules. `BASELINE.json` records each absence as a limit; the later T17 items start from there.

## 3. Vocabulary

Evidence classes say how the producer claims the export was made, not how far it can be trusted. There is no value for an unknown engine, evidence class or source role: any other value is refused. The table is generated from the code by the test.

| engine | evidence classes | payload profile |
| --- | --- | --- |
| `godot` | `headless-export`, `source-export` | `sbf.game-godot-scene-export/draft-1` |
| `unity` | `editor-export`, `source-export` | `sbf.game-unity-serialized-export/draft-1` |
| `unreal` | `editor-export`, `source-export` | `sbf.game-unreal-structure-export/draft-1` |

Constants that the modules export; the test reads the values from the code.

| constant | value | module |
| --- | --- | --- |
| `NATIVE_EXPORT_ENVELOPE_REVISION` | 2 | `native-export-envelope.mjs` |
| `NATIVE_EXPORT_ENVELOPE_SCHEMA` | `sbf.game-native-export-envelope/draft-1` | `native-export-envelope.mjs` |
| `NATIVE_STRUCTURE_REVISION` | 2 | `native-structure-normalizer.mjs` |
| `NATIVE_STRUCTURE_SCHEMA` | `sbf.game-native-structure/draft-1` | `native-structure-normalizer.mjs` |
| `NATIVE_SOURCE_EXPORTER_REVISION` | 1 | `native-text-source-exporters.mjs` |
| `WEBGAME_SCANNER_REVISION` | 1 | `scanners/webgame.mjs` |
| `WEBGAME_CONTRACT_VERSION` | `1` | `contracts/webgame.mjs` |

- Status: the envelope is `bound-uninterpreted` and the normalized structure is `declared-structure-only`. Neither is a support, runtime or correctness status. Source roles: `active` (the default), `generated`, `reference`, `template`, `vendor`.
- Artifact references have the shape of `sbf.artifact-ref/1`, copied locally: the export has family `game-native-export` and media type `application/json`, a source file has family `game-native-source`; both have version `draft-1`.
- Claims, all false: envelope claims {producer_identity_verified, runtime_behavior_verified, causal_edges_verified, state_transitions_verified}; structure claims {producer_identity_verified, source_structure_verified, runtime_behavior_verified, causal_edges_verified, state_transitions_verified}.

## 4. Inputs and outputs

| module | function | input | output |
| --- | --- | --- | --- |
| `native-export-envelope.mjs` | `createNativeExportEnvelope` | bytes, options {engine, evidenceClass, engineVersion, platform, producer, sourceInputs, maxBytes} | {schema, envelope_revision, status, engine, evidence_class, engine_version, platform, producer, source_inputs, artifact, payload_descriptor, claims} |
| `native-export-envelope.mjs` | `createNativeSourceRef` | bytes, options {path, role, mediaType} | {path, role, artifact} |
| `native-export-envelope.mjs` | `verifyNativeExportEnvelope` | envelope, options {sourceBytes, sourceInputBytes} | {valid, errors} |
| `native-structure-normalizer.mjs` | `normalizeNativeStructureExport` | bytes, envelope | {schema, normalizer_revision, status, engine, evidence_class, source_artifact, source_inputs, producer, nodes, relations, declarations, claims} |
| `native-structure-normalizer.mjs` | `verifyNativeStructureInvariants` | structure | {valid, errors} |
| `native-text-source-exporters.mjs` | `buildGodotTextSceneExport`, `buildUnityTextSceneExport` | bytes, options {path, engineVersion, platform, producer, maxBytes} | {payload, payload_bytes, source_inputs, diagnostics, envelope} |
| `native-text-source-exporters.mjs` | `parseGodotTextScene`, `parseUnityTextScene` | bytes, options {path, maxBytes} | {payload, diagnostics, source_ref} |
| `scanners/webgame.mjs` | `detectWebgameProjects` | repository root | list of {root, packageFile, engines, enginePackages, physics} |
| `scanners/webgame.mjs` | `scanWebgame` | repository root | {schema, adapter, adapter_revision, engines, engine_packages, project_roots, source_hash, files_read, scenes, entities, hierarchy, input, simulation, render, network, assets, warnings, completeness} |
| `contracts/webgame.mjs` | `buildWebgameContract` | {featureId, featureUid, scan} | {sbf_webgame_contract, feature_id, feature_uid, source, planes, warnings, completeness} |
| `contracts/webgame.mjs` | `verifyWebgameContractSnapshot` | {contract, scan, featureId, featureUid} | {current, changes, source_hash, adapter_revision} |

Nested shapes; the test compares each key list with the objects that real calls produce:

- Source input and source reference {path, role, artifact}; artifact {artifact_ref, family, version, media_type, byte_sha256, size_bytes}, for the export and for a source alike; producer {id, version, implementation_sha256}; payload descriptor {declared_schema, top_level_keys}; source locator {engine, path, local_id}.
- Nodes: Unity node {id, kind, name, type, class_id, file_id, source} of kind `unity-serialized-object`; Godot node {id, kind, name, type, source} of kind `godot-node`, `godot-resource` or `godot-scene`; Unreal node {id, kind, name, type, specifiers, source} of kind `unreal-class`, `unreal-enum`, `unreal-function`, `unreal-interface`, `unreal-property` or `unreal-struct`.
- Relations: relation {id, kind, from, to, source} of kind `component-of`, `declared-parent`, `declares` or `scene-member`; relation {id, kind, from, target_file_id, target_guid, source} of kind `serialized-reference`; relation {id, kind, from, target_uri, source} of kind `script-reference`; relation {id, kind, from, to_symbol, source} of kind `declared-base`.
- Declarations: declarations {replication, rpc, signals}; Godot signal {id, scene, signal, from, to, method, evidence}; Unreal replication {id, subject, mode, notify, evidence}; Unreal rpc {id, subject, mode, reliability, evidence}.
- Diagnostics: diagnostic {line, code}; section diagnostic {line, code, section}, which only `GODOT_UNMODELED_SECTION` carries. A change reported for a contract is contract change {field, expected, actual}.
- Bytes are a UTF-8 string, a Buffer or a Uint8Array. The budget (option `maxBytes`, 8 MiB by default) is applied before the bytes are parsed by `buildGodotTextSceneExport`, `buildUnityTextSceneExport`, `createNativeExportEnvelope`, `parseGodotTextScene` and `parseUnityTextScene`; `createNativeSourceRef`, `normalizeNativeStructureExport` and `verifyNativeExportEnvelope` have no budget and take bytes of any size, so a caller bounds the bytes it hands to those three.
- A source media type defaults to `text/plain`. It is accepted when it has no white space, a non-empty part before the first slash and a non-empty rest after it; nothing parses it, so text/plain;charset=utf-8 is accepted as it stands and text/plain; charset=utf-8 is refused (limit `source-media-types-are-restricted`).
- Required options: `createNativeSourceRef`, `parseGodotTextScene` and `parseUnityTextScene` need `path`; `createNativeExportEnvelope` needs `engine`, `evidenceClass`, `engineVersion`, `platform` and `producer`, plus `sourceInputs` for `source-export`; `buildGodotTextSceneExport` and `buildUnityTextSceneExport` need `path`, `engineVersion`, `platform` and `producer`.

## 5. Identity

- Export: its identity is the SHA-256 and the length of its exact bytes (`byte_sha256`, `size_bytes`). The same JSON formatted differently is another artifact. `payload_descriptor` is a convenience copy that identifies nothing and is not authoritative.
- Source file: `path` (repo-relative, POSIX, no empty, dot or dot-dot segment), `role` and its own artifact; `source_inputs` are sorted by `path`, and a path appears once.
- Producer: a declaration. `implementation_sha256` only has to look like a digest, nothing attests it, and `engine_version` and `platform` are free text.
- Ids in the structure: node ids use names the export itself declares (a Unity file id, a Godot scene and node path, an Unreal type id). Some relation and signal ids additionally use the zero-based position of a declaration within its parent list. In particular, a Unity serialized-reference id combines the document file id and reference index, while a Godot signal id combines the scene path and connection index. Reordering references or connections can keep an id while changing the declaration it denotes. A second declaration of the same id is refused. These are local names inside one export, not stable project, feature or cross-tool identities (limit `derived-identities-are-names-not-project-identity`).
- The modules never emit `sbf.contract-ref/1`, `sbf.identity-envelope/1` or `contract_hash`, and import nothing from `contracts/next`; a digest above must not be stored as a contract hash. T01 owns those identities. The legacy contract takes `featureId` and `featureUid` from the caller (limit `contract-identity-is-what-the-caller-passes`).

## 6. Unknown, partial and unsupported

- Fail closed: an unknown engine, evidence class or role, a claim that is true, a malformed digest, an unknown payload field and a payload profile that does not belong to the engine are errors. Unknown or unsupported is never reported as supported.
- `verifyNativeExportEnvelope` reports tokens, not messages: `schema`, `envelope_revision`, `status`, `engine-profile`, `producer`, `source_inputs.required`, `source_inputs`, `artifact`, `claims.<claim>`, `artifact-bytes`, `source_input_bytes`, `source_input_bytes.missing:<path>`, `source_input_bytes.mismatch:<path>`.
- `verifyNativeStructureInvariants` reports `schema`, `normalizer_revision`, `status`, `source_artifact`, `claims.<claim>`, `source_inputs`, `source_inputs.path`, `source_inputs.duplicate-path`, `source_inputs.required`, `source_inputs.artifact:<path>`, `nodes.duplicate-id`, `relations.duplicate-id`.
- Without bytes the verifier checks structure only: an envelope with a hash that fits no bytes is valid until `sourceBytes` and `sourceInputBytes` are passed. It does not look at `engine_version`, `platform`, `payload_descriptor` or extra keys (limit `verifier-checks-less-than-the-envelope-states`); the JSON schema is stricter there, and the schema test records the differences its negative matrix probes. Both export and source artifact digests must be strings; an array containing a valid digest is refused, not string-coerced.
- Partial reading: the text exporters leave out what they do not model and still succeed, reporting `GODOT_UNMODELED_LINE`, `GODOT_UNMODELED_SECTION` or `UNITY_UNMODELED_LINE`. Diagnostics are not part of the envelope, the payload or the structure, so a partial and a complete reading look alike downstream; keep them (limit `exporters-drop-unmodeled-text-with-a-diagnostic`).
- `editor-export` and `headless-export` are labels: no code produces them. Relations in the structure are declarations, not behaviour (limit `normalized-structure-is-declared-only`).

## 7. Legacy web path

`detectWebgameProjects` and `scanWebgame`: a project is found only when its `package.json` declares `@react-three/fiber` or `three`; a project that declares only another engine package is not found (limit `scanner-detects-only-three-and-react-three-fiber`). Its `completeness.status` is `blocked` (no project found; warning `WEBGAME_ENGINE_NOT_DETECTED`, the same for a damaged manifest, limit `blocked-does-not-say-why`),
`partial` (no scene, warning `WEBGAME_SCENE_UNRESOLVED`; or a scene with neither a loop nor a system, warning `WEBGAME_SIMULATION_LOOP_UNRESOLVED`) or `complete`, which only means a scene and a loop or a system were found (limit `complete-means-a-scene-and-a-loop-were-found`). Found input is never traced to an effect (warning `WEBGAME_INPUT_EFFECT_UNRESOLVED`).
`buildWebgameContract` throws for a blocked scan and emits a contract with the warnings for a partial one (limit `contract-is-emitted-from-a-partial-scan`); `verifyWebgameContractSnapshot` compares field by field.

## 8. File ownership

| paths | owner | T17 may |
| --- | --- | --- |
| `adapters/game-next`, `test/game-next` | T17 | edit |
| `scanners/webgame.mjs`, `contracts/webgame.mjs`, `schemas/webgame-contract.schema.json`, `schemas/webgame-scan.schema.json`, `test/webgame-contract.test.mjs` | stable surface | call and pin in `BASELINE.json`, never edit |
| `test/fixtures/historical-replay` | stable surface | none (it records no game plane, limit `historical-replay-records-no-game-plane`) |
| `contracts/next` | T01 | none, no import |
| `lib/trust-next` | T20 | none, no import |
| `package.json`, `scripts/run-next-nested-tests.mjs`, `.github/workflows` | coordinator | read only, never edit |

`adapters/game-next` holds exactly: `BASELINE.json`, `INTEGRATION.md`, `INTERFACE_RFC.md`, `NATIVE_STRUCTURE_FORMATS.md`, `README.md`, `T17_01_UNITY_HEADER_CORRECTION.md`, `T17_02_INTERFACE_VALIDATION.json`, `native-export-envelope.mjs`, `native-export-envelope.schema.json`, `native-structure-normalizer.mjs`, `native-text-source-exporters.mjs`.
`test/game-next` holds exactly: `baseline-record-lib.mjs`, `baseline-record.test.mjs`, `interface-doc.test.mjs`, `native-export-envelope-schema.test.mjs`, `native-structure-media-type.test.mjs`, `native-text-source-exporters.test.mjs`. A new file in either needs this RFC updated first.

`T17_02_INTERFACE_VALIDATION.json` records the source revision, exact commands, exit codes, test counts and file hashes of the interface checks after independent replay. It is a reproducibility receipt, not an engine-runtime or release attestation.
