import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { bridgeLegacyWebgameContract } from '../../adapters/game-next/legacy-webgame-bridge.mjs';
import { createNativeExportEnvelope } from '../../adapters/game-next/native-export-envelope.mjs';
import { normalizeNativeStructureExport } from '../../adapters/game-next/native-structure-normalizer.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function validator(name) {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'game-next', name), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function minimalLegacyBytes() {
  return Buffer.from(JSON.stringify({
    sbf_webgame_contract: '1',
    feature_id: '001-gameplay',
    feature_uid: '11111111-1111-4111-8111-111111111111',
    source: {
      adapter: 'typescript-webgame',
      adapter_revision: 1,
      engines: ['three'],
      engine_packages: [{ package: 'three', version: '^0.180.0', project_root: '.' }],
      project_roots: ['.'],
      source_hash: 'a'.repeat(64),
      files: ['package.json'],
    },
    planes: {
      scene: { scenes: [], hierarchy: [] },
      entity: { entities: [] },
      input: { listeners: [], keys: [] },
      simulation: { systems: [], loops: [], physics: [] },
      render: { renderers: [] },
      network: { sockets: [] },
      asset: { assets: [] },
      behavior: { triggers: [], systems: [] },
    },
    warnings: [],
    completeness: { status: 'partial', scene_count: 0, entity_count: 0, loop_count: 0 },
  }, null, 2) + '\n');
}

test('draft graph output satisfies its internal schema', () => {
  const validate = validator('game-graph-draft.schema.json');
  const graph = bridgeLegacyWebgameContract(minimalLegacyBytes());
  assert.equal(validate(graph), true, JSON.stringify(validate.errors));
});

test('draft graph schema rejects invented causal edges', () => {
  const validate = validator('game-graph-draft.schema.json');
  const graph = bridgeLegacyWebgameContract(minimalLegacyBytes());
  graph.behavior.causal_edges.push({ from: 'input', to: 'system' });
  assert.equal(validate(graph), false);
  assert.ok(validate.errors.some((error) => error.instancePath === '/behavior/causal_edges'));
});

test('native export output satisfies its internal schema', () => {
  const validate = validator('native-export-envelope.schema.json');
  const raw = Buffer.from('{"schema":"example.unreal/1"}\n');
  const envelope = createNativeExportEnvelope(raw, {
    engine: 'unreal',
    evidenceClass: 'editor-export',
    engineVersion: '5-test',
    platform: 'test-only',
    producer: {
      id: 'test-exporter',
      version: '0-draft',
      implementation_sha256: '1'.repeat(64),
    },
  });
  assert.equal(validate(envelope), true, JSON.stringify(validate.errors));
});

test('native export schema rejects runtime certification mutation', () => {
  const validate = validator('native-export-envelope.schema.json');
  const envelope = createNativeExportEnvelope(Buffer.from('{}\n'), {
    engine: 'unity',
    evidenceClass: 'source-export',
    engineVersion: '6-test',
    platform: 'test-only',
    producer: {
      id: 'test-exporter',
      version: '0-draft',
      implementation_sha256: '2'.repeat(64),
    },
  });
  envelope.claims.runtime_behavior_verified = true;
  assert.equal(validate(envelope), false);
  assert.ok(validate.errors.some((error) => error.instancePath === '/claims/runtime_behavior_verified'));
});


test('native structure export schema accepts the three pinned engine profiles and rejects unknown fields', () => {
  const validate = validator('native-structure-export.schema.json');
  const values = [
    {
      schema: 'sbf.game-unreal-structure-export/draft-1',
      types: [{ id: 'AHero', kind: 'class', name: 'AHero', properties: [], functions: [] }],
    },
    {
      schema: 'sbf.game-unity-serialized-export/draft-1',
      documents: [{ file_id: 1, class_id: 1, name: 'Hero', references: [] }],
    },
    {
      schema: 'sbf.game-godot-scene-export/draft-1',
      scenes: [{ path: 'res://main.tscn', nodes: [], resources: [], signal_connections: [] }],
    },
  ];
  for (const value of values) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  const bad = structuredClone(values[0]);
  bad.types[0].runtime_truth = true;
  assert.equal(validate(bad), false);
});

test('normalized native structure satisfies schema and cannot claim source/runtime verification', () => {
  const validate = validator('native-structure.schema.json');
  const raw = Buffer.from(JSON.stringify({
    schema: 'sbf.game-unreal-structure-export/draft-1',
    types: [{
      id: 'AHero',
      kind: 'class',
      name: 'AHero',
      properties: [{ name: 'Health', type: 'float', specifiers: ['Replicated'] }],
      functions: [{ name: 'ServerJump', specifiers: ['Server'] }],
    }],
  }) + '\n');
  const envelope = createNativeExportEnvelope(raw, {
    engine: 'unreal',
    evidenceClass: 'source-export',
    engineVersion: 'test-only',
    platform: 'test-only',
    producer: {
      id: 'schema-test-exporter',
      version: '0-draft',
      implementation_sha256: '3'.repeat(64),
    },
  });
  const normalized = normalizeNativeStructureExport(raw, envelope);
  assert.equal(validate(normalized), true, JSON.stringify(validate.errors));

  normalized.claims.source_structure_verified = true;
  assert.equal(validate(normalized), false);
  assert.ok(validate.errors.some((error) => error.instancePath === '/claims/source_structure_verified'));
});
