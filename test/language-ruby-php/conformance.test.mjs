import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRailsDslFacts, extractLaravelDslFacts } from '../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../scanners/language/ruby-php/dsl-expand.mjs';
import { parseRailsExpandedRoutes, parseLaravelRouteListJson } from '../../scanners/language/ruby-php/runtime-route-snapshot.mjs';
import { DSL_CONFORMANCE_CONTRACT, assertDslConformanceReport, compareDslCandidatesToRuntime } from '../../scanners/language/ruby-php/conformance.mjs';

test('conformance reports exact alignment without inventing a merged identity', () => {
  const source = expandDslFacts(extractRailsDslFacts('resources :widgets, only: [:index, :show]\n'));
  const runtime = parseRailsExpandedRoutes(`--[ Route 1 ]---
Prefix | widgets
Verb | GET
URI | /widgets(.:format)
Controller#Action | widgets#index
--[ Route 2 ]---
Prefix | widget
Verb | GET
URI | /widgets/:id(.:format)
Controller#Action | widgets#show
`);
  const report = compareDslCandidatesToRuntime(source, runtime);
  assert.equal(report.contract, DSL_CONFORMANCE_CONTRACT);
  assertDslConformanceReport(report);
  assert.equal(report.conclusion, 'route-set-aligned');
  assert.equal(report.matched.length, 2);
  assert.equal(report.metrics.conditionalRecall, 1);
  assert.equal(report.metrics.conditionalPrecision, 1);
  assert.ok(report.matched.every((x) => !Object.hasOwn(x, 'operationId')));
});

test('runtime-only dynamic route is a coverage difference, not silently backfilled into static output', () => {
  const source = expandDslFacts(extractLaravelDslFacts("Route::get($path, fn () => null);\n"));
  const runtime = parseLaravelRouteListJson(JSON.stringify([{ method: 'GET|HEAD', uri: 'runtime-only', name: 'runtime', action: 'Closure', middleware: [], domain: null, path: 'routes/web.php:1' }]));
  const report = compareDslCandidatesToRuntime(source, runtime);
  assert.equal(report.conclusion, 'differences-observed');
  assert.equal(report.matched.length, 0);
  assert.equal(report.runtimeOnly.length, 2);
  assert.equal(report.staticUnknowns.length, 1);
  assert.equal(source.candidates.length, 0);
});

test('static-only route remains visible instead of being dropped to make the comparison green', () => {
  const source = expandDslFacts(extractRailsDslFacts('get "/health", to: "health#show"\n'));
  const runtime = parseRailsExpandedRoutes('');
  const report = compareDslCandidatesToRuntime(source, runtime);
  assert.equal(report.conclusion, 'differences-observed');
  assert.equal(report.staticOnly.length, 1);
  assert.equal(report.runtimeOnly.length, 0);
});

test('runtime unknowns force an inconclusive conclusion even if comparable routes align', () => {
  const source = expandDslFacts(extractRailsDslFacts('get "/health", to: "health#show"\n'));
  const runtime = parseRailsExpandedRoutes(`--[ Route 1 ]---
Prefix | health
Verb | GET
URI | /health
Controller#Action | health#show
--[ Route 2 ]---
Prefix | assets
Verb | GET
URI | /assets
Controller#Action | Propshaft::Server
`);
  const report = compareDslCandidatesToRuntime(source, runtime);
  assert.equal(report.matched.length, 1);
  assert.equal(report.runtimeUnknowns.length, 1);
  assert.equal(report.conclusion, 'inconclusive-runtime-unknowns');
});

test('cross-framework runtime snapshots are rejected', () => {
  const source = expandDslFacts(extractRailsDslFacts('get "/health", to: "health#show"\n'));
  const runtime = parseLaravelRouteListJson('[]');
  assert.throws(() => compareDslCandidatesToRuntime(source, runtime), /require a Rails runtime snapshot/);
});
