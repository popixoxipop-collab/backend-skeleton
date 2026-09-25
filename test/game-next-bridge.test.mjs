import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_GRAPH_DRAFT_SCHEMA,
  LEGACY_WEBGAME_BRIDGE_REVISION,
  bridgeLegacyWebgameContract,
  verifyLegacyBridgeInvariants,
} from '../adapters/game-next/legacy-webgame-bridge.mjs';

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

test('legacy webgame contract bridges to a conservative game graph without causal edges', () => {
  const graph = bridgeLegacyWebgameContract(legacyContract());
  assert.equal(graph.schema, GAME_GRAPH_DRAFT_SCHEMA);
  assert.equal(graph.bridge_revision, LEGACY_WEBGAME_BRIDGE_REVISION);
  assert.equal(graph.status, 'derived-static-only');
  assert.equal(graph.source_contract.source_hash, 'a'.repeat(64));
  assert.equal(graph.nodes.filter((x) => x.category === 'input').length, 2);
  assert.equal(graph.nodes.filter((x) => x.category === 'system').length, 1);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].kind, 'hierarchy-symbolic');
  assert.equal(graph.relations[0].parent_symbol, 'scene');
  assert.equal(graph.relations[0].child_symbol, 'player');
  assert.deepEqual(graph.behavior.causal_edges, []);
  assert.deepEqual(graph.behavior.transitions, []);
  assert.equal(graph.gaps.input_effects_unresolved, true);
  assert.equal(graph.gaps.runtime_state_unresolved, true);
  assert.deepEqual(verifyLegacyBridgeInvariants(graph), { valid: true, errors: [] });
});

test('legacy behavior projection is not duplicated as invented graph nodes', () => {
  const graph = bridgeLegacyWebgameContract(legacyContract());
  assert.equal(graph.nodes.some((x) => x.source.plane.startsWith('behavior.')), false);
  assert.equal(graph.nodes.some((x) => x.id.includes('behavior-trigger')), false);
  assert.equal(graph.nodes.some((x) => x.id.includes('behavior-system')), false);
});

test('bridge output is deterministic when legacy plane arrays are reordered', () => {
  const a = legacyContract();
  const b = legacyContract();
  b.source.files.reverse();
  b.source.project_roots.reverse();
  b.source.engines.reverse();
  b.planes.input.listeners.reverse();
  b.planes.input.keys.reverse();
  assert.deepEqual(bridgeLegacyWebgameContract(a), bridgeLegacyWebgameContract(b));
});

test('bridge fails closed for another contract family/version', () => {
  const wrong = legacyContract();
  wrong.sbf_webgame_contract = '2';
  assert.throws(() => bridgeLegacyWebgameContract(wrong), /requires sbf\.webgame-contract\/1/);
  assert.throws(() => bridgeLegacyWebgameContract(null), /requires an object contract/);
});

test('duplicate legacy item ids cannot silently collapse into one graph node', () => {
  const value = legacyContract();
  value.planes.entity.entities.push({ ...value.planes.entity.entities[0] });
  assert.throws(() => bridgeLegacyWebgameContract(value), /duplicate game-next node id/);
});

test('invariant checker rejects invented causal edges and transition claims', () => {
  const graph = bridgeLegacyWebgameContract(legacyContract());
  graph.behavior.causal_edges.push({ from: 'KeyW', to: 'movePlayer' });
  graph.behavior.transitions.push({ from: 'idle', to: 'moving' });
  const checked = verifyLegacyBridgeInvariants(graph);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.includes('behavior.causal_edges'));
  assert.ok(checked.errors.includes('behavior.transitions'));
});
