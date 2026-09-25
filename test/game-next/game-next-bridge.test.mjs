import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanWebgame } from '../../scanners/webgame.mjs';
import { buildWebgameContract } from '../../contracts/webgame.mjs';
import {
  ARTIFACT_REF_VERSION,
  GAME_GRAPH_DRAFT_SCHEMA,
  LEGACY_WEBGAME_BRIDGE_REVISION,
  bridgeLegacyWebgameContract,
  verifyLegacyBridgeInvariants,
} from '../../adapters/game-next/legacy-webgame-bridge.mjs';

function legacyContract() {
  return {
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
      files: ['package.json', 'src/game.ts'],
    },
    planes: {
      scene: {
        scenes: [{ id: 'scene:11111111111111111111', symbol: 'scene', file: 'src/game.ts', line: 3, kind: 'three-scene', provenance: 'static-new-expression' }],
        hierarchy: [{ id: 'scene-edge:22222222222222222222', parent: 'scene', child: 'player', file: 'src/game.ts', line: 5, provenance: 'static-add-call' }],
      },
      entity: { entities: [{ id: 'entity:33333333333333333333', symbol: 'player', file: 'src/game.ts', line: 4, kind: 'Mesh', provenance: 'static-new-expression' }] },
      input: {
        listeners: [{ id: 'input-listener:44444444444444444444', target: 'window', event: 'keydown', handler: 'onKey', file: 'src/game.ts', line: 9, provenance: 'dom-listener' }],
        keys: [{ id: 'input-key:55555555555555555555', accessor: 'code', value: 'KeyW', file: 'src/game.ts', line: 8, provenance: 'literal-key-check' }],
      },
      simulation: {
        systems: [{ id: 'simulation-system:66666666666666666666', symbol: 'movePlayer', file: 'src/game.ts', line: 6, provenance: 'named-function' }],
        loops: [{ id: 'simulation-loop:77777777777777777777', kind: 'requestAnimationFrame', callback: 'animate', file: 'src/game.ts', line: 12, provenance: 'loop-registration' }],
        physics: [{ package: 'cannon-es', version: '^0.20.0', project_root: '.' }],
      },
      render: { renderers: [{ id: 'render:88888888888888888888', symbol: 'renderer', kind: 'WebGLRenderer', file: 'src/game.ts', line: 2, provenance: 'static-new-expression' }] },
      network: { sockets: [{ id: 'network:99999999999999999999', kind: 'WebSocket', endpoint: 'wss://example.invalid', file: 'src/game.ts', line: 13, provenance: 'literal-constructor' }] },
      asset: { assets: [{ id: 'asset:aaaaaaaaaaaaaaaaaaaa', uri: '/player.glb', file: 'src/game.ts', line: 14, provenance: 'literal-asset-reference' }] },
      behavior: {
        triggers: [{ id: 'behavior-trigger:bbbbbbbbbbbbbbbbbbbb', kind: 'key-check', accessor: 'code', value: 'KeyW', file: 'src/game.ts', line: 8, provenance: 'literal-key-check' }],
        systems: [{ id: 'behavior-system:cccccccccccccccccccc', symbol: 'movePlayer', file: 'src/game.ts', line: 6, provenance: 'named-function' }],
      },
    },
    warnings: [{ code: 'WEBGAME_INPUT_EFFECT_UNRESOLVED', message: 'input exists but effect is not inferred' }],
    completeness: { status: 'complete', scene_count: 1, entity_count: 1, loop_count: 1 },
  };
}

function bytes(value, space = 2) {
  return Buffer.from(JSON.stringify(value, null, space) + '\n', 'utf8');
}

test('exact source contract bytes are bound into the draft graph', () => {
  const raw = bytes(legacyContract());
  const graph = bridgeLegacyWebgameContract(raw);
  assert.equal(graph.source_contract.artifact.artifact_ref, ARTIFACT_REF_VERSION);
  assert.equal(graph.source_contract.artifact.family, 'webgame-contract');
  assert.equal(graph.source_contract.artifact.version, '1');
  assert.equal(graph.source_contract.artifact.size_bytes, raw.byteLength);
  assert.equal(graph.source_contract.artifact.byte_sha256, createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(verifyLegacyBridgeInvariants(graph, { sourceBytes: raw }), { valid: true, errors: [] });
});

test('formatting-only source changes remain different exact artifacts', () => {
  const contract = legacyContract();
  const compact = Buffer.from(JSON.stringify(contract), 'utf8');
  const pretty = bytes(contract, 2);
  const a = bridgeLegacyWebgameContract(compact);
  const b = bridgeLegacyWebgameContract(pretty);
  assert.notEqual(a.source_contract.artifact.byte_sha256, b.source_contract.artifact.byte_sha256);
  assert.notEqual(a.source_contract.artifact.size_bytes, b.source_contract.artifact.size_bytes);
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.relations, b.relations);
  const mismatched = verifyLegacyBridgeInvariants(a, { sourceBytes: pretty });
  assert.equal(mismatched.valid, false);
  assert.ok(mismatched.errors.includes('source_contract.artifact-bytes'));
});

