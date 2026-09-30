import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGinFacts } from '../../adapters/http-wave-a/gin.mjs';
import { projectLaravelCandidates } from '../../adapters/http-wave-a/laravel.mjs';
import { projectFlaskShadow } from '../../adapters/http-wave-a/flask.mjs';
import { handleAnalyzeRequest } from '../../scanners/language/native-server/index.mjs';
import { extractLaravelDslFacts } from '../../scanners/language/ruby-php/dsl-facts.mjs';
import { expandDslFacts } from '../../scanners/language/ruby-php/dsl-expand.mjs';

function ginResponse(routes, diagnostics = []) {
  return {
    protocol: 'bskel.native-language/1',
    kind: 'analyze-response',
    requestId: 'test',
    language: 'go',
    backend: 'static',
    framework: 'gin',
    routes,
    diagnostics,
  };
}

function ginRoute(method, path, handler, line) {
  return {
    method, path, handler,
    framework: 'gin', confidence: 'static-literal',
    source: { file: 'main.go', line, index: line * 10 },
  };
}

function laravelEnvelope(candidates, unknowns = []) {
  return {
    contract: 'sbf.dsl-route-candidates/1',
    sourceContract: 'sbf.dsl-facts/1',
    framework: 'laravel',
    source: { repo: 'fixture' },
    candidates,
    unknowns,
  };
}

function laravelCandidate(id, method, path, start) {
  return {
    id, framework: 'laravel', method, path,
    sourceFactId: 'fact_' + id, source: { file: 'routes/web.php', start, end: start + 10 },
    provenance: 'bounded-literal-dsl-expansion',
  };
}

function flaskRegistration(fn, path, methods, line) {
  return {
    module: 'app', source: 'app.py', function: fn, line,
    path, methods, methodsStatus: 'explicit-methods-list',
  };
}

const pairs = (result) => result.routes.map((r) => [r.method, r.path]);
const byCode = (result, code) => result.unknowns.filter((u) => u.code === code);

test('Gin: an ANY route becomes a wildcard unknown and every other route still projects', () => {
  const result = projectGinFacts(ginResponse([
    ginRoute('GET', '/ok', 'okHandler', 10),
    ginRoute('ANY', '/wild', 'wildHandler', 11),
    ginRoute('POST', '/also-ok', 'alsoOk', 12),
  ], [{
    code: 'GO_GIN_DYNAMIC_ROUTE_PATH', severity: 'unknown',
    file: 'main.go', line: 13, message: 'dynamic path',
  }]));

  assert.deepEqual(pairs(result), [['POST', '/also-ok'], ['GET', '/ok']]);
  const wildcard = byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED');
  assert.equal(wildcard.length, 1);
  assert.equal(wildcard[0].method, 'ANY');
  assert.equal(wildcard[0].path, '/wild');
  assert.equal(wildcard[0].handler, 'wildHandler');
  assert.deepEqual(wildcard[0].source, { file: 'main.go', line: 11, index: 110 });
  assert.equal(wildcard[0].provenance, 'T08:bskel.native-language/1:static-literal');
  assert.equal(typeof wildcard[0].reason, 'string');
  assert.ok(wildcard[0].reason.length > 0);
  assert.ok(result.unknowns.some((x) => x.code === 'T08_GO_GIN_DYNAMIC_ROUTE_PATH'), 'T08 diagnostics stay preserved');
});

test('Gin: an ANY route is never supported and is never expanded into a method list', () => {
  const result = projectGinFacts(ginResponse([
    ginRoute('ANY', '/wild', 'wildHandler', 11),
    ginRoute('GET', '/ok', 'okHandler', 10),
  ]));

  assert.equal(result.routes.some((r) => r.path === '/wild'), false);
  assert.equal(result.routes.some((r) => r.method === 'ANY'), false);
  assert.deepEqual(pairs(result), [['GET', '/ok']]);
  assert.equal(result.status, 'candidate');
});

