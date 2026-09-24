import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { scanWebgame } from '../scanners/webgame.mjs';
import { buildWebgameContract, verifyWebgameContractSnapshot } from '../contracts/webgame.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

function fixture(source, deps = { three: '^0.180.0', '@dimforge/rapier3d': '^0.19.0' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-webgame-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'game.ts'), source);
  return root;
}

function validateSchema(name, value) {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', name), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

test('Three.js scan extracts source-backed game planes without inventing input effects', () => {
  const root = fixture(`
import * as THREE from 'three';

const scene = new THREE.Scene();
const player = new THREE.Mesh();
const renderer = new THREE.WebGLRenderer();
scene.add(player);

function updatePlayer(dt) {
  player.position.z += dt;
}
function animate() {
  requestAnimationFrame(animate);
  updatePlayer(1 / 60);
  renderer.render(scene, camera);
}
function onKey(event) {
  if (event.code === 'KeyW') updatePlayer(1);
}
window.addEventListener('keydown', onKey);

const socket = new WebSocket('wss://example.invalid/game');
loader.load('/assets/player.glb');
animate();
`);

  const scan = scanWebgame(root);
  validateSchema('webgame-scan.schema.json', scan);

  assert.equal(scan.completeness.status, 'complete');
  assert.deepEqual(scan.engines, ['three']);
  assert.equal(scan.adapter_revision, 1);
  assert.deepEqual(scan.engine_packages, [{ package: 'three', version: '^0.180.0', project_root: '.' }]);
  assert.ok(scan.files_read.includes('package.json'));
  assert.ok(scan.scenes.some((x) => x.symbol === 'scene'));
  assert.ok(scan.entities.some((x) => x.symbol === 'player' && x.kind === 'Mesh'));
  assert.ok(scan.hierarchy.some((x) => x.parent === 'scene' && x.child === 'player'));
  assert.ok(scan.render.renderers.some((x) => x.kind === 'WebGLRenderer'));
  assert.ok(scan.input.listeners.some((x) => x.event === 'keydown' && x.handler === 'onKey'));
  assert.ok(scan.input.keys.some((x) => x.value === 'KeyW'));
  assert.ok(scan.simulation.systems.some((x) => x.symbol === 'updatePlayer'));
  assert.ok(scan.simulation.loops.some((x) => x.kind === 'requestAnimationFrame' && x.callback === 'animate'));
  assert.ok(scan.simulation.physics.some((x) => x.package === '@dimforge/rapier3d' && x.version === '^0.19.0'));
  assert.ok(scan.network.sockets.some((x) => x.endpoint === 'wss://example.invalid/game'));
  assert.ok(scan.assets.some((x) => x.uri === '/assets/player.glb'));
  assert.ok(scan.warnings.some((x) => x.code === 'WEBGAME_INPUT_EFFECT_UNRESOLVED'));

  const contract = buildWebgameContract({
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scan,
  });
  validateSchema('webgame-contract.schema.json', contract);
  assert.equal(contract.source.adapter_revision, 1);
  assert.deepEqual(contract.source.engine_packages, [{ package: 'three', version: '^0.180.0', project_root: '.' }]);
  assert.equal(contract.planes.scene.scenes[0].symbol, 'scene');
  assert.match(contract.planes.scene.scenes[0].id, /^scene:[a-f0-9]{20}$/);
  assert.ok(contract.planes.behavior.triggers.every((x) => /^behavior-trigger:[a-f0-9]{20}$/.test(x.id)));
  assert.ok(contract.planes.behavior.triggers.some((x) => x.kind === 'key-check' && x.value === 'KeyW'));
  assert.ok(!JSON.stringify(contract).includes('position.z += dt'), 'contract must not copy arbitrary source bodies');
});

test('webgame contract freshness is exact on feature identity, scanner revision and source hash', () => {
  const root = fixture("import * as THREE from 'three';\nconst scene = new THREE.Scene();\nfunction animate(){ requestAnimationFrame(animate); }\n");
  const scan = scanWebgame(root);
  const contract = buildWebgameContract({
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scan,
  });
  assert.deepEqual(verifyWebgameContractSnapshot({
    contract,
    scan,
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
  }), { current: true, changes: [], source_hash: scan.source_hash, adapter_revision: 1 });

  fs.appendFileSync(path.join(root, 'src', 'game.ts'), 'const changed = true;\n');
  const changedScan = scanWebgame(root);
  const stale = verifyWebgameContractSnapshot({
    contract,
    scan: changedScan,
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(stale.current, false);
  assert.ok(stale.changes.some((x) => x.field === 'source.source_hash'));

  const revisionDrift = verifyWebgameContractSnapshot({
    contract,
    scan: { ...scan, adapter_revision: 2 },
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(revisionDrift.current, false);
  assert.ok(revisionDrift.changes.some((x) => x.field === 'source.adapter_revision'));
});

test('React Three Fiber Canvas and JSX mesh are recognized as scene/render/entity declarations', () => {
  const root = fixture(`
import { Canvas } from '@react-three/fiber';

function updateWorld() {}
export function Game() {
  return <Canvas><mesh name="hero" onClick={selectHero} /></Canvas>;
}
`, { three: '^0.180.0', '@react-three/fiber': '^9.0.0' });

  const scan = scanWebgame(root);
  validateSchema('webgame-scan.schema.json', scan);
  assert.ok(scan.scenes.some((x) => x.kind === 'react-three-fiber-canvas'));
  assert.ok(scan.render.renderers.some((x) => x.kind === 'ReactThreeFiber'));
  assert.ok(scan.entities.some((x) => x.symbol === 'hero'));
  assert.ok(scan.input.listeners.some((x) => x.event === 'onClick' && x.handler === 'selectHero'));
});

test('unsupported repo fails closed instead of emitting an empty game contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-webgame-none-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'plain', dependencies: {} }));
  const scan = scanWebgame(root);
  validateSchema('webgame-scan.schema.json', scan);
  assert.equal(scan.completeness.status, 'blocked');
  assert.equal(scan.source_hash, null);
  assert.throws(() => buildWebgameContract({
    featureId: '001-gameplay',
    featureUid: '11111111-1111-4111-8111-111111111111',
    scan,
  }), /no supported webgame engine/);
});

test('source hash is deterministic for unchanged source and changes when source changes', () => {
  const root = fixture("import * as THREE from 'three';\nconst scene = new THREE.Scene();\nfunction animate(){ requestAnimationFrame(animate); }\n");
  const first = scanWebgame(root);
  const second = scanWebgame(root);
  assert.equal(first.source_hash, second.source_hash);
  fs.appendFileSync(path.join(root, 'src', 'game.ts'), 'const changed = true;\n');
  const third = scanWebgame(root);
  assert.notEqual(first.source_hash, third.source_hash);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies.three = '^0.181.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  const fourth = scanWebgame(root);
  assert.notEqual(third.source_hash, fourth.source_hash);
  assert.equal(fourth.engine_packages[0].version, '^0.181.0');
});
