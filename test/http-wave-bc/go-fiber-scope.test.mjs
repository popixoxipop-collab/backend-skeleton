import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json belongs to the seven cross-track scanner records, not target-only plans.
const scopePath = path.join(root, 'adapters/http-wave-bc/scope/go-fiber.TARGET_SCOPE.json');
const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/fiber';
const expectedFiles = [
  'go.mod',
  'normal/main.go',
  'counterexamples/all-vs-use/main.go',
  'counterexamples/dynamic-prefix/main.go',
  'counterexamples/middleware-order/main.go'
];
const sourceFiles = ['go.mod', 'docs/guide/routing.md', 'docs/guide/grouping.md', 'docs/api/app.md'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-go-fiber-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'go-fiber');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.module, 'github.com/gofiber/fiber/v3');
  assert.equal(record.upstream_pin.version, 'v3.6.1');
  assert.equal(record.upstream_pin.commit, 'e09ba687733538c74765c8f691772f328b62f670');
  assert.equal(record.upstream_pin.go_mod_minimum, '1.26.0');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), sourceFiles);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role), [
    'dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample'
  ]);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('go.mod'), /^go 1\.26\.0$/m);
  assert.match(fixtureText('go.mod'), /^require github\.com\/gofiber\/fiber\/v3 v3\.6\.1$/m);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-go-fiber-02', 'HTTP-go-fiber-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/go-fiber/adapter.mjs')), false);
}

test('Fiber target-01 has pinned authored fixtures and explicitly no adapter/runtime support claim', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id), [
    'literal-method-and-static-group', 'all-vs-use', 'dynamic-group-prefix', 'middleware-order-auth'
  ]);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/main.go'), /api := app\.Group\("\/api"\)/);
  assert.match(fixtureText('counterexamples/all-vs-use/main.go'), /app\.All\("\/ping", ok\)/);
  assert.match(fixtureText('counterexamples/all-vs-use/main.go'), /app\.Use\("\/ping",/);
  assert.match(fixtureText('counterexamples/dynamic-prefix/main.go'), /app\.Group\(prefix\)/);
  assert.match(fixtureText('counterexamples/middleware-order/main.go'), /c\.Get\("X-Token"\)/);
  assert.match(fixtureText('counterexamples/middleware-order/main.go'), /return c\.Next\(\)/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('app.Test(req)')));
  assert.ok(scope.limits.some((s) => s.includes('not upstream source copies or compiled evidence')));
});

test('Fiber target-01 rejects fixture, upstream pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[1].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const pinTamper = changed();
  pinTamper.upstream_pin.version = 'v3.6.2';
  assert.throws(() => validate(pinTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
