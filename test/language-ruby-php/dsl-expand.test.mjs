import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRailsDslFacts,
  extractLaravelDslFacts,
  extractSymfonyRouteAttributeFacts,
} from '../../scanners/language/ruby-php/dsl-facts.mjs';
import {
  DSL_ROUTE_CANDIDATES_CONTRACT,
  assertDslRouteCandidates,
  expandDslFacts,
} from '../../scanners/language/ruby-php/dsl-expand.mjs';

function keys(report) {
  return report.candidates.map((x) => `${x.method} ${x.path}`).sort();
}

test('Rails bounded expansion joins literal namespace/scope and expands only selected resource actions', () => {
  const facts = extractRailsDslFacts([
    'Rails.application.routes.draw do',
    '  namespace :api do',
    '    scope path: "v1", module: "v1" do',
    '      resources :people, only: [:index, :show], param: :person_uuid',
    '      get "/health", to: "health#show"',
    '    end',
    '  end',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.equal(expanded.contract, DSL_ROUTE_CANDIDATES_CONTRACT);
  assertDslRouteCandidates(expanded);
  assert.deepEqual(keys(expanded), [
    'GET /api/v1/health',
    'GET /api/v1/people',
    'GET /api/v1/people/{person_uuid}',
  ]);
});

test('Rails update expands to PUT+PATCH but no API operationId is synthesized', () => {
  const expanded = expandDslFacts(extractRailsDslFacts('resources :widgets, only: [:update]\n'));
  assert.deepEqual(keys(expanded), ['PATCH /widgets/{id}', 'PUT /widgets/{id}']);
  assert.ok(expanded.candidates.every((x) => !Object.hasOwn(x, 'operationId')));
});

test('Rails nested resource uses a regular parent nesting key without guessing API identity', () => {
  const facts = extractRailsDslFacts([
    'resources :teams do',
    '  resources :people, only: [:show]',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.ok(expanded.candidates.some((x) => x.method === 'GET' && x.path === '/teams/{team_id}/people/{id}'));
  assert.ok(expanded.candidates.every((x) => !Object.hasOwn(x, 'operationId')));
});

test('Rails nested resource refuses an irregular parent name without an explicit param', () => {
  const facts = extractRailsDslFacts([
    'resources :people do',
    '  resources :comments, only: [:show]',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.ok(expanded.unknowns.some((x) =>
    x.code === 'DSL_CONTEXT_UNRESOLVED' && /people/.test(x.reason),
  ));
  assert.equal(expanded.candidates.some((x) => x.path.includes('/comments/')), false);
});

test('Rails member collection and on modes resolve only the declared resource context', () => {
  const facts = extractRailsDslFacts([
    'resources :articles, only: [:index] do',
    '  member do',
    '    get :preview',
    '  end',
    '  collection do',
    '    get :search',
    '  end',
    '  get :export, on: :member',
    '  collection { post :bulk }',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  const actual = new Set(keys(expanded));
  for (const expected of [
    'GET /articles/{id}/preview',
    'GET /articles/search',
    'GET /articles/{id}/export',
    'POST /articles/bulk',
  ]) assert.ok(actual.has(expected), expected);
});

test('Laravel bounded expansion joins group prefix and expands apiResource selected actions', () => {
  const facts = extractLaravelDslFacts([
    "Route::prefix('api')->middleware('auth')->group(function () {",
    "  Route::get('/users/{id}', [UserController::class, 'show'])->name('users.show');",
    "  Route::apiResource('projects', ProjectController::class)->only(['index', 'show']);",
    '});',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.deepEqual(keys(expanded), [
    'GET /api/projects',
    'GET /api/projects/{project}',
    'GET /api/users/{id}',
  ]);
});

test('Laravel irregular resource parameter is an unknown instead of a fabricated singular', () => {
  const expanded = expandDslFacts(extractLaravelDslFacts("Route::apiResource('people', PersonController::class);\n"));
  assert.equal(expanded.candidates.length, 0);
  assert.equal(expanded.unknowns[0].code, 'DSL_RESOURCE_KEY_UNRESOLVED');
  assert.match(expanded.unknowns[0].reason, /people/);
});

test('dynamic Rails and Laravel paths never reach candidate output', () => {
  const rails = expandDslFacts(extractRailsDslFacts('namespace "#{tenant}" do\n  resources :accounts\nend\n'));
  const laravel = expandDslFacts(extractLaravelDslFacts("Route::get($runtimePath, fn () => null);\n"));
  assert.equal(rails.candidates.length, 0);
  assert.equal(laravel.candidates.length, 0);
  assert.ok(rails.unknowns.length > 0);
  assert.ok(laravel.unknowns.length > 0);
});

test('Symfony class prefix and method path combine only when methods are explicit', () => {
  const facts = extractSymfonyRouteAttributeFacts([
    "#[Route('/api')]",
    'final class UserController',
    '{',
    "  #[Route('/users/{id}', name: 'user_show', methods: ['GET', 'HEAD'])]",
    '  public function show(): Response {}',
    '}',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.deepEqual(keys(expanded), ['GET /api/users/{id}', 'HEAD /api/users/{id}']);
  assert.equal(expanded.candidates[0].declaredName, 'user_show');
});

test('Symfony method attribute without explicit methods is partial, not guessed as GET', () => {
  const facts = extractSymfonyRouteAttributeFacts([
    "#[Route('/api')]",
    'final class UserController',
    '{',
    "  #[Route('/users/{id}', name: 'user_show')]",
    '  public function show(): Response {}',
    '}',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.equal(expanded.candidates.length, 0);
  assert.equal(expanded.unknowns[0].code, 'DSL_ROUTE_PARTIAL');
});
