import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWebgame } from '../../scanners/webgame.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'adapters/game/r3f');
const pins = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(target, 'fixtures', `${name}.fixture.json`), 'utf8'));

function withFixture(name, use) {
  const spec = fixture(name);
  assert.equal(spec.schema, 'sbf.game-r3f-target-fixture/1');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'game-r3f-01-'));
  try {
    assert.equal(spec.source_file, 'src/scene.jsx');
    fs.mkdirSync(path.join(temp, 'src'));
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify(spec.package, null, 2) + '\n');
    fs.writeFileSync(path.join(temp, spec.source_file), spec.source);
    assert.match(spec.asset_file, /^assets\/[a-z-]+\.(?:glb|gltf)$/);
    fs.mkdirSync(path.join(temp, 'assets'));
    fs.writeFileSync(path.join(temp, spec.asset_file), spec.asset);
    return use(temp, spec);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('R3F target-01 pins exact Three/R3F source releases without runtime authority', () => {
  assert.equal(pins.schema, 'sbf.game-r3f-target-scope-pins/1');
  assert.equal(pins.scope, 'static-source-target-01-only');
  assert.deepEqual([pins.three.package, pins.three.version, pins.three.tag], ['three', '0.180.0', 'r180']);
  assert.deepEqual([pins.react_three_fiber.package, pins.react_three_fiber.version,
    pins.react_three_fiber.tag, pins.react_three_fiber.three_peer_range,
    pins.react_three_fiber.react_peer_range],
  ['@react-three/fiber', '9.0.0', 'v9.0.0', '>=0.156', '^19.0.0']);
  for (const value of [pins.three.tag_object_sha, pins.three.commit_sha,
    pins.three.package_json_blob_sha, pins.three.gltf_exporter_blob_sha,
    pins.react_three_fiber.commit_sha, pins.react_three_fiber.package_json_blob_sha]) {
    assert.match(value, /^[0-9a-f]{40}$/);
  }
  assert.equal(pins.threejs_target_credit, false);
  assert.equal(pins.runtime_certified, false);
  assert.equal(pins.release_authorized, false);
  for (const name of ['static-declaration', 'counterexamples']) {
    const spec = fixture(name);
    assert.deepEqual(spec.package.dependencies, {
      three: pins.three.version, '@react-three/fiber': pins.react_three_fiber.version,
    });
  }
  assert.deepEqual(fs.readdirSync(path.join(target, 'fixtures')).sort(),
    ['counterexamples.fixture.json', 'static-declaration.fixture.json']);
  assert.equal(fs.existsSync(path.join(target, 'fixtures', 'package.json')), false);
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['asset indirection', 'lifecycle', 'exporter version',
    'not a lockfile', 'useLoader', 'useFrame', 'GAME-r3f-02', 'GAME-r3f-03', 'release=BLOCKED']) {
    assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
  }
});

test('R3F Canvas and JSX declarations are observed, not hook execution or asset loading', () => {
  withFixture('static-declaration', (project) => {
    const scan = scanWebgame(project);
    assert.deepEqual(scan.engines, ['@react-three/fiber', 'three']);
    assert.deepEqual(scan.engine_packages, [
      { package: '@react-three/fiber', version: '9.0.0', project_root: '.' },
      { package: 'three', version: '0.180.0', project_root: '.' },
    ]);
    assert.deepEqual(scan.files_read, ['package.json', 'src/scene.jsx']);
    assert.ok(scan.scenes.some((x) => x.kind === 'react-three-fiber-canvas'));
    assert.ok(scan.render.renderers.some((x) => x.kind === 'ReactThreeFiber'));
    assert.ok(scan.entities.some((x) => x.kind === 'jsx:mesh' && x.symbol === 'actor'));
    assert.ok(scan.input.listeners.some((x) => x.event === 'onClick' && x.handler === 'selectActor'));
    assert.deepEqual(scan.assets, [], 'useLoader is not a scanner asset recognizer, even with a literal URI');
    assert.deepEqual(scan.simulation.loops, [], 'useFrame callback is not a scanner loop result');
    assert.equal(scan.completeness.status, 'partial');
    assert.ok(scan.warnings.some((x) => x.code === 'WEBGAME_SIMULATION_LOOP_UNRESOLVED'));
  });
});

test('computed asset, conditional mount, and dispose policy remain unresolved', () => {
  withFixture('counterexamples', (project) => {
    const scan = scanWebgame(project);
    assert.equal(scan.completeness.status, 'partial');
    assert.deepEqual(scan.assets, [], 'computed useLoader URI cannot be resolved');
    assert.ok(scan.entities.some((x) => x.kind === 'jsx:mesh' && x.symbol === 'conditional-actor'));
    assert.deepEqual(scan.hierarchy, []);
    assert.deepEqual(scan.simulation.loops, []);
    assert.ok(!scan.files_read.includes('assets/model.gltf'));
    assert.ok(!JSON.stringify(scan).includes('exporter release unknown'));
    assert.ok(!JSON.stringify(scan).includes('mounted'));
    assert.ok(!JSON.stringify(scan).includes('dispose'));
  });
});

test('unread asset bytes leave the R3F source hash fixed, while source and package drift move it', () => {
  withFixture('counterexamples', (project, spec) => {
    const initial = scanWebgame(project);
    const asset = path.join(project, spec.asset_file);
    fs.writeFileSync(asset, 'synthetic glTF fixture; different unknown exporter');
    assert.equal(scanWebgame(project).source_hash, initial.source_hash);
    const source = path.join(project, spec.source_file);
    fs.appendFileSync(source, '\nconst changedSource = true;\n');
    const changedSource = scanWebgame(project);
    assert.notEqual(changedSource.source_hash, initial.source_hash);
    const manifest = path.join(project, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    pkg.dependencies['@react-three/fiber'] = '9.0.1';
    fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
    const changedPackage = scanWebgame(project);
    assert.notEqual(changedPackage.source_hash, changedSource.source_hash);
    assert.equal(changedPackage.engine_packages[0].version, '9.0.1');
    assert.notEqual(changedPackage.engine_packages[0].version, pins.react_three_fiber.version);
  });
});
