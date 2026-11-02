import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/php-symfony.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/symfony';
const expectedFiles = [
  'composer.json',
  'normal/src/Controller/UserController.php',
  'counterexamples/yaml/config/routes.yaml',
  'counterexamples/php-config/config/routes.php',
  'counterexamples/xml-legacy/config/routes.xml',
  'counterexamples/dynamic-prefix/src/Controller/DynamicController.php'
];
const sourceFiles = [
  'composer.json',
  'src/Symfony/Component/Routing/Attribute/Route.php',
  'src/Symfony/Component/Routing/Loader/AttributeClassLoader.php',
  'src/Symfony/Component/Routing/Loader/YamlFileLoader.php',
  'src/Symfony/Component/Routing/Loader/PhpFileLoader.php'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-php-symfony-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'php-symfony');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.repository, 'symfony/symfony');
  assert.equal(record.upstream_pin.version, '8.1.10');
  assert.equal(record.upstream_pin.tag, 'v8.1.10');
  assert.equal(record.upstream_pin.tag_object, 'ba4f4496d42ae25c8de891925249d66f2b67489a');
  assert.equal(record.upstream_pin.commit, '34a08ab1b25dac1ebbdca78927f27cf353993625');
  assert.equal(record.upstream_pin.php_constraint_from_source, '>=8.4.1');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), sourceFiles);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'counterexample', 'counterexample', 'historical-unsupported-profile', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.equal(JSON.parse(fixtureText('composer.json')).require['symfony/framework-bundle'], '8.1.10');
  assert.equal(JSON.parse(fixtureText('composer.json')).require.php, '>=8.4.1');
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-php-symfony-02', 'HTTP-php-symfony-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/php-symfony/adapter.mjs')), false);
}

test('Symfony target-01 pins route profiles without runtime or adapter authority', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-class-and-method-attributes', 'yaml-and-php-config', 'legacy-xml', 'dynamic-prefix-condition']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/src/Controller/UserController.php'), /#\[Route\('\/api', name: 'api_'\)\]/);
  assert.match(fixtureText('counterexamples/yaml/config/routes.yaml'), /path: \/yaml-only/);
  assert.match(fixtureText('counterexamples/php-config/config/routes.php'), /RoutingConfigurator/);
  assert.match(fixtureText('counterexamples/xml-legacy/config/routes.xml'), /Historical XML profile only/);
  assert.match(fixtureText('counterexamples/dynamic-prefix/src/Controller/DynamicController.php'), /condition: .*X-Feature/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('debug:router')));
  assert.ok(scope.limits.some((s) => s.includes('T07 Symfony attribute-stack')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Symfony target-01 rejects fixture, source pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[1].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const pinTamper = changed();
  pinTamper.upstream_pin.commit = '0'.repeat(40);
  assert.throws(() => validate(pinTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
