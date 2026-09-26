import test from 'node:test';
import assert from 'node:assert/strict';
import { FASTIFY_PROFILE, projectFastifyFacts } from '../../adapters/http-wave-a/fastify.mjs';
import { DJANGO_DRF_PROFILE, projectDjangoDrfShadow } from '../../adapters/http-wave-a/django-drf.mjs';

test('Fastify stays BLOCKED when T04/T02 receiver ownership facts are absent', () => {
  const result = projectFastifyFacts();
  assert.equal(FASTIFY_PROFILE.state, 'blocked-upstream-fact-gap');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.routes, []);
  assert.equal(result.unknowns[0].code, 'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING');
});

test('Django/DRF preserves T06 URL observations but emits no HTTP endpoints without DRF action/method facts', () => {
  const result = projectDjangoDrfShadow({
    registrations: [{
      module: 'tutorial.urls',
      source: 'tutorial/urls.py',
      line: 12,
      kind: 'path',
      patternSegments: [{ kind: 'path', value: 'snippets/' }],
      target: { kind: 'symbol', module: 'snippets.views', name: 'SnippetList' },
      methodSemantics: 'not-declared-by-urlconf',
    }],
    includes: [],
    unknowns: [],
  });

  assert.equal(DJANGO_DRF_PROFILE.state, 'blocked-upstream-fact-gap');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.routes, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].methodSemantics, 'not-declared-by-urlconf');
  assert.ok(result.unknowns.some((x) => x.code === 'DRF_ACTION_METHOD_FACT_MISSING'));
});

test('Django/DRF missing upstream shadow is blocked rather than source-parsed', () => {
  const result = projectDjangoDrfShadow(null);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.routes, []);
  assert.equal(result.unknowns[0].code, 'DJANGO_DRF_UPSTREAM_FACTS_MISSING');
});