test('legacy webgame contract bridges conservatively without causal edges', () => {
  const graph = bridgeLegacyWebgameContract(bytes(legacyContract()));
  assert.equal(graph.schema, GAME_GRAPH_DRAFT_SCHEMA);
  assert.equal(graph.bridge_revision, LEGACY_WEBGAME_BRIDGE_REVISION);
  assert.equal(graph.status, 'derived-static-only');
  assert.equal(graph.nodes.filter((x) => x.category === 'input').length, 2);
  assert.equal(graph.nodes.filter((x) => x.category === 'system').length, 1);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].kind, 'hierarchy-symbolic');
  assert.equal(graph.relations[0].parent_symbol, 'scene');
  assert.equal(graph.relations[0].child_symbol, 'player');
  assert.deepEqual(graph.behavior.causal_edges, []);
  assert.deepEqual(graph.behavior.transitions, []);
  assert.equal(graph.gaps.input_effects_unresolved, true);
});

test('legacy behavior projection is not duplicated as invented graph nodes', () => {
  const graph = bridgeLegacyWebgameContract(bytes(legacyContract()));
  assert.equal(graph.nodes.some((x) => x.source.plane.startsWith('behavior.')), false);
  assert.equal(graph.nodes.some((x) => x.id.includes('behavior-trigger')), false);
  assert.equal(graph.nodes.some((x) => x.id.includes('behavior-system')), false);
});

test('semantic graph stays deterministic when legacy plane arrays reorder, while exact source identity changes', () => {
  const a = legacyContract();
  const b = legacyContract();
  b.source.files.reverse();
  b.source.project_roots.reverse();
  b.source.engines.reverse();
  b.planes.input.listeners.reverse();
  b.planes.input.keys.reverse();
  const ga = bridgeLegacyWebgameContract(bytes(a));
  const gb = bridgeLegacyWebgameContract(bytes(b));
  assert.deepEqual(ga.nodes, gb.nodes);
  assert.deepEqual(ga.relations, gb.relations);
  assert.notEqual(ga.source_contract.artifact.byte_sha256, gb.source_contract.artifact.byte_sha256);
});

test('bridge fails closed for another family/version and malformed bytes', () => {
  const wrong = legacyContract();
  wrong.sbf_webgame_contract = '2';
  assert.throws(() => bridgeLegacyWebgameContract(bytes(wrong)), /requires sbf\.webgame-contract\/1/);
  assert.throws(() => bridgeLegacyWebgameContract(Buffer.from('{broken')), /valid JSON/);
  assert.throws(() => bridgeLegacyWebgameContract(Buffer.from([0xff, 0xfe])), /valid UTF-8/);
  assert.throws(() => bridgeLegacyWebgameContract(legacyContract()), /bytes must be/);
});

test('duplicate legacy item ids cannot silently collapse into one graph node', () => {
  const value = legacyContract();
  value.planes.entity.entities.push({ ...value.planes.entity.entities[0] });
  assert.throws(() => bridgeLegacyWebgameContract(bytes(value)), /duplicate game-next node id/);
});

test('invariant checker rejects invented causal edges and transition claims', () => {
  const raw = bytes(legacyContract());
  const graph = bridgeLegacyWebgameContract(raw);
  graph.behavior.causal_edges.push({ from: 'KeyW', to: 'movePlayer' });
  graph.behavior.transitions.push({ from: 'idle', to: 'moving' });
  const checked = verifyLegacyBridgeInvariants(graph, { sourceBytes: raw });
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.includes('behavior.causal_edges'));
  assert.ok(checked.errors.includes('behavior.transitions'));
});

test('real legacy scan -> webgame contract -> exact-byte game-next bridge preserves authority boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-game-next-pipeline-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'game-next-pipeline',
    dependencies: { three: '^0.180.0', '@react-three/fiber': '^9.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'game.tsx'), [
    "import * as THREE from 'three';",
    "import { Canvas } from '@react-three/fiber';",
    'const scene = new THREE.Scene();',
    'const player = new THREE.Mesh();',
    'scene.add(player);',
    'function movePlayer() {}',
    'function onKey(event) { if (event.code === "KeyW") movePlayer(); }',
    "window.addEventListener('keydown', onKey);",
    'function animate(){ requestAnimationFrame(animate); }',
    'export function Game(){ return <Canvas><mesh name="hero" /></Canvas>; }',
  ].join('\n'));

  const scan = scanWebgame(root);
  const contract = buildWebgameContract({
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scan,
  });
  const raw = Buffer.from(JSON.stringify(contract, null, 2) + '\n', 'utf8');
  const graph = bridgeLegacyWebgameContract(raw);

  assert.equal(graph.source_contract.source_hash, scan.source_hash);
  assert.equal(graph.source_contract.artifact.byte_sha256, createHash('sha256').update(raw).digest('hex'));
  assert.ok(graph.nodes.some((x) => x.category === 'scene'));
  assert.ok(graph.nodes.some((x) => x.category === 'entity'));
  assert.ok(graph.nodes.some((x) => x.category === 'input'));
  assert.ok(graph.nodes.some((x) => x.category === 'system'));
  assert.deepEqual(graph.behavior.causal_edges, []);
  assert.deepEqual(graph.behavior.transitions, []);
  assert.deepEqual(verifyLegacyBridgeInvariants(graph, { sourceBytes: raw }), { valid: true, errors: [] });
});
