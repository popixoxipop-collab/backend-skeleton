import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGodotTextSceneExport,
  buildUnityTextSceneExport,
  parseGodotTextScene,
  parseUnityTextScene,
} from '../../adapters/game-next/native-text-source-exporters.mjs';
import {
  normalizeNativeStructureExport,
  verifyNativeStructureInvariants,
} from '../../adapters/game-next/native-structure-normalizer.mjs';
import { verifyNativeExportEnvelope } from '../../adapters/game-next/native-export-envelope.mjs';

const producer = {
  id: 't17-text-source-exporter',
  version: '0-draft',
  implementation_sha256: '5'.repeat(64),
};

function unityFixture(extra = '') {
  return Buffer.from([
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1 &6',
    'GameObject:',
    '  m_Name: Hero',
    '  m_Component:',
    '  - component: {fileID: 8}',
    '  - component: {fileID: 50}',
    '--- !u!4 &8',
    'Transform:',
    '  m_GameObject: {fileID: 6}',
    '  m_Father: {fileID: 0}',
    '--- !u!114 &50',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 6}',
    '  m_Script: {fileID: 11500000, guid: 9cbd8cdf99d44b58972fbc7f6f38088f, type: 3}',
    extra,
    '',
  ].join('\n'), 'utf8');
}

function godotFixture(extra = '') {
  return Buffer.from([
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://player.gd" id="1"]',
    '[sub_resource type="Resource" id="Stats"]',
    '',
    '[node name="Main" type="Node3D"]',
    '',
    '[node name="Player" type="CharacterBody3D" parent="."]',
    'script = ExtResource("1")',
    extra,
    '',
    '[connection signal="hit" from="Player" to="." method="_on_hit"]',
    '',
  ].join('\n'), 'utf8');
}

test('Unity text source exports document structure and retains exact source provenance', () => {
  const raw = unityFixture();
  const built = buildUnityTextSceneExport(raw, {
    path: 'Assets/Scenes/Main.unity',
    engineVersion: '6000-test',
    platform: 'source-only',
    producer,
  });

  assert.equal(built.payload.schema, 'sbf.game-unity-serialized-export/draft-1');
  assert.equal(built.payload.documents.length, 3);
  assert.ok(built.payload.documents.some((doc) => doc.file_id === '6' && doc.type === 'GameObject'));
  assert.ok(built.payload.documents.some((doc) => doc.file_id === '8' && doc.game_object_file_id === '6'));
  assert.ok(built.payload.documents.some((doc) => doc.references?.some((ref) => ref.guid === '9cbd8cdf99d44b58972fbc7f6f38088f')));
  assert.equal(built.source_inputs[0].path, 'Assets/Scenes/Main.unity');
  assert.equal(built.source_inputs[0].artifact.family, 'game-native-source');

  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, {
    sourceBytes: built.payload_bytes,
    sourceInputBytes: { 'Assets/Scenes/Main.unity': raw },
  }), { valid: true, errors: [] });

  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.ok(normalized.nodes.some((node) => node.type === 'GameObject'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'component-of'));
  assert.deepEqual(normalized.source_inputs, built.source_inputs);
  assert.deepEqual(verifyNativeStructureInvariants(normalized), { valid: true, errors: [] });
});

test('Unity source formatting changes alter source identity even if extracted structure is the same', () => {
  const a = parseUnityTextScene(unityFixture(), { path: 'Assets/Scenes/Main.unity' });
  const b = parseUnityTextScene(Buffer.from(unityFixture().toString('utf8').replace('m_Name: Hero', 'm_Name: Hero   ')), {
    path: 'Assets/Scenes/Main.unity',
  });
  assert.deepEqual(a.payload, b.payload);
  assert.notEqual(a.source_ref.artifact.byte_sha256, b.source_ref.artifact.byte_sha256);
});

test('Unity duplicate file IDs and malformed reference fields fail closed', () => {
  const duplicate = Buffer.from(unityFixture().toString('utf8') + [
    '--- !u!1 &6',
    'GameObject:',
    '  m_Name: Duplicate',
    '',
  ].join('\n'), 'utf8');
  assert.throws(
    () => parseUnityTextScene(duplicate, { path: 'Assets/Main.unity' }),
    /duplicate document file IDs/,
  );

  const malformed = Buffer.from(unityFixture().toString('utf8').replace('{fileID: 6}', '{guid: abc}'), 'utf8');
  assert.throws(
    () => parseUnityTextScene(malformed, { path: 'Assets/Main.unity' }),
    /m_GameObject reference is unsupported/,
  );
});

