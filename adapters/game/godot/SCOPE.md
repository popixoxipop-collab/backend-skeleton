# Godot target-01: pinned source scope, fixtures, and evidence plan

This is the `GAME-godot-01` **static text-source scope** record. It is not a Godot editor/headless export, installed-engine attestation, runtime signal oracle, lifecycle oracle, or `GAME-godot-02/-03` bridge/certificate. The shadow `buildGodotTextSceneExport` producer and normalizer in `adapters/game-next` are the only implementation assessed here; the stable webgame scanner is not a Godot project detector.

## Exact upstream boundary

`RELEASE_PINS.json` identifies the official [Godot `4.7.2-stable` release](https://github.com/godotengine/godot/releases/tag/4.7.2-stable), tag commit `ed1daf0bf001b61586d9930840f2f1394092c079`, and Git blobs for [`version.py`](https://github.com/godotengine/godot/blob/4.7.2-stable/version.py) (`4b0e55c61b87f2962329eaec53764727177bedde`), [`scene/main/node.cpp`](https://github.com/godotengine/godot/blob/4.7.2-stable/scene/main/node.cpp) (`748a8563ce83ec58583def7af535095d7f7b47c9`), and [`scene/resources/packed_scene.cpp`](https://github.com/godotengine/godot/blob/4.7.2-stable/scene/resources/packed_scene.cpp) (`49a72488173626c9d779242fa215061216cefa43`). The release's `version.py` says major 4, minor 7, patch 2, stable. These pins define the version for future compatibility work; they do **not** prove that a Godot binary is installed, that the fixtures were saved by that release, or that the current text producer enforces an engine version. Its `engineVersion` option is caller-supplied free text. A version change requires new scope adjudication.

## Fixture matrix and claim limits

| Source fixture | Static result | Deliberate unknown |
|---|---|---|
| `fixtures/declared-scene.tscn` | The draft text producer records a scene, root and child node declarations, one external script reference, a sub-resource ID, and one declared signal connection. The exact `.tscn` bytes bind to the source envelope. | It does not read `player.gd`, resolve a resource on disk, check Godot import, emit the signal, invoke `_on_hit`, or prove a state transition. |
| `fixtures/unsupported-lifecycle.tscn` | The same node and connection declarations remain visible; `process_mode`, `visible`, and `[editable]` produce unmodeled diagnostics. | The `Player` node's presence at a runtime frame, process/visibility effects, signal delivery, deletion/reparenting, and callback behavior are unknown. Diagnostics are returned separately and must be preserved by a caller; they are not in the normalized payload. |
| Negative mutations in the focused test | Duplicate derived node paths and resource IDs and incomplete connections fail closed. A changed source byte produces a different source artifact digest even when the extracted declarations are unchanged. | These checks do not certify the parser against every valid Godot text-scene construct. |

The fixtures are authored regression samples, not captured output from the pinned engine. Godot's [scene/node model](https://docs.godotengine.org/en/4.7/getting_started/step_by_step/scenes_and_nodes.html), [signals](https://docs.godotengine.org/en/4.7/getting_started/step_by_step/signals.html), and [command-line execution](https://docs.godotengine.org/en/4.7/tutorials/editor/command_line_tutorial.html) motivate the future runtime fixture, but no runtime command is run for target-01. A declared connection is not evidence of emission, method execution, or effect.

## Reproduction and later gates

Run `node --test test/game-next/godot-target-scope.test.mjs`, `node --test test/game-next/native-text-source-exporters.test.mjs`, and `node scripts/run-next-nested-tests.mjs T17` on the exact source revision. Record commands, exits, TAP totals, upstream identities and SHA-256 of each target-owned file in `GAME_GODOT_01_VALIDATION.json`. Validate the T17 ownership diff, required exact-head CI and independent review; repeat the exact protected merge on Bob before one-row T00 adjudication.

`GAME-godot-02` needs the production bridge/contract boundary, a bounded runtime profile and a real pinned-engine producer. `GAME-godot-03` needs independent engine fixture cross-verification and limited certification or an explicit blocked result. T00/T19/T20 gates, signed independent attestation and `release=BLOCKED` remain separate.
