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

test('Rails: concern, computed namespace, and loop-driven scopes stay explicit unknowns', () => {
  const report = extractRailsDslFacts(RAILS);

  const concern = byKind(report, 'concern')[0];
  assert.equal(concern.status, 'unknown');
  assert.match(concern.unknownReason, /separate declaration\/use-site resolution/);

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
