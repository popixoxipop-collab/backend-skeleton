# T17 native structure export profiles

Status: **internal draft / data-only**.

These formats define what a future approved engine exporter may hand to T17. They are not native Unreal, Unity or Godot file formats, and their existence is not native-engine support certification.

## Shared authority rule

Every payload is first wrapped by `native-export-envelope.mjs`, which binds the exact UTF-8 JSON bytes. `native-structure-normalizer.mjs` accepts the same bytes only when they match that envelope exactly.

The normalized document is always:

```text
status = declared-structure-only
source_structure_verified = false
runtime_behavior_verified = false
causal_edges_verified = false
state_transitions_verified = false
```

A declaration can become a runtime claim only through the later T16/beval runtime-evidence path. T17 does not infer behavior from names, adjacency, ownership or metadata.

## Unreal profile

Payload schema: `sbf.game-unreal-structure-export/draft-1`.

The profile models reflection declarations:

- type: class / struct / interface / enum;
- reflected property name/type/specifiers;
- reflected function name/specifiers;
- optional declared base type.

The Unreal reflection system exposes classes/functions/properties through reflection macros such as `UCLASS`, `UFUNCTION` and `UPROPERTY`:

https://dev.epicgames.com/documentation/unreal-engine/reflection-system-in-unreal-engine

T17 recognizes only explicit network-related specifier declarations:

- property: `Replicated`, `ReplicatedUsing=...`;
- function RPC mode: `Client`, `Server`, `Remote`, `NetMulticast`, `ServiceRequest`, `ServiceResponse`;
- function delivery declaration: `Reliable`, `Unreliable`.

References:

- https://dev.epicgames.com/documentation/unreal-engine/replicate-actor-properties-in-unreal-engine
- https://dev.epicgames.com/documentation/unreal-engine/remote-procedure-calls-in-unreal-engine
- https://dev.epicgames.com/documentation/unreal-engine/ufunctions-in-unreal-engine

These become `declared-specifier` facts only. T17 does **not** claim that:

- the owning Actor/subobject is configured for runtime replication;
- lifetime replication registration is correct;
- an RPC is reachable under actual ownership/authority conditions;
- a RepNotify or RPC implementation produces any specific gameplay effect.

Multiple incompatible RPC modes, both Reliable and Unreliable, or conflicting replication declarations fail closed instead of choosing one.

## Unity profile

Payload schema: `sbf.game-unity-serialized-export/draft-1`.

Unity text-serialized scene data uses a YAML subset with separate serialized objects. Unity documents class IDs such as GameObject (1), Transform (4), and MonoBehaviour (114). Serialized asset references use a GUID plus a local file ID.

References:

- https://docs.unity3d.com/6000.0/Documentation/Manual/FormatDescription.html
- https://docs.unity3d.com/6000.0/Documentation/Manual/ClassIDReference.html
- https://docs.unity3d.com/6000.0/Documentation/ScriptReference/AssetDatabase.TryGetGUIDAndLocalFileIdentifier.html
- https://docs.unity3d.com/6000.0/Documentation/Manual/script-serialization.html

The T17 JSON profile is an **export representation**, not a YAML parser. It preserves:

- `class_id` and `file_id`;
- optional serialized type/name;
- GameObject/component and parent references supplied by the exporter;
- serialized GUID/fileID references.

`fileID: 0` is treated as a null/no-target value and does not create a fake `unity:object:0` edge.

The class-ID convenience mapping is intentionally narrow: 1 → GameObject, 4 → Transform, 114 → MonoBehaviour. Other IDs remain explicit numeric facts unless the exporter supplies a type string. Serialized structure does not prove that a component executed successfully.

## Godot profile

Payload schema: `sbf.game-godot-scene-export/draft-1`.

Godot organizes a game as scenes made from node trees; scenes can include script/resource references and signal connections. A Godot project root is identified by `project.godot`. Godot also supports headless command-line execution, but T17 does not launch it before T20 provides an enforced runtime profile.

References:

- https://docs.godotengine.org/en/stable/getting_started/introduction/key_concepts_overview.html
- https://docs.godotengine.org/en/stable/tutorials/scripting/filesystem.html
- https://docs.godotengine.org/en/stable/classes/class_signal.html
- https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html

The draft export preserves:

- scene path;
- node path/name/type;
- declared parent path;
- script references;
- resource IDs/path/type;
- signal connection declarations.

A signal connection is `declared-connection`, not evidence that the signal was emitted, the method ran, or game state changed.

## Strict payload behavior

The normalizer rejects:

- an engine/profile schema mismatch;
- missing root collections (`types`, `documents`, or `scenes`);
- unknown fields at every modeled layer;
- duplicate derived node identities;
- export bytes that do not match the exact envelope;
- malformed identifiers used by the modeled structural references.

This deliberate strictness avoids silently dropping a new engine field and later treating a lossy normalization as complete.

## Future exporter boundary

A future engine exporter must be a separate producer. Its execution belongs to T20's target-runtime isolation boundary.

The exporter must eventually provide:

1. pinned executable/editor identity;
2. pinned exporter implementation identity;
3. bounded project read roots and isolated output path;
4. no ambient secrets;
5. explicit network/device permissions;
6. exact output bytes;
7. engine version/platform metadata;
8. cleanup and timeout behavior.

Even after those are available, T17 structural normalization remains distinct from T16 runtime behavior evidence.


## Exact source-input provenance

Native export envelope revision 2 separates two identities:

1. the exact generated export JSON artifact (`game-native-export`); and
2. the exact input source artifacts (`game-native-source`).

A `source-export` must include at least one `source_inputs[]` item. Each item records a repo-relative POSIX path, source role, media type, SHA-256 and byte length. The path is metadata for location; the byte digest is the artifact identity.

A future Unity `.unity`, Godot `.tscn`, or Unreal/T08 source producer must create refs from the actual source bytes. Reformatting or changing those bytes creates a different source artifact even if a later parser would derive the same structure.

The normalized native structure carries these refs unchanged while keeping `source_structure_verified=false`. An exact source ref proves which bytes were named; it does not by itself prove the parser or exporter interpreted them correctly.


## Implemented text-source producers

T17 now includes a conservative source-only producer for Unity text scenes/prefabs and Godot text scenes.

### Unity producer

Recognized source facts:
- Unity serialized document header `--- !u!<classID> &<fileID>`;
- document body type;
- `m_Name`;
- `m_GameObject` fileID;
- `m_Father` fileID;
- inline GUID/fileID serialized references.

Other source lines are counted as unmodeled diagnostics rather than interpreted. Duplicate document fileIDs and malformed required references fail closed.

### Godot producer

Recognized source facts:
- `gd_scene`;
- `ext_resource` / `sub_resource`;
- `node` name/type/parent;
- node script `ExtResource` / `SubResource` reference;
- `connection` signal/from/to/method.

Other sections/lines are diagnostics. Duplicate derived node paths and duplicate resource IDs fail closed.

These are source exporters into the draft interchange, not claims that every Unity YAML or Godot text construct is supported. The exact original source bytes are retained separately from the generated JSON bytes.
