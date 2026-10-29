import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWebgame } from '../../scanners/webgame.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'adapters/game/threejs');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(target, 'fixtures', `${name}.fixture.json`), 'utf8'));
const pin = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));
const withFixture = (name, use) => {
  const spec = fixture(name);
  assert.equal(spec.schema, 'sbf.game-threejs-target-fixture/1');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'game-threejs-01-'));
  try {
    fs.mkdirSync(path.join(temp, 'src'));
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify(spec.package, null, 2) + '\n');
    assert.equal(spec.source_file, 'src/game.js');
    fs.writeFileSync(path.join(temp, spec.source_file), spec.source);
    if (spec.asset_file) {
      assert.equal(spec.asset_file, 'assets/model.gltf');
      fs.mkdirSync(path.join(temp, 'assets'));
      fs.writeFileSync(path.join(temp, spec.asset_file), JSON.stringify(spec.asset, null, 2) + '\n');
    }
    return use(temp, spec);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};

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
    const spec = fixture(name);
    assert.equal(spec.package.dependencies.three, pin.three.version);
    assert.deepEqual(Object.keys(spec.package.dependencies), ['three']);
  }
  assert.deepEqual(fs.readdirSync(path.join(target, 'fixtures'), { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name).sort(),
    ['counterexamples.fixture.json', 'static-declaration.fixture.json']);
  assert.equal(fs.readdirSync(path.join(target, 'fixtures'), { recursive: true })
    .filter((entry) => path.basename(entry) === 'package.json').length, 0,
  'repository fixtures must not be detected as Three.js projects');
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['asset indirection', 'lifecycle', 'exporter version', 'not a lockfile',
    'GAME-threejs-02', 'GAME-threejs-03', 'release=BLOCKED']) {
    assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
  }
});

test('pinned direct fixture records only static Three.js declarations', () => {
  withFixture('static-declaration', (project) => {
    const scan = scanWebgame(project);
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
});

test('indirected asset and removed/disposed object remain unknown despite a complete scanner status', () => {
  withFixture('counterexamples', (project) => {
    const scan = scanWebgame(project);
    assert.equal(scan.completeness.status, 'complete');
    assert.deepEqual(scan.assets, [], 'computed asset URI must not be invented as a literal');
    assert.ok(scan.hierarchy.some((x) => x.parent === 'scene' && x.child === 'actor'));
    assert.ok(!JSON.stringify(scan).includes('scene.remove(actor)'));
    assert.ok(!JSON.stringify(scan).includes('geometry.dispose'));
    assert.ok(!scan.files_read.includes('assets/model.gltf'));
    assert.ok(!JSON.stringify(scan).includes('exporter release unknown'));
  });
});

test('unread asset/exporter bytes do not change the source hash, while source and package drift do', () => {
  withFixture('counterexamples', (copy) => {
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
  });
});
