import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeExportEnvelope } from '../../adapters/game-next/native-export-envelope.mjs';
import {
  normalizeNativeStructureExport,
  verifyNativeStructureInvariants,
} from '../../adapters/game-next/native-structure-normalizer.mjs';

const producer = {
  id: 't17-structure-test-exporter',
  version: '0-draft',
  implementation_sha256: '1'.repeat(64),
};

function bytes(value) {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

function envelope(raw, engine, evidenceClass = 'source-export') {
  return createNativeExportEnvelope(raw, {
    engine,
    evidenceClass,
    engineVersion: 'test-only',
    platform: 'test-only',
    producer,
  });
}

test('Unreal reflection facts preserve declared replication and RPC specifiers without runtime claims', () => {
  const raw = bytes({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [{
      id: 'AHero',
      kind: 'class',
      name: 'AHero',
      base: 'AActor',
      specifiers: ['Blueprintable'],
      properties: [{
        name: 'Health',
        type: 'float',
        specifiers: ['ReplicatedUsing=OnRep_Health'],
      }],
      functions: [{
        name: 'ServerJump',
        specifiers: ['Server', 'Reliable'],
      }],
    }],
  });

  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'unreal'));
  assert.equal(normalized.status, 'declared-structure-only');
  assert.equal(normalized.declarations.replication[0].mode, 'ReplicatedUsing');
  assert.equal(normalized.declarations.replication[0].notify, 'OnRep_Health');
  assert.equal(normalized.declarations.rpc[0].mode, 'Server');
  assert.equal(normalized.declarations.rpc[0].reliability, 'reliable');
  assert.deepEqual(normalized.claims, {
    source_structure_verified: false,
    runtime_behavior_verified: false,
    causal_edges_verified: false,
    state_transitions_verified: false,
  });
  assert.deepEqual(verifyNativeStructureInvariants(normalized), { valid: true, errors: [] });
});

test('Unreal property without an explicit replication specifier is not marked replicated', () => {
  const raw = bytes({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [{
      id: 'AHero',
      kind: 'class',
      name: 'AHero',
      properties: [{ name: 'MaxHealth', type: 'float', specifiers: ['EditDefaultsOnly'] }],
      functions: [{ name: 'Jump', specifiers: ['BlueprintCallable'] }],
    }],
  });
  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'unreal'));
  assert.deepEqual(normalized.declarations.replication, []);
  assert.deepEqual(normalized.declarations.rpc, []);
});

test('Unity serialized object identifiers and GUID/fileID references remain structural facts', () => {
  const raw = bytes({
    schema: 'sbf.game-unity-serialized-export/draft-1',
    documents: [
      { file_id: 6, class_id: 1, name: 'Hero', references: [] },
      {
        file_id: 8,
        class_id: 4,
        type: 'Transform',
        game_object_file_id: 6,
        parent_file_id: 0,
        references: [{ guid: '9cbd8cdf99d44b58972fbc7f6f38088f', file_id: 11500000 }],
      },
      { file_id: 50, class_id: 114, name: 'HeroScript', game_object_file_id: 6, references: [] },
    ],
  });

  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'unity'));
  assert.ok(normalized.nodes.some((node) => node.class_id === 1 && node.type === 'GameObject'));
  assert.ok(normalized.nodes.some((node) => node.class_id === 114 && node.type === 'MonoBehaviour'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'component-of'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'serialized-reference'));
  assert.deepEqual(normalized.declarations.rpc, []);
  assert.deepEqual(normalized.declarations.replication, []);
});

test('Godot scene/node/resource/signal data remain declared structure, not causal behavior', () => {
  const raw = bytes({
    schema: 'sbf.game-godot-scene-export/draft-1',
    scenes: [{
      path: 'res://main.tscn',
      nodes: [
        { path: '.', name: 'Main', type: 'Node3D' },
        { path: 'Player', name: 'Player', type: 'CharacterBody3D', parent_path: '.', script: 'res://player.gd' },
      ],
      resources: [{ id: '1', path: 'res://player.tres', type: 'Resource' }],
      signal_connections: [{ signal: 'hit', from: 'Player', to: '.', method: '_on_hit' }],
    }],
  });

  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'godot', 'headless-export'));
  assert.ok(normalized.nodes.some((node) => node.kind === 'godot-scene'));
  assert.ok(normalized.nodes.some((node) => node.kind === 'godot-node'));
  assert.ok(normalized.nodes.some((node) => node.kind === 'godot-resource'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'scene-member'));
  assert.ok(normalized.relations.some((edge) => edge.kind === 'script-reference'));
  assert.equal(normalized.declarations.signals[0].evidence, 'declared-connection');
  assert.equal(normalized.claims.causal_edges_verified, false);
  assert.equal(normalized.claims.state_transitions_verified, false);
});

