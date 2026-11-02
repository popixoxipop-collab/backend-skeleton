import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/java-quarkus.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/quarkus';
const expectedFiles = [
  'pom.xml',
  'normal/src/main/java/org/sbf/fixture/UserResource.java',
  'counterexamples/application-path/src/main/java/org/sbf/fixture/ApiApplication.java',
  'counterexamples/build-profile/src/main/java/org/sbf/fixture/ProfileOnlyResource.java',
  'counterexamples/runtime-disabled/src/main/java/org/sbf/fixture/ToggleResource.java',
  'counterexamples/duplicate/src/main/java/org/sbf/fixture/FirstResource.java',
  'counterexamples/duplicate/src/main/java/org/sbf/fixture/SecondResource.java'
];
const sourceFiles = [
  'pom.xml',
  'extensions/resteasy-reactive/rest/runtime/pom.xml',
  'extensions/resteasy-reactive/rest/deployment/pom.xml',
  'docs/src/main/asciidoc/rest.adoc',
  'docs/src/main/asciidoc/getting-started-testing.adoc'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-java-quarkus-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'java-quarkus');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.repository, 'quarkusio/quarkus');
  assert.equal(record.upstream_pin.version, '3.40.1.1');
  assert.equal(record.upstream_pin.tag, '3.40.1.1');
  assert.equal(record.upstream_pin.commit, 'ab576ecfc88f94a2acfe73968fb2e82b116c307e');
  assert.equal(record.upstream_pin.jdk_minimum_from_3_40_guide, '17');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), sourceFiles);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('pom.xml'), /<quarkus\.platform\.version>3\.40\.1\.1<\/quarkus\.platform\.version>/);
  assert.match(fixtureText('pom.xml'), /<maven\.compiler\.release>17<\/maven\.compiler\.release>/);
  assert.match(fixtureText('pom.xml'), /<artifactId>quarkus-rest<\/artifactId>/);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['HTTP-java-quarkus-02', 'HTTP-java-quarkus-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/java-quarkus/adapter.mjs')), false);
}

test('Quarkus target-01 pins REST planning fixtures without runtime or adapter authority', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-class-and-method-jaxrs', 'application-path', 'build-profile', 'runtime-disabled', 'duplicate-endpoint']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText('normal/src/main/java/org/sbf/fixture/UserResource.java'), /@Path\("\/api\/users"\)/);
  assert.match(fixtureText('counterexamples/application-path/src/main/java/org/sbf/fixture/ApiApplication.java'), /@ApplicationPath\("\/v1"\)/);
  assert.match(fixtureText('counterexamples/build-profile/src/main/java/org/sbf/fixture/ProfileOnlyResource.java'), /@IfBuildProfile\("prod"\)/);
  assert.match(fixtureText('counterexamples/runtime-disabled/src/main/java/org/sbf/fixture/ToggleResource.java'), /@EndpointDisabled\(name = "feature\.users", stringValue = "disabled"\)/);
  assert.match(fixtureText('counterexamples/duplicate/src/main/java/org/sbf/fixture/FirstResource.java'), /@Path\("\/duplicate"\)/);
  assert.match(fixtureText('counterexamples/duplicate/src/main/java/org/sbf/fixture/SecondResource.java'), /@Path\("\/duplicate"\)/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('@QuarkusTest')));
  assert.ok(scope.limits.some((s) => s.includes('T05 quarkus-jaxrs-java')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Quarkus target-01 rejects fixture, pin and authority tampering', () => {
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
