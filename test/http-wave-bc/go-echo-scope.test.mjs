import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scopePath = path.join(root, 'adapters/http-wave-bc/scope/go-echo.SCOPE.json');
const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
const expectedFiles = [
  'go.mod',
  'normal/main.go',
  'counterexamples/dynamic-prefix/main.go',
  'counterexamples/group-middleware/main.go',
  'counterexamples/any-match/main.go'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-go-echo-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'go-echo');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.module, 'github.com/labstack/echo/v5');
  assert.equal(record.upstream_pin.version, 'v5.4.0');
  assert.equal(record.upstream_pin.commit, 'fc410094b2f3415cf2bf5204082137b205bfd5af');
  assert.equal(record.upstream_pin.go_mod_minimum, '1.25.0');
  assert.equal(record.fixture_root, 'test/http-wave-bc/fixtures/target-scope/echo');
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role), [
    'dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample'
  ]);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const resolved = path.resolve(root, record.fixture_root, fixture.path);
    assert.ok(resolved.startsWith(`${path.resolve(root, record.fixture_root)}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(resolved)), fixture.sha256, `${fixture.path} changed`);
  }
  const goMod = fs.readFileSync(path.join(root, record.fixture_root, 'go.mod'), 'utf8');
  assert.match(goMod, /^go 1\.25\.0$/m);
  assert.match(goMod, /^require github\.com\/labstack\/echo\/v5 v5\.4\.0$/m);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-go-echo-02', 'HTTP-go-echo-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/go-echo/adapter.mjs')), false);
}

test('Echo target-01 scope has pinned fixtures, explicit counterexamples and no adapter/runtime claim', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id), [
    'literal-method-and-static-group', 'dynamic-group-prefix', 'group-middleware-auth', 'any-match-methods'
  ]);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('httptest')));
  assert.ok(scope.limits.some((s) => s.includes('not upstream source copies or compiled evidence')));
});

test('Echo scope rejects tampered fixture hash, upstream pin and unsupported runtime claim', () => {
  const changed = () => structuredClone(scope);
  const hashTamper = changed();
  hashTamper.fixtures[1].sha256 = '0'.repeat(64);
  assert.throws(() => validate(hashTamper));
  const versionTamper = changed();
  versionTamper.upstream_pin.version = 'v5.4.1';
  assert.throws(() => validate(versionTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
