import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLaravelDslFacts } from '../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../scanners/language/ruby-php/dsl-expand.mjs';

test('Laravel empty URI is a literal group root, not a dynamic path', () => {
  const facts = extractLaravelDslFacts([
    "Route::prefix('vaults')->group(function () {",
    "  Route::get('', [VaultController::class, 'index'])->name('vault.index');",
    '});',
    '',
  ].join('\n'));
  const route = facts.facts.find((fact) => fact.kind === 'route');
  assert.equal(route.status, 'literal');
  assert.equal(route.attributes.path, '');

  const expanded = expandDslFacts(facts);
  assert.deepEqual(
    expanded.candidates.map((candidate) => `${candidate.method} ${candidate.path}`),
    ['GET /vaults'],
  );
  assert.equal(expanded.unknowns.length, 0);
});
