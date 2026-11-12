import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DSL_FACTS_CONTRACT,
  assertDslFactsEnvelope,
  extractDslFacts,
  extractRailsDslFacts,
  extractLaravelDslFacts,
  extractSymfonyRouteAttributeFacts,
} from '../../scanners/language/ruby-php/dsl-facts.mjs';

const RAILS = [
  'Rails.application.routes.draw do',
  '  namespace :api do',
  '    scope path: "v1", module: "v1" do',
  '      resources :people, only: [:index, :show], param: :person_uuid',
  '      get "/health", to: "health#show"',
  '      concerns :commentable',
  '    end',
  '  end',
  '',
  '  namespace "#{tenant}" do',
  '    resources :accounts',
  '  end',
  '',
  '  %i[admin moderator].each do |role|',
  '    scope role do',
  '      resources :audits',
  '    end',
  '  end',
  'end',
  '',
].join('\n');

const LARAVEL = [
  '<?php',
  'use Illuminate\\Support\\Facades\\Route;',
  '',
  "Route::prefix('api')->middleware('auth:sanctum')->group(function () {",
  "    Route::get('/users/{id}', [UserController::class, 'show'])->name('users.show');",
  "    Route::apiResource('projects', ProjectController::class)->only(['index', 'show']);",
  '});',
  '',
  "Route::get($runtimePath, [DebugController::class, 'show']);",
  "Route::macro('tenantResource', function ($name, $controller) {});",
  '',
].join('\n');

const SYMFONY = [
  '<?php',
  'namespace App\\Controller;',
  'use Symfony\\Component\\Routing\\Attribute\\Route;',
  '',
  "#[Route('/api/users/{id}', name: 'user_show', methods: ['GET'])]",
  'final class UserController',
  '{',
  "    #[Route('/details', name: 'user_details', methods: ['GET', 'HEAD'])]",
  '    public function details(): Response {}',
  '}',
  '',
].join('\n');

function byKind(report, kind) {
  return report.facts.filter((fact) => fact.kind === kind);
}

test('Rails: literal namespace/scope/resource/route declarations preserve source provenance', () => {
  const report = extractRailsDslFacts(RAILS);
  assert.equal(report.contract, DSL_FACTS_CONTRACT);
  assert.equal(report.framework, 'rails');
  assert.equal(report.language, 'ruby');
  assertDslFactsEnvelope(report);

  const people = byKind(report, 'resource').find((fact) => fact.declaration.name === 'people');
  assert.ok(people);
  assert.equal(people.status, 'literal');
  assert.deepEqual(people.attributes.only, ['index', 'show']);
  assert.equal(people.attributes.param, 'person_uuid');
  assert.deepEqual(people.context.map((entry) => entry.kind), ['namespace', 'scope']);
  assert.deepEqual(people.context.map((entry) => entry.name), ['api', 'v1']);
  assert.equal(people.source.file, 'config/routes.rb');
  assert.ok(people.source.start < people.source.end);
  assert.match(people.source.sha256, /^[0-9a-f]{64}$/);

  const health = byKind(report, 'route').find((fact) => fact.attributes.path === '/health');
  assert.equal(health.attributes.method, 'GET');
  assert.equal(health.attributes.controller, 'health');
  assert.equal(health.attributes.action, 'show');
});

test('Rails: literal concern use is preserved while computed namespace and loops stay unknown', () => {
  const report = extractRailsDslFacts(RAILS);

  const concern = byKind(report, 'concern')[0];
  assert.equal(concern.status, 'literal');
  assert.equal(concern.attributes.declaration, 'concerns');
  assert.deepEqual(concern.attributes.names, ['commentable']);

  const dynamicNamespace = byKind(report, 'namespace').find((fact) => fact.status === 'unknown');
  assert.ok(dynamicNamespace);
  assert.match(dynamicNamespace.unknownReason, /not a literal/);

  const dynamicBlock = byKind(report, 'dynamic-block')[0];
  assert.ok(dynamicBlock);
  assert.equal(dynamicBlock.status, 'unknown');
  assert.match(dynamicBlock.unknownReason, /runtime-dependent/);

  const audits = byKind(report, 'resource').find((fact) => fact.declaration.name === 'audits');
  assert.equal(audits.status, 'unknown');
});

test('Rails: irregular resource names are preserved and not singularized by this fact layer', () => {
  const report = extractRailsDslFacts('Rails.application.routes.draw do\n  resources :people\nend\n');
  const resource = byKind(report, 'resource')[0];
  assert.equal(resource.declaration.name, 'people');
  assert.equal(resource.status, 'literal');
  assert.equal(Object.hasOwn(resource.attributes, 'singularizedName'), false);
});

