import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildGodotTextSceneExport, parseGodotTextScene } from '../../adapters/game-next/native-text-source-exporters.mjs';
import { normalizeNativeStructureExport, verifyNativeStructureInvariants } from '../../adapters/game-next/native-structure-normalizer.mjs';
import { verifyNativeExportEnvelope } from '../../adapters/game-next/native-export-envelope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'adapters/game/godot');
const pins = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));
const sourcePath = 'game/main.tscn';
const producerPath = path.join(root, 'adapters/game-next/native-text-source-exporters.mjs');
const producer = {
  id: 't17-text-source-exporter',
  version: '1',
  implementation_sha256: createHash('sha256').update(fs.readFileSync(producerPath)).digest('hex'),
};
const fixture = (name) => fs.readFileSync(path.join(target, 'fixtures', `${name}.tscn`));
const build = (bytes) => buildGodotTextSceneExport(bytes, {
  path: sourcePath,
  engineVersion: pins.godot.version,
  platform: 'source-only',
  producer,
});

test('Godot target-01 fixes a source release but awards no installed-engine or runtime authority', () => {
  assert.equal(pins.schema, 'sbf.game-godot-target-scope-pins/1');
  assert.equal(pins.scope, 'static-text-source-target-01-only');
  assert.equal(pins.godot.version, '4.7.2-stable');
  assert.equal(pins.godot.tag, pins.godot.version);
  for (const field of ['commit_sha', 'version_py_blob_sha', 'node_cpp_blob_sha', 'packed_scene_cpp_blob_sha']) {
    assert.match(pins.godot[field], /^[0-9a-f]{40}$/);
  }
  for (const field of ['fixture_generated_by_pinned_engine', 'engine_executed', 'runtime_certified', 'release_authorized']) {
    assert.equal(pins[field], false);
  }
  assert.deepEqual(fs.readdirSync(path.join(target, 'fixtures')).sort(),
    ['declared-scene.tscn', 'unsupported-lifecycle.tscn']);
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['caller-supplied free text', 'not captured output', 'signal delivery',
    'lifecycle', 'GAME-godot-02', 'GAME-godot-03', 'release=BLOCKED']) {
    assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
  }
});

test('declared scene binds exact source bytes and preserves only structural declarations', () => {
  const bytes = fixture('declared-scene');
  const built = build(bytes);
  assert.equal(built.envelope.engine, 'godot');
  assert.equal(built.envelope.engine_version, pins.godot.version);
  assert.equal(built.envelope.evidence_class, 'source-export');
  assert.deepEqual(built.diagnostics, []);
  assert.equal(built.payload.scenes[0].path, sourcePath);
  assert.deepEqual(built.payload.scenes[0].nodes.map(({ path: nodePath, type }) => [nodePath, type]),
    [['.', 'Node3D'], ['Player', 'CharacterBody3D']]);
  assert.equal(built.payload.scenes[0].nodes[1].script, 'res://player.gd');
  assert.deepEqual(built.payload.scenes[0].resources.map(({ id }) => id), ['ext:1_player', 'sub:Stats']);
  assert.deepEqual(built.payload.scenes[0].signal_connections,
    [{ signal: 'hit', from: 'Player', to: '.', method: '_on_hit' }]);
  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, {
    sourceBytes: built.payload_bytes,
    sourceInputBytes: { [sourcePath]: bytes },
  }), { valid: true, errors: [] });
  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.deepEqual(verifyNativeStructureInvariants(normalized), { valid: true, errors: [] });
  assert.ok(normalized.nodes.some((node) => node.kind === 'godot-scene'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'script-reference' && edge.target_uri === 'res://player.gd'));
  assert.equal(normalized.declarations.signals[0].evidence, 'declared-connection');
  assert.deepEqual(normalized.source_inputs, built.source_inputs);
  for (const claim of Object.values(normalized.claims)) assert.equal(claim, false);
  for (const claim of Object.values(built.envelope.claims)) assert.equal(claim, false);
});

test('lifecycle properties remain diagnostics; a signal declaration does not prove delivery', () => {
  const built = build(fixture('unsupported-lifecycle'));
  assert.deepEqual(built.diagnostics.map(({ code }) => code),
    ['GODOT_UNMODELED_LINE', 'GODOT_UNMODELED_LINE', 'GODOT_UNMODELED_SECTION']);
  const normalized = normalizeNativeStructureExport(built.payload_bytes, built.envelope);
  assert.equal(normalized.declarations.signals.length, 1);
  assert.equal(normalized.declarations.signals[0].evidence, 'declared-connection');
  assert.equal(normalized.claims.runtime_behavior_verified, false);
  assert.equal(normalized.claims.causal_edges_verified, false);
  assert.equal(normalized.claims.state_transitions_verified, false);
  assert.equal(JSON.stringify(normalized).includes('process_mode'), false);
  assert.equal(JSON.stringify(normalized).includes('visible'), false);
});

test('source identity changes with unmodeled bytes even when parsed declarations do not', () => {
  const a = parseGodotTextScene(fixture('declared-scene'), { path: sourcePath });
  const changed = Buffer.from(fixture('declared-scene').toString('utf8').replace(
    '[node name="Main" type="Node3D"]',
    '; fixture note\n[node name="Main" type="Node3D"]',
  ));
  const b = parseGodotTextScene(changed, { path: sourcePath });
  assert.deepEqual(a.payload, b.payload);
  assert.notEqual(a.source_ref.artifact.byte_sha256, b.source_ref.artifact.byte_sha256);
  assert.equal(verifyNativeExportEnvelope(build(fixture('declared-scene')).envelope, {
    sourceBytes: build(fixture('declared-scene')).payload_bytes,
    sourceInputBytes: { [sourcePath]: changed },
  }).valid, false);
});

test('duplicate identities and incomplete signal connections fail closed', () => {
  const source = fixture('declared-scene').toString('utf8');
  assert.throws(() => parseGodotTextScene(Buffer.from(source.replace(
    '[connection signal=', '[node name="Player" type="Node3D" parent="."]\n\n[connection signal=',
  )), { path: sourcePath }), /duplicate derived node paths/);
  assert.throws(() => parseGodotTextScene(Buffer.from(source.replace(
    '[sub_resource type="Resource" id="Stats"]',
    '[sub_resource type="Resource" id="Stats"]\n[sub_resource type="Resource" id="Stats"]',
  )), { path: sourcePath }), /duplicate resource IDs/);
  assert.throws(() => parseGodotTextScene(Buffer.from(source.replace(' method="_on_hit"', '')),
    { path: sourcePath }), /connection requires method/);
});
