// T12-02: source-backed regressions for explicitly lossy upstream facts and blocked unknown ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNestJsFacts } from '../../adapters/http-wave-a/nestjs.mjs';
import { projectFlaskShadow } from '../../adapters/http-wave-a/flask.mjs';
import { projectDjangoDrfShadow } from '../../adapters/http-wave-a/django-drf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const record = readJson('adapters/http-wave-a/BASELINE.json');
const rfc = fs.readFileSync(path.join(ROOT, 'adapters/http-wave-a/INTERFACE_RFC.md'), 'utf8');
const recordedFixture = (id) => {
  const fixture = record.fixtures.find((x) => x.id === id);
  assert.ok(fixture, 'missing original T12-01 fixture: ' + id);
  return fixture;
};

function proseBoundaryProblems(text) {
  const lines = text.split('\n');
  const purpose = lines.find((line) => line.startsWith('The scanners of T04, T06, T07 and T08'));
  const unknown = lines.find((line) => line.startsWith('A leaf output has'));
  const limits = lines.find((line) => line.startsWith('Groups: route, from'));
  const problems = [];
  if (!purpose?.includes('Upstream facts can disappear without either a route or an unknown; unknowns are not exhaustive.')) {
    problems.push('purpose falsely implies all omitted facts become unknowns');
  }
  if (!unknown?.includes('at least one unknown of the blocked group') ||
      !unknown.includes('The first unknown need not be blocked') ||
      !unknown.includes('a wrapped upstream unknown can sort before it')) {
    problems.push('blocked unknown ordering claim omits upstream wrapped-first counterexample');
  }
  if (!unknown?.includes('does not cover all dropped upstream facts or unresolved mount context; silent omissions are possible')) {
    problems.push('candidate partial claim hides upstream silent omissions');
  }
  if (!limits?.includes('NestJS computed/undecorated member example emits neither route nor unknown') ||
      !limits.includes('Flask can report a route without a separate unknown')) {
    problems.push('source-pinned NestJS/Flask counterexample acknowledgement missing');
  }
  return problems;
}

test('T12 original NestJS and Flask fixtures prove that unknowns cannot be exhaustive', () => {
  const silent = recordedFixture('nestjs-undecorated-or-computed-skipped-hand-fed');
  const lost = projectNestJsFacts(...silent.call.args);
  assert.equal(lost.status, 'candidate');
  assert.deepEqual([lost.routes.length, lost.unknowns.length, lost.observations.length], [0, 0, 0]);
  assert.ok(silent.expect.some(([p, v]) => p === '/routes/length' && v === 0));
  assert.ok(silent.expect.some(([p, v]) => p === '/unknowns/length' && v === 0));

  const blueprint = recordedFixture('flask-registration-with-t06-limitation-hand-fed');
  assert.ok(blueprint.call.args[0].registrations[0].limitations.some((x) => x.includes('not composed')));
  const flask = projectFlaskShadow(...blueprint.call.args);
  assert.equal(flask.status, 'candidate');
  assert.equal(flask.routes.length, 1);
  assert.equal(flask.unknowns.length, 0);
  assert.equal(flask.routes[0].path, '/admin/');
});

test('T12 pinned real Django results and leaf code disprove the blocked-first-unknown claim', () => {
  const stored = readJson('adapters/http-wave-a/python-django/results/static.json');
  const leaf = stored.fixtures['counterexamples/router-prefix'].layers['t12-django-drf-leaf'];
  assert.equal(leaf.status, 'blocked');
  assert.deepEqual(leaf.routes, []);
  assert.equal(leaf.flags[0].code, 'T06_DJANGO_UNKNOWN:route-pattern-not-literal');
  assert.equal(leaf.flags[1].code, 'DRF_ACTION_METHOD_FACT_MISSING');

  const output = projectDjangoDrfShadow({
    registrations: [],
    unknowns: [{ callee: 'path', code: 'T06_DJANGO_UNKNOWN:route-pattern-not-literal', reason: 'dynamic upstream route' }],
  });
  assert.equal(output.status, 'blocked');
  assert.deepEqual(output.routes, []);
  assert.equal(output.unknowns[0].code, 'T06_DJANGO_UNKNOWN:route-pattern-not-literal');
  assert.ok(output.unknowns.some((x) => x.code === 'DRF_ACTION_METHOD_FACT_MISSING'));
});

test('T12 RFC truth wording names source-backed counterexamples and rejects false edits', () => {
  assert.deepEqual(proseBoundaryProblems(rfc), []);
  const edits = [
    [ 'Upstream facts can disappear without either a route or an unknown; unknowns are not exhaustive.', 'everything else as an unknown.' ],
    [ 'The first unknown need not be blocked', 'The first unknown is always blocked' ],
    [ 'does not cover all dropped upstream facts or unresolved mount context; silent omissions are possible', 'covers all dropped facts' ],
    [ 'NestJS computed/undecorated member example emits neither route nor unknown', 'all NestJS omissions are coded' ],
  ];
  for (const [known, fake] of edits) {
    assert.ok(rfc.includes(known), 'missing expected precise RFC claim: ' + known);
    assert.notDeepEqual(proseBoundaryProblems(rfc.replace(known, fake)), [], 'false RFC claim escaped: ' + fake);
  }
});
