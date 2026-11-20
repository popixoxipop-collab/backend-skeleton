// Source-only DSL checks against the disposable installed package, with no target runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, slot] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(slot));
const modulePath = name => path.join(root, 'scanners/language/ruby-php', name);
const members = ['_route-candidates.mjs', 'conformance.mjs', 'corpus.mjs',
  'dsl-expand.mjs', 'dsl-facts.mjs', 'expand-laravel.mjs',
  'expand-rails.mjs', 'expand-symfony.mjs', 'model-facts.mjs',
  'runtime-route-snapshot.mjs'];
if (slot === 'previous') {
  for (const name of members) assert.equal(fs.existsSync(modulePath(name)), false, name);
  console.log(JSON.stringify({ expected: slot, vectors: 1, runtime_certified: false,
    release_authorized: false }));
} else {
  for (const name of members) assert.equal(fs.existsSync(modulePath(name)), true, name);
  const load = async name => import(pathToFileURL(modulePath(name)).href);
  const factsModule = await load('dsl-facts.mjs');
  const { expandDslFacts, assertDslRouteCandidates } = await load('dsl-expand.mjs');
  const models = await load('model-facts.mjs');
  const { extractRailsDslFacts, extractLaravelDslFacts,
    extractSymfonyRouteAttributeFacts, assertDslFactsEnvelope } = factsModule;
  const keys = report => report.candidates.map(x => `${x.method} ${x.path}`).sort();

  const rails = extractRailsDslFacts('Rails.application.routes.draw do\n namespace :api do\n  get "/health", to: "health#show"\n end\nend\n');
  assertDslFactsEnvelope(rails);
  const railsRoutes = expandDslFacts(rails);
  assertDslRouteCandidates(railsRoutes);
  assert.deepEqual(keys(railsRoutes), ['GET /api/health']);
  assert.ok(railsRoutes.candidates.every(x => !Object.hasOwn(x, 'operationId')));

  const railsDynamic = expandDslFacts(extractRailsDslFacts('namespace "#{tenant}" do\n resources :accounts\nend\n'));
  assert.equal(railsDynamic.candidates.length, 0);
  assert.ok(railsDynamic.unknowns.length > 0);

  const laravel = expandDslFacts(extractLaravelDslFacts("Route::prefix('api')->group(function () {\n Route::get('/users/{id}', fn () => null);\n});\n"));
  assert.deepEqual(keys(laravel), ['GET /api/users/{id}']);
  assert.ok(laravel.candidates.every(x => !Object.hasOwn(x, 'operationId')));

  const laravelDynamic = expandDslFacts(extractLaravelDslFacts("Route::prefix(config('app.api_prefix'))->group(function () {\n Route::get('/hidden', fn () => null);\n});\nRoute::get('/outside', fn () => null);\n"));
  assert.deepEqual(keys(laravelDynamic), ['GET /outside']);
  assert.ok(laravelDynamic.unknowns.some(x => x.code === 'DSL_DYNAMIC_DECLARATION'));

  const symfony = extractSymfonyRouteAttributeFacts("#[Route('/api')]\nfinal class UserController {\n #[Route('/users/{id}', methods: ['GET', 'HEAD'])]\n public function show(): Response {}\n}\n");
  assertDslFactsEnvelope(symfony);
  const symfonyRoutes = expandDslFacts(symfony);
  assert.deepEqual(keys(symfonyRoutes), ['GET /api/users/{id}', 'HEAD /api/users/{id}']);

  const symfonyPartial = expandDslFacts(extractSymfonyRouteAttributeFacts("#[Route('/api')]\nfinal class UserController {\n #[Route('/users/{id}') ]\n public function show(): Response {}\n}\n"));
  assert.equal(symfonyPartial.candidates.length, 0);
  assert.ok(symfonyPartial.unknowns.some(x => x.code === 'DSL_ROUTE_PARTIAL'));

  const activeRecord = models.extractActiveRecordModelFacts('class Article < ApplicationRecord\n self.table_name = "published_articles"\n self.primary_key = "article_uid"\nend\n');
  models.assertModelFactsEnvelope(activeRecord);
  assert.equal(activeRecord.models[0].table.value, 'published_articles');
  assert.equal(activeRecord.models[0].primaryKey.value, 'article_uid');

  const eloquent = models.extractEloquentModelFacts('<?php\nclass User extends Model {\n}\n');
  models.assertModelFactsEnvelope(eloquent);
  assert.equal(eloquent.models[0].table, null);
  assert.equal(eloquent.models[0].primaryKey, null);
  assert.deepEqual(eloquent.unknowns.map(x => x.code).sort(),
    ['MODEL_PRIMARY_KEY_IMPLICIT', 'MODEL_TABLE_IMPLICIT']);

  if (process.env.T07_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
  console.log(JSON.stringify({ expected: slot, vectors: 8,
    frameworks: ['rails', 'laravel', 'symfony'], runtime_certified: false,
    release_authorized: false }));
}
