# game-next: native export intake (draft, shadow only)

This directory is an opt-in, draft intake for the T17 game-plane expansion. It does not replace or mutate `sbf.webgame-contract/1`, and nothing outside `adapters/game-next` and `test/game-next` loads it.

Every statement in this directory describes one revision, the base commit 15a38e923cb5e079c6f8e2a4c2a9386406c41f52 that `BASELINE.json` pins. Reading order: this file; `INTERFACE_RFC.md` (inputs, outputs, identity, unknown and partial semantics, file ownership); `NATIVE_STRUCTURE_FORMATS.md` (payload formats); `native-export-envelope.schema.json` (shape of the envelope); `INTEGRATION.md` (cross-track handoff). `test/game-next/interface-doc.test.mjs` reads three of these texts, `README.md`, `INTERFACE_RFC.md` and `INTEGRATION.md`, and fails when one of them names a file, an exported name or a value that the repository does not have. The prose of `NATIVE_STRUCTURE_FORMATS.md` and the descriptive values inside `native-export-envelope.schema.json` are not compared by that test; `test/game-next/native-export-envelope-schema.test.mjs` compares the schema with the envelope that the code builds and checks, of its descriptive values, only the three that describe the payload descriptor, the status property and the media type.

## What is not here

An earlier text of this file described a bridge that turned `sbf.webgame-contract/1` documents into a draft game graph, and three test files for that bridge, for the export envelope and for a schema. None of them is part of the repository at this revision, so this file neither describes nor relies on them (limit `bridge-is-described-but-not-on-main` in `BASELINE.json`). The same limit list records what else is absent: engine adapter directories, any call from the scanner, the registry or the command line into these modules, and any export from a real engine.

## Native engine export intake

`native-export-envelope.mjs` is a **data-only intake boundary** for Unreal, Unity and Godot exports. It does not launch an editor, compiler or engine, and it imports nothing but `node:crypto`.

It accepts exact UTF-8 JSON export bytes with a bounded size (8 MiB unless the option `maxBytes` says otherwise) and binds:

- engine and evidence class (section 3 of `INTERFACE_RFC.md` lists which engine accepts which evidence class);
- engine version and platform;
- producer ID/version plus a declared implementation SHA-256 field (metadata only; not attestation);
- exact export byte SHA-256 and byte length;
- the exact source files the export came from (`source_inputs`, see "Source provenance");
- a non-authoritative payload descriptor containing only declared schema and top-level keys.

The evidence classes deliberately stop short of runtime certification. The envelope hard-codes these claims to false: `producer_identity_verified`, `runtime_behavior_verified`, `causal_edges_verified` and `state_transitions_verified`. The normalized structure adds `source_structure_verified`, also false.

Therefore the presence of an Unreal, Unity or Godot export artifact is never enough to claim producer attestation, runtime behavior or causality; such evidence would have to be established separately, and nothing in this directory produces it.

Actual engine or editor execution remains a separate target-runtime isolation task (track T20) and a future T17 engine-specific exporter task. T08 language facts may feed source-export producers, but this module does not import or execute T08 code.

## Invariants

The native export envelope fails closed on:

- unsupported engine/evidence-class combinations;
- invalid UTF-8 or non-object JSON;
- byte-budget overflow;
- a malformed producer implementation digest;
- mismatched exact export bytes;
- mutation of runtime, causal or transition claims to true.

These draft files are not public replacement contracts. They are internal migration surfaces while legacy consumers keep reading the exact v1 webgame contract.

## Focused tests

| Test file | Tests | Covers |
|---|---|---|
| `native-structure-media-type.test.mjs` | 6 | media types of source inputs, and agreement between the envelope constructor and the structure invariant check |
| `native-text-source-exporters.test.mjs` | 10 | Unity and Godot text exporters: structure, source provenance, diagnostics, fail-closed inputs |

The two files above are the ones that existed at the base commit; together they hold 16 tests, and `BASELINE.json` pins both files, their counts and their hashes. Three more test files sit beside them:

