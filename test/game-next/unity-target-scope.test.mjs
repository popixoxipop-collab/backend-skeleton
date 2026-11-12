import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildUnityTextSceneExport, parseUnityTextScene } from '../../adapters/game-next/native-text-source-exporters.mjs';
import { normalizeNativeStructureExport, verifyNativeStructureInvariants } from '../../adapters/game-next/native-structure-normalizer.mjs';
import { verifyNativeExportEnvelope } from '../../adapters/game-next/native-export-envelope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'adapters/game/unity');
const pins = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));
const sourcePath = 'Assets/Scenes/Main.unity';
const producerPath = path.join(root, 'adapters/game-next/native-text-source-exporters.mjs');
const producer = {
  id: 't17-text-source-exporter',
  version: '1',
  implementation_sha256: createHash('sha256').update(fs.readFileSync(producerPath)).digest('hex'),
};
const fixture = (name) => fs.readFileSync(path.join(target, 'fixtures', name));
const build = (bytes, source = sourcePath) => buildUnityTextSceneExport(bytes, {
  path: source,
  engineVersion: pins.unity.editor_version,
  platform: 'source-only',
  producer,
});

test('Unity target-01 pins an official Editor release without installation or runtime authority', () => {
  assert.equal(pins.schema, 'sbf.game-unity-target-scope-pins/1');
  assert.equal(pins.scope, 'static-text-source-target-01-only');
  assert.deepEqual([pins.unity.editor_version, pins.unity.changeset, pins.unity.released_on,
    pins.unity.serialization_manual_version], ['6000.0.85f1', 'ee7790f1426a', '2026-10-15', '6000.0']);
  assert.equal(pins.unity.release_notes_url,
    'https://unity.com/releases/editor/whats-new/6000.0.85f1');
  for (const field of ['fixture_generated_by_pinned_editor', 'editor_executed',
    'runtime_certified', 'release_authorized']) assert.equal(pins[field], false);
  assert.deepEqual(fs.readdirSync(path.join(target, 'fixtures')).sort(),
    ['ToggleActor.cs', 'declared-scene.unity', 'prefab-override.unity']);
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['caller-supplied free text', 'not Editor-generated', 'prefab override',
    'runtime-only state', 'stripped', 'GAME-unity-02', 'GAME-unity-03', 'release=BLOCKED']) {
    assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
  }
});

test('scene documents and source bytes are bound, but active/enabled state is not runtime proof', () => {
  const bytes = fixture('declared-scene.unity');
  const built = build(bytes);
  assert.equal(built.envelope.engine, 'unity');
  assert.equal(built.envelope.engine_version, pins.unity.editor_version);
  assert.equal(built.envelope.evidence_class, 'source-export');
  assert.equal(built.payload.schema, 'sbf.game-unity-serialized-export/draft-1');
  assert.deepEqual(built.payload.documents.map(({ file_id, class_id }) => [file_id, class_id]),
    [['10', 1], ['11', 4], ['12', 114]]);
  assert.equal(built.payload.documents[0].name, 'Actor');
  assert.equal(built.payload.documents[1].parent_file_id, '0');
  assert.equal(built.payload.documents[2].game_object_file_id, '10');
  assert.ok(built.payload.documents[2].references.some(({ file_id, guid }) =>
    file_id === '11500000' && guid === '9cbd8cdf99d44b58972fbc7f6f38088f'));
  assert.ok(built.diagnostics.filter(({ code }) => code === 'UNITY_UNMODELED_LINE').length >= 2);
  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, {
    sourceBytes: built.payload_bytes,
    sourceInputBytes: { [sourcePath]: bytes },
  }), { valid: true, errors: [] });
  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.deepEqual(verifyNativeStructureInvariants(normalized), { valid: true, errors: [] });
  assert.ok(normalized.relations.some((edge) => edge.kind === 'component-of'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'serialized-reference' &&
    edge.target_guid === '9cbd8cdf99d44b58972fbc7f6f38088f'));
  assert.deepEqual(normalized.source_inputs, built.source_inputs);
  for (const claim of Object.values(normalized.claims)) assert.equal(claim, false);
  for (const claim of Object.values(built.envelope.claims)) assert.equal(claim, false);
  assert.equal(JSON.stringify(normalized).includes('m_IsActive'), false);
  assert.equal(JSON.stringify(normalized).includes('m_Enabled'), false);
});

