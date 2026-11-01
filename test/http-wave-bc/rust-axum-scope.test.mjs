import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/rust-axum.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/axum';
const expectedFiles = [
  'Cargo.toml',
  'normal/src/lib.rs',
  'counterexamples/dynamic-nest/src/lib.rs',
  'counterexamples/nested-fallback/src/lib.rs',
  'counterexamples/route-layer/src/lib.rs'
];
const sourceFiles = [
  'Cargo.toml', 'axum/Cargo.toml', 'axum/src/docs/routing/route.md',
  'axum/src/docs/routing/nest.md', 'axum/src/docs/routing/route_layer.md'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-rust-axum-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'rust-axum');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.crate, 'axum');
  assert.equal(record.upstream_pin.version, '0.8.9');
  assert.equal(record.upstream_pin.tag, 'axum-v0.8.9');
  assert.equal(record.upstream_pin.commit, 'c59208c86fded335cd85e388030ad59347b0e5ae');
  assert.equal(record.upstream_pin.rust_version_minimum, '1.80');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), sourceFiles);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('Cargo.toml'), /^axum = "=0\.8\.9"$/m);
  assert.match(fixtureText('Cargo.toml'), /^rust-version = "1\.80"$/m);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-rust-axum-02', 'HTTP-rust-axum-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/rust-axum/adapter.mjs')), false);
}

test('Axum target-01 pins authored fixtures and keeps runtime/adapter authority false', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-route-and-nest', 'dynamic-nest', 'nested-fallback', 'route-layer-order']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/src/lib.rs'), /\.nest\("\/api", users\)/);
  assert.match(fixtureText('counterexamples/dynamic-nest/src/lib.rs'), /\.nest\(prefix, users\)/);
  assert.match(fixtureText('counterexamples/nested-fallback/src/lib.rs'), /StatusCode::GONE/);
  assert.match(fixtureText('counterexamples/route-layer/src/lib.rs'), /\.route_layer\(from_fn\(guard\)\)/);
  assert.match(fixtureText('counterexamples/route-layer/src/lib.rs'), /\.route\("\/late", get\(late\)\)/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('ServiceExt::oneshot')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Axum target-01 rejects fixture, upstream pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[1].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const pinTamper = changed();
  pinTamper.upstream_pin.version = '0.8.8';
  assert.throws(() => validate(pinTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