- `test/game-next/baseline-record.test.mjs` recomputes the size and hashes of every pinned file, the test counts (including the 5 legacy tests), the exit code and counts of every recorded command, the output and expected values of every fixture, the reference lists of the limits that carry them, the installed package versions and the figures of this text. It does not recompute `ci_observations`, `environment`, prose (limit statements, fixture origins, the title), the files inside the installed packages, fixture inputs or the explanatory text of `README.md`, `INTERFACE_RFC.md` and `INTEGRATION.md`; the record lists them under `not_recomputed`, and `artifact_digest` only reports an edit that was not re-sealed, it does not show that a claim is true;
- `test/game-next/native-export-envelope-schema.test.mjs` checks `native-export-envelope.schema.json` against the envelope that the code builds and verifies, and lists where schema and code differ;
- `test/game-next/interface-doc.test.mjs` compares `INTERFACE_RFC.md` with the code, and checks the paths and names that this file and `INTEGRATION.md` cite.

Run one of them directly with `node --test test/game-next/native-structure-media-type.test.mjs` (or any other file named above). All of them together run as `node scripts/run-next-nested-tests.mjs T17`.

## Test discovery integration

T17 tests intentionally live under `test/game-next/**`, the T17-owned test namespace. The root `npm test` glob only expands `test/*.test.mjs`, so a green root `npm test` does **not** prove these nested suites ran. The nested-next CI job runs them as the step `T17 game-next`, which executes `node scripts/run-next-nested-tests.mjs T17`. At the base commit that command printed `NESTED_SUITE T17 RUN 2 files` and ran the two files of the table; the files added beside them raise the count, and the baseline test recomputes the figure instead of this file stating it.

## Native structure normalization

`native-structure-normalizer.mjs` consumes the exact bytes already bound by a native export envelope and accepts only three pinned internal payload profiles:

- `sbf.game-unreal-structure-export/draft-1`
- `sbf.game-unity-serialized-export/draft-1`
- `sbf.game-godot-scene-export/draft-1`

The normalized result is `sbf.game-native-structure/draft-1` with status `declared-structure-only`.

It preserves only structural declarations:

- Unreal reflection type/property/function declarations plus explicit replication/RPC specifiers;
- Unity serialized object `class_id`/`file_id`, component/parent links and GUID/fileID references;
- Godot scene/node/resource declarations and signal connection declarations.

It does not convert those declarations into runtime behavior. All verification, causality and state claims remain false. Unknown payload fields, engine/schema mismatches, duplicate derived identities, conflicting Unreal network specifiers and exact-byte mismatches fail closed.

See `NATIVE_STRUCTURE_FORMATS.md` for the source semantics and official engine documentation used to constrain the draft formats.

### Source provenance for source-only exporters

Native export envelope revision 2 carries the list `source_inputs`. Each item contains a repo-relative POSIX path, a source role, and an exact-byte `sbf.artifact-ref/1`-shaped reference with family `game-native-source`.

`source-export` is rejected when this list is empty. The envelope verifier can additionally receive the actual source bytes by path and rejects missing or mismatched bytes. Absolute paths, parent traversal, backslashes and duplicate source paths fail closed.

The normalized native structure retains the same source refs unchanged. This establishes byte identity and provenance, but does not set `source_structure_verified`; independent verification remains a separate evidence step.

## Source-only Unity and Godot exporters

`native-text-source-exporters.mjs` implements a deliberately narrow, no-engine-execution source path:

- Unity: `.unity` / `.prefab` text serialization document headers, `m_Name`, `m_GameObject`, `m_Father`, and inline fileID/GUID references;
- Godot: `.tscn` scene/node/ext-resource/sub-resource declarations, script references, and signal connections.

Each source parser:

1. reads bounded UTF-8 bytes;
2. creates an exact `game-native-source` ArtifactRef from the original source bytes;
3. emits one of the pinned draft JSON payloads;
4. creates a `source-export` native envelope that contains the exact source ref;
5. feeds the existing native structure normalizer.

Unknown Unity lines and unsupported Godot sections or lines are diagnostics (`UNITY_UNMODELED_LINE`, `GODOT_UNMODELED_LINE`, `GODOT_UNMODELED_SECTION`); they are not converted into behavior, and they are not carried by the envelope, the payload or the normalized structure. The output remains `declared-structure-only`, and all producer, source, runtime and causal verification claims remain false.

The first source-only slice does **not** parse:

- arbitrary Unity YAML semantics, nested managed-reference graphs, prefab override execution, or runtime lifecycle;
- arbitrary Godot property expressions, script execution, imported binary resources, or runtime signal emission;
- Unreal C++ source. Unreal source analysis remains a T08/T17 integration boundary.
