# Unity target-01: pinned text-source scope, fixtures, and evidence plan

This is the `GAME-unity-01` **static text-source scope** record. It is not a Unity Editor export, a play-mode/runtime oracle, a prefab override resolver, or the `GAME-unity-02/-03` bridge/certificate. The shadow `buildUnityTextSceneExport` producer and normalizer in `adapters/game-next` are the only implementation assessed here; the stable webgame scanner does not detect Unity projects.

## Exact upstream boundary

`RELEASE_PINS.json` fixes the official [Unity `6000.0.85f1` Editor release](https://unity.com/releases/editor/whats-new/6000.0.85f1) dated 2026-10-15 and its changeset `ee7790f1426a`. The [Unity 6.0 text-scene format](https://docs.unity.com/en-us/engine/6000.0/manual/working-with-scenes/text-scene-format/format-description) and [prefab serialization](https://docs.unity.com/en-us/engine/6000.0/manual/working-with-scenes/text-scene-format/yaml-prefab-serialization) manuals define the documented file boundary. Unity Editor source is proprietary, and no Editor binary or source archive was acquired. These release facts are **not** a fixture-generation or installation receipt. The producer's `engineVersion` option is caller-supplied free text, not a verified Editor identity. Version drift needs new adjudication.

## Fixture matrix and claim limits

| Fixture | Static result | Deliberate unknown |
|---|---|---|
| `fixtures/declared-scene.unity` | Draft producer records GameObject, Transform and MonoBehaviour document IDs, local component/parent relations, and a GUID/fileID script reference. Exact `.unity` bytes are bound in the source envelope. | `m_IsActive` and `m_Enabled` become unmodeled diagnostics. They are serialized values, not proof of a live object, component execution or current active state. |
| `fixtures/prefab-override.unity` | A `PrefabInstance` class ID 1001 document and generic source-prefab/target refs are visible. `m_Modification`, `propertyPath`, `value`, added/removed lists and override application remain unmodeled diagnostics. | The producer cannot resolve the source prefab, apply the override, infer the effective name, or claim that a stripped placeholder was loaded. A `stripped` document header fails closed rather than disappearing. |
| `fixtures/ToggleActor.cs` | Deliberate script-side counterexample: `Start` could call `SetActive` and `Destroy`, but this file is outside the `.unity` source producer's input bytes. | Its code is neither executed nor included in the scene source artifact. No runtime-only state, lifecycle or final hierarchy is inferred from the scene. |

The fixtures are authored regression samples, **not Editor-generated files**. The parser does not implement all UnityYAML or prefab semantics. Its generic reference collection can preserve a prefab GUID/fileID while losing the semantic meaning of the override; downstream consumers must retain diagnostics and must not reinterpret a `PrefabInstance` as a resolved GameObject. The source envelope proves exact input bytes, not parser correctness or runtime behavior.

## Reproduction and later gates

Run `node --test test/game-next/unity-target-scope.test.mjs`, `node --test test/game-next/native-text-source-exporters.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact source revision. Record commands, exits, TAP totals, official release identity and SHA-256 of target-owned files in `GAME_UNITY_01_VALIDATION.json`. Validate T17 ownership, exact-head required CI and independent review, then repeat the protected merge on Bob before a one-row T00 adjudication.

`GAME-unity-02` needs production bridge/contract wiring, a bounded pinned-Editor producer, and prefab-override semantics or explicit unsupported claims. `GAME-unity-03` needs independent Editor fixture cross-verification and limited certification or an explicit blocked result. T00/T19/T20 gates, signed independent attestation and `release=BLOCKED` remain separate.
