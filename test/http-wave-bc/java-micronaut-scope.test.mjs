import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/java-micronaut.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/micronaut';
const expectedFiles = [
  'pom.xml',
  'normal/src/main/java/org/sbf/fixture/Application.java',
  'normal/src/main/java/org/sbf/fixture/UserController.java',
  'counterexamples/conditional-bean/src/main/java/org/sbf/fixture/FeatureController.java',
  'counterexamples/route-condition/src/main/java/org/sbf/fixture/VersionController.java',
  'counterexamples/context-path/src/main/resources/application.properties'
];
const platformSources = ['gradle.properties', 'gradle/libs.versions.toml'];
const coreSources = [
  'http/src/main/java/io/micronaut/http/annotation/Controller.java',
  'http/src/main/java/io/micronaut/http/annotation/Get.java',
  'http/src/main/java/io/micronaut/http/annotation/Post.java',
  'http/src/main/java/io/micronaut/http/annotation/RouteCondition.java',
  'inject/src/main/java/io/micronaut/context/annotation/Requires.java'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-java-micronaut-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'java-micronaut');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  const { platform, core } = record.upstream_pin;
  assert.equal(platform.repository, 'micronaut-projects/micronaut-platform');
  assert.equal(platform.version, '5.2.4');
  assert.equal(platform.tag, 'v5.2.4');
  assert.equal(platform.tag_object, '16fffa97f08f8675e0c244698176d3bd78558cef');
  assert.equal(platform.commit, '24098f833f9580f73b6fee648532e81406a954a8');
  assert.equal(core.repository, 'micronaut-projects/micronaut-core');
  assert.equal(core.version, '5.2.20');
  assert.equal(core.tag, 'v5.2.20');
  assert.equal(core.tag_object, '9b63ad5a3931c6b734a6813e090dda7a0e94d307');
  assert.equal(core.commit, '077ee7c2d728a152bed5c7aafa040e8aac27fccd');
  assert.equal(record.upstream_pin.jdk_minimum_from_5_announcement, '25');
  assert.deepEqual(platform.sources.map((s) => s.path), platformSources);
  assert.deepEqual(core.sources.map((s) => s.path), coreSources);
  assert.ok([...platform.sources, ...core.sources].every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'normal', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('pom.xml'), /<micronaut\.platform\.version>5\.2\.4<\/micronaut\.platform\.version>/);
  assert.match(fixtureText('pom.xml'), /<micronaut\.core\.version>5\.2\.20<\/micronaut\.core\.version>/);
  assert.match(fixtureText('pom.xml'), /<maven\.compiler\.release>25<\/maven\.compiler\.release>/);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-java-micronaut-02', 'HTTP-java-micronaut-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/java-micronaut/adapter.mjs')), false);
}

test('Micronaut target-01 pins HTTP planning fixtures without runtime or adapter authority', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-controller-method-routes', 'conditional-bean', 'route-condition', 'server-context-path']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/src/main/java/org/sbf/fixture/UserController.java'), /@Controller\("\/api\/users"\)/);
  assert.match(fixtureText('counterexamples/conditional-bean/src/main/java/org/sbf/fixture/FeatureController.java'), /@Requires\(property = "feature\.users", value = "enabled"\)/);
  assert.match(fixtureText('counterexamples/route-condition/src/main/java/org/sbf/fixture/VersionController.java'), /@RouteCondition\("#\{request\.parameters/);
  assert.match(fixtureText('counterexamples/context-path/src/main/resources/application.properties'), /micronaut\.server\.context-path=\/tenant/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('@MicronautTest')));
  assert.ok(scope.limits.some((s) => s.includes('T05 micronaut-http-java')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Micronaut target-01 rejects fixture, platform/core pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[2].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const platformTamper = changed();
  platformTamper.upstream_pin.platform.commit = '0'.repeat(40);
  assert.throws(() => validate(platformTamper));
  const coreTamper = changed();
  coreTamper.upstream_pin.core.version = '5.2.21';
  assert.throws(() => validate(coreTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
