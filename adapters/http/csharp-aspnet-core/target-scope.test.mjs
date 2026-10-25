import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  ASPNET_CORE_PROFILE,
  projectAspNetCoreFacts,
} from '../../http-wave-a/aspnet-core.mjs';
import { analyzeCSharpAspNetSource } from '../../../scanners/language/native-server/csharp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'adapters/http/csharp-aspnet-core/fixtures', name), 'utf8');

function response(result) {
  return {
    protocol: 'bskel.native-language/1',
    kind: 'analyze-response',
    requestId: 'HTTP-csharp-aspnet-core-01',
    language: 'csharp',
    backend: 'csharp-static-pilot',
    ...result,
  };
}

test('scope is honest about static-only execution and BLOCKED_INFRA comparison', () => {
  const text = fs.readFileSync(path.join(ROOT, 'adapters/http/csharp-aspnet-core/TARGET_SCOPE.md'), 'utf8');
  assert.match(text, /realRepoComparison` is `BLOCKED_INFRA`/);
  assert.match(text, /does not invoke `dotnet`, Roslyn, or\nKestrel/);
  assert.match(text, /not verified/i);
  assert.doesNotMatch(text, /runtime certified/i);
});

test('profile freezes one upstream repository, path, commit, and sample framework without a range claim', () => {
  assert.deepEqual(ASPNET_CORE_PROFILE.versionPin, {
    repo: 'dotnet/AspNetCore.Docs',
    path: 'aspnetcore/tutorials/min-web-api/samples/8.x/todoDTO',
    ref: '5f20cce1736b24cb468c98833d965e969613bc3f',
    framework: 'net8.0 sample',
  });
  assert.equal(ASPNET_CORE_PROFILE.realRepoComparison, 'BLOCKED_INFRA');
  assert.equal(Object.hasOwn(ASPNET_CORE_PROFILE.versionPin, 'range'), false);
});

test('positive Minimal API fixture deterministically resolves nested literal groups', () => {
  const result = analyzeCSharpAspNetSource(fixture('positive/Program.cs'), { file: 'Program.cs' });
  assert.deepEqual(result.routes.map(({ method, path: routePath, framework }) => ({ method, path: routePath, framework })), [
    { method: 'GET', path: '/api/v1/todos/{id}', framework: 'aspnet-core-minimal' },
    { method: 'POST', path: '/api/todos', framework: 'aspnet-core-minimal' },
  ]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(analyzeCSharpAspNetSource(fixture('positive/Program.cs'), { file: 'Program.cs' }), result);
});

test('positive controller fixture resolves literal tokens without operation ids', () => {
  const result = analyzeCSharpAspNetSource(fixture('positive/TodoController.cs'), { file: 'TodoController.cs' });
  assert.deepEqual(result.routes.map(({ method, path: routePath, handler }) => ({ method, path: routePath, handler })), [
    { method: 'GET', path: '/api/Todo/{id}', handler: 'TodoController.Get' },
    { method: 'POST', path: '/api/Todo/Create', handler: 'TodoController.Create' },
  ]);
  assert.ok(result.routes.every((route) => !Object.hasOwn(route, 'operationId')));
});

test('projection preserves T08 routes and diagnostics while denying runtime equality', () => {
  const analyzed = analyzeCSharpAspNetSource(fixture('positive/Program.cs'), { file: 'Program.cs' });
  analyzed.diagnostics.push({ code: 'TEST_UNKNOWN', severity: 'unknown', file: 'Program.cs', line: 1, message: 'bounded test diagnostic' });
  const projected = projectAspNetCoreFacts(response(analyzed));
  assert.deepEqual(projected.routes.map(({ method, path: routePath }) => [method, routePath]), [
    ['POST', '/api/todos'],
    ['GET', '/api/v1/todos/{id}'],
  ]);
  assert.ok(projected.unknowns.some((item) => item.code === 'T08_TEST_UNKNOWN'));
  assert.equal(projected.evidence.runtimeValidated, false);
  assert.equal(projected.evidence.realRepoComparison, 'BLOCKED_INFRA');
});

test('candidate remains unregistered, non-default, non-runtime-tested, and outside T19 review', () => {
  assert.equal(ASPNET_CORE_PROFILE.registration, 'unregistered');
  assert.equal(ASPNET_CORE_PROFILE.productionDefault, false);
  assert.equal(ASPNET_CORE_PROFILE.runtimeTested, false);
  assert.equal(ASPNET_CORE_PROFILE.t19Review, 'NOT_REVIEWED');
  assert.equal(projectAspNetCoreFacts(response(analyzeCSharpAspNetSource('', { file: 'Empty.cs' }))).status, 'candidate');
});

test('T00 ownership, baseline lock, and T12 nested-runner boundaries already cover this target', () => {
  const ownership = JSON.parse(fs.readFileSync(path.join(ROOT, 'next/t00/ownership-map.json')));
  const t12 = ownership.tracks.find((track) => track.track === 'T12');
  assert.ok(t12.plan_scopes.includes('adapters/http/csharp-aspnet-core/**'));
  assert.ok(ownership.reserved_hot_paths.some((entry) => entry.repository === 'bskel' && entry.path === 'scripts/run-next-nested-tests.mjs'));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'next/t00/baseline.lock.json')));
  assert.equal(baseline.schema, 'bskel.t00-baseline-lock/1');
  const runner = fs.readFileSync(path.join(ROOT, 'scripts/run-next-nested-tests.mjs'), 'utf8');
  assert.match(runner, /id: 'T12', sourcePaths: \['adapters\/http-wave-a'\], testDir: 'test\/http-wave-a'/);
});
