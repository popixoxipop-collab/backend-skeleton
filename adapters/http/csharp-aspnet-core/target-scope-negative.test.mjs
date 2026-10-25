import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { projectAspNetCoreFacts } from '../../http-wave-a/aspnet-core.mjs';
import { analyzeCSharpAspNetSource } from '../../../scanners/language/native-server/csharp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'adapters/http/csharp-aspnet-core/fixtures', name), 'utf8');

function response(overrides = {}) {
  return {
    protocol: 'bskel.native-language/1', kind: 'analyze-response', requestId: 'negative',
    language: 'csharp', backend: 'csharp-static-pilot', framework: 'aspnet-core',
    routes: [], diagnostics: [], ...overrides,
  };
}

test('scope document carries exact commit and explicit no-authority guardrails', () => {
  const text = fs.readFileSync(path.join(ROOT, 'adapters/http/csharp-aspnet-core/TARGET_SCOPE.md'), 'utf8');
  assert.match(text, /5f20cce1736b24cb468c98833d965e969613bc3f/);
  assert.match(text, /Passing these tests creates no MET, release, runtime certification/);
  assert.match(text, /global release remains blocked/i);
});

test('dynamic Minimal API inputs and MapMethods remain explicit unknown diagnostics', () => {
  const result = analyzeCSharpAspNetSource(fixture('negative/DynamicRoutes.cs'), { file: 'DynamicRoutes.cs' });
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes('CSHARP_DYNAMIC_GROUP_PATH'));
  assert.ok(codes.includes('CSHARP_DYNAMIC_MINIMAL_ROUTE'));
  assert.ok(codes.includes('CSHARP_MAPMETHODS_NEEDS_METHOD_SET'));
  assert.equal(result.routes.length, 0);
});

test('dynamic and conventional controller routing are diagnostics, never invented routes', () => {
  const result = analyzeCSharpAspNetSource(fixture('negative/DynamicRoutes.cs'), { file: 'DynamicRoutes.cs' });
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes('CSHARP_DYNAMIC_CONTROLLER_ROUTE'));
  assert.ok(codes.includes('CSHARP_DYNAMIC_ACTION_ROUTE'));
  assert.ok(codes.includes('CSHARP_ACTION_ROUTE_UNRESOLVED'));
  assert.equal(result.routes.length, 0);
});

test('route lookalikes in comments and strings do not become facts', () => {
  const source = `// app.MapGet("/comment", Fake);\nvar text = "app.MapPost(\\\"/string\\\", Fake)";\nvar app = builder.Build();\napp.MapGet("/real", Real);`;
  const result = analyzeCSharpAspNetSource(source, { file: 'Lookalikes.cs' });
  assert.deepEqual(result.routes.map(({ method, path: routePath }) => [method, routePath]), [['GET', '/real']]);
});

test('wrong transport identity throws and foreign route facts become unknowns', () => {
  assert.throws(() => projectAspNetCoreFacts(response({ protocol: 'wrong/1' })), /requires a T08/);
  assert.throws(() => projectAspNetCoreFacts(response({ language: 'go' })), /requires a T08/);
  const projected = projectAspNetCoreFacts(response({ routes: [{
    method: 'GET', path: '/foreign', handler: null, framework: 'gin', confidence: 'static-literal',
    source: { file: 'foreign.go', line: 1, index: 0 },
  }] }));
  assert.equal(projected.routes.length, 0);
  assert.deepEqual(projected.unknowns.map((item) => item.code), ['ASPNET_FOREIGN_ROUTE_FACT']);
});

test('unsupported methods and relative paths fail closed at the projection boundary', () => {
  const base = { handler: null, framework: 'aspnet-core-minimal', confidence: 'static-literal', source: null };
  assert.throws(() => projectAspNetCoreFacts(response({ routes: [{ ...base, method: 'ANY', path: '/x' }] })), /supported explicit HTTP method/);
  assert.throws(() => projectAspNetCoreFacts(response({ routes: [{ ...base, method: 'GET', path: 'relative' }] })), /path must be absolute/);
});

test('bounded projection cannot manufacture runtime, operation-id, MET, or release claims', () => {
  const projected = projectAspNetCoreFacts(response({ routes: [{
    method: 'GET', path: '/x', handler: null, framework: 'aspnet-core-minimal', confidence: 'static-literal', source: null,
  }] }));
  assert.equal(projected.registration, 'unregistered');
  assert.equal(projected.productionDefault, false);
  assert.equal(projected.evidence.runtimeValidated, false);
  assert.equal(projected.evidence.realRepoComparison, 'BLOCKED_INFRA');
  assert.ok(projected.routes.every((route) => !Object.hasOwn(route, 'operationId')));
  assert.equal(Object.hasOwn(projected, 'MET'), false);
  assert.equal(Object.hasOwn(projected, 'release'), false);
});
