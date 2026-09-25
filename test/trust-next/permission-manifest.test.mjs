import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA, compilePermissionPolicy, diffPermissionManifests, selectApprovedEnvironment, validatePermissionManifest } from '../../lib/trust-next/permission-manifest.mjs';

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
  assert.equal(policy.canReadEnv('LANG'), false);
  assert.equal(policy.canUseSecret('provider-token'), false);
});

test('read/write roots use path segment boundaries and reject traversal', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['src'], write_roots: ['artifacts/out'] });
  assert.equal(policy.canRead('src/a.mjs'), true);
  assert.equal(policy.canRead('src2/a.mjs'), false);
  assert.equal(policy.canRead('src/../secret'), false);
  assert.equal(policy.canWrite('artifacts/out/report.json'), true);
  assert.equal(policy.canWrite('artifacts/outside/report.json'), false);
  for (const root of ['C:/Windows/System32', 'z:/tmp']) {
    assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, read_roots: [root] }).ok, false, root);
  }
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
  for (const host of ['a..example.com', '-bad.example.com', 'bad-.example.com', 'https://example.com']) {
    const invalid = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, network: { mode: 'allowlist', allow: [{ host, ports: [443] }] } });
    assert.equal(invalid.ok, false, host);
  }
});

test('process grants only exact executable basenames and never shell fragments', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: ['node', 'python3'], max_children: 2 } });
  assert.equal(policy.canExecute('node'), true);
  assert.equal(policy.canExecute('/usr/bin/node'), false);
  assert.equal(policy.canExecute('node;curl'), false);
  assert.throws(() => compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: ['sh -c'], max_children: 1 } }), /INVALID_EXECUTABLE/);
  for (const executable of ['.', '..', './node', '../node']) {
    assert.equal(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: [executable], max_children: 1 } }).ok, false, executable);
  }
});

test('environment grants names only; secret values are rejected', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI', 'LANG'] }, secret_refs: ['provider-token'] });
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


test('compiled policies are deeply immutable after validation', () => {
  const policy = compilePermissionPolicy({
    schema: PERMISSION_MANIFEST_SCHEMA,
    read_roots: ['src'],
    network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443] }] },
    process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 },
    environment: { allow: ['CI'] },
    secret_refs: ['provider-token'],
  });
  assert.equal(Object.isFrozen(policy.manifest), true);
  assert.equal(Object.isFrozen(policy.manifest.read_roots), true);
  assert.equal(Object.isFrozen(policy.manifest.network), true);
  assert.equal(Object.isFrozen(policy.manifest.network.allow), true);
  assert.equal(Object.isFrozen(policy.manifest.network.allow[0].ports), true);
  assert.throws(() => policy.manifest.read_roots.push('secret'));
  assert.throws(() => policy.manifest.network.allow[0].ports.push(80));
  assert.equal(policy.canRead('secret/file'), false);
  assert.equal(policy.canConnect('api.example.com', 80), false);
});


test('network normalization merges duplicate hosts and is input-order independent', () => {
  const a = validatePermissionManifest({
    schema: PERMISSION_MANIFEST_SCHEMA,
    network: { mode: 'allowlist', allow: [
      { host: 'B.example.com', ports: [8443] },
      { host: 'api.example.com', ports: [443] },
      { host: 'API.EXAMPLE.COM', ports: [8443, 443] },
    ] },
  });
  const b = validatePermissionManifest({
    schema: PERMISSION_MANIFEST_SCHEMA,
    network: { mode: 'allowlist', allow: [
      { host: 'api.example.com', ports: [8443] },
      { host: 'b.example.com', ports: [8443] },
      { host: 'api.example.com', ports: [443] },
    ] },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.value.network, b.value.network);
  assert.deepEqual(a.value.network.allow, [
    { host: 'api.example.com', ports: [443, 8443] },
    { host: 'b.example.com', ports: [8443] },
  ]);
});

test('argv allowlist with zero child capacity is rejected as an inconsistent grant', () => {
  const result = validatePermissionManifest({
    schema: PERMISSION_MANIFEST_SCHEMA,
    process: { mode: 'argv-allowlist', executables: ['node'], max_children: 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((x) => x.code === 'EMPTY_PROCESS_CAPACITY'), true);
});


test('secret references are identifiers, never paths or assignment strings', () => {
  for (const ref of ['../secret', 'folder/secret', '.hidden', 'TOKEN=secret', 'has space']) {
    const result = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, secret_refs: [ref] });
    assert.equal(result.ok, false, ref);
    assert.equal(result.errors.some((x) => x.code === 'INVALID_SECRET_REF'), true, ref);
  }
  const good = validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA, secret_refs: ['provider-token', 'db.primary', 'vault:payments'] });
  assert.equal(good.ok, true);
});

