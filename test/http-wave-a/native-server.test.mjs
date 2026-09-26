import test from 'node:test';
import assert from 'node:assert/strict';
import { ASPNET_CORE_PROFILE, projectAspNetCoreFacts } from '../../adapters/http-wave-a/aspnet-core.mjs';
import { GIN_PROFILE, projectGinFacts } from '../../adapters/http-wave-a/gin.mjs';

function response(language, framework, routes, diagnostics = []) {
  return {
    protocol: 'bskel.native-language/1',
    kind: 'analyze-response',
    requestId: 'test',
    language,
    backend: 'static',
    framework,
    routes,
    diagnostics,
  };
}

test('ASP.NET Core leaf consumes only T08 ASP.NET route facts and preserves diagnostics as unknowns', () => {
  const result = projectAspNetCoreFacts(response('csharp', 'aspnet-core', [
    {
      method: 'GET', path: '/todoitems/{id}', handler: null,
      framework: 'aspnet-core-minimal', confidence: 'static-literal',
      source: { file: 'Program.cs', line: 20, index: 200 },
    },
    {
      method: 'GET', path: '/foreign', handler: null,
      framework: 'other', confidence: 'static-literal',
      source: { file: 'Program.cs', line: 21, index: 210 },
    },
  ], [{
    code: 'CSHARP_DYNAMIC_MINIMAL_ROUTE', severity: 'unknown',
    file: 'Program.cs', line: 30, message: 'computed route',
  }]));

  assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [['GET', '/todoitems/{id}']]);
  assert.ok(result.unknowns.some((x) => x.code === 'T08_CSHARP_DYNAMIC_MINIMAL_ROUTE'));
  assert.ok(result.unknowns.some((x) => x.code === 'ASPNET_FOREIGN_ROUTE_FACT'));
  assert.equal(result.evidence.realRepoComparison, 'BLOCKED_INFRA');
  assert.equal(ASPNET_CORE_PROFILE.t19Review, 'NOT_REVIEWED');
});

test('Gin leaf consumes T08 Gin routes and leaves dynamic-path diagnostics unresolved', () => {
  const result = projectGinFacts(response('go', 'gin', [{
    method: 'POST', path: '/api/rooms/:roomid', handler: 'roomGET',
    framework: 'gin', confidence: 'static-literal',
    source: { file: 'main.go', line: 40, index: 400 },
  }], [{
    code: 'GO_GIN_DYNAMIC_ROUTE_PATH', severity: 'unknown',
    file: 'main.go', line: 41, message: 'dynamic path',
  }]));

  assert.deepEqual(result.routes.map((r) => [r.method, r.path, r.handler]), [
    ['POST', '/api/rooms/:roomid', 'roomGET'],
  ]);
  assert.ok(result.unknowns.some((x) => x.code === 'T08_GO_GIN_DYNAMIC_ROUTE_PATH'));
  assert.equal(GIN_PROFILE.versionPin.framework, 'v1.12.0');
});

test('native-server leaves reject wrong protocol/language instead of accepting lookalike objects', () => {
  assert.throws(() => projectAspNetCoreFacts(response('go', 'gin', [])), /requires a T08/);
  assert.throws(() => projectGinFacts(response('csharp', 'aspnet-core', [])), /requires a T08/);
});
