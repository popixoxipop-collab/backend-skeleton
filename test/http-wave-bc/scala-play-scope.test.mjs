import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// *.SCOPE.json is reserved for the seven cross-track scanner records.
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/http-wave-bc/scope/scala-play.TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'test/http-wave-bc/fixtures/target-scope/play';
const expectedFiles = [
  'project/plugins.sbt',
  'normal/conf/routes',
  'normal/app/controllers/Users.scala',
  'counterexamples/wildcard/conf/routes',
  'counterexamples/regex/conf/routes',
  'counterexamples/modifier/conf/routes',
  'counterexamples/mounted-router/conf/routes'
];
const upstreamSources = [
  'documentation/manual/working/scalaGuide/main/http/ScalaRouting.md',
  'documentation/manual/working/scalaGuide/main/application/ScalaHttpFilters.md',
  'documentation/manual/working/scalaGuide/main/http/ScalaActionsComposition.md',
  'documentation/manual/working/scalaGuide/main/tests/ScalaTestingYourApplication.md',
  'dev-mode/play-routes-compiler/src/main/scala/play/routes/compiler/RoutesFileParser.scala',
  'dev-mode/play-routes-compiler/src/main/scala/play/routes/compiler/RoutesCompiler.scala'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.http-target-scope/1');
  assert.equal(record.task, 'HTTP-scala-play-01');
  assert.equal(record.track, 'T13');
  assert.equal(record.target, 'scala-play');
  assert.equal(record.status, 'scope-only');
  assert.deepEqual(record.claims, {
    adapter_implemented: false,
    static_extraction_verified: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.repository, 'playframework/playframework');
  assert.equal(record.upstream_pin.version, '3.0.12');
  assert.equal(record.upstream_pin.tag, '3.0.12');
  assert.equal(record.upstream_pin.tag_object, '286cee4ef7d3b5a8ab549f5ebbd7adc554bdacc9');
  assert.equal(record.upstream_pin.commit, '316f494b2d1292c250c19685f21189ab077d7229');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), upstreamSources);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.match(record.upstream_pin.version_boundary, /Play 2\.9\.x.*excluded/);
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'normal', 'counterexample', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('project/plugins.sbt'), /sbt-plugin" % "3\.0\.12"/);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['T08 Scala profile review', 'HTTP-scala-play-02', 'HTTP-scala-play-03', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(fs.existsSync(path.join(root, 'adapters/http-wave-bc/scala-play/adapter.mjs')), false);
}

test('Play target-01 pins routes-file scope and negative planning fixtures', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['literal-and-single-segment-routes', 'wildcard-capture', 'regex-constrained-capture', 'route-modifier', 'mounted-router']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText(expectedFiles[1]), /GET\s+\/api\/users\/:id/);
  assert.match(fixtureText(expectedFiles[3]), /\/files\/\*name/);
  assert.match(fixtureText(expectedFiles[4]), /\$id<\[0-9\]\+>/);
  assert.match(fixtureText(expectedFiles[5]), /\+ nocsrf/);
  assert.match(fixtureText(expectedFiles[6]), /->\s+\/api\s+api\.MyRouter/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('FakeRequest')));
  assert.ok(scope.limits.some((s) => s.includes('DEFER_UNTIL_PROFILE_REVIEW')));
  assert.ok(scope.limits.some((s) => s.includes('T08-05 HTTP composition remains BLOCKED')));
});

test('Play target-01 rejects fixture, upstream pin and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[3].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const upstreamTamper = changed();
  upstreamTamper.upstream_pin.commit = '0'.repeat(40);
  assert.throws(() => validate(upstreamTamper));
  const claimTamper = changed();
  claimTamper.claims.runtime_tested = true;
  assert.throws(() => validate(claimTamper));
});