test('Laravel: literal group metadata and resource declarations retain context', () => {
  const report = extractLaravelDslFacts(LARAVEL);
  assertDslFactsEnvelope(report);

  const group = byKind(report, 'group')[0];
  assert.equal(group.attributes.prefix, 'api');
  assert.deepEqual(group.attributes.middleware, ['auth:sanctum']);

  const route = byKind(report, 'route').find((fact) => fact.attributes.path === '/users/{id}');
  assert.ok(route);
  assert.deepEqual(route.attributes.methods, ['GET']);
  assert.equal(route.attributes.routeName, 'users.show');
  assert.equal(route.context[0].prefix, 'api');

  const resource = byKind(report, 'resource').find((fact) => fact.declaration.name === 'projects');
  assert.equal(resource.attributes.apiOnly, true);
  assert.deepEqual(resource.attributes.only, ['index', 'show']);
});

test('Laravel: variable URI and Route::macro are explicit unknowns', () => {
  const report = extractLaravelDslFacts(LARAVEL);

  const variableRoute = byKind(report, 'route').find((fact) => fact.status === 'unknown');
  assert.ok(variableRoute);
  assert.match(variableRoute.unknownReason, /URI/);

  const macro = byKind(report, 'unsupported').find((fact) => fact.declaration.name === 'macro');
  assert.ok(macro);
  assert.equal(macro.status, 'unknown');
  assert.match(macro.unknownReason, /runtime/);
});

test('Laravel: non-literal group prefixes taint descendants instead of stripping the prefix', () => {
  const report = extractLaravelDslFacts([
    "Route::prefix(config('app.api_prefix'))->group(function () {",
    "  Route::get('/from-config', fn () => null);",
    '});',
    'Route::prefix(API_PREFIX)->group(function () {',
    "  Route::get('/from-constant', fn () => null);",
    '});',
    "Route::group(['prefix' => config('app.api_prefix')], function () {",
    "  Route::get('/from-array', fn () => null);",
    '});',
    "Route::prefix('api' . '/v1')->group(function () {",
    "  Route::get('/from-concatenation', fn () => null);",
    '});',
    "Route::group(['prefix' => 'api' . '/v1'], function () {",
    "  Route::get('/from-array-concatenation', fn () => null);",
    '});',
    "Route::middleware('auth')->group(function () {",
    "  Route::get('/middleware-only', fn () => null);",
    '});',
    '',
  ].join('\n'));

  const groups = byKind(report, 'group');
  assert.deepEqual(groups.map((fact) => fact.status), [
    'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'literal',
  ]);
  assert.ok(groups.slice(0, 5).every((fact) => fact.attributes.dynamic));
  const routes = byKind(report, 'route');
  assert.deepEqual(routes.map((fact) => fact.status), [
    'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'literal',
  ]);
  assert.equal(routes.at(-1).attributes.path, '/middleware-only');
});

test('Laravel: Route::match binds a finite literal method list to its second URI argument', () => {
  const report = extractLaravelDslFacts([
    "Route::match(['GET', 'POST'], '/matched', fn () => null)->name('matched');",
    "Route::match(['get', 'post'], '/lower', fn () => null);",
    "Route::match($methods, '/dynamic-methods', fn () => 'GET');",
    "Route::match(['GET', $method], '/mixed-methods', fn () => null);",
    "Route::match([], '/empty-methods', fn () => null);",
    "Route::match(['GET', 'CONNECT'], '/unsupported-method', fn () => null);",
    "Route::match(['GET'], config('route.uri'), fn () => null);",
    "Route::match(['GET', 'GET'], '/deduplicated', fn () => null);",
    "Route::match(['GET'], \"/users/$id\", fn () => null);",
    "Route::get(\"/rock'n\", fn () => null);",
    '',
  ].join('\n'));
  const routes = byKind(report, 'route');

  assert.deepEqual(routes[0].attributes, {
    methods: ['GET', 'POST'], path: '/matched', routeName: 'matched',
  });
  assert.deepEqual(routes[1].attributes.methods, ['GET', 'POST']);
  assert.equal(routes[1].attributes.path, '/lower');
  assert.ok(routes.slice(2, 7).every((fact) => fact.status === 'unknown'));
  assert.ok(routes.slice(2, 6).every((fact) => /method/.test(fact.unknownReason)));
  assert.match(routes[6].unknownReason, /URI/);
  assert.deepEqual(routes[7].attributes.methods, ['GET']);
  assert.equal(routes[7].status, 'literal');
  assert.equal(routes[8].status, 'unknown');
  assert.match(routes[8].unknownReason, /URI/);
  assert.equal(routes[9].attributes.path, "/rock'n");
  assert.equal(routes[9].status, 'literal');
});

