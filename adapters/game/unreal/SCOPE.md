# Unreal target-01: pinned reflection-declaration scope, fixtures and evidence plan

This is the `GAME-unreal-01` **declared-reflection scope** record. It is not Unreal source analysis, an Editor export, a Blueprint graph reader, an asset registry, a runtime oracle or the `GAME-unreal-02/-03` bridge/certificate. The T17 shadow envelope and normalizer can consume a declared JSON profile, but no Unreal producer exists. The stable webgame scanner does not detect Unreal projects.

## Exact upstream boundary

`RELEASE_PINS.json` pins the officially announced [Unreal Engine 5.8 release series](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available) of 2026-06-23, its [release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes), and Epic's [reflection manual](https://dev.epicgames.com/documentation/unreal-engine/reflection-system-in-unreal-engine). The announcement does not establish an exact installed patch, source changelist or local executable identity. No engine source, binary or Editor-generated export was acquired. The envelope's `engineVersion` and `producer` values are caller declarations, not verified identities. Version or source drift needs new adjudication.

## Fixture matrix and claim limits

| Fixture | Declared result | Deliberate unknown |
|---|---|---|
| `fixtures/ProbeActor.h` | Authored C++ illustration of `UCLASS`, `UPROPERTY`, `UFUNCTION`, replication and RPC specifiers. Its exact bytes can be bound as a source input. | No C++/UHT parser reads this header. The hand-written JSON below is not proven to correspond to it, and no engine has compiled it. |
| `fixtures/declared-reflection.json` | Hand-written `sbf.game-unreal-structure-export/draft-1` declaration: type, property, function, declared base, RepNotify and Server/Reliable specifiers. The normalizer emits only declared structure. | No actor replication setup, authority, ownership, network delivery, RepNotify execution or gameplay effect is inferred. |
| Blueprint/editor-only counterexample | A source-only view cannot observe an unexported Blueprint graph or editor-only asset. A missing node in this fixture means unknown, not absent from a game. This mirrors T19 `NEG-GAME-06`. | No Blueprint content, compiled class or runtime behavior is certified. |
| Asset identity counterexample | A changed exact source input invalidates its bound artifact; an extra asset-identity field is rejected. This mirrors T19 `NEG-GAME-07`. | The profile does not model asset GUIDs, package version, redirectors or asset registry identity; a property type/name is not an asset binding. |

The fixtures are authored regression samples, **not Engine-generated**. In the tests, `source-export` is a data-shape label only; no source exporter exists and the supplied producer digest is an unverified test declaration. The envelope binds bytes, not the correspondence between header and JSON or the correctness of reflection semantics. Unrecognized payload fields, duplicate identities and conflicting replication/RPC specifiers fail closed. `editor-export` is likewise a permitted label with no producer. All producer, source-structure, runtime, causal and state claims remain false.

## Reproduction and later gates

Run `node --test test/game-next/unreal-target-scope.test.mjs`, `node --test test/game-next/native-export-envelope-schema.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact source revision. Record commands, exits, TAP totals, release-series identity and SHA-256 of target-owned files in `GAME_UNREAL_01_VALIDATION.json`. Validate T17 ownership, exact-head required CI and independent review, then replay the protected merge on Bob before a one-row T00 adjudication.

`GAME-unreal-02` needs a real bounded producer, production bridge/contract wiring, a precise patch/changelist and asset/Blueprint coverage or explicit unsupported states. `GAME-unreal-03` needs independent engine-export cross-verification and limited certification or an explicit blocked result. T00/T19/T20 gates, independent attestation and `release=BLOCKED` remain separate.
