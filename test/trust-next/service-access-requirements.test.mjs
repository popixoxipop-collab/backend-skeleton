import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_ACCESS_REQUIREMENTS_CONTRACT,
  buildDatabaseAccessRequirements,
  buildLocalServerRequirements,
} from '../../lib/trust-next/service-access-requirements.mjs';

const policy = () => ({
  schema: 'bskel.trust-artifact-policy/1',
  generation: 8,
  allow: [],
  revoked: [],
});

test('database-read requires one exact endpoint + opaque secret and does not grant listen/process/device', () => {
  const r = buildDatabaseAccessRequirements({
    mode: 'read',
    endpoint: { host: 'db.internal.example', port: 5432 },
    secretRef: 'db.primary',
    artifactTrustPolicy: policy(),
    limits: { wall_ms: 30_000, memory_bytes: 536_870_912 },
  });
  assert.equal(r.contract, SERVICE_ACCESS_REQUIREMENTS_CONTRACT);
  assert.equal(r.service_class, 'database-read');
  assert.deepEqual(r.permission_manifest.network.allow, [{ host: 'db.internal.example', ports: [5432] }]);
  assert.deepEqual(r.permission_manifest.listen, { mode: 'deny', allow: [] });
  assert.deepEqual(r.permission_manifest.process, { mode: 'deny', executables: [], max_children: 0 });
  assert.deepEqual(r.permission_manifest.devices, { mode: 'deny', allow: [] });
  assert.deepEqual(r.permission_manifest.secret_refs, ['db.primary']);
  assert.equal(r.read_only_required, true);
  assert.equal(r.mutation_approval_required, false);
  assert.equal(r.destructive_ddl_allowed, false);
  assert.equal(r.production_target_allowed_by_default, false);
  assert.equal(r.executable_now, false);
  assert.match(r.trust_requirements.permission.sha256, /^[0-9a-f]{64}$/);
});

test('database-write is a distinct class and still never grants destructive DDL', () => {
  const r = buildDatabaseAccessRequirements({
    mode: 'write',
    endpoint: { host: '127.0.0.1', port: 5432 },
    secretRef: 'db.test',
    artifactTrustPolicy: policy(),
  });
  assert.equal(r.service_class, 'database-write');
  assert.equal(r.read_only_required, false);
  assert.equal(r.mutation_approval_required, true);
  assert.equal(r.destructive_ddl_allowed, false);
  assert.equal(r.runtime_binding_required, true);
});

test('database access refuses raw credentials, malformed endpoints and unsupported mode', () => {
  for (const secretRef of ['postgres://u:p@host/db', 'DB_URL=secret', '../secret']) {
    assert.throws(
      () => buildDatabaseAccessRequirements({
        mode: 'read', endpoint: { host: 'db.example.com', port: 5432 },
        secretRef, artifactTrustPolicy: policy(),
      }),
      (e) => e?.code === 'DATABASE_SECRET_REF_INVALID',
      secretRef,
    );
  }
  assert.throws(() => buildDatabaseAccessRequirements({
    mode: 'admin', endpoint: { host: 'db.example.com', port: 5432 },
    secretRef: 'db.primary', artifactTrustPolicy: policy(),
  }), (e) => e?.code === 'DATABASE_ACCESS_MODE_INVALID');
  assert.throws(() => buildDatabaseAccessRequirements({
    mode: 'read', endpoint: { host: 'db.example.com', port: 70000 },
    secretRef: 'db.primary', artifactTrustPolicy: policy(),
  }), (e) => e?.code === 'SERVICE_ENDPOINT_INVALID');
});

test('local-server binds loopback separately from outbound DB/API access', () => {
  const r = buildLocalServerRequirements({
    bind: { host: '127.0.0.1', port: 3000 },
    connectAllow: [
      { host: 'db.internal.example', port: 5432 },
      { host: 'api.internal.example', port: 443 },
    ],
    secretRefs: ['db.primary'],
    artifactTrustPolicy: policy(),
  });
  assert.equal(r.service_class, 'local-server');
  assert.deepEqual(r.permission_manifest.listen.allow, [{ host: '127.0.0.1', ports: [3000] }]);
  assert.deepEqual(r.permission_manifest.network.allow, [
    { host: 'api.internal.example', ports: [443] },
    { host: 'db.internal.example', ports: [5432] },
  ]);
  assert.equal(r.permission_manifest.secret_refs[0], 'db.primary');
  assert.equal(r.public_bind_allowed, false);
  assert.equal(r.cleanup_proof_required, true);
  assert.equal(r.executable_now, false);
});

test('local-server rejects public/all-interface listener instead of widening local profile', () => {
  for (const host of ['0.0.0.0', '[::]', '192.168.1.20', 'example.com']) {
    assert.throws(
      () => buildLocalServerRequirements({
        bind: { host, port: 3000 },
        artifactTrustPolicy: policy(),
      }),
      (e) => e?.code === 'LOCAL_SERVER_PERMISSION_REJECTED',
      host,
    );
  }
});

test('local-server cannot smuggle secret values through secret refs', () => {
  assert.throws(
    () => buildLocalServerRequirements({
      bind: { host: 'localhost', port: 3000 },
      secretRefs: ['DATABASE_URL=postgres://secret'],
      artifactTrustPolicy: policy(),
    }),
    (e) => e?.code === 'LOCAL_SERVER_SECRET_REFS_INVALID',
  );
});
