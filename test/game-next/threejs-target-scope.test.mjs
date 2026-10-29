import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWebgame } from '../../scanners/webgame.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'adapters/game/threejs');
const fixture = (name) => path.join(target, 'fixtures', name);
const pin = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));

test('Three.js target-01 pins exact upstream releases and states its limited authority', () => {
  assert.equal(pin.schema, 'sbf.game-threejs-target-scope-pins/1');
  assert.equal(pin.scope, 'static-source-target-01-only');
  assert.deepEqual([pin.three.package, pin.three.version, pin.three.tag], ['three', '0.180.0', 'r180']);
  assert.match(pin.three.tag_object_sha, /^[0-9a-f]{40}$/);
  assert.match(pin.three.commit_sha, /^[0-9a-f]{40}$/);
  assert.match(pin.three.package_json_blob_sha, /^[0-9a-f]{40}$/);
  assert.match(pin.three.gltf_exporter_blob_sha, /^[0-9a-f]{40}$/);
  assert.deepEqual([pin.react_three_fiber_companion.package, pin.react_three_fiber_companion.version,
    pin.react_three_fiber_companion.tag, pin.react_three_fiber_companion.target_credit],
  ['@react-three/fiber', '9.0.0', 'v9.0.0', false]);
  assert.match(pin.react_three_fiber_companion.commit_sha, /^[0-9a-f]{40}$/);
  assert.match(pin.react_three_fiber_companion.package_json_blob_sha, /^[0-9a-f]{40}$/);
  for (const name of ['static-declaration', 'counterexamples']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture(name), 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.three, pin.three.version);
    assert.deepEqual(Object.keys(pkg.dependencies), ['three']);
  }
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['asset indirection', 'lifecycle', 'exporter version', 'not a lockfile',
    'GAME-threejs-02', 'GAME-threejs-03', 'release=BLOCKED']) {
    assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
  }
});

test('pinned direct fixture records only static Three.js declarations', () => {
  const scan = scanWebgame(fixture('static-declaration'));
  assert.deepEqual(scan.engines, ['three']);
  assert.deepEqual(scan.engine_packages, [{ package: 'three', version: '0.180.0', project_root: '.' }]);
  assert.deepEqual(scan.files_read, ['package.json', 'src/game.js']);
  assert.equal(scan.completeness.status, 'complete');
  assert.ok(scan.scenes.some((x) => x.kind === 'three-scene' && x.symbol === 'scene'));
  assert.ok(scan.entities.some((x) => x.kind === 'Mesh' && x.symbol === 'actor'));
  assert.ok(scan.render.renderers.some((x) => x.kind === 'WebGLRenderer'));
  assert.ok(scan.hierarchy.some((x) => x.parent === 'scene' && x.child === 'actor'));
  assert.ok(scan.simulation.loops.some((x) => x.kind === 'requestAnimationFrame'));
  assert.ok(scan.assets.some((x) => x.uri === '/assets/direct.glb'));
});

test('indirected asset and removed/disposed object remain unknown despite a complete scanner status', () => {
  const scan = scanWebgame(fixture('counterexamples'));
  assert.equal(scan.completeness.status, 'complete');
  assert.deepEqual(scan.assets, [], 'computed asset URI must not be invented as a literal');
  assert.ok(scan.hierarchy.some((x) => x.parent === 'scene' && x.child === 'actor'));
  assert.ok(!JSON.stringify(scan).includes('scene.remove(actor)'));
  assert.ok(!JSON.stringify(scan).includes('geometry.dispose'));
  assert.ok(!scan.files_read.includes('assets/model.gltf'));
  assert.ok(!JSON.stringify(scan).includes('exporter release unknown'));
});

test('unread asset/exporter bytes do not change the source hash, while source and package drift do', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'game-threejs-01-'));
  const copy = path.join(temp, 'fixture');
  try {
    fs.cpSync(fixture('counterexamples'), copy, { recursive: true });
    const initial = scanWebgame(copy);
    const asset = path.join(copy, 'assets/model.gltf');
    fs.writeFileSync(asset, fs.readFileSync(asset, 'utf8').replace('exporter release unknown', 'another unknown exporter'));
    const changedAsset = scanWebgame(copy);
    assert.equal(changedAsset.source_hash, initial.source_hash);
    const source = path.join(copy, 'src/game.js');
    fs.appendFileSync(source, '\nconst changedSource = true;\n');
    const changedSource = scanWebgame(copy);
    assert.notEqual(changedSource.source_hash, initial.source_hash);
    const packageFile = path.join(copy, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    pkg.dependencies.three = '0.181.0';
    fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    const changedPackage = scanWebgame(copy);
    assert.notEqual(changedPackage.source_hash, changedSource.source_hash);
    assert.equal(changedPackage.engine_packages[0].version, '0.181.0');
    assert.notEqual(changedPackage.engine_packages[0].version, pin.three.version);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
