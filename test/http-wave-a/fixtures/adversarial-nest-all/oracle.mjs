// Opt-in real NestJS 12.0.1 differential oracle. Install the sibling pinned
// target-scope/nestjs package lock first; this file never runs in ordinary npm test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pinned = path.resolve(here, '../target-scope/nestjs');
const require = createRequire(path.join(pinned, 'package.json'));
require('reflect-metadata');
const { All, Controller, Injectable, Module, UseGuards } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
for (const name of ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express']) {
  const got = JSON.parse(fs.readFileSync(path.join(pinned, 'node_modules', name, 'package.json'))).version;
  assert.equal(got, '12.0.1', `${name} version drift`);
}

class TokenGuard {
  canActivate(context) { return context.switchToHttp().getRequest().headers['x-token'] === 'ok'; }
}
Injectable()(TokenGuard);

class AllController {
  catchAll() { return 'all'; }
}
Controller('edge')(AllController);
const descriptor = Object.getOwnPropertyDescriptor(AllController.prototype, 'catchAll');
All('anything')(AllController.prototype, 'catchAll', descriptor);
UseGuards(TokenGuard)(AllController.prototype, 'catchAll', descriptor);

class AppModule {}
Module({ controllers: [AllController] })(AppModule);
const app = await NestFactory.create(AppModule, { logger: false });
try {
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address();
  const probes = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    for (const authorized of [true, false]) {
      const response = await fetch(`http://127.0.0.1:${port}/edge/anything`, {
        method, headers: authorized ? { 'x-token': 'ok' } : {},
      });
      await response.arrayBuffer();
      probes.push({ method, authorized, status: response.status });
    }
  }
  process.stdout.write(`${JSON.stringify({ schema: 'bskel.t12.nest-all-runtime/1', framework: '@nestjs/core 12.0.1',
    path: '/edge/anything', probes }, null, 2)}\n`);
} finally {
  await app.close();
}