test('Gin: wildcard spelling is matched case-insensitively, like the method normalisation of supported routes', () => {
  for (const spelling of ['ANY', 'Any', 'any']) {
    const result = projectGinFacts(ginResponse([
      ginRoute('GET', '/ok', 'okHandler', 10),
      ginRoute(spelling, '/wild', 'wildHandler', 11),
    ]));
    assert.deepEqual(pairs(result), [['GET', '/ok']], spelling);
    assert.equal(byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED').length, 1, spelling);
    assert.equal(byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED')[0].method, spelling);
  }
});

test('Gin: a projection whose only routes are ANY completes with zero routes instead of throwing', () => {
  const result = projectGinFacts(ginResponse([
    ginRoute('ANY', '/a', 'a', 1),
    ginRoute('ANY', '/b', 'b', 2),
  ]));

  assert.deepEqual(result.routes, []);
  assert.equal(byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED').length, 2);
});

test('Gin: methods outside the seven explicit ones are unsupported unknowns, not aborts', () => {
  for (const method of ['TRACE', 'CONNECT', 'PROPFIND', '', null]) {
    const result = projectGinFacts(ginResponse([
      ginRoute('GET', '/ok', 'okHandler', 10),
      ginRoute(method, '/odd', 'oddHandler', 11),
    ]));
    assert.deepEqual(pairs(result), [['GET', '/ok']], String(method));
    const unsupported = byCode(result, 'ROUTE_METHOD_UNSUPPORTED');
    assert.equal(unsupported.length, 1, String(method));
    assert.equal(unsupported[0].method, method);
    assert.equal(unsupported[0].path, '/odd');
  }
});

test('Gin: HEAD and OPTIONS stay authoritative routes', () => {
  const result = projectGinFacts(ginResponse([
    ginRoute('HEAD', '/h', 'h', 1),
    ginRoute('OPTIONS', '/o', 'o', 2),
    ginRoute('ANY', '/wild', 'w', 3),
  ]));
  assert.deepEqual(pairs(result), [['HEAD', '/h'], ['OPTIONS', '/o']]);
});

test('Gin: projection output does not depend on the order of the input routes', () => {
  const routes = [
    ginRoute('GET', '/ok', 'okHandler', 10),
    ginRoute('ANY', '/wild', 'wildHandler', 11),
    ginRoute('POST', '/also-ok', 'alsoOk', 12),
    ginRoute('ANY', '/other-wild', 'otherWild', 13),
  ];
  const forward = projectGinFacts(ginResponse(routes));
  const reverse = projectGinFacts(ginResponse([...routes].reverse()));
  assert.deepEqual(forward, reverse);
  assert.equal(byCode(forward, 'ROUTE_METHOD_WILDCARD_UNRESOLVED').length, 2);
});

test('Gin: real T08 analysis of a Go file that calls Any keeps the other routes and reports the wildcard', () => {
  const source = [
    'package main',
    '',
    'import "github.com/gin-gonic/gin"',
    '',
    'func main() {',
    '\tr := gin.Default()',
    '\tr.GET("/ok", okHandler)',
    '\tr.Any("/wild", wildHandler)',
    '\tapi := r.Group("/api")',
    '\tapi.Any("/proxy", proxyHandler)',
    '\tapi.POST("/also-ok", alsoOk)',
    '}',
    '',
  ].join('\n');
  const response = handleAnalyzeRequest({
    protocol: 'bskel.native-language/1', kind: 'analyze-request', requestId: 'fu06',
    language: 'go', file: 'main.go', source,
  });
  const t08Wildcards = response.routes.filter((r) => r.method === 'ANY');
  assert.deepEqual(t08Wildcards.map((r) => r.path).sort(), ['/api/proxy', '/wild'], 'precondition: T08 emits ANY for Gin Any');

  const result = projectGinFacts(response);

  assert.deepEqual(pairs(result), [['POST', '/api/also-ok'], ['GET', '/ok']]);
  const wildcard = byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED').sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(wildcard.map((u) => [u.method, u.path, u.handler]), [
    ['ANY', '/api/proxy', 'proxyHandler'],
    ['ANY', '/wild', 'wildHandler'],
  ]);
  for (const unknown of wildcard) {
    const upstream = t08Wildcards.find((r) => r.path === unknown.path);
    assert.deepEqual(unknown.source, upstream.source);
  }
});

test('Gin: a malformed handler is still a contract violation and is not swallowed as an unknown', () => {
  assert.throws(
    () => projectGinFacts(ginResponse([ginRoute('GET', '/ok', '', 10)])),
    /handler must be null or a non-empty string/,
  );
});

test('Laravel: real T07 analysis of Route::any keeps the other routes and reports the wildcard', () => {
  const php = [
    '<?php',
    "Route::get('/ok', 'C@a');",
    "Route::any('/wild', 'C@b');",
    "Route::post('/also-ok', 'C@c');",
    '',
  ].join('\n');
  const envelope = expandDslFacts(extractLaravelDslFacts(php, { file: 'routes/web.php' }));
  const t07Wildcard = envelope.candidates.find((c) => c.method === 'ANY');
  assert.ok(t07Wildcard, 'precondition: T07 emits an ANY candidate for Route::any');
  assert.equal(t07Wildcard.path, '/wild');

  const result = projectLaravelCandidates(envelope);

  assert.deepEqual(pairs(result), [['POST', '/also-ok'], ['GET', '/ok']]);
  assert.equal(result.routes.some((r) => r.path === '/wild' || r.method === 'ANY'), false);
  const wildcard = byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED');
  assert.equal(wildcard.length, 1);
  assert.equal(wildcard[0].method, 'ANY');
  assert.equal(wildcard[0].path, '/wild');
  assert.equal(wildcard[0].sourceFactId, t07Wildcard.sourceFactId);
  assert.equal(wildcard[0].candidateId, t07Wildcard.id);
  assert.deepEqual(wildcard[0].source, t07Wildcard.source);
});

test('Laravel: a partial candidate with a null path becomes a path unknown and does not abort the projection', () => {
  const result = projectLaravelCandidates(laravelEnvelope([
    laravelCandidate('dslr_1', 'GET', '/admin/users', 1),
    { ...laravelCandidate('dslr_2', 'GET', null, 20), provenance: 'partial' },
    laravelCandidate('dslr_3', 'POST', '/admin/users', 40),
  ], [{
    code: 'DSL_DYNAMIC_DECLARATION', sourceFactId: 'fact_x',
    source: { file: 'routes/web.php', start: 60, end: 70 }, reason: 'dynamic URI',
  }]));

  assert.deepEqual(pairs(result), [['GET', '/admin/users'], ['POST', '/admin/users']]);
  const pathUnknown = byCode(result, 'ROUTE_PATH_UNKNOWN');
  assert.equal(pathUnknown.length, 1);
  assert.equal(pathUnknown[0].method, 'GET');
  assert.equal(pathUnknown[0].path, null);
  assert.equal(pathUnknown[0].sourceFactId, 'fact_dslr_2');
  assert.equal(pathUnknown[0].candidateId, 'dslr_2');
  assert.deepEqual(pathUnknown[0].source, { file: 'routes/web.php', start: 20, end: 30 });
  assert.equal(pathUnknown[0].provenance, 'T07:sbf.dsl-route-candidates/1:partial');
  assert.ok(result.unknowns.some((x) => x.code === 'T07_DSL_DYNAMIC_DECLARATION'), 'T07 unknowns stay preserved');
  assert.ok(result.routes.every((r) => !Object.hasOwn(r, 'operationId')));
});

test('Laravel: undefined, non-string and non-absolute candidate paths are path unknowns', () => {
  for (const path of [undefined, 42, '', 'admin/users']) {
    const result = projectLaravelCandidates(laravelEnvelope([
      laravelCandidate('dslr_1', 'GET', '/ok', 1),
      laravelCandidate('dslr_2', 'GET', path, 20),
    ]));
    assert.deepEqual(pairs(result), [['GET', '/ok']], String(path));
    assert.equal(byCode(result, 'ROUTE_PATH_UNKNOWN').length, 1, String(path));
  }
});

test('Laravel: an ANY candidate with no path is reported once, as a wildcard', () => {
  const result = projectLaravelCandidates(laravelEnvelope([
    laravelCandidate('dslr_1', 'GET', '/ok', 1),
    laravelCandidate('dslr_2', 'ANY', null, 20),
  ]));
  assert.deepEqual(pairs(result), [['GET', '/ok']]);
  assert.equal(result.unknowns.filter((u) => u.code.startsWith('ROUTE_')).length, 1);
  assert.equal(byCode(result, 'ROUTE_METHOD_WILDCARD_UNRESOLVED').length, 1);
});

test('Flask: one unsupported method in a methods list is an unknown while its other methods and routes project', () => {
  const result = projectFlaskShadow({
    registrations: [
      flaskRegistration('ok', '/ok', ['GET'], 5),
      flaskRegistration('multi', '/multi', ['GET', 'TRACE'], 9),
    ],
    declarations: [],
    unknowns: [],
  });

  assert.deepEqual(result.routes.map((r) => [r.method, r.path, r.handler]), [
    ['GET', '/multi', 'multi'],
    ['GET', '/ok', 'ok'],
  ]);
  const unsupported = byCode(result, 'ROUTE_METHOD_UNSUPPORTED');
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].method, 'TRACE');
  assert.equal(unsupported[0].path, '/multi');
  assert.equal(unsupported[0].handler, 'multi');
  assert.deepEqual(unsupported[0].source, { file: 'app.py', line: 9 });
});

test('Flask: a registration path without a leading slash is a path unknown and does not abort the projection', () => {
  const result = projectFlaskShadow({
    registrations: [
      flaskRegistration('ok', '/ok', ['GET'], 5),
      flaskRegistration('ns', 'noslash', ['GET'], 12),
    ],
    declarations: [],
    unknowns: [],
  });

  assert.deepEqual(pairs(result), [['GET', '/ok']]);
  const pathUnknown = byCode(result, 'ROUTE_PATH_UNKNOWN');
  assert.equal(pathUnknown.length, 1);
  assert.equal(pathUnknown[0].path, 'noslash');
  assert.equal(pathUnknown[0].handler, 'ns');
});