test('normalizer rejects source bytes that do not match the exact export envelope', () => {
  const original = bytes({ schema: 'sbf.game-unreal-structure-export/draft-1', types: [] });
  const changed = bytes({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [{ id: 'X', kind: 'class', name: 'X' }],
  });
  assert.throws(
    () => normalizeNativeStructureExport(changed, envelope(original, 'unreal')),
    /artifact-bytes/,
  );
});

test('engine-specific draft schema must match the engine named by the exact envelope', () => {
  const raw = bytes({ schema: 'sbf.game-unity-serialized-export/draft-1', documents: [] });
  assert.throws(
    () => normalizeNativeStructureExport(raw, envelope(raw, 'unreal')),
    /schema mismatch/,
  );
});

test('duplicate engine-local identities fail closed instead of collapsing facts', () => {
  const raw = bytes({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [
      { id: 'X', kind: 'class', name: 'X' },
      { id: 'X', kind: 'class', name: 'XAgain' },
    ],
  });
  assert.throws(
    () => normalizeNativeStructureExport(raw, envelope(raw, 'unreal')),
    /duplicate native node id/,
  );
});

test('normalizer claims cannot be upgraded by mutating the derived document', () => {
  const raw = bytes({ schema: 'sbf.game-godot-scene-export/draft-1', scenes: [] });
  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'godot', 'headless-export'));
  normalized.claims.runtime_behavior_verified = true;
  normalized.claims.source_structure_verified = true;
  const checked = verifyNativeStructureInvariants(normalized);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.includes('claims.runtime_behavior_verified'));
  assert.ok(checked.errors.includes('claims.source_structure_verified'));
});

test('source artifact identity is carried unchanged from the exact native export envelope', () => {
  const raw = bytes({ schema: 'sbf.game-unity-serialized-export/draft-1', documents: [] });
  const sourceEnvelope = envelope(raw, 'unity');
  const normalized = normalizeNativeStructureExport(raw, sourceEnvelope);
  assert.deepEqual(normalized.source_artifact, sourceEnvelope.artifact);
  assert.equal(
    normalized.source_artifact.byte_sha256,
    createHash('sha256').update(raw).digest('hex'),
  );
});


test('Unity null fileID zero does not invent parent or component relations', () => {
  const raw = bytes({
    schema: 'sbf.game-unity-serialized-export/draft-1',
    documents: [{
      file_id: 8,
      class_id: 4,
      type: 'Transform',
      game_object_file_id: 0,
      parent_file_id: 0,
      references: [{ file_id: 0 }],
    }],
  });
  const normalized = normalizeNativeStructureExport(raw, envelope(raw, 'unity'));
  assert.equal(normalized.relations.length, 0);
});

test('unknown engine-export fields fail closed instead of being silently ignored', () => {
  const unrealRaw = bytes({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [{ id: 'X', kind: 'class', name: 'X', mystery: true }],
  });
  assert.throws(
    () => normalizeNativeStructureExport(unrealRaw, envelope(unrealRaw, 'unreal')),
    /unsupported fields: mystery/,
  );

  const unityRaw = bytes({
    schema: 'sbf.game-unity-serialized-export/draft-1',
    documents: [{ file_id: 1, class_id: 1, hidden_runtime_state: true }],
  });
  assert.throws(
    () => normalizeNativeStructureExport(unityRaw, envelope(unityRaw, 'unity')),
    /unsupported fields: hidden_runtime_state/,
  );

  const godotRaw = bytes({
    schema: 'sbf.game-godot-scene-export/draft-1',
    scenes: [{ path: 'res://main.tscn', nodes: [], resources: [], signal_connections: [], inferred_behavior: true }],
  });
  assert.throws(
    () => normalizeNativeStructureExport(godotRaw, envelope(godotRaw, 'godot', 'headless-export')),
    /unsupported fields: inferred_behavior/,
  );
});
