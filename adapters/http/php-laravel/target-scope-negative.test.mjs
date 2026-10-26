import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LARAVEL_PROFILE, projectLaravelCandidates } from '../../http-wave-a/laravel.mjs';
import { extractLaravelDslFacts } from '../../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../../scanners/language/ruby-php/dsl-expand.mjs';
import { parseLaravelRouteListJson } from '../../../scanners/language/ruby-php/runtime-route-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.join(HERE, 'TARGET_SCOPE.md'), 'utf8');
const PIN = JSON.parse(fs.readFileSync(path.join(HERE, 'UPSTREAM_PIN.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const analyze = (source) => expandDslFacts(extractLaravelDslFacts(source, { file: 'routes/web.php' }));
const leaf = (source) => projectLaravelCandidates(analyze(source));

function guard(text) {
  const required = [
    'static source', 'aa0cf127fc365a56ee016867144ddffabc2290ae',
    'v13.17.0', '0802b7a81f3252d78200b8037ac183a686a529f0',
    'NOT VERIFIED', 'historical-pass-needs-leaf-rerun', 'T00 one-row CAS',
  ];
  const forbidden = [
    /all Laravel versions/, /runtime route equality verified/, /production certified/,
    /(?:is|as) a registered scanner adapter/,
  ];
  return [
    ...required.filter((value) => !text.includes(value)),
    ...forbidden.filter((pattern) => pattern.test(text)).map(String),
  ];
}

test('scope guard rejects missing source pins and false runtime or registry claims', () => {
  assert.deepEqual(guard(DOC), []);
  assert.ok(guard(DOC.replaceAll('NOT VERIFIED', 'PASSED')).length);
  assert.ok(guard(DOC + '\nall Laravel versions').length);
});

test('dynamic route and group inputs become unknowns instead of guessed routes', () => {
  const result = leaf([
    '<?php',
    'Route::get($runtimePath, fn () => null);',
    'Route::prefix($tenant)->group(function () {',
    "  Route::post('/inside', fn () => null);",
    '});',
    '',
  ].join('\n'));
  assert.deepEqual(result.routes, []);
  assert.deepEqual(result.unknowns.map((item) => item.code), [
    'T07_DSL_DYNAMIC_DECLARATION', 'T07_DSL_DYNAMIC_DECLARATION',
  ]);
});

test('Route::any and null paths stay unknown while independent literal routes survive', () => {
  const expanded = analyze([
    '<?php',
    "Route::get('/ok', fn () => null);",
    "Route::any('/wild', fn () => null);",
    '',
  ].join('\n'));
  expanded.candidates.push({
    id: 'partial', framework: 'laravel', method: 'POST', path: null,
    sourceFactId: 'hand-fed', source: null, provenance: 'partial',
  });
  const result = projectLaravelCandidates(expanded);
  assert.deepEqual(result.routes.map(({ method, path: routePath }) => [method, routePath]), [['GET', '/ok']]);
  assert.deepEqual(result.unknowns.map((item) => item.code), [
    'ROUTE_METHOD_WILDCARD_UNRESOLVED', 'ROUTE_PATH_UNKNOWN',
  ]);
});

test('irregular resource keys and unsupported actions remain explicit unknown evidence', () => {
  const irregular = leaf("<?php\nRoute::apiResource('people', PersonController::class);\n");
  assert.deepEqual(irregular.routes, []);
  assert.deepEqual(irregular.unknowns.map((item) => item.code), ['T07_DSL_RESOURCE_KEY_UNRESOLVED']);
  const unsupported = leaf("<?php\nRoute::apiResource('projects', ProjectController::class)->only(['index', 'publish']);\n");
  assert.deepEqual(unsupported.routes.map((route) => route.path), ['/projects']);
  assert.deepEqual(unsupported.unknowns.map((item) => item.code), ['T07_DSL_RESOURCE_ACTION_UNSUPPORTED']);
});

test('comments, strings, unsupported calls, and non-Route receivers cannot create routes', () => {
  const source = [
    '<?php',
    "// Route::get('/comment', fn () => null);",
    "$text = \"Route::post('/string', fn () => null);\";",
    "Router::get('/foreign', fn () => null);",
    "Route::view('/view', 'welcome');",
    "Route::get('/real', fn () => null);",
    '',
  ].join('\n');
  assert.deepEqual(leaf(source).routes.map((route) => route.path), ['/real']);
});

test('wrong envelope identity throws and runtime parser bytes do not create runtime authority', () => {
  assert.throws(
    () => projectLaravelCandidates({ contract: 'sbf.dsl-route-candidates/1', framework: 'rails' }),
    /framework=laravel/,
  );
  assert.throws(
    () => projectLaravelCandidates({ contract: 'wrong/1', framework: 'laravel' }),
    /requires T07/,
  );
  const parsed = parseLaravelRouteListJson(JSON.stringify([
    { method: 'GET|HEAD', uri: '/', name: 'home', action: 'Closure', middleware: [] },
  ]));
  assert.deepEqual(parsed.routes.map(({ method, path: routePath }) => [method, routePath]), [['GET', '/'], ['HEAD', '/']]);
  assert.equal(PIN.runtime_executed, false);
  assert.match(DOC, /No PHP process, Composer install/);
});

test('baseline inline fixture and history marker cannot become a current runtime pass', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/http-wave-a/BASELINE.json'), 'utf8'));
  const fixture = baseline.fixtures.find((row) => row.id === 'laravel-routes-upstream');
  assert.match(fixture.origin, /inline routes file/);
  assert.equal(LARAVEL_PROFILE.realRepoComparison, 'historical-pass-needs-leaf-rerun');
  assert.equal(LARAVEL_PROFILE.runtimeTested, false);
  assert.match(DOC, /not a current runtime pass/);
});

test('upstream byte or manifest tampering cannot preserve the declared source digest', () => {
  const route = fs.readFileSync(path.join(HERE, 'fixtures/upstream/laravel/routes/web.php'));
  const framework = fs.readFileSync(path.join(HERE, 'fixtures/framework/laravel-v13.17.0/composer.json'));
  assert.equal(sha(route), PIN.application.files['routes/web.php'].sha256);
  assert.equal(sha(framework), PIN.framework.files['composer.json'].sha256);
  assert.notEqual(sha(Buffer.concat([route, Buffer.from('// forged\n')])), PIN.application.files['routes/web.php'].sha256);
  assert.notEqual({ ...PIN.framework, commit: '0'.repeat(40) }.commit, PIN.framework.commit);
});
