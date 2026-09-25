import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA, compilePermissionPolicy, validatePermissionManifest } from '../../lib/trust-next/permission-manifest.mjs';

const minimal = () => ({ schema: PERMISSION_MANIFEST_SCHEMA });

test('defaults are deny-by-default and bounded', () => {
  const result = validatePermissionManifest(minimal());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.read_roots, []);
  assert.deepEqual(result.value.write_roots, []);
  assert.deepEqual(result.value.network, { mode: 'deny', allow: [] });
  assert.deepEqual(result.value.process, { mode: 'deny', executables: [], max_children: 0 });
  const policy = compilePermissionPolicy(minimal());
  assert.equal(policy.canRead('src/app.mjs'), false);
  assert.equal(policy.canWrite('out/report.json'), false);
  assert.equal(policy.canConnect('example.com', 443), false);
  assert.equal(policy.canExecute('node'), false);
  assert.equal(policy.canReadEnv('PATH'), false);
  assert.equal(policy.canUseSecret('provider-token'), false);
});

test('read/write roots use path segment boundaries and reject traversal', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['src'], write_roots: ['artifacts/out'] });
  assert.equal(policy.canRead('src/a.mjs'), true);
  assert.equal(policy.canRead('src2/a.mjs'), false);
  assert.equal(policy.canRead('src/../secret'), false);
  assert.equal(policy.canWrite('artifacts/out/report.json'), true);
  assert.equal(policy.canWrite('artifacts/outside/report.json'), false);
});

test('network grants are exact host+port allowlists with no wildcards', () => {
  const manifest = { schema: PERMISSION_MANIFEST_SCHEMA, network: { mode: 'allowlist', allow: [{ host: 'API.Example.COM', ports: [443, 8443, 443] }] } };
  const policy = compilePermissionPolicy(manifest);
  assert.equal(policy.canConnect('api.example.com', 443), true);
  assert.equal(policy.canConnect('api.example.com', 80), false);
  assert.equal(policy.canConnect('evil-api.example.com', 443), false);
  const bad = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, network: { mode: 'allowlist', allow: [{ host: '*.example.com', ports: [443] }] } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.some((x) => x.code === 'INVALID_NETWORK_HOST'), true);
});

test('process grants only exact executable basenames and never shell fragments', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: ['node', 'python3'], max_children: 2 } });
  assert.equal(policy.canExecute('node'), true);
  assert.equal(policy.canExecute('/usr/bin/node'), false);
  assert.equal(policy.canExecute('node;curl'), false);
  assert.throws(() => compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: ['sh -c'], max_children: 1 } }), /INVALID_EXECUTABLE/);
});

test('environment grants names only; secret values are rejected', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI', 'PATH'] }, secret_refs: ['provider-token'] });
  assert.equal(policy.canReadEnv('CI'), true);
  assert.equal(policy.canReadEnv('HOME'), false);
  assert.equal(policy.canUseSecret('provider-token'), true);
  assert.equal(policy.canUseSecret('actual-secret-value'), false);
  assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['TOKEN=secret'] } }).ok, false);
  assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, secret_refs: ['TOKEN=secret'] }).ok, false);
});

test('unknown fields and inconsistent deny+allow declarations fail closed', () => {
  const unknown = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, shell: true });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0].code, 'UNKNOWN_PERMISSION_FIELD');
  const network = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, network: { mode: 'deny', allow: [{ host: 'example.com', ports: [443] }] } });
  assert.equal(network.ok, false);
  assert.equal(network.errors.some((x) => x.code === 'DENY_WITH_ALLOWLIST'), true);
});

test('resource limits must be positive safe integers', () => {
  assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, limits: { wall_ms: 0 } }).ok, false);
  assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, limits: { stdout_bytes: Number.MAX_SAFE_INTEGER + 1 } }).ok, false);
  const good = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, limits: { wall_ms: 10_000, stdout_bytes: 2048, stderr_bytes: 4096 } });
  assert.equal(good.ok, true);
  assert.equal(good.value.limits.wall_ms, 10_000);
});

test('non-plain manifests are rejected rather than inheriting ambient properties', () => {
  assert.equal(validatePermissionManifest(null).ok, false);
  assert.equal(validatePermissionManifest([]).ok, false);
  class Manifest { constructor() { this.schema = PERMISSION_MANIFEST_SCHEMA; } }
  assert.equal(validatePermissionManifest(new Manifest()).ok, false);
});
