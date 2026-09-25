import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapter,
  detectTypeScriptNestJsRoot,
  scanTypeScriptNestJs,
} from '../scanners/adapters/typescript-nestjs.mjs';

function fixture({ nest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-nestjs-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    dependencies: nest ? {
      '@nestjs/common': '^11.0.0',
      '@nestjs/core': '^11.0.0'
    } : {
      express: '^5.0.0'
    }
  }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'users.controller.ts'), [
    "import { Controller, Get, Post, Patch } from '@nestjs/common';",
    '',
    "// @Controller('phantom')",
    "@Controller('users')",
    'export class UsersController {',
    "  @Get(':id')",
    '  findOne() { return null; }',
    '',
    '  @Post()',
    '  async create() { return null; }',
    '',
    '  @Patch(dynamicPath)',
    '  computedPath() { return null; }',
    '',
    "  // @Get('phantom')",
    '  ignoredComment() { return null; }',
    '}',
    ''
  ].join('\n'));
  return root;
}

test('detectTypeScriptNestJsRoot requires Nest dependencies and source-confirmed @Controller usage', () => {
  const root = fixture();
  assert.equal(detectTypeScriptNestJsRoot(root), root);
  const nonNest = fixture({ nest: false });
  assert.equal(detectTypeScriptNestJsRoot(nonNest), null);
});

test('scanTypeScriptNestJs joins literal controller and method paths without inventing operationIds', () => {
  const root = fixture();
  const report = scanTypeScriptNestJs(root, root);
  assert.equal(report.modules.length, 1);
  const users = report.modules[0];
  assert.equal(users.module, 'users');
  assert.equal(users.controllers.length, 1);
  const controller = users.controllers[0];
  assert.equal(controller.className, 'UsersController');
  assert.equal(controller.basePath, '/users');
  assert.deepEqual(controller.operationIds, []);
  assert.deepEqual(
    controller.endpoints.map((ep) => [ep.verb, ep.path, ep.method, ep.operationId]),
    [
      ['GET', '/users/:id', 'findOne', null],
      ['POST', '/users', 'create', null],
    ],
  );
});

test('computed decorator paths and commented-out routes are skipped instead of guessed', () => {
  const root = fixture();
  const report = scanTypeScriptNestJs(root, root);
  const endpoints = report.modules[0].controllers[0].endpoints;
  assert.equal(endpoints.some((ep) => ep.method === 'computedPath'), false);
  assert.equal(endpoints.some((ep) => ep.path.includes('phantom')), false);
});

test('listReadSet includes the package manifest and TypeScript source that detection/scan actually read', () => {
  const root = fixture();
  const readSet = adapter.listReadSet(root);
  assert.deepEqual(readSet, ['package.json', path.join('src', 'users.controller.ts')]);
});

test('first NestJS slice declares unsupported capabilities honestly', () => {
  assert.equal(adapter.id, 'typescript-nestjs');
  assert.equal(adapter.contract, 'sbf.adapter/2');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