test('prefab source reference is generic; override effects and effective name are not modeled', () => {
  const bytes = fixture('prefab-override.unity');
  const built = build(bytes, 'Assets/Scenes/PrefabScene.unity');
  assert.equal(built.payload.documents.length, 1);
  const doc = built.payload.documents[0];
  assert.deepEqual([doc.file_id, doc.class_id, doc.type], ['1001', 1001, 'PrefabInstance']);
  assert.ok(doc.references.some((ref) => ref.file_id === '100100000' &&
    ref.guid === '95cf80858ee0c4940b72f62b17aefd41'));
  assert.ok(built.diagnostics.length >= 8, 'override block is not parsed as effective properties');
  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.equal(normalized.nodes[0].type, 'PrefabInstance');
  assert.equal(normalized.nodes.some((node) => node.name === 'RenamedActor'), false);
  assert.equal(JSON.stringify(normalized).includes('m_Modifications'), false);
  assert.equal(JSON.stringify(normalized).includes('RenamedActor'), false);
  assert.equal(normalized.claims.runtime_behavior_verified, false);
  assert.equal(normalized.claims.source_structure_verified, false);
});

test('stripped prefab placeholder header fails closed, not as a resolved prefab object', () => {
  const source = fixture('prefab-override.unity').toString('utf8');
  const stripped = Buffer.from(source + [
    '--- !u!4 &200 stripped',
    'Transform:',
    '  m_CorrespondingSourceObject: {fileID: 100000, guid: 95cf80858ee0c4940b72f62b17aefd41, type: 3}',
    '  m_PrefabInstance: {fileID: 1001}',
    '',
  ].join('\n'));
  assert.throws(() => parseUnityTextScene(stripped, { path: sourcePath }),
    /unsupported Unity document header/);
});

test('script code is outside the scene export input; lifecycle remains unknown', () => {
  const scene = fixture('declared-scene.unity');
  const script = fixture('ToggleActor.cs').toString('utf8');
  assert.match(script, /SetActive\(false\)/);
  assert.match(script, /Destroy\(gameObject\)/);
  const first = build(scene);
  const second = build(scene);
  assert.equal(first.source_inputs[0].artifact.byte_sha256, second.source_inputs[0].artifact.byte_sha256);
  assert.deepEqual(first.payload, second.payload);
  assert.deepEqual(first.source_inputs.map(({ path: p }) => p), [sourcePath]);
  assert.equal(JSON.stringify(first).includes('ToggleActor.cs'), false);
  assert.equal(JSON.stringify(first).includes('SetActive'), false);
  assert.equal(JSON.stringify(first).includes('Destroy'), false);
});

test('format-only source drift moves source identity while declarations remain unchanged', () => {
  const bytes = fixture('declared-scene.unity');
  const changed = Buffer.from(bytes.toString('utf8').replace('  m_Name: Actor', '  m_Name: Actor   '));
  const a = parseUnityTextScene(bytes, { path: sourcePath });
  const b = parseUnityTextScene(changed, { path: sourcePath });
  assert.deepEqual(a.payload, b.payload);
  assert.notEqual(a.source_ref.artifact.byte_sha256, b.source_ref.artifact.byte_sha256);
  const original = build(bytes);
  assert.equal(verifyNativeExportEnvelope(original.envelope, {
    sourceBytes: original.payload_bytes,
    sourceInputBytes: { [sourcePath]: changed },
  }).valid, false);
});
