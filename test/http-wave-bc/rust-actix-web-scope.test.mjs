import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/rust-actix-web.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/actix-web';
const expectedFiles = [
  'Cargo.toml',
  'normal/src/lib.rs',
  'counterexamples/dynamic-scope/src/lib.rs',
  'counterexamples/configure-factory/src/lib.rs',
  'counterexamples/guarded-resource/src/lib.rs'
];
const sourceFiles = [
  'Cargo.toml', 'actix-web/Cargo.toml', 'actix-web/src/app.rs',
  'actix-web/src/scope.rs', 'actix-web/src/route.rs', 'actix-web/src/web.rs'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-rust-actix-web-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'rust-actix-web');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.crate, 'actix-web');
  assert.equal(record.upstream_pin.version, '4.17.0');
  assert.equal(record.upstream_pin.tag, 'actix-web-v4.17.0');
  assert.equal(record.upstream_pin.commit, '15fd3ff31f6fa8c03b34099558ff3079b537b1f8');
  assert.equal(record.upstream_pin.rust_version_minimum, '1.88');
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
  assert.match(fixtureText('Cargo.toml'), /^actix-web = "=4\.17\.0"$/m);
  assert.match(fixtureText('Cargo.toml'), /^rust-version = "1\.88"$/m);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-rust-actix-web-02', 'HTTP-rust-actix-web-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/rust-actix-web/adapter.mjs')), false);
}

test('Actix Web target-01 pins authored fixtures without runtime or adapter authority', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-app-route-and-scope', 'dynamic-scope', 'configure-factory', 'guarded-resource']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/src/lib.rs'), /web::scope\("\/api"\)/);
  assert.match(fixtureText('counterexamples/dynamic-scope/src/lib.rs'), /web::scope\(prefix\)/);
  assert.match(fixtureText('counterexamples/configure-factory/src/lib.rs'), /\.configure\(install_routes\)/);
  assert.match(fixtureText('counterexamples/guarded-resource/src/lib.rs'), /guard::Header\("x-token", "ok"\)/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('test::init_service')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Actix Web target-01 rejects fixture, pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[1].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const pinTamper = changed();
  pinTamper.upstream_pin.version = '4.16.0';
  assert.throws(() => validate(pinTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
