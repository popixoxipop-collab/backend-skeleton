import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRailsDslFacts } from '../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../scanners/language/ruby-php/dsl-expand.mjs';

test('Rails scope path:nil is a static no-prefix scope', () => {
  const facts = extractRailsDslFacts([
    'scope path: nil, constraints: { format: :json } do',
    '  get "/health", to: "health#show"',
    'end',
    '',
  ].join('\n'));
  const scope = facts.facts.find((fact) => fact.kind === 'scope');
  assert.equal(scope.status, 'literal');
  assert.equal(scope.attributes.path, null);
  assert.equal(scope.attributes.pathExplicitNil, true);
  const expanded = expandDslFacts(facts);
  assert.deepEqual(expanded.candidates.map((x) => `${x.method} ${x.path}`), ['GET /health']);
});

test('Rails parenthesized scope literal and colon params normalize for runtime comparison', () => {
  const facts = extractRailsDslFacts([
    'scope("/users/:id") do',
    '  put "/:role", to: "user_roles#update"',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.deepEqual(expanded.candidates.map((x) => `${x.method} ${x.path}`), ['PUT /users/{id}/{role}']);
});

test('Rails empty URI is a literal namespace root', () => {
  const facts = extractRailsDslFacts([
    'namespace :admin do',
    '  get "", to: "admin#index"',
    'end',
    '',
  ].join('\n'));
  const route = facts.facts.find((fact) => fact.kind === 'route');
  assert.equal(route.status, 'literal');
  assert.equal(route.attributes.path, '');
  const expanded = expandDslFacts(facts);
  assert.deepEqual(expanded.candidates.map((x) => `${x.method} ${x.path}`), ['GET /admin']);
});


test('Rails resources inside collection mode use the parent collection path', () => {
  const facts = extractRailsDslFacts([
    'resources :users, only: [:index] do',
    '  collection do',
    '    resources :devices, only: [:create, :destroy]',
    '  end',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  const routes = new Set(expanded.candidates.map((x) => `${x.method} ${x.path}`));
  assert.ok(routes.has('POST /users/devices'));
  assert.ok(routes.has('DELETE /users/devices/{id}'));
  assert.equal(expanded.unknowns.length, 0);
});

test('Rails postfix runtime condition remains an explicit dynamic unknown', () => {
  const facts = extractRailsDslFacts([
    'resources :session, only: [:create] do',
    '  get "become" if !Rails.env.production?',
    'end',
    '',
  ].join('\n'));
  const route = facts.facts.find((fact) => fact.kind === 'route');
  assert.equal(route.status, 'unknown');
  assert.match(route.unknownReason, /runtime Ruby condition/);
  const expanded = expandDslFacts(facts);
  assert.equal(expanded.candidates.some((x) => x.path.includes('become')), false);
  assert.ok(expanded.unknowns.some((x) => x.code === 'DSL_DYNAMIC_DECLARATION'));
});


test('Rails nested resource custom param uses resource-prefixed parent key', () => {
  const facts = extractRailsDslFacts([
    'resources :profiles, param: :username do',
    '  resources :messages, only: [:show]',
    'end',
    '',
  ].join('\n'));
  const expanded = expandDslFacts(facts);
  assert.ok(expanded.candidates.some((x) =>
    x.method === 'GET' && x.path === '/profiles/{profile_username}/messages/{id}',
  ));
});
