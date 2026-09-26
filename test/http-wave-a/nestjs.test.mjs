import test from 'node:test';
import assert from 'node:assert/strict';
import { NESTJS_PROFILE, projectNestJsFacts } from '../../adapters/http-wave-a/nestjs.mjs';

function facts({ alias = false, dynamic = true } = {}) {
  const controllerLocal = alias ? 'C' : 'Controller';
  const getLocal = alias ? 'G' : 'Get';
  const postLocal = alias ? 'P' : 'Post';
  return {
    moduleFacts: {
      contract: 'bskel.internal.js-ts-source-facts/0',
      filePath: 'src/users.controller.ts',
      complete: true,
      syntaxValidated: false,
      moduleEdges: [{
        kind: 'import',
        specifier: '@nestjs/common',
        bindings: [
          { imported: 'Controller', local: controllerLocal, bindingKind: 'named', typeOnly: false },
          { imported: 'Get', local: getLocal, bindingKind: 'named', typeOnly: false },
          { imported: 'Post', local: postLocal, bindingKind: 'named', typeOnly: false },
        ],
      }],
    },
    structureFacts: {
      contract: 'bskel.internal.js-ts-structure/0',
      filePath: 'src/users.controller.ts',
      language: 'typescript',
      complete: true,
      syntaxValidated: true,
      runtimeValidated: false,
      typescriptVersion: '5.9.3',
      decoratedClasses: [{
        name: 'UsersController',
        source: { line: 4, byteStart: 80, byteEnd: 400 },
        decorators: [{
          name: controllerLocal,
          called: true,
          arguments: [{ kind: 'literal', value: 'users' }],
          source: { line: 3, byteStart: 55, byteEnd: 79 },
        }],
        members: [
          {
            kind: 'method', name: 'show', computed: false,
            source: { line: 7, byteStart: 120, byteEnd: 200 },
            decorators: [{
              name: getLocal, called: true,
              arguments: [{ kind: 'literal', value: ':id' }],
              source: { line: 6, byteStart: 105, byteEnd: 119 },
            }],
          },
          ...(dynamic ? [{
            kind: 'method', name: 'create', computed: false,
            source: { line: 10, byteStart: 210, byteEnd: 300 },
            decorators: [{
              name: postLocal, called: true,
              arguments: [{ kind: 'expression', text: 'prefix + "/new"' }],
              source: { line: 9, byteStart: 201, byteEnd: 209 },
            }],
          }] : []),
        ],
      }],
      diagnostics: [],
    },
  };
}

test('NestJS leaf consumes T04 import + decorator facts and emits only literal proven routes', () => {
  const result = projectNestJsFacts(facts());
  assert.equal(result.profileId, 'typescript-nestjs');
  assert.equal(result.registration, 'unregistered');
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0], {
    method: 'GET',
    path: '/users/:id',
    handler: 'UsersController.show',
    source: { file: 'src/users.controller.ts', line: 7, byteStart: 120, byteEnd: 200 },
    provenance: 'T04:bskel.internal.js-ts-structure/0 + @nestjs/common import binding',
  });
  assert.equal(Object.hasOwn(result.routes[0], 'operationId'), false);
  assert.ok(result.unknowns.some((x) => x.code === 'NESTJS_METHOD_PATH_UNKNOWN'));
});

test('NestJS leaf follows T04-proven import aliases instead of decorator-name guessing', () => {
  const result = projectNestJsFacts(facts({ alias: true, dynamic: false }));
  assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [['GET', '/users/:id']]);
});

test('NestJS leaf does not treat same-named decorators as NestJS without @nestjs/common binding evidence', () => {
  const input = facts({ dynamic: false });
  input.moduleFacts.moduleEdges = [];
  const result = projectNestJsFacts(input);
  assert.deepEqual(result.routes, []);
});

test('NestJS leaf fails closed on file mismatch or incomplete upstream facts', () => {
  const mismatch = facts({ dynamic: false });
  mismatch.moduleFacts.filePath = 'src/other.ts';
  assert.equal(projectNestJsFacts(mismatch).unknowns[0].code, 'NESTJS_FACT_FILE_MISMATCH');

  const incomplete = facts({ dynamic: false });
  incomplete.structureFacts.complete = false;
  const result = projectNestJsFacts(incomplete);
  assert.deepEqual(result.routes, []);
  assert.equal(result.unknowns[0].code, 'NESTJS_UPSTREAM_FACTS_INCOMPLETE');
});

test('NestJS profile remains unregistered and non-runtime-tested', () => {
  assert.equal(NESTJS_PROFILE.registration, 'unregistered');
  assert.equal(NESTJS_PROFILE.productionDefault, false);
  assert.equal(NESTJS_PROFILE.runtimeTested, false);
  assert.equal(NESTJS_PROFILE.t19Review, 'NOT_REVIEWED');
  assert.equal(NESTJS_PROFILE.versionPin.framework, '12.0.1');
});