test('Laravel: bounded multiline group chains preserve or taint their enclosing context', () => {
  const report = extractLaravelDslFacts([
    "Route::prefix('api')",
    "  ->middleware('auth')",
    '  ->group(function () {',
    "    Route::get('/literal', fn () => null);",
    '  });',
    'Route::group(',
    "  ['prefix' => config('app.api_prefix')],",
    '  function () {',
    "    Route::get('/dynamic', fn () => null);",
    '  });',
    "Route::prefix('v2')->group(",
    '  function () {',
    "    Route::get('/split-callback', fn () => null);",
    '  });',
    "Route::prefix('{tenant}')",
    "  ->middleware('auth')",
    '  ->group(function () {',
    "    Route::get('/parameterized-prefix', fn () => null);",
    '  });',
    'Route::group([',
    "  'prefix' => config('app.other_prefix'),",
    '], function () {',
    "  Route::get('/split-array', fn () => null);",
    '});',
    "Route::get('/outside', fn () => null);",
    '',
  ].join('\n'));
  const groups = byKind(report, 'group');
  const routes = byKind(report, 'route');

  assert.deepEqual(groups.map((fact) => fact.status), [
    'literal', 'unknown', 'literal', 'literal', 'unknown',
  ]);
  assert.deepEqual(routes.map((fact) => fact.status), [
    'literal', 'unknown', 'literal', 'literal', 'unknown', 'literal',
  ]);
  assert.equal(routes[0].context[0].prefix, 'api');
  assert.equal(routes[1].context[0].dynamic, true);
  assert.equal(routes[2].context[0].prefix, 'v2');
  assert.equal(routes[3].context[0].prefix, '{tenant}');
  assert.equal(routes[4].context[0].dynamic, true);
  assert.deepEqual(routes[5].context, []);
});

test('Laravel: route handler closure endings do not pop the enclosing route group', () => {
  const report = extractLaravelDslFacts([
    "Route::prefix('api')->group(function () {",
    "  Route::get('/first', function () {",
    "    return 'first';",
    '  });',
    "  Route::prefix('v1')->group(function () {",
    "    Route::get('/nested', function () {",
    "      return 'nested';",
    '    });',
    '  });',
    "  Route::get('/second', fn () => 'second');",
    '});',
    '',
  ].join('\n'));
  const routes = byKind(report, 'route');

  assert.deepEqual(routes.map((fact) => fact.context.map((entry) => entry.prefix)), [
    ['api'], ['api', 'v1'], ['api'],
  ]);
});

test('Symfony: Route attributes retain path, methods, name and the nearest declaration target', () => {
  const report = extractSymfonyRouteAttributeFacts(SYMFONY);
  assertDslFactsEnvelope(report);
  assert.equal(report.facts.length, 2);

  assert.deepEqual(report.facts[0].attributes.methods, ['GET']);
  assert.equal(report.facts[0].attributes.path, '/api/users/{id}');
  assert.equal(report.facts[0].attributes.routeName, 'user_show');
  assert.equal(report.facts[0].attributes.targetKind, 'class');
  assert.equal(report.facts[0].attributes.targetName, 'UserController');

  assert.equal(report.facts[1].attributes.targetKind, 'method');
  assert.equal(report.facts[1].attributes.targetName, 'details');

  for (const fact of report.facts) {
    assert.equal(Object.hasOwn(fact, 'operationId'), false);
    assert.equal(Object.hasOwn(fact.attributes, 'operationId'), false);
  }
});

test('fact ids and source hashes are deterministic for identical source bytes and file', () => {
  const a = extractRailsDslFacts(RAILS, { file: 'config/routes.rb' });
  const b = extractRailsDslFacts(RAILS, { file: 'config/routes.rb' });
  assert.deepEqual(a, b);
});

test('the fact id is source-bound rather than a semantic API operation identity', () => {
  const a = extractRailsDslFacts('resources :people\n');
  const b = extractRailsDslFacts('\nresources :people\n');
  assert.notEqual(a.facts[0].id, b.facts[0].id);
});

test('dispatcher rejects unsupported frameworks and source paths that escape the repo', () => {
  assert.throws(
    () => extractDslFacts({ framework: 'unknown', source: '', file: 'x' }),
    /unsupported/,
  );
  assert.throws(
    () => extractRailsDslFacts('resources :people', { file: '../routes.rb' }),
    /repository root/,
  );
  assert.throws(
    () => extractLaravelDslFacts("Route::get('/x', fn () => 1);", { file: '/tmp/api.php' }),
    /repository-relative/,
  );
});

test('the envelope validator rejects an operationId claim in a DSL fact', () => {
  const report = extractRailsDslFacts('get "/health", to: "health#show"\n');
  report.facts[0].attributes.operationId = 'health';
  assert.throws(
    () => assertDslFactsEnvelope(report),
    /must not claim an API operationId/,
  );
});
