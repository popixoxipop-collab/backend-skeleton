import test from 'node:test';
import assert from 'node:assert/strict';
import { FLASK_PROFILE, projectFlaskShadow } from '../../adapters/http-wave-a/flask.mjs';

test('Flask leaf projects only T06 registrations with explicit method semantics', () => {
  const result = projectFlaskShadow({
    registrations: [
      {
        module: 'app', source: 'app.py', function: 'health', line: 10,
        path: '/health', methods: ['GET'], methodsStatus: 'explicit-decorator',
      },
      {
        module: 'auth', source: 'auth.py', function: 'login', line: 20,
        path: '/auth/login', methods: ['GET', 'POST'], methodsStatus: 'explicit-methods-list',
      },
      {
        module: 'legacy', source: 'legacy.py', function: 'home', line: 30,
        path: '/', methods: [], methodsStatus: 'framework-default-unresolved',
      },
    ],
    declarations: [],
    unknowns: [{ kind: 'flask-route', module: 'x', reason: 'route-path-not-literal' }],
  });

  assert.deepEqual(result.routes.map((r) => [r.method, r.path, r.handler]), [
    ['GET', '/auth/login', 'login'],
    ['POST', '/auth/login', 'login'],
    ['GET', '/health', 'health'],
  ]);
  assert.ok(result.unknowns.some((x) => x.code === 'FLASK_METHOD_SEMANTICS_UNRESOLVED'));
  assert.ok(result.unknowns.some((x) => x.code === 'T06_FLASK_UNKNOWN'));
  assert.ok(result.routes.every((r) => !Object.hasOwn(r, 'operationId')));
});

test('Flask leaf rejects non-T06-shaped input instead of reparsing Python source', () => {
  assert.throws(() => projectFlaskShadow({ source: '@app.get("/x")' }), /requires T06 buildFlaskRouteShadow output/);
});

test('Flask profile stays unregistered, static-only and exact package version unresolved', () => {
  assert.equal(FLASK_PROFILE.registration, 'unregistered');
  assert.equal(FLASK_PROFILE.runtimeTested, false);
  assert.equal(FLASK_PROFILE.versionPin.framework, null);
  assert.equal(FLASK_PROFILE.t19Review, 'NOT_REVIEWED');
});
