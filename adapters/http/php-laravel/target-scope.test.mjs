import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LARAVEL_PROFILE, projectLaravelCandidates } from '../../http-wave-a/laravel.mjs';
import { extractLaravelDslFacts } from '../../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../../scanners/language/ruby-php/dsl-expand.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.join(HERE, 'TARGET_SCOPE.md'), 'utf8');
const PIN = JSON.parse(fs.readFileSync(path.join(HERE, 'UPSTREAM_PIN.json'), 'utf8'));
const APP_COMPOSER_REL = 'adapters/http/php-laravel/fixtures/upstream/laravel/composer.json';
const APP_ROUTE_REL = 'adapters/http/php-laravel/fixtures/upstream/laravel/routes/web.php';
const FRAMEWORK_COMPOSER_REL = 'adapters/http/php-laravel/fixtures/framework/laravel-v13.17.0/composer.json';
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const text = (relative) => read(relative).toString('utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const routePairs = (value) => value.routes.map(({ method, path: routePath }) => [method, routePath]);
const candidatePairs = (value) => value.candidates.map(({ method, path: routePath }) => [method, routePath]);
const analyze = (source, file = 'routes/web.php') => expandDslFacts(extractLaravelDslFacts(source, { file }));

test('Laravel scope is a static evidence plan without runtime or release authority', () => {
  assert.match(DOC, /Prerequisite T12-02 is MET/);
  assert.match(DOC, /Scanner-versus-runtime equality is \*\*NOT VERIFIED\*\*/);
  assert.match(DOC, /Passing creates no MET, release, runtime certification/);
  assert.match(DOC, /global release remain BLOCKED/);
});

test('exact application and framework identities close copied bytes with SHA-1 and SHA-256 pins', () => {
  assert.equal(PIN.application.repository, 'laravel/laravel');
  assert.equal(PIN.application.commit, 'aa0cf127fc365a56ee016867144ddffabc2290ae');
  assert.equal(PIN.framework.repository, 'laravel/framework');
  assert.equal(PIN.framework.tag, 'v13.17.0');
  assert.equal(PIN.framework.commit, '0802b7a81f3252d78200b8037ac183a686a529f0');
  assert.deepEqual([
    PIN.application.files['composer.json'].git_blob_sha1,
    PIN.application.files['routes/web.php'].git_blob_sha1,
    PIN.framework.files['composer.json'].git_blob_sha1,
  ], [
    '9b8fbd5d4dcf8535e1342196f5619187bf17bbed',
    '86a06c53eb430eeef17e0fe90f7ba997952a96c6',
    '46e87b55f44f2b92bd544cddd36f644a70ea6733',
  ]);
  assert.equal(sha(read(APP_COMPOSER_REL)), PIN.application.files['composer.json'].sha256);
  assert.equal(sha(read(APP_ROUTE_REL)), PIN.application.files['routes/web.php'].sha256);
  assert.equal(sha(read(FRAMEWORK_COMPOSER_REL)), PIN.framework.files['composer.json'].sha256);
});

test('the exact upstream route deterministically yields one T07 candidate and one T12 route', () => {
  const source = text(APP_ROUTE_REL);
  const one = analyze(source);
  const two = analyze(source);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.deepEqual(candidatePairs(one), [['GET', '/']]);
  assert.deepEqual(one.unknowns, []);
  const leaf = projectLaravelCandidates(one);
  assert.deepEqual(routePairs(leaf), [['GET', '/']]);
  assert.deepEqual(leaf.unknowns, []);
  assert.equal(leaf.evidence.runtimeValidated, false);
  assert.ok(leaf.routes.every((route) => route.handler === null && !Object.hasOwn(route, 'operationId')));
});

test('literal group prefixes and bounded apiResource actions compose without guessing', () => {
  const source = [
    '<?php',
    "Route::prefix('api')->middleware('auth')->group(function () {",
    "  Route::get('/users/{id}', [UserController::class, 'show']);",
    "  Route::apiResource('projects', ProjectController::class)->only(['index', 'show']);",
    '});',
    '',
  ].join('\n');
  const result = projectLaravelCandidates(analyze(source));
  assert.deepEqual(routePairs(result), [
    ['GET', '/api/projects'],
    ['GET', '/api/projects/{project}'],
    ['GET', '/api/users/{id}'],
  ]);
  assert.deepEqual(result.unknowns, []);
});

test('application range and exact framework-source boundary remain distinct and truthful', () => {
  const app = JSON.parse(text(APP_COMPOSER_REL));
  const framework = JSON.parse(text(FRAMEWORK_COMPOSER_REL));
  assert.equal(app.require.php, '^8.3');
  assert.equal(app.require['laravel/framework'], '^13.17');
  assert.equal(framework.name, 'laravel/framework');
  assert.equal(framework.require.php, '^8.3');
  assert.equal(LARAVEL_PROFILE.versionPin.ref, PIN.application.commit);
  assert.equal(LARAVEL_PROFILE.versionPin.framework, null);
  assert.equal(LARAVEL_PROFILE.versionPin.declaredRange, '^13.17');
  assert.match(DOC, /compatibility declaration, not an installed version/);
});

test('candidate leaf remains unregistered, non-default, non-runtime-tested, and outside T19 review', () => {
  const leaf = projectLaravelCandidates(analyze(text(APP_ROUTE_REL)));
  assert.equal(leaf.status, 'candidate');
  assert.equal(leaf.registration, 'unregistered');
  assert.equal(leaf.productionDefault, false);
  assert.equal(LARAVEL_PROFILE.runtimeTested, false);
  assert.equal(LARAVEL_PROFILE.t19Review, 'NOT_REVIEWED');
  assert.equal(PIN.runtime_executed, false);
  assert.equal(PIN.external_runtime_equal, false);
});

test('historical baseline markers remain explicit non-certifying records', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/http-wave-a/BASELINE.json'), 'utf8'));
  const profile = baseline.profiles.find((row) => row.id === 'php-laravel');
  const fixture = baseline.fixtures.find((row) => row.id === 'laravel-routes-upstream');
  assert.equal(profile.framework_version.status, 'UNKNOWN');
  assert.equal(profile.real_repo_comparison.kind, 'history-needs-leaf-rerun');
  assert.equal(fixture.input_kind, 'upstream-real');
  assert.match(fixture.origin, /inline routes file/);
  assert.ok(baseline.limits.some((row) => row.statement.includes('not a comparison against a real third-party repository')));
  assert.match(DOC, /historical record text, not a current runtime pass/);
});

test('ownership and nested-suite inputs retain the Laravel target in T12 only', () => {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'next/t00/fixtures/plan-write-scopes.json'), 'utf8'));
  const row = plan.tasks.find((task) => task.id === 'HTTP-php-laravel-01');
  assert.deepEqual(row, {
    id: 'HTTP-php-laravel-01', track: 'T12', repository: 'bskel',
    write_scope: ['adapters/http/php-laravel/**'],
  });
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'next/t00/baseline.lock.json'), 'utf8'));
  assert.equal(lock.schema, 'bskel.t00-baseline-lock/1');
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/run-next-nested-tests.mjs'), 'utf8');
  assert.match(runner, /id: 'T12', sourcePaths: \['adapters\/http-wave-a'\], testDir: 'test\/http-wave-a'/);
});
