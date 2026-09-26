import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_ROUTE_SNAPSHOT_CONTRACT,
  assertRuntimeRouteSnapshot,
  parseRailsExpandedRoutes,
  parseLaravelRouteListJson,
  parseSymfonyRouterJson,
} from '../../scanners/language/ruby-php/runtime-route-snapshot.mjs';

test('Rails expanded route table becomes a source-hashed normalized snapshot', () => {
  const raw = `--[ Route 1 ]-----------------------------
Prefix            | users
Verb              | GET
URI               | /users/:id(.:format)
Controller#Action | users#show
Source Location   | /app/config/routes.rb:2
--[ Route 2 ]-----------------------------
Prefix            | users
Verb              | POST
URI               | /users(.:format)
Controller#Action | users#create
Source Location   | /app/config/routes.rb:3
`;
  const snap = parseRailsExpandedRoutes(raw);
  assert.equal(snap.contract, RUNTIME_ROUTE_SNAPSHOT_CONTRACT);
  assertRuntimeRouteSnapshot(snap);
  assert.deepEqual(snap.routes.map((x) => `${x.method} ${x.path}`), ['POST /users', 'GET /users/{id}']);
  assert.equal(snap.routes.find((x) => x.method === 'GET').action, 'show');
});

test('Rails framework/internal target stays unknown rather than fabricating a controller action', () => {
  const raw = `--[ Route 1 ]---
Prefix            | assets
Verb              | GET
URI               | /assets
Controller#Action | Propshaft::Server
Source Location   | propshaft/lib/x.rb:1
`;
  const snap = parseRailsExpandedRoutes(raw);
  assert.equal(snap.routes.length, 0);
  assert.equal(snap.unknowns[0].code, 'RUNTIME_ROUTE_TARGET_UNRESOLVED');
});

test('Laravel route:list JSON preserves methods, middleware and controller action', () => {
  const raw = JSON.stringify([{ domain: null, method: 'GET|HEAD', uri: 'api/users/{user}', name: 'users.show', action: 'App\\Http\\Controllers\\UserController@show', middleware: ['api', 'auth:sanctum'], path: 'routes/api.php:12' }]);
  const snap = parseLaravelRouteListJson(raw);
  assertRuntimeRouteSnapshot(snap);
  assert.deepEqual(snap.routes.map((x) => `${x.method} ${x.path}`), ['GET /api/users/{user}', 'HEAD /api/users/{user}']);
  assert.deepEqual(snap.routes[0].middleware, ['api', 'auth:sanctum']);
});

test('Laravel malformed rows stay explicit unknowns and invalid JSON is rejected', () => {
  const snap = parseLaravelRouteListJson(JSON.stringify([{ uri: 'x' }, null]));
  assert.equal(snap.routes.length, 0);
  assert.deepEqual(snap.unknowns.map((x) => x.code), ['RUNTIME_ROUTE_INCOMPLETE', 'RUNTIME_ROUTE_INVALID_ROW']);
  assert.throws(() => parseLaravelRouteListJson('{'), /not valid JSON/);
});

test('Symfony JSON keeps explicit method set and refuses ANY as a finite candidate set', () => {
  const raw = JSON.stringify({
    user_show: { path: '/users/{id}', host: 'ANY', scheme: 'ANY', method: 'GET|HEAD', defaults: { _controller: 'App\\Controller\\UserController::show' }, requirements: 'NO CUSTOM', options: {} },
    homepage: { path: '/', host: 'ANY', scheme: 'ANY', method: 'ANY', defaults: { _controller: 'App\\Controller\\HomeController::index' }, requirements: 'NO CUSTOM', options: {} },
  });
  const snap = parseSymfonyRouterJson(raw);
  assertRuntimeRouteSnapshot(snap);
  assert.deepEqual(snap.routes.map((x) => `${x.method} ${x.path}`), ['GET /users/{id}', 'HEAD /users/{id}']);
  assert.equal(snap.routes[0].controller, 'App\\Controller\\UserController::show');
  assert.equal(snap.unknowns[0].code, 'RUNTIME_ROUTE_METHOD_ANY');
});

test('runtime snapshot identity is exact on exporter bytes and never contains operationId', () => {
  const a = parseLaravelRouteListJson('[]');
  const b = parseLaravelRouteListJson('[]\n');
  assert.notEqual(a.rawSha256, b.rawSha256);
  assert.ok(a.routes.every((x) => !Object.hasOwn(x, 'operationId')));
});
