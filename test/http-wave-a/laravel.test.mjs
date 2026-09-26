import test from 'node:test';
import assert from 'node:assert/strict';
import { LARAVEL_PROFILE, projectLaravelCandidates } from '../../adapters/http-wave-a/laravel.mjs';

test('Laravel leaf consumes T07 route candidates without inventing operation identity', () => {
  const result = projectLaravelCandidates({
    contract: 'sbf.dsl-route-candidates/1',
    sourceContract: 'sbf.dsl-facts/1',
    framework: 'laravel',
    source: { repo: 'fixture' },
    candidates: [
      {
        id: 'dslr_1', framework: 'laravel', method: 'GET', path: '/admin/users',
        sourceFactId: 'fact1', source: { file: 'routes/web.php', start: 20, end: 50 },
        provenance: 'bounded-literal-dsl-expansion',
      },
      {
        id: 'dslr_2', framework: 'laravel', method: 'POST', path: '/admin/users',
        sourceFactId: 'fact2', source: { file: 'routes/web.php', start: 51, end: 80 },
        provenance: 'bounded-literal-dsl-expansion',
      },
    ],
    unknowns: [{
      code: 'DSL_DYNAMIC_DECLARATION',
      sourceFactId: 'fact3',
      source: { file: 'routes/web.php', start: 81, end: 100 },
      reason: 'dynamic URI',
    }],
  });

  assert.deepEqual(result.routes.map((r) => [r.method, r.path]), [
    ['GET', '/admin/users'],
    ['POST', '/admin/users'],
  ]);
  assert.ok(result.routes.every((r) => !Object.hasOwn(r, 'operationId')));
  assert.ok(result.unknowns.some((x) => x.code === 'T07_DSL_DYNAMIC_DECLARATION'));
  assert.equal(LARAVEL_PROFILE.versionPin.framework, null);
  assert.equal(LARAVEL_PROFILE.t19Review, 'NOT_REVIEWED');
});

test('Laravel leaf rejects non-Laravel or non-T07 candidate envelopes', () => {
  assert.throws(() => projectLaravelCandidates({ contract: 'sbf.dsl-route-candidates/1', framework: 'rails' }), /framework=laravel/);
  assert.throws(() => projectLaravelCandidates({ contract: 'other', framework: 'laravel' }), /requires T07/);
});