test('permission diff flags privilege expansion across every grant class', () => {
  const before = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    read_roots: ['src/api'],
    write_roots: ['artifacts/report'],
    network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443] }] },
    process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 },
    environment: { allow: ['CI'] },
    secret_refs: ['provider-token'],
    limits: { wall_ms: 10_000, stdout_bytes: 2048, stderr_bytes: 2048 },
  };
  const after = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    read_roots: ['src'],
    write_roots: ['artifacts'],
    network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443, 8443] }, { host: 'db.example.com', ports: [5432] }] },
    process: { mode: 'argv-allowlist', executables: ['node', 'python3'], max_children: 2 },
    environment: { allow: ['CI', 'LANG'] },
    secret_refs: ['provider-token', 'db-primary'],
    limits: { wall_ms: 20_000, stdout_bytes: 4096, stderr_bytes: 2048 },
  };
  const delta = diffPermissionManifests(before, after);
  assert.equal(delta.expanded, true);
  const permissions = new Set(delta.expansions.map((x) => x.permission));
  for (const permission of [
    'filesystem.read', 'filesystem.write', 'network.connect', 'process.execute',
    'process.max_children', 'environment.read', 'secret.use', 'limits.wall_ms', 'limits.stdout_bytes',
  ]) assert.equal(permissions.has(permission), true, permission);
  assert.equal(Object.isFrozen(delta), true);
  assert.equal(Object.isFrozen(delta.expansions), true);
});

test('permission diff understands nested root narrowing as a reduction, not an expansion', () => {
  const before = { schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['src'] };
  const after = { schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['src/api'] };
  const delta = diffPermissionManifests(before, after);
  assert.equal(delta.expanded, false);
  assert.equal(delta.reduced, true);
  assert.deepEqual(delta.reductions, [{ permission: 'filesystem.read', value: 'src' }]);
});

test('permission diff is empty for semantically equivalent normalized manifests', () => {
  const before = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    network: { mode: 'allowlist', allow: [
      { host: 'API.EXAMPLE.COM', ports: [8443, 443] },
      { host: 'api.example.com', ports: [443] },
    ] },
    environment: { allow: ['LANG', 'CI', 'CI'] },
  };
  const after = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443, 8443] }] },
    environment: { allow: ['CI', 'LANG'] },
  };
  const delta = diffPermissionManifests(before, after);
  assert.equal(delta.expanded, false);
  assert.equal(delta.reduced, false);
  assert.deepEqual(delta.expansions, []);
  assert.deepEqual(delta.reductions, []);
});

test('permission diff refuses invalid manifests rather than comparing partially normalized grants', () => {
  assert.throws(
    () => diffPermissionManifests(
      { schema: PERMISSION_MANIFEST_SCHEMA },
      { schema: PERMISSION_MANIFEST_SCHEMA, read_roots: ['../secret'] },
    ),
    (error) => error?.code === 'INVALID_PERMISSION_MANIFEST',
  );
});


test('code-loading environment variables are forbidden even when explicitly requested', () => {
  for (const name of [
    'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT',
    'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'BASH_ENV',
  ]) {
    const result = validatePermissionManifest({
      schema: PERMISSION_MANIFEST_SCHEMA,
      environment: { allow: [name] },
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.errors.some((x) => x.code === 'FORBIDDEN_ENV_NAME'), true, name);
  }
});

test('environment selection copies only approved host values into a null-prototype frozen object', () => {
  const selected = selectApprovedEnvironment(
    { schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI', 'LANG', 'RAILS_ENV'] } },
    { CI: '1', LANG: 'C.UTF-8', RAILS_ENV: 'test', HOME: '/Users/example', TOKEN: 'secret' },
  );
  assert.deepEqual(Object.keys(selected), ['CI', 'LANG', 'RAILS_ENV']);
  assert.equal(selected.HOME, undefined);
  assert.equal(selected.TOKEN, undefined);
  assert.equal(Object.getPrototypeOf(selected), null);
  assert.equal(Object.isFrozen(selected), true);
  assert.throws(() => { selected.EXTRA = 'x'; });
});

test('environment selection refuses non-string and NUL-bearing values', () => {
  assert.throws(
    () => selectApprovedEnvironment(
      { schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI'] } },
      { CI: 1 },
    ),
    (error) => error?.code === 'INVALID_ENV_VALUE',
  );
  assert.throws(
    () => selectApprovedEnvironment(
      { schema: PERMISSION_MANIFEST_SCHEMA, environment: { allow: ['CI'] } },
      { CI: 'ok\0bad' },
    ),
    (error) => error?.code === 'INVALID_ENV_VALUE',
  );
  assert.throws(
    () => selectApprovedEnvironment({ schema: PERMISSION_MANIFEST_SCHEMA }, []),
    (error) => error?.code === 'INVALID_AMBIENT_ENV',
  );
});