test('Godot text source exports scene/node/resource/signal structure and source refs', () => {
  const raw = godotFixture();
  const built = buildGodotTextSceneExport(raw, {
    path: 'game/main.tscn',
    engineVersion: '4-test',
    platform: 'source-only',
    producer,
  });

  const scene = built.payload.scenes[0];
  assert.equal(scene.path, 'game/main.tscn');
  assert.ok(scene.nodes.some((node) => node.path === '.' && node.name === 'Main'));
  assert.ok(scene.nodes.some((node) => node.path === 'Player' && node.script === 'res://player.gd'));
  assert.ok(scene.resources.some((resource) => resource.id === 'ext:1'));
  assert.ok(scene.resources.some((resource) => resource.id === 'sub:Stats'));
  assert.equal(scene.signal_connections[0].signal, 'hit');

  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, {
    sourceBytes: built.payload_bytes,
    sourceInputBytes: { 'game/main.tscn': raw },
  }), { valid: true, errors: [] });

  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.ok(normalized.nodes.some((node) => node.kind === 'godot-scene'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'script-reference'));
  assert.equal(normalized.declarations.signals[0].evidence, 'declared-connection');
  assert.deepEqual(normalized.source_inputs, built.source_inputs);
});

test('Godot unsupported sections/lines are diagnostics, never runtime behavior claims', () => {
  const parsed = parseGodotTextScene(godotFixture('[editable path="Player"]'), { path: 'game/main.tscn' });
  assert.ok(parsed.diagnostics.some((diag) => diag.code === 'GODOT_UNMODELED_SECTION'));
  const built = buildGodotTextSceneExport(godotFixture('[editable path="Player"]'), {
    path: 'game/main.tscn',
    engineVersion: '4-test',
    platform: 'source-only',
    producer,
  });
  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.equal(normalized.claims.runtime_behavior_verified, false);
  assert.equal(normalized.claims.causal_edges_verified, false);
});

test('Godot duplicate node paths and duplicate resource IDs fail closed', () => {
  const duplicateNode = Buffer.from([
    '[gd_scene format=3]',
    '[node name="Main" type="Node3D"]',
    '[node name="Player" type="Node3D" parent="."]',
    '[node name="Player" type="Node3D" parent="."]',
    '',
  ].join('\n'), 'utf8');
  assert.throws(
    () => parseGodotTextScene(duplicateNode, { path: 'game/main.tscn' }),
    /duplicate derived node paths/,
  );

  const duplicateResource = Buffer.from([
    '[gd_scene format=3]',
    '[ext_resource type="Script" path="res://a.gd" id="1"]',
    '[ext_resource type="Script" path="res://b.gd" id="1"]',
    '[node name="Main" type="Node3D"]',
    '',
  ].join('\n'), 'utf8');
  assert.throws(
    () => parseGodotTextScene(duplicateResource, { path: 'game/main.tscn' }),
    /duplicate resource IDs/,
  );
});

test('source exporters reject path escape, invalid UTF-8 and source byte budget overflow', () => {
  assert.throws(
    () => parseUnityTextScene(unityFixture(), { path: '../Main.unity' }),
    /repo-relative|parent/,
  );
  assert.throws(
    () => parseGodotTextScene(Buffer.from([0xff]), { path: 'game/main.tscn' }),
    /valid UTF-8/,
  );
  assert.throws(
    () => parseUnityTextScene(unityFixture(), { path: 'Assets/Main.unity', maxBytes: 4 }),
    /byte budget/,
  );
});


test('Unity serialized refs reject short GUID and signed-64-bit overflow', () => {
  const shortGuid = Buffer.from(unityFixture().toString('utf8').replace(
    '9cbd8cdf99d44b58972fbc7f6f38088f',
    'abc',
  ), 'utf8');
  assert.throws(
    () => parseUnityTextScene(shortGuid, { path: 'Assets/Main.unity' }),
    /GUID must be exactly 32 hexadecimal characters/,
  );

  const positiveOverflow = Buffer.from(unityFixture().toString('utf8').replace(
    'fileID: 11500000',
    'fileID: 9223372036854775808',
  ), 'utf8');
  assert.throws(
    () => parseUnityTextScene(positiveOverflow, { path: 'Assets/Main.unity' }),
    /outside signed 64-bit range/,
  );

  const negativeOverflow = Buffer.from(unityFixture().toString('utf8').replace(
    'fileID: 11500000',
    'fileID: -9223372036854775809',
  ), 'utf8');
  assert.throws(
    () => parseUnityTextScene(negativeOverflow, { path: 'Assets/Main.unity' }),
    /outside signed 64-bit range/,
  );
});

test('Unity signed-64-bit boundary fileIDs remain accepted', () => {
  for (const boundary of ['9223372036854775807', '-9223372036854775808']) {
    const raw = Buffer.from(unityFixture().toString('utf8').replace(
      'fileID: 11500000',
      `fileID: ${boundary}`,
    ), 'utf8');
    const parsed = parseUnityTextScene(raw, { path: 'Assets/Main.unity' });
    assert.ok(parsed.payload.documents.some((doc) =>
      doc.references?.some((ref) => ref.file_id === boundary)));
  }
});

test('Unity document header fileID also rejects signed-64-bit overflow', () => {
  const raw = Buffer.from(unityFixture().toString('utf8').replace(
    '--- !u!1 &6',
    '--- !u!1 &9223372036854775808',
  ), 'utf8');
  assert.throws(
    () => parseUnityTextScene(raw, { path: 'Assets/Main.unity' }),
    /document fileID.*outside signed 64-bit range/,
  );
});
