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
