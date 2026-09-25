import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter, detectGoGinRoot, scanGoGin } from '../scanners/adapters/go-gin.mjs';

function fixture({ gin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gin-'));
  fs.writeFileSync(path.join(root, 'go.mod'), gin
    ? 'module example.com/api\n\ngo 1.23\n\nrequire github.com/gin-gonic/gin v1.10.0\n'
    : 'module example.com/api\n\ngo 1.23\n');
  fs.writeFileSync(path.join(root, 'main.go'), [
    'package main',
    '',
    'import "github.com/gin-gonic/gin"',
    '',
    'func main() {',
    '    router := gin.Default()',
    '    router.GET("/health", health)',
    '    api := router.Group("/api", authMiddleware)',
    '    v1 := api.Group("/v1")',
    '    v1.GET("/users/:id", users.Show)',
    '    v1.POST("/users", createUser)',
    '    v1.DELETE(dynamicPath, deleteUser)',
    '    router.POST("/inline", func(c *gin.Context) {})',
    '}',
    ''
  ].join('\n'));
  return root;
}

test('detectGoGinRoot requires go.mod dependency plus source-confirmed gin root construction', () => {
  const root = fixture();
  assert.equal(detectGoGinRoot(root), root);
  const other = fixture({ gin: false });
  assert.equal(detectGoGinRoot(other), null);
});

test('same-file Gin Group prefixes compose through nested groups', () => {
  const root = fixture();
  const report = scanGoGin(root, root);
  const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/health' && e.method === 'health'));
  assert.ok(endpoints.some((e) => e.verb === 'GET' && e.path === '/api/v1/users/:id' && e.method === 'users.Show'));
  assert.ok(endpoints.some((e) => e.verb === 'POST' && e.path === '/api/v1/users' && e.method === 'createUser'));
});

test('inline handlers are represented without inventing a handler name', () => {
  const root = fixture();
  const report = scanGoGin(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.ok(endpoints.some((e) => e.path === '/inline' && e.method === null));
});

test('computed route paths are skipped instead of guessed', () => {
  const root = fixture();
  const report = scanGoGin(root, root);
  const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.equal(endpoints.some((e) => e.method === 'deleteUser'), false);
});

test('first Gin slice keeps operation/schema/persistence/codegen capabilities off', () => {
  assert.equal(adapter.id, 'go-gin');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
