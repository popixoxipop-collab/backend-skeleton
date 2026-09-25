import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter, detectPhpLaravelRoot, scanPhpLaravel } from '../scanners/adapters/php-laravel.mjs';

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ laravel = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-laravel-'));
  write(root, 'composer.json', JSON.stringify({
    name: 'example/api',
    require: laravel ? { 'laravel/framework': '^12.0' } : { 'php': '^8.2' }
  }, null, 2));
  write(root, 'routes/web.php', [
    '<?php',
    'use Illuminate\\Support\\Facades\\Route;',
    'use App\\Http\\Controllers\\UserController;',
    '',
    "Route::get('/health', function () { return 'ok'; });",
    "Route::prefix('admin')->group(function () {",
    "    Route::get('/users', [UserController::class, 'index']);",
    "    Route::prefix('v1')->group(function () {",
    "        Route::post('/users', [UserController::class, 'store']);",
    '    });',
    '});',
    "Route::delete($dynamicPath, [UserController::class, 'destroy']);",
    ''
  ].join('\n'));
  write(root, 'routes/api.php', [
    '<?php',
    'use Illuminate\\Support\\Facades\\Route;',
    "Route::get('/users', [UserController::class, 'index']);",
    ''
  ].join('\n'));
  return root;
}

test('detectPhpLaravelRoot requires laravel/framework and source-confirmed Route facade use', () => {
  const root = fixture();
  assert.equal(detectPhpLaravelRoot(root), root);
  const other = fixture({ laravel: false });
  assert.equal(detectPhpLaravelRoot(other), null);
});

test('literal Laravel route facade calls are extracted with controller-array handler identity', () => {
  const root = fixture();
  const report = scanPhpLaravel(root, root);
  const web = report.modules.find((m) => m.module === 'web');
  assert.ok(web);
  const endpoints = web.controllers.flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/health' && e.method === null));
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/admin/users' && e.method === 'UserController@index'));
  assert.ok(endpoints.some((e) => e.verb === 'POST' && e.path === '/admin/v1/users' && e.method === 'UserController@store'));
});

test('routes/api.php is not given an invented /api prefix without bootstrap evidence', () => {
  const root = fixture();
  const report = scanPhpLaravel(root, root);
  const api = report.modules.find((m) => m.module === 'api');
  assert.ok(api);
  const endpoints = api.controllers.flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.path === '/users'));
  assert.equal(endpoints.some((e) => e.path === '/api/users'), false);
});

test('computed route paths are skipped instead of guessed', () => {
  const root = fixture();
  const report = scanPhpLaravel(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.equal(endpoints.some((e) => e.method === 'UserController@destroy'), false);
});

test('first Laravel slice keeps operation/schema/persistence/codegen capabilities off', () => {
  assert.equal(adapter.id, 'php-laravel');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
