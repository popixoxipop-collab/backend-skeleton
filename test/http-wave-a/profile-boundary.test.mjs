import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { NESTJS_PROFILE } from '../../adapters/http-wave-a/nestjs.mjs';
import { FASTIFY_PROFILE } from '../../adapters/http-wave-a/fastify.mjs';
import { FLASK_PROFILE } from '../../adapters/http-wave-a/flask.mjs';
import { DJANGO_DRF_PROFILE } from '../../adapters/http-wave-a/django-drf.mjs';
import { ASPNET_CORE_PROFILE } from '../../adapters/http-wave-a/aspnet-core.mjs';
import { GIN_PROFILE } from '../../adapters/http-wave-a/gin.mjs';
import { LARAVEL_PROFILE } from '../../adapters/http-wave-a/laravel.mjs';

const PROFILES = [
  NESTJS_PROFILE,
  FASTIFY_PROFILE,
  FLASK_PROFILE,
  DJANGO_DRF_PROFILE,
  ASPNET_CORE_PROFILE,
  GIN_PROFILE,
  LARAVEL_PROFILE,
];

test('Wave A leaves are not present in the stable production adapter registry', () => {
  const stable = new Set(ADAPTERS.map((adapter) => adapter.id));
  for (const profile of PROFILES) assert.equal(stable.has(profile.id), false, profile.id);
});

test('all seven Wave A profiles remain unregistered, non-default, non-runtime-tested and not T19-certified', () => {
  assert.equal(PROFILES.length, 7);
  for (const profile of PROFILES) {
    assert.equal(profile.registration, 'unregistered', profile.id);
    assert.equal(profile.productionDefault, false, profile.id);
    assert.equal(profile.runtimeTested, false, profile.id);
    assert.equal(profile.t19Review, 'NOT_REVIEWED', profile.id);
  }
});

test('Fastify and Django/DRF remain explicitly blocked on upstream fact gaps', () => {
  assert.equal(FASTIFY_PROFILE.state, 'blocked-upstream-fact-gap');
  assert.equal(DJANGO_DRF_PROFILE.state, 'blocked-upstream-fact-gap');
});

test('candidate leaves do not become npm package assets through an implicit package allowlist change', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.files.some((entry) => entry === 'adapters/' || entry.startsWith('adapters/')), false);
});
